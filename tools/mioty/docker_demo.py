#!/usr/bin/env python3
"""Expose the isolated E2E UI fixture through fixed container-only TCP ports."""
import argparse
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import socket
import sys
import uuid

DATA = Path("/data")
CURRENT = DATA / "current.json"


async def relay(reader, writer, target_port):
    upstream = None
    try:
        remote_reader, upstream = await asyncio.open_connection("127.0.0.1", target_port)

        async def copy(source, target):
            while data := await source.read(65536):
                target.write(data)
                await target.drain()
            if target.can_write_eof():
                target.write_eof()

        await asyncio.gather(copy(reader, upstream), copy(remote_reader, writer))
    except (ConnectionError, OSError):
        pass  # A browser/MQTT client may close a long-lived connection at any time.
    finally:
        writer.close()
        if upstream:
            upstream.close()


async def run():
    DATA.mkdir(exist_ok=True)
    CURRENT.unlink(missing_ok=True)
    directory = DATA / (datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%S-") + uuid.uuid4().hex[:8])
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    child = await asyncio.create_subprocess_exec(
        sys.executable, "tools/mioty/e2e.py", "--chirpstack", "/usr/local/bin/chirpstack",
        "--work-dir", str(directory), "--serve-ui", "--ui-uplink-interval", "5")
    finished = asyncio.create_task(child.wait())
    servers = []
    try:
        fixture = directory / "ui-fixture.json"
        while not fixture.exists():
            if finished.done():
                raise RuntimeError(f"Fixture setup failed (exit {finished.result()}); inspect Docker logs")
            if stop.is_set():
                return
            await asyncio.sleep(0.25)
        manifest = json.loads(fixture.read_text())
        api_port = int(manifest["url"].split(":")[-1].strip("/"))
        for exposed, target in ((8080, api_port), (1883, manifest["mqtt_port"])):
            servers.append(await asyncio.start_server(
                lambda reader, writer, target=target: relay(reader, writer, target),
                "0.0.0.0", exposed))
        # Public ports may be customized by Compose; paths remain reusable.
        manifest["url"] = f"http://localhost:{os.environ.get('DEMO_HTTP_PORT', '8080')}/"
        manifest["mqtt_url"] = f"mqtt://localhost:{os.environ.get('DEMO_MQTT_PORT', '1884')}"
        manifest["container_api_port"] = api_port
        manifest["note"] = "A fresh disposable fixture is created on each start."
        CURRENT.write_text(json.dumps(manifest, indent=2))
        print(json.dumps({"demo_ready": manifest}), flush=True)
        stop_task = asyncio.create_task(stop.wait())
        await asyncio.wait((finished, stop_task), return_when=asyncio.FIRST_COMPLETED)
        stop_task.cancel()
        if finished.done() and finished.result() != 0:
            raise RuntimeError("Live fixture exited with an error; inspect Docker logs")
    finally:
        CURRENT.unlink(missing_ok=True)
        for server in servers:
            server.close()
            await server.wait_closed()
        if child.returncode is None:
            (directory / "stop-ui").touch()
            try:
                await asyncio.wait_for(asyncio.shield(finished), timeout=15)
            except asyncio.TimeoutError:
                child.terminate()
                await child.wait()


def healthy():
    try:
        manifest = json.loads(CURRENT.read_text())
        for port in (8080, 1883, manifest["container_api_port"]):
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                pass
        return 0
    except (OSError, ValueError, KeyError):
        return 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    if args.healthcheck:
        sys.exit(healthy())
    asyncio.run(run())
