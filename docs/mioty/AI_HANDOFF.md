# mioty continuation handoff

## Latest UI continuation checkpoint — 12 November 2026

The sections below originally described the earlier backend milestone. The
current uncommitted working tree also includes Claude's multi-protocol UI/API
work and the continuation documented in [UI_IMPLEMENTATION.md](UI_IMPLEMENTATION.md).
That document is the current route, workflow, validation and unsupported-feature
record. Historical statements below about no frontend changes apply only to the
earlier backend milestone.

Profiles now persist protocol identity, inventory APIs accept optional protocol
filters, and the UI provides native endpoint/Base Station management, receive-only
TH920_925 policy, existing per-device Live Events and real inventory monitoring.
The API additions are recorded in [API_CONTRACT.md](API_CONTRACT.md).

Continuation fixes include accessible selectors, subscription cleanup and bounded
event buffers, RF editor isolation between gateways, strict backend enum checks,
and an SQLite writer-lock fix exposed by real concurrent endpoint edits. This
combined implementation was prepared against `02c244f3` and is recorded with its
validation reports in the commit containing this document. Preserve prior work.

Docker Engine 29.9.3 / Compose 5.7.0 are available and `docker compose config
--quiet` passed. Integration validation continues in the existing isolated WSL
environment; no Compose services or deployment were started for this check.

Final continuation checks: UI type-check/build passed; 103 UI tests passed;
SQLite and PostgreSQL each passed 256 Rust tests. The rebuilt SQLite binary
passed all 13 real-service checks in [UI_E2E_REPORT.json](UI_E2E_REPORT.json),
including decoded MQTT uplinks, authorized Live Events, concurrent edits and
TH TX refusal. Whole-UI lint still has documented errors; the seven focused
continuation files pass ESLint. No connected browser was available; HTTP assets
were verified, and the manual browser workflow remains in UI_IMPLEMENTATION.md.

Branch: `master`. Development base/current HEAD at handoff authoring:
`02c244f3` (`Add MIOTY gateway session leases, resume, and profile checks.`).
The milestone was prepared as a reviewable diff on that commit; inspect its
containing commit and verify the current state with `git log` and `git status`.
No branches were reset, merged, force-pushed or deployed. `cnis` remains
`df1a9412`; its branding is intact on
that branch. See [BASELINE_AUDIT.md](BASELINE_AUDIT.md) for all fork-only commits
and the verified upstream merge-base.

## Implemented in this milestone

* `chirpstack/src/mioty/rf.rs`: TH920_925 identity/display name, immutable
  920000000..925000000 Hz boundaries, desired occupied-envelope channels,
  exact integer EIRP validation, serialization and explicit TX rejection.
* `chirpstack/src/storage/mioty_rf.rs`: optional persisted gateway policy;
  atomic replacement, pending-send guard, shared lock with downlink reservation,
  migration compatibility/cascade tests. Matching new PostgreSQL/SQLite
  `2026-11-11-000000_mioty_rf_policy` migrations and Diesel schema declarations.
* `chirpstack/src/api/gateway.rs`: authenticated tenant-scoped get/update policy
  methods, readable errors and limited last-reported bidi capability.
* `api/proto/api/gateway.proto`: RF methods/messages. Exact contracts and REST
  deployment requirements: [API_CONTRACT.md](API_CONTRACT.md).
* `api/proto/integration/integration.proto`: typed native mioty metadata in
  existing UplinkEvent/TxAckEvent. Matching Rust proto copies are synchronized.
  New native events no longer project packet counters into LoRaWAN FCnt fields.
  Native queue reservations likewise leave the LoRaWAN FCnt column unset.
* `chirpstack/src/mioty/{uplink,events,server}.rs`: populated native event fields,
  desired-region RX metadata, persisted authenticated BSSCI bidi declaration,
  and both-encoding receive-only network test. Present invalid optional payload
  format values are now rejected instead of silently defaulted.
* `chirpstack/src/mioty/wire.rs`: exact synthetic ping fixtures derived from the
  official framing/operation definitions, clearly distinguished from hardware captures.
* `chirpstack/src/mioty/metrics.rs`: handled/rejected uplink operations and
  policy-blocked reservation counters through existing Prometheus monitoring.
* `chirpstack/src/api/fuota.rs`: repaired an existing test fixture's missing device
  name after it caused the full suite's shared-lock failure cascade. Production
  FUOTA behavior is unchanged.
