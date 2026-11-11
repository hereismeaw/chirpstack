# Validation — 11 November 2026

This document records the earlier backend milestone. For the 12 November UI
continuation (103 UI tests, 256 tests per SQL backend, 13 real-service checks,
HTTP asset smoke and documented lint/browser limitations), see
[UI_IMPLEMENTATION.md](UI_IMPLEMENTATION.md) and [UI_E2E_REPORT.json](UI_E2E_REPORT.json).
Statements below about no frontend changes apply to that earlier milestone.

This records commands executed in this task. Previous test counts in MIOTY.md
are historical and are not substituted for these results.

## Environment and baseline

Windows: Python 3.13.15, Node 24.22.1, pnpm 12.18.0. Repository Rust pin 1.89.0.
Pristine-source `cargo +1.98.1 check -p chirpstack --locked
--no-default-features --features sqlite` failed at existing `signal-hook-tokio`
imports of Unix-only `signal_hook::iterator` and `tokio::net::UnixStream`.
The pinned-toolchain check failed at the same Unix-only dependency. No source
workaround for native Windows was introduced.

The initial WSL environment had no Rust/C toolchain or database tooling. Installed
Rust 1.98.1 plus Linux build prerequisites. A build in /tmp was interrupted during
WSL service initialization and lost its temporary output. Retried with durable
output, two jobs and debug info disabled. The next attempt required the system
`libprotobuf-dev` package to provide well-known .proto files. Implementation
compile errors in the new serde/event fields were corrected before final tests.

The final Linux environment is WSL Ubuntu 26.04 with PostgreSQL 18.6, Redis 8.0.5,
protoc 3.21.12 and Rust 1.98.1. Dedicated test services: PostgreSQL port 15432,
database `chirpstack_mioty_test`; Redis port 16379/database 15. No user application
database was migrated or reset. Repository toolchain/lockfiles remain unchanged.

## Commands

From the repository root in WSL, use these exports for the recorded backend runs:

```sh
export TEST_POSTGRESQL_DSN=postgresql://meaw@127.0.0.1:15432/chirpstack_mioty_test
export TEST_REDIS_URL=redis://127.0.0.1:16379/15
export RUST_MIN_STACK=8388608 TZ=UTC
export CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0
export CARGO_TARGET_DIR=/home/meaw/chirpstack-validation/target
```

Tests reset the specified SQL database and flush the specified Redis database.
These addresses refer only to the isolated test services provisioned for this run.

```sh
cargo +1.98.1 test -p chirpstack --locked --no-default-features --features sqlite mioty -- --test-threads=1
```

## Final backend outcomes

| Check | Result |
| --- | --- |
| Focused mioty SQLite tests | 29 passed |
| Full SQLite suite, final source | 252 passed, 0 failed; 36.65 s |
| Full PostgreSQL suite | 252 passed, 0 failed; 61.10 s |
| Focused mioty PostgreSQL rerun, final source | 29 passed, 0 failed; 7.17 s |
| Clippy, sqlite and postgres variants | Both passed, with 42 existing/style warnings per main binary run; no warning points at the new RF policy/persistence modules |
| SQLite backend binary build and `--help` smoke check | Passed |
| lrwn all-feature unit tests | 172 passed |
| lrwn_filters all-feature unit tests | 3 passed |
| lrwn documentation tests | 8 passed |
| backend unit tests | 6 passed |
| chirpstack_integration test | 1 passed |
| chirpstack_api default-feature test build and library documentation tests | Passed; no additional default-feature API unit tests |

The full PostgreSQL run preceded the final removal of the obsolete native write
to the shared queue's LoRaWAN FCnt column. The final focused PostgreSQL rerun,
full SQLite rerun, clippy/build and real-process end-to-end check cover that
cleanup. No LoRaWAN counter logic changed.

Additional executed commands, with the exports above:

