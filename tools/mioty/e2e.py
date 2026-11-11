#!/usr/bin/env python3
"""Run the real ChirpStack binary, gRPC API, MQTT broker and Mioty TLS peer.

All services bind loopback ports and use a newly created test directory/database.
No existing server, account or database is modified. Run this on Linux/WSL.
"""
import argparse
import asyncio
import base64
import copy
from datetime import datetime, timedelta, timezone
import importlib
import json
import math
import os
from pathlib import Path
import queue
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time

import grpc
from grpc_tools import protoc
import grpc_tools
import paho.mqtt.client as mqtt
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID

from simulator import Peer, CounterState, ProtocolError, arguments as peer_arguments, state_lock


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def wait_port(number, process):
    for _ in range(200):
        if process.poll() is not None:
            raise RuntimeError("Test service exited during startup; inspect its log")
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", number)
            writer.close()
            await writer.wait_closed()
            return
        except OSError:
            await asyncio.sleep(0.05)
    raise TimeoutError("Test service did not start")


def certificates(directory):
    now = datetime.now(timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Mioty E2E test CA")])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
          .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
          .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=1))
          .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
          .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, None, None), critical=True)
          .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
          .sign(ca_key, hashes.SHA256()))
    server_key = ec.generate_private_key(ec.SECP256R1())
    server_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    server = (x509.CertificateBuilder().subject_name(server_name).issuer_name(ca_name)
              .public_key(server_key.public_key()).serial_number(x509.random_serial_number())
              .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=1))
              .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
              .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
              .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
              .add_extension(x509.KeyUsage(True, False, False, False, False, False, False, None, None), critical=True)
              .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
              .sign(ca_key, hashes.SHA256()))
    for name, value in (("ca.pem", ca), ("server.pem", server)):
        (directory / name).write_bytes(value.public_bytes(serialization.Encoding.PEM))
    for name, value in (("ca-key.pem", ca_key), ("server-key.pem", server_key)):
        (directory / name).write_bytes(value.private_bytes(serialization.Encoding.PEM,
                                                         serialization.PrivateFormat.PKCS8,
                                                         serialization.NoEncryption()))


def generate_clients(root, directory):
    output = directory / "proto"
    output.mkdir()
    source = root / "api/proto"
    inputs = [str(path) for folder in ("api", "common", "gw", "integration", "google/api")
              for path in sorted((source / folder).glob("*.proto"))]
    result = protoc.main(["grpc_tools.protoc", f"-I{source}",
                          f"-I{Path(grpc_tools.__file__).parent / '_proto'}",
                          f"--python_out={output}", f"--grpc_python_out={output}", *inputs])
    if result:
        raise RuntimeError("Could not generate gRPC clients from repository protos")
    sys.path.insert(0, str(output))
    return {name: (importlib.import_module(f"api.{name}_pb2"), importlib.import_module(f"api.{name}_pb2_grpc"))
            for name in ("tenant", "application", "device_profile", "gateway", "device", "internal")}


class Broker:
    def __init__(self, number):
        self.messages = queue.Queue()
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, protocol=mqtt.MQTTv5)
        self.client.on_message = lambda client, userdata, message: self.messages.put((message.topic, json.loads(message.payload)))
        self.connected = __import__("threading").Event()
        self.subscribed = __import__("threading").Event()
        def connected(client, userdata, flags, reason, properties):
            if reason.is_failure:
                return
            client.subscribe("application/+/device/+/event/+", qos=1)
            self.connected.set()
        self.client.on_connect = connected
        self.client.on_subscribe = lambda *args: self.subscribed.set()
        self.client.connect("127.0.0.1", number, 30)
        self.client.loop_start()
        if not self.connected.wait(5) or not self.subscribed.wait(5):
            raise RuntimeError("MQTT test client could not subscribe")

    def publish(self, topic, payload):
        result = self.client.publish(topic, json.dumps(payload), qos=1)
        result.wait_for_publish(timeout=5)
        if not result.is_published():
            raise RuntimeError("MQTT command was not acknowledged by the broker")

    async def event(self, event, eui, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                topic, payload = self.messages.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.02)
                continue
            if topic.endswith("/event/" + event) and f"/device/{eui}/" in topic:
                return payload
        raise TimeoutError(f"MQTT {event} event did not arrive")

    def close(self):
        self.client.disconnect()
        self.client.loop_stop()


