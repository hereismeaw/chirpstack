"""State/framing checks; live TLS interoperability is tested in Rust."""
import asyncio
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from simulator import Codec, CounterState, MAGIC, MAX_COUNTER, ProtocolError, state_lock


class CounterTests(unittest.TestCase):
    def test_counter_survives_restart_and_never_rewinds_to_gateway_state(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "counter.json"
            state = CounterState(path, 1, 2)
            self.assertEqual(state.reserve(40), 41)
            restarted = CounterState(path, 1, 2)
            self.assertEqual(restarted.reserve(0), 42)
            self.assertEqual(restarted.reserve(100), 101)
            with self.assertRaises(ProtocolError):
                CounterState(path, 1, 3)
            with self.assertRaises(ProtocolError):
                restarted.reserve(MAX_COUNTER)

    def test_failed_atomic_write_preserves_original_counter(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "counter.json"
            state = CounterState(path, 1, 2)
            state.reserve(0)
            original = path.read_bytes()
            with patch("simulator.os.replace", side_effect=OSError("disk write failed")):
                with self.assertRaises(OSError):
                    state.reserve(1)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(state.next_counter, 2)
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_state_lock_excludes_another_process_without_removing_its_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "counter.json"
            with state_lock(path):
                with self.assertRaises(ProtocolError):
                    with state_lock(path):
                        self.fail("Second process acquired the state lock")
                self.assertTrue(Path(str(path) + ".lock").exists())
            self.assertFalse(Path(str(path) + ".lock").exists())

    def test_corrupt_state_does_not_reset_counters(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "counter.json"
            for data in ([], {"version": 1, "gateway_eui": "0000000000000001",
                              "device_eui": "0000000000000002", "next_counter": True}):
                path.write_text(json.dumps(data))
                with self.assertRaises(ProtocolError):
                    CounterState(path, 1, 2)


class FramingTests(unittest.IsolatedAsyncioTestCase):
    async def test_reads_fragmented_header_and_payload_without_losing_u64(self):
        await self.fragmented_roundtrip("json")

    @unittest.skipUnless(importlib.util.find_spec("msgpack"), "Optional msgpack package is not installed")
    async def test_messagepack_preserves_full_range_eui_in_fragmented_frame(self):
        await self.fragmented_roundtrip("msgpack")

    async def fragmented_roundtrip(self, encoding):
        codec = Codec(encoding)
        message = {"command": "conRsp", "opId": 0, "scEui": (1 << 64) - 1}
        frame = codec.encode(message)
        reader = asyncio.StreamReader()

        async def fragmented_peer():
            for byte in frame:
                reader.feed_data(bytes([byte]))
                await asyncio.sleep(0)
            reader.feed_eof()

        task = asyncio.create_task(fragmented_peer())
        self.assertEqual(await codec.read(reader), message)
        await task

    async def test_rejects_oversized_frame_before_waiting_for_payload(self):
        reader = asyncio.StreamReader()
        reader.feed_data(MAGIC + struct.pack("<I", (1 << 32) - 1))
        with self.assertRaises(ProtocolError):
            await asyncio.wait_for(Codec("json").read(reader), 1)


if __name__ == "__main__":
    unittest.main()
