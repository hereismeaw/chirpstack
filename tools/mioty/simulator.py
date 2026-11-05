#!/usr/bin/env python3
"""BSSCI test peer for preattached Mioty devices using application crypto mode 0.

This emulates a gateway's network interface, not a Mioty radio stack. JSON uses
only the Python standard library; MessagePack additionally needs `msgpack`.
"""
import argparse
import asyncio
from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import ssl
import struct
import sys
import tempfile
import time
import uuid

MAGIC = b"MIOTYB01"
MAX_FRAME = 1024 * 1024
MAX_COUNTER = (1 << 32) - 1


class ProtocolError(Exception):
    pass


def integer(value, minimum=0, maximum=(1 << 64) - 1):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ProtocolError("Invalid protocol integer")
    return value


def boolean(value):
    if type(value) is not bool:
        raise ProtocolError("Invalid protocol boolean")
    return value


def octets(value, size=None):
    if not isinstance(value, list) or (size is not None and len(value) != size):
        raise ProtocolError("Invalid protocol byte array")
    return bytes(integer(v, 0, 255) for v in value)


class Codec:
    def __init__(self, encoding):
        self.encoding = encoding
        self.msgpack = None
        if encoding == "msgpack":
            try:
                import msgpack
            except ImportError as exc:
                raise ProtocolError("MessagePack requires: python -m pip install msgpack") from exc
            self.msgpack = msgpack

    def encode(self, message):
        if self.msgpack:
            data = self.msgpack.packb(message, use_bin_type=True)
        else:
            data = json.dumps(message, separators=(",", ":"), allow_nan=False).encode()
        if not 0 < len(data) <= MAX_FRAME:
            raise ProtocolError("Outgoing frame exceeds size limit")
        return MAGIC + struct.pack("<I", len(data)) + data

    async def read(self, reader):
        header = await reader.readexactly(12)
        size = struct.unpack("<I", header[8:])[0]
        if header[:8] != MAGIC or not 0 < size <= MAX_FRAME:
            raise ProtocolError("Invalid BSSCI frame header or size")
        data = await reader.readexactly(size)
        if self.msgpack:
            message = self.msgpack.unpackb(data, raw=False, strict_map_key=True)
        else:
            message = json.loads(data)
        if not isinstance(message, dict) or not isinstance(message.get("command"), str):
            raise ProtocolError("Expected a BSSCI message object")
        integer(message.get("opId"), -(1 << 63), (1 << 63) - 1)
        return message


class CounterState:
    def __init__(self, path, gateway_eui, device_eui):
        self.path = Path(path)
        self.identity = {"gateway_eui": f"{gateway_eui:016x}", "device_eui": f"{device_eui:016x}"}
        self.next_counter = 0
        if self.path.exists():
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("version") != 1 or any(data.get(k) != v for k, v in self.identity.items()):
                raise ProtocolError("Counter state belongs to a different gateway/device or version")
            self.next_counter = integer(data.get("next_counter"), 0, MAX_COUNTER + 1)

    def reserve(self, last_seen):
        counter = max(self.next_counter, last_seen + 1)
        if counter > MAX_COUNTER:
            raise ProtocolError("Packet counter exhausted; counter rollover is not supported")
        # Persist before sending: an uncertain transmission must never reuse a
        # counter for a different payload on the next run.
        data = {"version": 1, **self.identity, "next_counter": counter + 1}
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent,
                                             prefix=".mioty-state-", delete=False) as file:
                temporary = Path(file.name)
                json.dump(data, file)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        self.next_counter = counter + 1
        return counter


@contextmanager
def state_lock(path):
    lock = Path(str(path) + ".lock")
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise ProtocolError(f"State is locked: {lock}. Remove a stale lock only after its process has stopped.") from exc
    try:
        with os.fdopen(fd, "w") as file:
            file.write(str(os.getpid()))
        yield
    finally:
        lock.unlink()


