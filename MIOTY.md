# Native Mioty development

Mioty runs inside ChirpStack and uses the existing tenants, users, gateways,
applications, device profiles, queues and integrations. No external service center
or separate account system is required. The listener is disabled by default.

This implementation is under development. No physical gateway or device is
available for interoperability testing.

For testing without hardware, use the standalone
[gateway/device simulator](tools/mioty/README.md). It connects to the native TLS
listener, handles uplink/downlink exchanges and persists counters across process
restarts. Configure application crypto mode 0 for this simulator.

## Supported scope

- BSSCI 1.0.x over mutually authenticated TLS, with JSON or MessagePack framing.
- Gateway certificate matching against the certificate provisioned through the
  existing Gateway API. A certificate for another gateway is rejected.
- Connect, status, ping, attach/detach propagation and uplink operations.
- Preattached Class Z uplinks and Class A uplinks/downlinks.
- Application crypto modes 0, 1 and 17. Keys are write-only in the management API.
- SQL outbox for uplinks, downlink transmission results and failure logs. Packet
  acceptance or queue transitions commit together with their integration event.
  A failed event stays in the outbox and does not block other events in its batch.
  Delivery is at least once: deduplicate uplinks by their deduplication ID, TX
  results by queue item ID and counter, and failure logs by `context.event_id`.
- Downlinks are reserved atomically across gateway connections for one receive
  window. The selected gateway, queue UUID, BSSCI queue ID and packet counter are
  persisted. A result must match that reservation before it changes the queue.

OTA attach/detach authentication, BSSCI session resumption, PFS, agnosticity,
optional BSSCI subchannels and radio interoperability remain unfinished. Unsupported
operations receive an error. Class A configuration currently requires pre-attach.

## Configuration and certificates

Add to the ChirpStack TOML configuration:

```toml
[mioty]
enabled = true
bind = "0.0.0.0:5000"
service_center_eui = "0102030405060708"
server_cert = "/etc/chirpstack/certs/mioty-server.pem"
server_key = "/etc/chirpstack/certs/mioty-server-key.pem"
max_frame_size = 1048576
max_connections = 256
idle_timeout_secs = 180
```

Configure `gateway.ca_cert` and `gateway.ca_key` using ChirpStack's gateway CA
configuration. The listener trusts client certificates issued by that CA. The
private key is used by the existing certificate provisioning API; the listener
only reads the CA certificate.

1. Provision a server certificate with a DNS subject alternative name matching
   the hostname configured in the gateway. Gateways must trust its issuer.
2. Create a gateway in the existing Gateways screen and select **Mioty Gateway**.
3. Generate its client certificate with the existing Gateway certificate action.
   Install the returned certificate and key on that gateway. Configure its BSSCI
   destination to the server hostname and port above, with server verification on.
4. Create a Mioty device in an existing application in the same tenant. Use a
   device profile for payload codecs and integration settings. Configure matching
   EUI, short address, class, radio flags and keys on both sides; enable pre-attach.
5. Use the existing device queue or application MQTT command topic to enqueue raw
   payloads. Mioty uses `fPort=0`, `confirmed=false`; LoRaWAN encryption flags and
   expiry options are rejected. Class Z does not accept downlinks.

Server certificates and keys must be readable by the ChirpStack service account.
Keep private keys outside source control. The listener validates limits and TLS
configuration before startup succeeds. No migrations have been applied to a user
database as part of this development work.

## Queue recovery and operational limits

After a socket loss, pending queue entries remain in SQL. On the next completed
connect, `snResume=false` starts a new BSSCI session, discards the gateway's old
session queue and releases its local reservations. Retrying an uncertain send can
produce duplicate application delivery, so downlink commands should be idempotent.
The persisted last-downlink counter prevents sending a different payload in a
previously reserved receive window. Failed/expired sends can retry in a newer
window. A successful `dlDataRes` retires the queue item and emits a TX event; it
does not claim an endpoint acknowledgement.

Queue flushing is refused while a radio operation is pending. Device settings
cannot change during a pending downlink. Editing keys preserves counters; it does
not provide a counter reset. Gateway tenant changes are rejected. Disabling a
device propagates detachment to connected gateways in its tenant.

Use a single native Mioty listener instance for now. The SQL counters and queue
reservations handle simultaneous gateways, but multi-process ownership of a
gateway session and cross-process configuration notifications are not implemented.
Partial failures in an integration can cause retries to repeat delivery to
integrations that already succeeded. Optional RX aggregation uses Redis and falls
back to the persisted RX; its key is captured when the event is accepted so a
later session change cannot select RX metadata from a different session.

The `2026-11-05-000000_mioty_delivery` migration extends the original outbox with
an event kind and an optional RX aggregation key. Existing outbox rows default to
uplink events. Both PostgreSQL and SQLite have matching up/down migrations.

## Validation

On Linux/WSL, with a dedicated Redis test database:

```sh
TEST_POSTGRESQL_DSN=postgresql://unused \
TEST_REDIS_URL=redis://127.0.0.1:16379/15 \
cargo +1.98.1 test -p chirpstack --no-default-features --features sqlite mioty -- --test-threads=1
cargo +1.98.1 check -p chirpstack --no-default-features --features postgres
npm run type-check --prefix ui
npm run build --prefix ui
```

For PostgreSQL database tests, use a dedicated test database with the `pg_trgm`
extension installed. Set `TEST_POSTGRESQL_DSN` to that database and
`TEST_REDIS_URL` to a dedicated Redis test database, then run:

```sh
cargo +1.98.1 test -p chirpstack --no-default-features --features postgres mioty -- --test-threads=1
```

Database tests reset all ChirpStack tables in the configured test database.

The tests cover framing, full-range EUI64 encoding, application crypto vectors,
certificate identity binding, a live local TLS handshake and reconciliation,
simulated uplink/downlink cycles in both encodings, tenant isolation, replay
suppression, outbox rollback and leases, atomic settings/create operations, queue
reservation, flush protection and recovery without counter reuse.

These tests emulate network peers and storage behavior; they do not emulate the
Mioty radio stack or establish compatibility with any specific gateway firmware.

Verified on 5 November 2026: 16 Mioty tests passed on SQLite and the same 16 passed
against PostgreSQL 18, including simultaneous gateway acceptance/reservation,
atomic TX-result/outbox rollback, failed-event recovery and failure log delivery.
The 11 existing storage/device tests and 16 LoRaWAN Class A tests passed again on
SQLite. Both databases passed migration compatibility, constraint and rollback
checks with an existing outbox row. Rust formatting and diff checks passed; the
UI passed type checking/build in the preceding development round.

Simulator follow-up on the same date: 17 native Mioty tests passed on SQLite,
including the standalone Python CLI against the native TLS listener. That live
CLI test also passed separately with MessagePack enabled. Seven Python tests
passed in WSL; Windows passed six and skipped the optional MessagePack test because
that package was not installed. The PostgreSQL results above are from the preceding
round; this simulator round did not change SQL storage or migrations.

Protocol references: [BSSCI 1.0.0 revision 1](https://developers.mioty-alliance.com/wp-content/uploads/2025/01/BSSCI_specification_v1.0.0_rev1.pdf),
[Application Layer 1.1.0](https://mioty-alliance.com/wp-content/uploads/2026/07/MIOTY_Application_Layer_Specification_v1.1.0.pdf),
[MAC and higher layers](https://mioty-alliance.com/wp-content/uploads/2025/07/public_Mioty-Mac_and_Higher_Layers.pdf).
