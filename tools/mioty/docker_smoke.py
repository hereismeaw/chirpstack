#!/usr/bin/env python3
"""Read-only smoke checks against the running disposable Docker demo."""
import base64
import json
from pathlib import Path
import queue
import re
import sys
from urllib.request import urlopen

import grpc
import paho.mqtt.client as mqtt


def main():
    manifest = json.loads(Path('/data/current.json').read_text())
    sys.path.insert(0, str(Path(manifest['stop_file']).parent / 'proto'))
    from api import internal_pb2, internal_pb2_grpc
    from api import device_pb2, device_pb2_grpc
    from api import device_profile_pb2, device_profile_pb2_grpc
    from api import gateway_pb2, gateway_pb2_grpc

    with urlopen('http://127.0.0.1:8080/', timeout=10) as response:
        assert response.status == 200
        html = response.read().decode()
    assets = re.findall(r'(?:src|href)="(/assets/[^" ]+)"', html)
    assert assets
    for path in assets:
        with urlopen('http://127.0.0.1:8080' + path, timeout=10) as response:
            assert response.status == 200 and response.read(1)

    with grpc.insecure_channel('127.0.0.1:8080') as channel:
        internal = internal_pb2_grpc.InternalServiceStub(channel)
        login = internal.Login(internal_pb2.LoginRequest(email='admin', password='admin'), timeout=10)
        auth = (('authorization', 'Bearer ' + login.jwt),)
        profile = device_profile_pb2_grpc.DeviceProfileServiceStub(channel).Get(
            device_profile_pb2.GetDeviceProfileRequest(id=manifest['profile_id']), metadata=auth, timeout=10)
        assert profile.device_profile.protocol == device_profile_pb2.PROFILE_MIOTY
        device = device_pb2_grpc.DeviceServiceStub(channel).Get(
            device_pb2.GetDeviceRequest(dev_eui=manifest['device_eui']), metadata=auth, timeout=10).device
        assert device.device_type == device_pb2.MIOTY_DEVICE
        assert not device.mioty.network_key and not device.mioty.application_key
        rf = gateway_pb2_grpc.GatewayServiceStub(channel).GetMiotyRfConfig(
            gateway_pb2.GetMiotyRfConfigRequest(gateway_id=manifest['gateway_id']), metadata=auth, timeout=10)
        assert rf.config.profile_id == 'TH920_925' and not rf.config.tx_enabled
        assert rf.tx_supported and not rf.tx_blockers
        assert (rf.min_frequency_hz, rf.max_frequency_hz) == (920000000, 925000000)
        stream = internal.StreamDeviceEvents(
            internal_pb2.StreamDeviceEventsRequest(dev_eui=manifest['device_eui']), metadata=auth, timeout=10)
        try:
            for item in stream:
                if item.description == 'up':
                    event = json.loads(item.body)
                    assert event['mioty']['packetCounter'] > 0
                    break
            else:
                raise AssertionError('No persisted Live Events uplink')
        finally:
            stream.cancel()

    messages = queue.Queue()
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, protocol=mqtt.MQTTv5)
    topic = f"application/{manifest['application_id']}/device/{manifest['device_eui']}/event/up"
    client.on_connect = lambda client, userdata, flags, reason, properties: client.subscribe(topic, qos=1)
    client.on_message = lambda client, userdata, message: messages.put(json.loads(message.payload))
    client.connect('127.0.0.1', 1883)
    client.loop_start()
    try:
        events = [messages.get(timeout=15), messages.get(timeout=15)]
        counters = [event['mioty']['packetCounter'] for event in events]
        assert counters[1] > counters[0]
        for event in events:
            assert base64.b64decode(event['data']) == b'\x01\x02\x03'
            assert event['object']['firstByte'] == 1
            assert event['rxInfo'][0]['metadata']['regional_profile'] == 'TH920_925'
    finally:
        client.disconnect()
        client.loop_stop()
    print(json.dumps({'passed': True, 'checks': [
        'HTTP index and production assets', 'Seeded admin login through API relay',
        'Persisted mioty profile and endpoint; write-only keys',
        'Persisted TH920_925 receive-only policy and blockers',
        'Authorized Live Events stream through API relay',
        'Two consecutive decoded MQTT uplinks through broker relay'],
        'mqtt_counters': counters}, indent=2))


if __name__ == '__main__':
    main()