class Peer:
    def __init__(self, args, state, stats):
        self.args, self.state, self.stats = args, state, stats
        self.codec = Codec(args.encoding)
        self.reader = self.writer = self.reader_task = None
        self.write_lock = asyncio.Lock()
        self.attached = asyncio.Event()
        self.attachments = {}
        self.sc_pending = {}
        self.bs_pending = {}
        self.background = set()
        self.last_bs = self.last_sc = 0
        self.window = None
        self.failure = None

    async def send(self, message):
        async with self.write_lock:
            self.writer.write(self.codec.encode(message))
            await asyncio.wait_for(self.writer.drain(), self.args.timeout)

    async def connect(self):
        context = ssl.create_default_context(cafile=self.args.ca)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(self.args.cert, self.args.key)
        self.reader, self.writer = await asyncio.wait_for(asyncio.open_connection(
            self.args.host, self.args.port, ssl=context,
            server_hostname=self.args.server_name or self.args.host,
        ), self.args.timeout)
        await self.send({"command": "con", "opId": 0, "version": "1.0.0", "bsEui": self.args.gateway_eui,
                         "bidi": True, "vendor": "ChirpStack simulator", "snBsUuid": list(uuid.uuid4().bytes)})
        response = await asyncio.wait_for(self.codec.read(self.reader), self.args.timeout)
        if response["command"] != "conRsp" or response["opId"] != 0:
            raise ProtocolError("Service center rejected connect")
        version = response.get("version", "1.0.0").split(".")
        if len(version) != 3 or version[:2] != ["1", "0"] or not version[2].isdigit():
            raise ProtocolError("Unsupported BSSCI version")
        if boolean(response.get("snResume")):
            raise ProtocolError("Simulator does not support session resumption")
        integer(response.get("scEui"))
        octets(response.get("snScUuid"), 16)
        await self.send({"command": "conCmp", "opId": 0})
        self.stats["connections"] += 1
        self.reader_task = asyncio.create_task(self.read_loop())
        await asyncio.wait_for(self.attached.wait(), self.args.timeout)
        self.check()

    def check(self):
        if self.failure:
            raise self.failure

    async def read_loop(self):
        try:
            while True:
                # One reader retains framing state; timeout closes this session.
                message = await asyncio.wait_for(self.codec.read(self.reader), self.args.timeout)
                await self.handle(message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.failure = exc
            self.attached.set()  # Release connect() if the peer disconnected early.
            for _, future in self.bs_pending.values():
                if not future.done():
                    future.set_exception(exc)

    async def request(self, command, **fields):
        self.check()
        if len(self.bs_pending) >= 128:
            raise ProtocolError("Too many pending gateway operations")
        self.last_bs += 1
        integer(self.last_bs, 1, (1 << 63) - 1)
        op_id = self.last_bs
        future = asyncio.get_running_loop().create_future()
        self.bs_pending[op_id] = (command, future)
        try:
            await self.send({"command": command, "opId": op_id, **fields})
            return await asyncio.wait_for(future, self.args.timeout)
        finally:
            self.bs_pending.pop(op_id, None)
            if not future.done():
                future.cancel()

    async def handle(self, message):
        command, op_id = message["command"], message["opId"]
        if op_id > 0:
            operation, future = self.bs_pending.get(op_id, (None, None))
            if operation is None:
                raise ProtocolError("Response refers to an unknown gateway operation")
            if command == "error":
                await self.send({"command": "errorAck", "opId": op_id})
                future.set_exception(ProtocolError(f"Service center rejected {operation} (code {message.get('code')})"))
            elif command == operation + "Rsp":
                await self.send({"command": operation + "Cmp", "opId": op_id})
                future.set_result(message)
            else:
                raise ProtocolError("Unexpected gateway operation response")
            return
        if op_id >= 0:
            raise ProtocolError("Invalid service center operation ID")
        if command == "error":
            if self.sc_pending.pop(op_id, None) is None:
                raise ProtocolError("Error refers to an unknown service center operation")
            await self.send({"command": "errorAck", "opId": op_id})
            raise ProtocolError("Service center rejected a gateway response")
        if command == "errorAck":
            request, response = self.sc_pending.pop(op_id, (None, None))
            if response is None or response["command"] != "error":
                raise ProtocolError("Unexpected error acknowledgement")
            return
        if command.endswith("Cmp"):
            request, response = self.sc_pending.pop(op_id, (None, None))
            if request is None or command != request["command"] + "Cmp":
                raise ProtocolError("Unexpected service center completion")
            await self.complete(request)
            return
        if op_id in self.sc_pending:
            request, response = self.sc_pending[op_id]
            if request != message:
                raise ProtocolError("Service center reused an operation ID with a different request")
            await self.send(response)
            return
        if op_id >= self.last_sc or len(self.sc_pending) >= 128:
            raise ProtocolError("Invalid service center operation sequence")
        self.last_sc = op_id
        fields = {}
        if command == "status":
            fields = {"code": 0, "message": "ok", "time": time.time_ns(), "dutyCycle": 0.0}
        elif command == "attPrp":
            integer(message.get("epEui"))
            boolean(message.get("bidi"))
            octets(message.get("nwkSnKey"), 16)
            integer(message.get("lastPacketCnt"), 0, MAX_COUNTER)
            integer(message.get("shAddr"), 0, 65535)
            for flag in ("dualChan", "repetition", "wideCarrOff", "longBlkDist"):
                boolean(message.get(flag))
        elif command == "detPrp":
            integer(message.get("epEui"))
        elif command == "dlDataQue":
            integer(message.get("epEui"))
            integer(message.get("queId"))
            dependent = boolean(message.get("cntDepend"))
            data = message.get("userData")
            if not isinstance(data, list) or not data or any(len(octets(v)) > 245 for v in data):
                raise ProtocolError("Invalid downlink data")
            if dependent:
                counters = message.get("packetCnt")
                if not isinstance(counters, list) or len(counters) != len(data):
                    raise ProtocolError("Downlink counter/data length mismatch")
                for counter in counters:
                    integer(counter, 0, MAX_COUNTER)
            elif len(data) != 1:
                raise ProtocolError("Counter independent downlink requires one payload")
        elif command != "ping":
            response = {"command": "error", "opId": op_id, "code": 95, "message": "Unsupported operation"}
            self.sc_pending[op_id] = (message, response)
            await self.send(response)
            return
        response = {"command": command + "Rsp", "opId": op_id, **fields}
        self.sc_pending[op_id] = (message, response)
        await self.send(response)

    async def complete(self, request):
        command = request["command"]
        if command == "attPrp":
            # Do not retain or log the network key: the simulator has no radio MAC.
            self.attachments[request["epEui"]] = {"bidi": request["bidi"], "last_counter": request["lastPacketCnt"]}
            if request["epEui"] == self.args.device_eui:
                self.attached.set()
        elif command == "detPrp":
            self.attachments.pop(request["epEui"], None)
            if request["epEui"] == self.args.device_eui:
                self.attached.clear()
        elif command == "dlDataQue":
            result = self.args.downlink_result
            eui = request["epEui"]
            if eui != self.args.device_eui or self.window is None or not self.attachments.get(eui, {}).get("bidi"):
                result = "invalid"
            if request["cntDepend"] and self.window not in request["packetCnt"]:
                result = "expired"
            fields = {"epEui": eui, "queId": request["queId"], "result": result}
            if result == "sent":
                fields.update(txTime=time.time_ns(), packetCnt=self.window)
            task = asyncio.create_task(self.report_downlink(fields))
            self.background.add(task)

    async def report_downlink(self, fields):
        await self.request("dlDataRes", **fields)
        self.stats["downlinks" if fields["result"] == "sent" else "failed_downlinks"] += 1
        print(f"downlink result={fields['result']} counter={fields.get('packetCnt', '-')}", flush=True)

    async def uplink(self, payload):
        self.check()
        endpoint = self.attachments.get(self.args.device_eui)
        if not endpoint:
            raise ProtocolError("Device is not attached to this gateway")
        self.window = self.state.reserve(endpoint["last_counter"])
        await self.request("ulData", epEui=self.args.device_eui, rxTime=time.time_ns(), packetCnt=self.window,
                           rssi=-80, snr=6.0, userData=list(payload), dlOpen=endpoint["bidi"],
                           responseExp=False, dlAck=False, format=0, profile="eu1", mode="ulp")
        endpoint["last_counter"] = self.window
        self.stats["uplinks"] += 1
        print(f"uplink accepted counter={self.window} bytes={len(payload)}", flush=True)
        await asyncio.sleep(self.args.listen_seconds)
        self.check()
        # The reader may have started a result exchange during the receive window.
        if self.background:
            await asyncio.wait_for(asyncio.gather(*self.background), self.args.timeout)
            self.background.clear()

    async def close(self):
        if self.reader_task:
            self.reader_task.cancel()
            await asyncio.gather(self.reader_task, return_exceptions=True)
        for task in self.background:
            task.cancel()
        await asyncio.gather(*self.background, return_exceptions=True)
        if self.writer:
            self.writer.close()
            try:
                await asyncio.wait_for(self.writer.wait_closed(), 3)
            except (OSError, asyncio.TimeoutError):
                pass


def eui_argument(value):
    if len(value) != 16 or any(c not in "0123456789abcdefABCDEF" for c in value):
        raise argparse.ArgumentTypeError("EUI must contain 16 hexadecimal characters")
    try:
        return int(value, 16)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("EUI must contain 16 hexadecimal characters") from exc


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--server-name", help="TLS certificate hostname, if different from --host")
    parser.add_argument("--ca", required=True, help="PEM issuer of the server certificate")
    parser.add_argument("--cert", required=True, help="Provisioned gateway client certificate")
    parser.add_argument("--key", required=True, help="Gateway client private key")
    parser.add_argument("--gateway-eui", required=True, type=eui_argument)
    parser.add_argument("--device-eui", required=True, type=eui_argument)
    parser.add_argument("--payload", default="010203", help="Hex application payload; configure device crypto mode 0")
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--listen-seconds", type=float, default=2.0, help="Time per uplink to accept a downlink")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--reconnect-after", type=int, default=0, help="Reconnect after this many uplinks; 0 keeps one session")
    parser.add_argument("--downlink-result", choices=("sent", "expired", "invalid"), default="sent")
    parser.add_argument("--encoding", choices=("json", "msgpack"), default="json")
    parser.add_argument("--state-file", type=Path, help="Persistent packet counter; default is a hidden file in the working directory")
    args = parser.parse_args(argv)
    try:
        args.payload = bytes.fromhex(args.payload)
    except ValueError:
        parser.error("--payload must be hexadecimal bytes")
    if len(args.payload) > 245:
        parser.error("--payload must contain at most 245 bytes")
    if not 1 <= args.port <= 65535 or not 1 <= args.count <= 1000000 or args.reconnect_after < 0:
        parser.error("Invalid port, count or reconnect interval")
    if any(not math.isfinite(v) or v < 0 for v in (args.interval, args.listen_seconds, args.timeout)) or args.timeout == 0:
        parser.error("Time intervals must be finite and nonnegative; timeout must be positive")
    args.state_file = args.state_file or Path(f".mioty-simulator-{args.gateway_eui:016x}-{args.device_eui:016x}.json")
    return args


async def run(args):
    Codec(args.encoding)  # Check optional dependency before opening a connection.
    state = CounterState(args.state_file, args.gateway_eui, args.device_eui)
    stats = {"connections": 0, "uplinks": 0, "downlinks": 0, "failed_downlinks": 0}
    while stats["uplinks"] < args.count:
        peer = Peer(args, state, stats)
        try:
            await peer.connect()
            batch = args.reconnect_after or args.count
            for _ in range(min(batch, args.count - stats["uplinks"])):
                await peer.uplink(args.payload)
                if stats["uplinks"] < args.count:
                    await asyncio.sleep(args.interval)
        finally:
            await peer.close()
        if stats["uplinks"] < args.count:
            await asyncio.sleep(0.25)  # Let the server retire the previous TLS session.
    print(json.dumps({**stats, "next_counter": state.next_counter}), flush=True)


def main(argv=None):
    args = arguments(argv)
    try:
        with state_lock(args.state_file):
            asyncio.run(run(args))
        return 0
    except KeyboardInterrupt:
        return 130
    except (OSError, ValueError, ProtocolError, asyncio.TimeoutError, asyncio.IncompleteReadError) as exc:
        print(f"Simulator failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
