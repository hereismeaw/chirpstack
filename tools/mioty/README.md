# Mioty gateway/device simulator

This command connects to ChirpStack's native BSSCI listener over mutually
authenticated TLS. It simulates one gateway and one preattached device without
transmitting radio packets. It does not create accounts, gateways or devices.

Use Python 3.10 or newer. JSON needs only Python's standard library. For optional
MessagePack encoding, install `msgpack` in your Python environment and add
`--encoding msgpack`.

## Prepare ChirpStack

Follow [the native Mioty setup guide](../../MIOTY.md) to enable the listener and
configure its server certificate and gateway CA.

1. Create a **Mioty Gateway** and generate its client certificate through the
   existing Gateway certificate action. Save the certificate and private key.
2. In an application in the same tenant, create a **Mioty Device** with class A,
   pre-attach enabled and **application cryptography None (0)**. The simulator
   does not implement application encryption or the radio MAC. The network key
   still needs to be a valid 16-byte key when creating the device.
3. Set the device profile's payload codec to a suitable decoder, or no decoder.
4. Save the CA that issued the BSSCI **server certificate**. It may be a different
   CA from the one that issued the gateway's client certificate.

## Run

From the repository root (replace paths and EUIs):

```sh
python tools/mioty/simulator.py --host localhost --port 5000 --ca server-ca.pem --cert gateway.pem --key gateway-key.pem --gateway-eui 0102030405060708 --device-eui 1122334455667788 --payload 010203 --count 3
```

Use the hostname on the server certificate. If connecting to an IP address, use
`--server-name` to specify that hostname. Certificate verification remains enabled.
The PEM client certificate must be the one provisioned for the registered gateway.

The command waits for device attachment propagation, sends uplinks and handles
status/ping operations. It prints accepted counters and a final JSON summary:

```json
{"connections": 1, "uplinks": 3, "downlinks": 0, "failed_downlinks": 0, "next_counter": 4}
```

The exact counter depends on the device's persisted state. Logs omit network keys
and payload contents. Received uplinks enter ChirpStack's existing integrations;
observe the application's usual MQTT `up` topic or device event stream.

## Downlinks and reconnects

Enqueue a raw payload in the existing device queue before running the simulator.
Each uplink opens a simulated receive window. After completing the `dlDataQue`
exchange, the simulator sends a `dlDataRes` result. With the default `sent` result,
ChirpStack should remove that queue item and emit its TX event through the outbox.
This reports simulated transmission, not an endpoint acknowledgement.

- `--listen-seconds 2`: wait for downlinks after each uplink. Increase this if the
  test server is slow.
- `--downlink-result expired` or `--downlink-result invalid`: exercise failure logs
  and leave the item available for a newer receive window. These options apply
  to every downlink in that run.
- `--reconnect-after 1 --count 3`: use a new TLS/BSSCI session for each uplink.
- `--interval 1`: delay between uplinks, in addition to the receive-window wait.
- `--timeout 30`: connection, frame and operation timeout in seconds.

The simulator supports BSSCI 1.0.x with `snResume=false`. It responds with an error
to unsupported service-center operations; it does not emulate OTA attach/detach,
radio timing, retransmission over the air, RF encryption or specific firmware.

## Counter persistence

By default, counters are stored in a hidden file in the current directory:
`.mioty-simulator-<gateway-eui>-<device-eui>.json`. Use `--state-file PATH` to choose
another location; its parent directory must already exist.

Each counter is saved atomically **before** sending. A process restart or an
uncertain network outcome therefore cannot cause that counter to be reused for a
different payload. The simulator also advances beyond the last counter propagated
by ChirpStack. It rejects mismatched/corrupt state and counter exhaustion, rather
than silently resetting the device's replay protection.

A sibling `.lock` file prevents two processes from using the same state file.
After a forced process termination, remove a stale lock only after checking that
its process has stopped. Keep the state file. Do not run multiple simulators with
different state files for the same device.

## Tests

```sh
python -m unittest discover -s tools/mioty -v
```

The native Rust test
`mioty::server::tests::standalone_python_simulator_uses_native_listener_and_preserves_counters`
starts the actual native TLS listener with a test CA and provisioned certificate,
then invokes this Python command as separate processes. It checks uplinks,
downlink retirement, reconnects, persisted counters, integration events and
hostname rejection. It needs `python3` (or `MIOTY_SIMULATOR_PYTHON` pointing to a
Python executable), plus the normal dedicated database and Redis test setup in
[MIOTY.md](../../MIOTY.md).