* `tools/mioty/e2e.py`: extended the real-process gRPC/mTLS/MQTT harness with typed
  event assertions, cross-instance RF configuration and TX refusal, tenant
  isolation and retained-queue checks. All 11 checks passed; see E2E_REPORT.json.

The existing native BSSCI listener, endpoint lifecycle, crypto modes, replay checks,
session leases/resume, durable outbox, codecs and integrations were extended,
not replaced. No frontend source or Gateway OS source was changed.

Verified outcomes: 252 tests passed on each SQL backend, final focused PostgreSQL
mioty rerun 29/29, real-process end-to-end 11/11, supporting protocol/library tests,
both clippy variants, formatting, SQLite binary build and existing frontend
type-check/build. See VALIDATION.md for timing, warnings and exact sequencing.

## Run and validate

See [DEPLOYMENT.md](DEPLOYMENT.md) for server configuration and receive-only API
example, `tools/mioty/README.md` for the network simulator, and
[VALIDATION.md](VALIDATION.md) for exact executed commands and real results.
Tests that use `crate::test::prepare` reset the configured SQL database and flush
the configured Redis database. Only use isolated disposable services.

The validation environment uses WSL Ubuntu 26.04, Rust 1.98.1, PostgreSQL 18.6
on localhost:15432 and isolated Redis on localhost:16379 database 15. Linux build
tools were installed because this WSL environment initially had no C toolchain,
Rust, protobuf headers or DB tooling. Persistent build/log output is outside the
repository at `/home/meaw/chirpstack-validation`. Repository toolchain and
dependency locks are unchanged. Native Windows backend compilation is blocked
by the existing Unix signal dependencies; use Linux/Nix/WSL.

## UI integration

Use the additive GatewayService methods and typed mioty event messages described
in API_CONTRACT. Existing create-device/gateway selectors and dashboards are
preserved. Add RF controls without replacing those flows. Keep experimental TX
disabled, show blockers, and distinguish desired values from verified hardware
capabilities. Last-reported bidi alone is not frequency support. Optional empty
power fields must stay absent. All old LoRaWAN clients continue using their
existing contracts; earlier mioty-preview consumers must move counter reads to
the new `mioty.packetCounter` field. Old persisted events are not rewritten.

## Limitations and continuation backlog

1. **RF TX blocked by external evidence:** no verified Thailand firmware/channel
   plan/endpoint support, driver configuration/readback or regulatory and physical
   interoperability results. [HARDWARE_AND_REGULATORY.md](HARDWARE_AND_REGULATORY.md)
   identifies primary sources and exact uncertainties. The backend policy cannot
   disable autonomous hardware radio responses; configure those radios separately.
2. Add endpoint/profile regional association and capability matching for mixed
   regions. Current policy is per Base Station; select it on every Base Station
   that could serve Thailand endpoints. Existing unconfigured gateways deliberately
   retain their previous native behavior. No API removes a selected safety policy.
3. Implement a vendor-specific capability/configuration adapter only against a
   verified contract; persist measured/reported ranges separately from desired
   policy. Do not send invented BSSCI retuning fields or accept user-editable
   attestations as hardware verification.
4. Extend the native protocol only with verified OTA authentication, PFS,
   outstanding-operation crash recovery/resume and subchannel fixtures. Current
   preattachment and quiescent in-process resume restrictions remain.
5. Verify ALB schema/version/decoder behavior before adding it. Existing JavaScript
   codecs remain the working application decoding path. A separate external
   Service Center adapter is optional future work, not implemented or relabeled
   as native in this milestone. Reuse/license assessment is in ARCHITECTURE.md.
6. Expand malformed-message, nesting/resource, reconnect/queue-overflow and fault
   injection coverage; current tests include existing bounds/timeouts/session
   recovery and synthetic peers, not physical protocol certification. Expand
   observability for TLS connection states and integration delivery failures.
7. Review key encryption-at-rest/key rotation and least-privilege deployment.
   Existing keys remain write-only in normal APIs but are stored in SQL; do not
   describe that as encryption-at-rest or a complete credential lifecycle.
8. Complete physical gateway validation and regulatory review before considering
   production claims. The highest-value working slice here is persisted,
   tenant-controlled Thailand receive-only policy on the existing native backend.

Architecture decisions: [ARCHITECTURE.md](ARCHITECTURE.md). Stale historical
statements in MIOTY.md/HANDOVER_MIOTY.md must not override current source or the
new validation record.
