# Native backend configuration and simulation

Build in the repository's Linux/Nix environment. The listener remains disabled
by default; normal LoRaWAN configuration does not change. Database migration is
automatic through the existing embedded Diesel framework. Back up deployments
before applying migrations. The new isolated RF table does not rewrite gateway,
device, application or historical event rows.

Add to an existing ChirpStack configuration directory:

```toml
[mioty]
enabled = true
bind = "127.0.0.1:5000"
service_center_eui = "0102030405060708"
server_cert = "/etc/chirpstack/certs/mioty-server.pem"
server_key = "/etc/chirpstack/certs/mioty-server-key.pem"
max_frame_size = 1048576
max_connections = 256
idle_timeout_secs = 180
```

Use the existing gateway CA configuration/provisioning API, as documented in
`MIOTY.md`. Server certificates must match the hostname used by the peer. Generate
a client certificate for the registered mioty gateway EUI. Protect CA/server/client
private keys with service-account filesystem permissions. This backend does not
introduce encrypted-at-rest endpoint keys; use protected database access and
encrypted storage/backups. Normal management reads omit keys.

Start with `cargo +1.98.1 run -p chirpstack --no-default-features --features sqlite
-- -c /etc/chirpstack` (or build/run the postgres variant). The explicit toolchain
matches this validation environment; the repository toolchain pin is unchanged.
Build actual UI assets before backend compilation using the API/UI Makefiles.

Register a mioty gateway, application and preattached endpoint in the same tenant.
Use application crypto mode 0 with the existing Python simulator; it does not
implement crypto modes 1/17. See `tools/mioty/README.md` for certificate and CLI
arguments. JSON and optional MessagePack are supported. The simulator has no RF
transmitter and its counters must be kept persistent across restarts.

Before simulating Thailand, issue `UpdateMiotyRfConfig` with:

```json
{"gatewayId":"0202020202020202","config":{"profileId":"TH920_925","txEnabled":false,"channels":[]}}
```

Select the policy on all Base Stations serving these endpoints. Verify Get
returns the selected policy and blockers. Uplinks should appear in the usual
application integration; queued downlinks remain unsent. Inspect the new mioty
event fields and per-RX regional-policy metadata. This does not configure a real
Base Station into physical receive-only mode; do that separately at its driver.

Unknown physical hardware/profile combinations cannot enable TX. A future driver
must report verified capabilities independently from this desired policy, apply
and read back a supported plan, and enforce power/spectrum-access rules. There is
no generic BSSCI retuning packet in this milestone.

Use structured backend logs, queue/outbox state and the monitoring endpoint to
diagnose rejected messages, retained delivery failures and blocked reservations.
Outbox delivery is at least once. Do not treat a Base Station transmission report
as an endpoint acknowledgement. No deployment, push or real radio transmission
was performed during this development task.
