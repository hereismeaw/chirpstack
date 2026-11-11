# Baseline audit — 11 November 2026

## Provenance

Inspected before implementation. Clean working tree; checked out `master` at
`02c244f3` (origin/master). Origin is https://github.com/hereismeaw/chirpstack.git;
upstream is https://github.com/chirpstack/chirpstack.git. Fetched upstream master
without merging: `62b1eb9975ee390798d93c5b51e96bac2272ac56`.
`git merge-base master upstream/master` is
`6b7ac90417bf5395459981f36b3816dcf633a941`.

All fork-only master commits are `712f072d` (55 files, mioty implementation) and
`02c244f3` (16 files, session leases/resume/profile ownership checks).
`cnis` is `df1a9412`; its merge-base with both master and current upstream is
`6b7ac904`. All cnis-only commits: `967063f9` (localization/title), `25ff07d1`
(delete icon), `5c76d870` (delete logo), `86c8cf45` (replacement branding), and
upstream merges `72a682b0`, `0edc7066`, `df1a9412`. The net diff from the merge-base
is only `ui/index.html`, `ui/public/icon.png`, `ui/public/logo.png`. These branch
changes have not been merged into master; neither branch was reset or rewritten.

## Verified existing implementation

* `chirpstack/src/mioty/{server,wire,crypto,uplink,events,mod}.rs`: native BSSCI
  TLS listener, certificate-to-inventory binding, JSON/MessagePack framing,
  bounded message/control queues, timeouts, preattachment, application crypto,
  Class A downlinks and Class Z uplinks. Separate from LoRaWAN PHYPayload parsing.
* `chirpstack/src/storage/{mioty,mioty_session}.rs`: endpoint counters, atomic
  replay suppression/event outbox, downlink reservation, SQL session ownership,
  configuration revisions. Resume is limited to quiescent sessions retained in
  this process, not crash recovery of arbitrary outstanding operations.
* Both `chirpstack/migrations_{postgres,sqlite}` contain matching migrations
  `2026-11-04-000000_add_mioty`, `2026-11-05-000000_mioty_delivery`, and
  `2026-11-05-000001_mioty_gateway_leases`. Diesel schemas match these tables.
* `api/proto/api/{device,gateway}.proto` and their Rust proto copies add protocol
  enums and endpoint configuration. `chirpstack/src/api/{device,gateway}.rs`
  reuse tenant authorization; normal device reads omit keys. Device profiles
  still supply shared codec settings rather than native mioty radio profiles.
* `chirpstack/src/mioty/uplink.rs` and `events.rs` route through existing codecs
  and integrations, use `protocol=mioty`, aggregate RX metadata via Redis, and
  deliver outbox events at least once. Event fields retain compatibility slots
  such as fPort=0; these are not mioty MAC semantics.
* Existing UI selection/dashboard/queue work is in `ui/src/views/{devices,gateways}`.
  No frontend rewrite is required.
* `tools/mioty/{simulator.py,test_simulator.py,e2e.py}` implement a network peer
  simulator and API lifecycle test, not a mioty RF demodulator.

## Partial, missing and problematic behavior

* No TH920_925 regional policy, band-edge checks, hardware capability model,
  persisted RF configuration or explicit experimental-region TX gate exists.
* No verified Thailand hardware/firmware/channel plan, spectrum-access policy,
  equipment approval, emission test results or physical interoperability evidence.
* OTA attach/detach authentication, PFS, optional BSSCI subchannels, ALB decoding,
  and an external Service Center adapter are absent. Do not substitute invented
  wire fields or label an MQTT adapter a native Service Center.
* `MIOTY.md` and later parts of `HANDOVER_MIOTY.md` contain stale statements that
  resume/leases/server.rs do not exist. The source at HEAD does contain them.
* Uplink optional `format` currently defaults even when a present value has the
  wrong type. BSSCI 1.0.0 rev1 section 4.4 requires invalid optional values to be
  rejected. This is a concrete validation defect for the implementation slice.

## Toolchain and build conventions

`rust-toolchain.toml` pins 1.89.0 with rustfmt/clippy; workspace edition is 2024.
The lockfile actually resolves Tokio 1.54.1, Diesel 2.3.14, diesel_migrations 2.3.2,
rustls 0.23.46, Redis 1.8.0, serde_json 1.0.154 (not merely manifest lower bounds).
Mioty adds rmp-serde/rmpv 1.3 and tokio-rustls 0.26. PostgreSQL is the default
feature; SQLite is selected with `--no-default-features --features sqlite`.
Embedded Diesel up/down migrations run through `storage/mod.rs`.
API generation: `api/rust/build.rs`, `api/rust/Makefile`, and language-specific
Makefiles under `api/`. `.github/workflows/main.yml` uses Nix and both databases.
`chirpstack/Makefile` runs fmt, clippy and tests; root Makefile also builds APIs
and tests backend/lrwn/lrwn-filters. UI assets must exist under `ui/build`.

## Baseline execution

* Windows Python 3.13.15: `python -m unittest discover -s tools/mioty -p
  test_simulator.py -v`: six passed, one skipped (optional msgpack unavailable).
* `cargo +1.98.1 check -p chirpstack --locked --no-default-features --features
  sqlite`: started against pristine source; final result recorded in
  `VALIDATION.md`. Native Windows is not the Linux/Nix CI environment.
* Pinned-toolchain check also attempted. Historical test counts in MIOTY.md are
  previous-session claims, not results of this audit. Full DB tests require
  disposable PostgreSQL/Redis services; no user database is to be reset.

## Implementation order

1. Preserve the existing native path; add a pure RF policy model and boundary tests.
2. Add isolated PostgreSQL/SQLite RF persistence and authenticated gateway RPCs.
3. Gate BSSCI downlinks and automatic responses for configured experimental
   profiles; include desired-region metadata without fabricating measured RF data.
4. Exercise schema compatibility, API isolation, simulator and existing regressions.
5. Document exact API/configuration, source evidence, limitations and continuation.

This milestone is an RF-policy/control-plane slice on the existing native backend.
Thailand RF transmission remains blocked pending a verified driver and approvals.

## Baseline defect confirmed during regression

The first full SQLite run reached `api::fuota::test::test_fuota` and failed at
`chirpstack/src/api/fuota.rs:741`: its device fixture omits the required name.
`git blame` attributes the unchanged fixture to upstream commit `a3e27d8b6`.
The panic poisoned TEST_MUX, so later DB tests failed with PoisonError rather
than running. The initial broad result was 136 passed/116 failed. The milestone
adds only a name to that test fixture; production FUOTA logic is unchanged.
See VALIDATION.md for rerun outcomes rather than interpreting the cascade as
116 independent regressions.