```sh
cargo +1.98.1 test -p chirpstack --locked --no-default-features --features sqlite -- --test-threads=1
cargo +1.98.1 test -p chirpstack --locked --no-default-features --features postgres -- --test-threads=1
cargo +1.98.1 test -p chirpstack --locked --no-default-features --features postgres mioty -- --test-threads=1
cargo +1.98.1 clippy -p chirpstack --locked --no-deps --no-default-features --features sqlite
cargo +1.98.1 clippy -p chirpstack --locked --no-deps --no-default-features --features postgres
cargo +1.98.1 build -p chirpstack --locked --no-default-features --features sqlite
cargo +1.98.1 test -p lrwn -p lrwn_filters --locked --all-features
cargo +1.98.1 test -p backend -p chirpstack_api -p chirpstack_integration --locked
```

The first broad SQLite attempt failed at the pre-existing nameless FUOTA device
fixture, followed by TEST_MUX poison failures (136 passed, 116 failed). Adding the
fixture name repaired that test; the final full run passes without exclusions.
One supporting-library command initially used directory name `lrwn-filters`
instead of Cargo package name `lrwn_filters`; it ran no tests, was corrected, and
the corrected all-feature run passed.

Full logs and build artifacts remain outside the repository under
`/home/meaw/chirpstack-validation`. The end-to-end report below is copied into the
repository so the key result does not depend on those local logs.

## Verified native end-to-end run

Built and ran the real SQLite backend binary with a generated gRPC client, two
server instances, mTLS Base Station peer, private Redis and Mosquitto MQTT v5:

```sh
/home/meaw/chirpstack-validation/venv/bin/python tools/mioty/e2e.py \
  --chirpstack /home/meaw/chirpstack-validation/target/debug/chirpstack \
  --work-dir /home/meaw/chirpstack-validation/e2e-final
```

**Passed all 11 checks**, including provisioning/write-only keys, authorization,
tenant/profile isolation, exclusive gateway ownership, MQTT uplink/downlink,
cross-process configuration propagation, crash recovery, certificate rotation,
and the Thailand policy. Five uplinks and two downlinks completed. After selecting
TH920_925 through the other server instance, an additional queued downlink stayed
unsent while its uplink reached MQTT with typed mioty counter/raw data and desired
region metadata. The peer's reported `eu1` profile remained separate: this test is
not a claim of Thailand RF operation.

The exact retained report is [E2E_REPORT.json](E2E_REPORT.json). This harness uses
fresh ports/databases, cleans up its processes, and performs no radio transmission.
Python validation dependencies were installed only in an external WSL venv:
grpcio/grpcio-tools 1.85.1, paho-mqtt 2.2.0, cryptography 50.0.2, msgpack 1.2.4.
Mosquitto 2.0.22 was used as the local test broker.

## Completed independent checks

* `cargo fmt --all -- --check` with the pinned toolchain: passed.
* `git diff --check`: passed (Git prints normal Windows CRLF notices).
* Byte comparison: canonical gateway/integration protos match Rust proto copies.
* Windows `python -m unittest discover -s tools/mioty -p test_simulator.py -v`:
  six passed, one skipped because optional MessagePack was unavailable.
* WSL `python3 -m unittest discover -s tools/mioty -p test_simulator.py -v`:
  all seven passed, including MessagePack.
* Generated grpc-web clients using locked `grpc-tools` 1.13.1 and
  `protoc-gen-grpc-web` 1.5.0, following api/grpc-web/Makefile arguments.
* `pnpm install --frozen-lockfile` for api/grpc-web and ui: passed. Reinstalled the
  local API package after generation without updating locks.
* `pnpm type-check` and `pnpm build` in ui with final event/gateway protos: passed.
  Vite reports the existing large JS chunk warning. No frontend source changes.

No hardware certification, physical RF test, exhaustive BSSCI conformance suite,
live external Service Center adapter, production deployment or generated REST
gateway runtime test is implied by these checks.