async def verify(binary, directory, report, serve_ui=False, ui_uplink_interval=0.0):
    root = Path(__file__).resolve().parents[2]
    modules = generate_clients(root, directory)
    processes, logs = [], []
    broker = None
    channel = None
    alternate_channel = None
    def launch(name, args):
        log = (directory / f"{name}.log").open("wb")
        logs.append(log)
        process = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
        processes.append(process)
        return process
    try:
        redis_port, mqtt_port, api_port, mioty_port = [port() for _ in range(4)]
        redis = launch("redis", ["redis-server", "--bind", "127.0.0.1", "--port", str(redis_port),
                                 "--save", "", "--appendonly", "no"])
        mqtt_config = directory / "mosquitto.conf"
        mqtt_config.write_text(f"listener {mqtt_port} 127.0.0.1\nallow_anonymous true\npersistence false\n")
        mosquitto = launch("mosquitto", ["mosquitto", "-c", str(mqtt_config)])
        await wait_port(redis_port, redis)
        await wait_port(mqtt_port, mosquitto)
        certificates(directory)
        config = directory / "config"
        config.mkdir()
        value = lambda path: json.dumps(str(path))
        (config / "chirpstack.toml").write_text(f"""
[logging]
level="WARN"
[sqlite]
path={value(directory / 'test.sqlite')}
max_open_connections=4
[redis]
servers=["redis://127.0.0.1:{redis_port}/15"]
[api]
bind="127.0.0.1:{api_port}"
secret="{secrets.token_hex(32)}"
[network]
enabled_regions=[]
[gateway]
ca_cert={value(directory / 'ca.pem')}
ca_key={value(directory / 'ca-key.pem')}
[mioty]
enabled=true
bind="127.0.0.1:{mioty_port}"
service_center_eui="0102030405060708"
server_cert={value(directory / 'server.pem')}
server_key={value(directory / 'server-key.pem')}
[integration]
enabled=["mqtt"]
[integration.mqtt]
server="tcp://127.0.0.1:{mqtt_port}/"
qos=1
json=true
""")
        key = subprocess.run([str(binary), "--config", str(config), "create-api-key", "--name", "Mioty isolated E2E"],
                             capture_output=True, check=True, text=True, timeout=30)
        token = next((line.removeprefix("token: ") for line in key.stdout.splitlines() if line.startswith("token: ")), None)
        if not token:
            raise RuntimeError("Test server did not generate its bootstrap API key")
        app = launch("chirpstack", [str(binary), "--config", str(config)])
        await wait_port(api_port, app)
        channel = grpc.aio.insecure_channel(f"127.0.0.1:{api_port}")
        await asyncio.wait_for(channel.channel_ready(), 10)
        stubs = {name: getattr(service, "".join(x.title() for x in name.split("_")) + "ServiceStub")(channel)
                 for name, (_, service) in modules.items()}
        # API-key management intentionally requires a user identity upstream.
        # This is a freshly migrated, isolated test DB with its seeded admin.
        internal_pb, _ = modules["internal"]
        user = await stubs["internal"].Login(internal_pb.LoginRequest(email="admin", password="admin"), timeout=10)
        admin = (("authorization", "Bearer " + user.jwt),)
        checks = report["checks"]
        async def call(name, method, request, metadata=admin):
            report["operation"] = name + "." + method
            return await getattr(stubs[name], method)(request, metadata=metadata, timeout=10)
        async def denied(name, method, request, metadata):
            try:
                await call(name, method, request, metadata)
            except grpc.aio.AioRpcError as error:
                if error.code() in (grpc.StatusCode.UNAUTHENTICATED, grpc.StatusCode.PERMISSION_DENIED, grpc.StatusCode.NOT_FOUND):
                    return
                raise
            raise AssertionError("Unauthorized API request was accepted")
        tenant_pb, _ = modules["tenant"]
        internal_pb, _ = modules["internal"]
        tenants, auth = [], []
        for name in ("Mioty E2E A", "Mioty E2E B"):
            response = await call("tenant", "Create", tenant_pb.CreateTenantRequest(tenant=tenant_pb.Tenant(name=name, can_have_gateways=True)))
            tenants.append(response.id)
            response = await call("internal", "CreateApiKey", internal_pb.CreateApiKeyRequest(api_key=internal_pb.ApiKey(name=name, tenant_id=response.id)))
            auth.append((("authorization", "Bearer " + response.token),))
        readonly = await call("internal", "CreateApiKey", internal_pb.CreateApiKeyRequest(api_key=internal_pb.ApiKey(name="Mioty E2E read-only", tenant_id=tenants[0], is_read_only=True)))
        readonly_auth = (("authorization", "Bearer " + readonly.token),)
        app_pb, _ = modules["application"]
        application = await call("application", "Create", app_pb.CreateApplicationRequest(application=app_pb.Application(name="Mioty E2E", tenant_id=tenants[0])), auth[0])
        profile_pb, _ = modules["device_profile"]
        profile = await call("device_profile", "Create", profile_pb.CreateDeviceProfileRequest(device_profile=profile_pb.DeviceProfile(
            name="Mioty E2E", tenant_id=tenants[0], protocol=profile_pb.PROFILE_MIOTY, uplink_interval=60,
            payload_codec_runtime=profile_pb.JS,
            payload_codec_script="function decodeUplink(input) { return { data: { firstByte: input.bytes[0], applicationFormat: input.fPort } }; }")), auth[0])
        stored_profile = await call("device_profile", "Get", profile_pb.GetDeviceProfileRequest(id=profile.id), auth[0])
        assert stored_profile.device_profile.protocol == profile_pb.PROFILE_MIOTY
        gateway_pb, _ = modules["gateway"]
        device_pb, _ = modules["device"]
        gateway_eui, device_eui = secrets.token_hex(8), secrets.token_hex(8)
        gw = gateway_pb.Gateway(gateway_id=gateway_eui, tenant_id=tenants[0], name="Mioty E2E", gateway_type=gateway_pb.MIOTY, stats_interval=30, downlink_priority=10)
        await call("gateway", "Create", gateway_pb.CreateGatewayRequest(gateway=gw), auth[0])
        device = device_pb.Device(dev_eui=device_eui, application_id=application.id, device_profile_id=profile.id,
                                 name="Mioty E2E", device_type=device_pb.MIOTY_DEVICE,
                                 mioty=device_pb.MiotyDevice(ep_class="A", short_address=42, network_key=secrets.token_hex(16), pre_attach=True))
        await call("device", "Create", device_pb.CreateDeviceRequest(device=device), auth[0])
        fetched = (await call("device", "Get", device_pb.GetDeviceRequest(dev_eui=device_eui), auth[0])).device
        assert fetched.device_type == device_pb.MIOTY_DEVICE and not fetched.mioty.network_key and not fetched.mioty.application_key
        checks.append("API provisioning and write-only keys")
        for metadata in ((), auth[1]):
            await denied("device", "Get", device_pb.GetDeviceRequest(dev_eui=device_eui), metadata)
            await denied("gateway", "Get", gateway_pb.GetGatewayRequest(gateway_id=gateway_eui), metadata)
        await denied("device", "Update", device_pb.UpdateDeviceRequest(device=fetched), readonly_auth)
        await denied("device", "Enqueue", device_pb.EnqueueDeviceQueueItemRequest(queue_item=device_pb.DeviceQueueItem(dev_eui=device_eui, data=b"test")), readonly_auth)
        await denied("gateway", "GenerateClientCertificate", gateway_pb.GenerateGatewayClientCertificateRequest(gateway_id=gateway_eui), readonly_auth)
        assert not (await call("device", "Get", device_pb.GetDeviceRequest(dev_eui=device_eui), readonly_auth)).device.mioty.network_key
        checks.append("Unauthenticated, cross-tenant and read-only API access rejected")
        foreign_profile = await call("device_profile", "Create", profile_pb.CreateDeviceProfileRequest(device_profile=profile_pb.DeviceProfile(
            name="Foreign E2E profile", tenant_id=tenants[1], supports_otaa=True, adr_algorithm_id="default", uplink_interval=60)), auth[1])
        invalid = device_pb.Device()
        invalid.CopyFrom(device)
        invalid.dev_eui = secrets.token_hex(8)
        invalid.device_profile_id = foreign_profile.id
        await denied("device", "Create", device_pb.CreateDeviceRequest(device=invalid), auth[0])
        try:
            await call("device", "Create", device_pb.CreateDeviceRequest(device=invalid))
            raise AssertionError("Cross-tenant device profile was accepted")
        except grpc.aio.AioRpcError as error:
            assert error.code() == grpc.StatusCode.INVALID_ARGUMENT
        checks.append("Foreign-tenant device profiles rejected, including global admin requests")
        fetched.name = "Mioty E2E updated"
        await call("device", "Update", device_pb.UpdateDeviceRequest(device=fetched), auth[0])
        try:
            await call("device", "GetKeys", device_pb.GetDeviceKeysRequest(dev_eui=device_eui), auth[0])
            raise AssertionError("LoRaWAN keys operation accepted for Mioty")
        except grpc.aio.AioRpcError as error:
            assert error.code() == grpc.StatusCode.FAILED_PRECONDITION
        cert = await call("gateway", "GenerateClientCertificate", gateway_pb.GenerateGatewayClientCertificateRequest(gateway_id=gateway_eui), auth[0])
        cert_path, key_path = directory / "gateway.pem", directory / "gateway-key.pem"
        cert_path.write_text(cert.tls_cert)
        key_path.write_text(cert.tls_key)
        broker = await asyncio.to_thread(Broker, mqtt_port)
        # MQTT integrations subscribe asynchronously after the broker connection.
        await asyncio.sleep(0.5)
        state_path = directory / "counter.json"
        args = peer_arguments(["--host", "127.0.0.1", "--server-name", "localhost", "--port", str(mioty_port),
                               "--ca", str(directory / "ca.pem"), "--cert", str(cert_path), "--key", str(key_path),
                               "--gateway-eui", gateway_eui, "--device-eui", device_eui,
                               "--state-file", str(state_path), "--listen-seconds", "0.5", "--timeout", "10"])
        state = CounterState(state_path, args.gateway_eui, args.device_eui)
        stats = dict(connections=0, uplinks=0, downlinks=0, failed_downlinks=0)
        # A second real process shares SQL, Redis and MQTT while binding its own
        # API/TLS ports. All subsequent API changes use this other process.
        alternate_api_port, alternate_mioty_port = port(), port()
        alternate_config = directory / "config-alternate"
        alternate_config.mkdir()
        (alternate_config / "chirpstack.toml").write_text((config / "chirpstack.toml").read_text()
            .replace(f"127.0.0.1:{api_port}", f"127.0.0.1:{alternate_api_port}")
            .replace(f"127.0.0.1:{mioty_port}", f"127.0.0.1:{alternate_mioty_port}"))
        alternate_app = launch("chirpstack-alternate", [str(binary), "--config", str(alternate_config)])
        await wait_port(alternate_api_port, alternate_app)
        alternate_channel = grpc.aio.insecure_channel(f"127.0.0.1:{alternate_api_port}")
        await asyncio.wait_for(alternate_channel.channel_ready(), 10)
        alternate_stubs = {name: getattr(service, "".join(x.title() for x in name.split("_")) + "ServiceStub")(alternate_channel)
                           for name, (_, service) in modules.items()}
        class VerifiedPeer(Peer):
            async def complete(self, request):
                if request["command"] == "attPrp" and request["epEui"] == args.device_eui:
                    assert bytes(request["nwkSnKey"]) == bytes.fromhex(device.mioty.network_key), "Blank-key update changed the network key"
                await super().complete(request)
        args.timeout = 30
        with state_lock(state_path):
            peer = VerifiedPeer(args, state, stats)
            try:
                await peer.connect()
                alternate_args = copy.copy(args)
                alternate_args.port = alternate_mioty_port
                contender = Peer(alternate_args, state, stats)
                try:
                    try:
                        await contender.connect()
                        raise AssertionError("Two instances acquired the same gateway")
                    except (ProtocolError, asyncio.IncompleteReadError, ConnectionError):
                        pass
                finally:
                    await contender.close()
                checks.append("Second process cannot acquire an actively owned gateway")
                stubs = alternate_stubs
                await peer.uplink(b"\x01\x02\x03")
                event = await broker.event("up", device_eui)
                assert base64.b64decode(event["data"]) == b"\x01\x02\x03"
                assert event["mioty"]["packetCounter"] == peer.window
                assert base64.b64decode(event["mioty"]["rawUserData"]) == b"\x01\x02\x03"
                assert event.get("fCnt", 0) == 0
                assert event["object"]["firstByte"] == 1 and event["object"]["applicationFormat"] == 0
                checks.append("TLS uplink and JavaScript-decoded payload delivered through real MQTT")
                # Verify the same stream used by the existing React Events page,
                # independently of MQTT delivery and without a parallel event API.
                stream = stubs["internal"].StreamDeviceEvents(
                    internal_pb.StreamDeviceEventsRequest(dev_eui=device_eui), metadata=auth[0], timeout=10)
                try:
                    while True:
                        item = await stream.read()
                        assert item is not grpc.aio.EOF, "Live Events stream ended before the uplink"
                        if item.description == "up":
                            live = json.loads(item.body)
                            assert base64.b64decode(live["data"]) == b"\x01\x02\x03"
                            assert live["mioty"]["packetCounter"] == peer.window
                            assert live["object"]["firstByte"] == 1
                            break
                finally:
                    stream.cancel()
                forbidden_stream = stubs["internal"].StreamDeviceEvents(
                    internal_pb.StreamDeviceEventsRequest(dev_eui=device_eui), metadata=auth[1], timeout=10)
                try:
                    try:
                        await forbidden_stream.read()
                        raise AssertionError("Other tenant could read Live Events")
                    except grpc.aio.AioRpcError as error:
                        assert error.code() in (grpc.StatusCode.UNAUTHENTICATED, grpc.StatusCode.PERMISSION_DENIED, grpc.StatusCode.NOT_FOUND)
                finally:
                    forbidden_stream.cancel()
                checks.append("Native uplink reaches the authorized Live Events stream; another tenant is rejected")
                topic = f"application/{application.id}/device/{device_eui}/command/down"
                await asyncio.to_thread(broker.publish, topic, {"devEui": device_eui, "fPort": 0, "confirmed": False, "data": base64.b64encode(b"\x09\x08\x07").decode()})
                for _ in range(100):
                    queued = await call("device", "GetQueue", device_pb.GetDeviceQueueItemsRequest(dev_eui=device_eui), auth[0])
                    if queued.total_count:
                        break
                    await asyncio.sleep(0.05)
                assert queued.total_count == 1
                queue_id = queued.result[0].id
                await peer.uplink(b"\x04\x05\x06")
                txack = await broker.event("txack", device_eui)
                assert txack["queueItemId"] == queue_id and txack["gatewayId"] == gateway_eui
                assert txack["mioty"]["packetCounter"] == peer.window
                assert txack.get("fCntDown", 0) == 0
                assert (await call("device", "GetQueue", device_pb.GetDeviceQueueItemsRequest(dev_eui=device_eui), auth[0])).total_count == 0
                checks.append("Real MQTT down command, TLS transmission result and queue retirement")
                # Concurrent API edits must acquire SQLite's writer lock before
                # reading endpoint state, while the owning instance also writes
                # leases/outbox state. Do not mask SQLITE_BUSY with test retries.
                for _ in range(4):
                    await asyncio.gather(*[
                        call("device", "Update", device_pb.UpdateDeviceRequest(device=fetched), auth[0])
                        for _ in range(2)
                    ])
                checks.append("Concurrent End Point edits succeed alongside another instance's session writes")
                fetched.is_disabled = True
                await call("device", "Update", device_pb.UpdateDeviceRequest(device=fetched), auth[0])
                for _ in range(700):
                    if not peer.attached.is_set():
                        break
                    await asyncio.sleep(0.05)
                assert not peer.attached.is_set()
                checks.append("API disable on another instance propagates detachment to the owning instance")
                fetched.is_disabled = False
                await call("device", "Update", device_pb.UpdateDeviceRequest(device=fetched), auth[0])
                for _ in range(700):
                    if peer.attached.is_set():
                        break
                    await asyncio.sleep(0.05)
                assert peer.attached.is_set()
                # Leave an unsent item in SQL, then kill its gateway owner without
                # graceful cleanup. The second process must wait out the lease.
                queued = await call("device", "Enqueue", device_pb.EnqueueDeviceQueueItemRequest(
                    queue_item=device_pb.DeviceQueueItem(dev_eui=device_eui, data=b"after-crash")), auth[0])
                app.kill()
                await asyncio.to_thread(app.wait, 5)
                await peer.close()
                recovered = None
                for _ in range(75):
                    candidate = VerifiedPeer(alternate_args, state, stats)
                    try:
                        await candidate.connect()
                        recovered = candidate
                        break
                    except (ProtocolError, asyncio.IncompleteReadError, ConnectionError):
                        await candidate.close()
                        await asyncio.sleep(1)
                assert recovered is not None, "Gateway lease did not recover after owner crash"
                peer = recovered
                await peer.uplink(b"after-crash")
                txack = await broker.event("txack", device_eui)
                assert txack["queueItemId"] == queued.id
                checks.append("Owner process crash recovers through another instance without losing queued data or counters")
                rotated = await call("gateway", "GenerateClientCertificate", gateway_pb.GenerateGatewayClientCertificateRequest(gateway_id=gateway_eui), auth[0])
                try:
                    await peer.request("ping")
                    raise AssertionError("Rotated gateway certificate remained active")
                except (ProtocolError, asyncio.IncompleteReadError, ConnectionError):
                    pass
                await peer.close()
                rejected = VerifiedPeer(alternate_args, state, stats)
                try:
                    try:
                        await rejected.connect()
                        raise AssertionError("Old certificate was accepted after rotation")
                    except (ProtocolError, asyncio.IncompleteReadError, ConnectionError):
                        pass
                finally:
                    await rejected.close()
                cert_path.write_text(rotated.tls_cert)
                key_path.write_text(rotated.tls_key)
                peer = VerifiedPeer(alternate_args, state, stats)
                await peer.connect()
                await peer.uplink(b"rotated-cert")
                checks.append("Certificate rotation disconnects old session, rejects old certificate and accepts newly provisioned certificate")
                # Select a desired Thailand policy through the other real process.
                # This peer still reports eu1: the policy must not fabricate RF data.
                rf_request = gateway_pb.GetMiotyRfConfigRequest(gateway_id=gateway_eui)
                assert not (await call("gateway", "GetMiotyRfConfig", rf_request, auth[0])).HasField("config")
                policy = gateway_pb.MiotyRfConfig(profile_id="TH920_925")
                rf_update = gateway_pb.UpdateMiotyRfConfigRequest(gateway_id=gateway_eui, config=policy)
                await denied("gateway", "GetMiotyRfConfig", rf_request, auth[1])
                await denied("gateway", "UpdateMiotyRfConfig", rf_update, auth[1])
                await call("gateway", "UpdateMiotyRfConfig", rf_update, auth[0])
                status = await call("gateway", "GetMiotyRfConfig", rf_request, auth[0])
                assert status.config == policy and status.experimental and status.tx_supported
                assert status.min_frequency_hz == 920000000 and status.max_frequency_hz == 925000000
                assert status.reported_bidirectional and not status.tx_blockers
                rf_update.config.tx_enabled = True
                await call("gateway", "UpdateMiotyRfConfig", rf_update, auth[0])
                assert (await call("gateway", "GetMiotyRfConfig", rf_request, auth[0])).config.tx_enabled
                rf_update.config.tx_enabled = False
                await call("gateway", "UpdateMiotyRfConfig", rf_update, auth[0])
                assert (await call("gateway", "GetMiotyRfConfig", rf_request, auth[0])).config == policy
                await call("device", "Enqueue", device_pb.EnqueueDeviceQueueItemRequest(
                    queue_item=device_pb.DeviceQueueItem(dev_eui=device_eui, data=b"blocked-by-policy")), auth[0])
                transmitted = stats["downlinks"]
                await peer.uplink(b"thailand-policy")
                deadline = time.monotonic() + 10
                while True:
                    remaining = deadline - time.monotonic()
                    assert remaining > 0, "Thailand policy uplink did not reach MQTT"
                    event = await broker.event("up", device_eui, timeout=remaining)
                    if base64.b64decode(event["data"]) == b"thailand-policy":
                        break
                assert event["mioty"]["packetCounter"] == peer.window
                assert event["rxInfo"][0]["metadata"]["regional_profile"] == "TH920_925"
                assert event["rxInfo"][0]["metadata"]["regional_profile_source"] == "desired_policy"
                assert event["rxInfo"][0]["metadata"]["profile"] == "eu1"
                queued = await call("device", "GetQueue", device_pb.GetDeviceQueueItemsRequest(dev_eui=device_eui), auth[0])
                assert queued.total_count == 1 and not queued.result[0].is_pending
                assert stats["downlinks"] == transmitted
                await call("device", "FlushQueue", device_pb.FlushDeviceQueueRequest(dev_eui=device_eui), auth[0])
                checks.append("TH920_925 RPC isolation, transmit-enabled policy accepted, receive-only mode sends no radio downlink")
            finally:
                await peer.close()
        if serve_ui:
            # Leave only this disposable test environment available for manual
            # browser verification. No authentication tokens or private keys in
            # this manifest. Its fresh database has the default admin login.
            manifest = {
                "url": f"http://127.0.0.1:{alternate_api_port}/",
                "tenant_id": tenants[0], "application_id": application.id,
                "profile_id": profile.id, "gateway_id": gateway_eui, "device_eui": device_eui,
                "rf_path": f"#/tenants/{tenants[0]}/gateways/{gateway_eui}/rf",
                "events_path": f"#/tenants/{tenants[0]}/applications/{application.id}/devices/{device_eui}/events",
                "mqtt_port": mqtt_port,
                "uplink_interval_seconds": ui_uplink_interval,
                "stop_file": str(directory / "stop-ui"),
            }
            (directory / "ui-fixture.json").write_text(json.dumps(manifest, indent=2))
            print(json.dumps({"ui_ready": manifest}), flush=True)
            # Keep the same authenticated simulator/counter state for live UI
            # review. TH policy is already selected and continues to block TX.
            if ui_uplink_interval:
                with state_lock(state_path):
                    demo_peer = VerifiedPeer(alternate_args, state, stats)
                    try:
                        await demo_peer.connect()
                        next_uplink = 0.0
                        while not (directory / "stop-ui").exists():
                            if time.monotonic() >= next_uplink:
                                await demo_peer.uplink(b"\x01\x02\x03")
                                event = await broker.event("up", device_eui)
                                assert event["mioty"]["packetCounter"] == demo_peer.window
                                next_uplink = time.monotonic() + ui_uplink_interval
                            await asyncio.sleep(0.5)
                    finally:
                        await demo_peer.close()
            else:
                while not (directory / "stop-ui").exists():
                    await asyncio.sleep(0.5)
        await call("device", "Delete", device_pb.DeleteDeviceRequest(dev_eui=device_eui), auth[0])
        await call("gateway", "Delete", gateway_pb.DeleteGatewayRequest(gateway_id=gateway_eui), auth[0])
        checks.append("API device and gateway deletion")
        report.update(passed=True, transport="real gRPC + TLS + Mosquitto MQTT v5", stats=stats)
        report.pop("operation", None)
    finally:
        if broker:
            broker.close()
        if channel:
            await channel.close()
        if alternate_channel:
            await alternate_channel.close()
        for process in reversed(processes):
            if process.poll() is not None:
                continue
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        for log in logs:
            log.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chirpstack", type=Path, required=True, help="ChirpStack binary built with --features sqlite")
    parser.add_argument("--work-dir", type=Path, help="New directory for test files; preserved for inspection")
    parser.add_argument("--serve-ui", action="store_true", help="Keep disposable UI fixture running until its stop-ui file exists")
    parser.add_argument("--ui-uplink-interval", type=float, default=0.0,
                        help="Send simulated uplinks while serving the UI (seconds; 0 disables)")
    args = parser.parse_args()
    if not math.isfinite(args.ui_uplink_interval) or args.ui_uplink_interval < 0:
        parser.error("UI uplink interval must be finite and nonnegative")
    if args.ui_uplink_interval and not args.serve_ui:
        parser.error("--ui-uplink-interval requires --serve-ui")
    directory = args.work_dir.resolve() if args.work_dir else Path(tempfile.mkdtemp(prefix="chirpstack-mioty-e2e-"))
    if args.work_dir:
        directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    os.chmod(directory, 0o700)
    report = {"passed": False, "checks": []}
    try:
        asyncio.run(verify(args.chirpstack.resolve(strict=True), directory, report,
                           args.serve_ui, args.ui_uplink_interval))
        print(json.dumps(report, indent=2))
        return 0
    except Exception as error:
        report["error"] = str(error)
        print(json.dumps(report, indent=2), file=sys.stderr)
        print(f"Test files retained at {directory}", file=sys.stderr)
        return 1
    finally:
        (directory / "report.json").write_text(json.dumps(report, indent=2))
        if report["passed"] and not args.work_dir:
            # Only remove the directory allocated above by this process.
            assert directory.parent.resolve() == Path(tempfile.gettempdir()).resolve()
            assert directory.name.startswith("chirpstack-mioty-e2e-")
            shutil.rmtree(directory)


if __name__ == "__main__":
    sys.exit(main())
