# Multi-protocol UI implementation and handoff

Continuation started 11 November 2026, completed 12 November 2026 (Asia/Bangkok).
Branch `master`, HEAD `02c244f3`. The starting working tree already contained
Astra's backend milestone and Claude's uncommitted UI/API/profile work. No commits
were reset, no existing modifications were discarded, and no upstream was merged.
This document describes the combined working tree, with continuation fixes called
out below. The backend audit in BASELINE_AUDIT.md describes the earlier baseline,
not a clean working tree at the start of this UI continuation.

## Audit and implementation order

Read BASELINE_AUDIT.md, API_CONTRACT.md and AI_HANDOFF.md, then verified the actual
protobufs, service implementations, generated clients, migrations and React routes.
No UI_IMPLEMENTATION.md existed at handoff. Claude had already added navigation,
mioty profiles, inventory filters, RF editor, event details and monitoring pages.
The baseline UI type-check/build passed; tests were 83 passed/6 failed (89 total).
The six failures were device registration tests: the Technology selector's tooltip
changed its accessible name. Explicit accessible names repaired the real control
and all original tests passed, without weakening assertions.

Work proceeded through registration/accessibility, event subscription lifecycle,
RF form ownership, backend contract validation, real-process integration, and the
operator handoff. The final validation results are recorded below.

## Screens, routes and API dependencies

All URLs retain the existing hash router and tenant/application ownership model.
The table shows router paths, without the leading `#` used in a browser URL.

| Workflow / route | Implementation and actual API |
| --- | --- |
| Tenant navigation and dashboard | `ui/src/components/Menu.tsx`, `views/tenants/TenantLoader.tsx`; existing tenant routes and permission context are retained. |
| `/tenants/:tenantId/network-health` (new) | `views/tenants/NetworkHealth.tsx`; GatewayService.List, ApplicationService.List, DeviceService.List counts, InternalService.GetDevicesSummary. Figures are real snapshots; capped application/gateway listings show a notice. |
| `/tenants/:tenantId/mioty` (new) | `views/mioty/MiotyNetwork.tsx`; server-side mioty gateway filter, Base Station connection/metadata and regional-profile links. |
| Existing application lists | `views/applications/ListApplications.tsx`, `components/DeviceCount.tsx`; per-protocol device counts and latest last-seen value from DeviceService.List. Integrations stay in existing application pages. |
| Existing device list/create/edit routes | `views/devices/{ListDevices,DeviceForm,MiotyDeviceFields}.tsx`; shared inventory, server-side protocol filter, existing DeviceService CRUD. LoRaWAN QR/join/activation fields are kept for LoRaWAN. |
| Existing device-profile create/edit/list routes | `views/device-profiles/{DeviceProfileForm,ListDeviceProfiles}.tsx`, `components/DeviceProfileSelect.tsx`; persisted ProfileProtocol. mioty profiles show shared codecs/measurements/tags and omit LoRaWAN MAC/ADR/activation/relay tabs. |
| Existing gateway list/create/edit/dashboard routes | `views/gateways/{ListGateways,GatewayForm,GatewayLayout,MiotyGatewayDashboard}.tsx`; shared registry, server-side protocol filter and self-reported BSSCI metadata. LoRaWAN frames remain on their original route. |
| `/tenants/:tenantId/gateways/:gatewayId/rf` (new, mioty only) | `views/gateways/MiotyRfPolicy.tsx`; GatewayService.GetMiotyRfConfig and UpdateMiotyRfConfig. A read-only tenant member can inspect; only gateway administrators can edit. |
| Existing `/tenants/:tenantId/applications/:applicationId/devices/:devEui/events` | `views/devices/DeviceEvents.tsx`, `components/{LogTable,EventDetails,ProtocolTag}.tsx`, `lib/eventLog.ts`; existing authorized InternalService.StreamDeviceEvents. Typed mioty fields, JSON/hex, diagnostic copy/download, protocol/type/Base Station filters. The device is selected by the existing route. |
| Existing device queue route | `views/devices/DeviceQueue.tsx`; existing queue RPCs. Class Z/unknown mioty classes cannot enqueue; Class A exposes raw-payload queue semantics with explicit RF-policy limitations. No endpoint ACK is inferred from a Base Station transmission result. |

The sidebar groups Overview, Management, Networks and System without replacing
Ant Design or breaking old deep links. A new global event system was not invented.
Server-wide administration links are absent for ordinary tenant users; backend
validators remain authoritative for all reads/writes and streams.

## Changes completed in this continuation

* `ui/src/App.tsx`: subscribe to SessionStore once and remove the listener on
  unmount; rendering no longer accumulates authentication listeners.
* `ui/src/views/tenants/TenantLoader.tsx`: unsubscribe from the TenantStore that
  supplied the listener, rather than removing a different SessionStore listener.
* `DeviceForm.tsx`, `GatewayForm.tsx`, `DeviceProfileForm.tsx`,
  `DeviceProfileSelect.tsx`: explicit accessible names for technology/profile
  selectors. Device submission omits hidden LoRaWAN JoinEUI/FCnt options after
  switching to mioty.
* `DeviceEvents.tsx`: subscription identity is the endpoint EUI, not the props
  object; cancel and ignore old stream callbacks; keep buffers separate by EUI;
  compare Redis IDs as two exact integers; retain at most 500 events.
* `MiotyRfPolicy.tsx`: editor state belongs to one Base Station through its React
  key. Late responses from a previous Base Station cannot populate the new form.
  Retry/save reload the persisted policy. A TX capability flag cannot override
  nonempty backend blocker reasons.
* `NetworkHealth.tsx`: use the actual exported Prometheus `_total` counter names.
* `chirpstack/src/api/{device_profile,device,gateway}.rs`: validate enum values
  before narrowing them into SQL small integers; e.g. 65536 cannot wrap into
  LoRaWAN protocol 0. Existing omitted-filter behavior is retained.
* `chirpstack/src/storage/mioty.rs`: acquire SQLite's writer lock before reading
  endpoint state in settings updates. The real two-process harness exposed
  `database is locked` during a deferred read-to-write upgrade. The change avoids
  that snapshot upgrade; it does not add success mocks or retry the failed edit.
  PostgreSQL keeps its existing row lock. See the
  [SQLite isolation documentation](https://www.sqlite.org/isolation.html).
* `tools/mioty/e2e.py`: provision/retrieve a typed mioty Device Profile, verify the
  existing Live Events stream and cross-tenant rejection, exercise concurrent
  edits alongside session writes, and optionally hold an isolated fixture for
  manual UI verification with `--serve-ui`.

New continuation tests are in `components/Menu.test.tsx`,
`views/gateways/GatewayForm.test.tsx`, `views/device-profiles/DeviceProfileForm.test.tsx`,
`views/devices/DeviceEvents.test.tsx`, with additional device/RF form regressions.
Claude's `DeviceForm.test.tsx`, `MiotyRfPolicy.test.tsx`, `LogTable.test.tsx` and
`lib/{miotyRf,eventLog}.test.ts` are preserved and exercised.

## Cross-layer contract additions retained from Claude

Canonical protobufs and Rust proto copies are kept synchronized.

* `DeviceProfile.protocol = 100`, `DeviceProfileListItem.protocol = 100` use
  `ProfileProtocol`: PROFILE_LORAWAN=0, PROFILE_MIOTY=1.
* Matching `2026-11-11-000001_device_profile_protocol` PostgreSQL/SQLite migrations
  add a constrained SMALLINT, default 0. Existing profiles/data remain LoRaWAN
  typed. New mioty endpoints may still use legacy profiles for their codecs.
* A mioty profile cannot be assigned to a LoRaWAN device. Converting a profile
  used by LoRaWAN devices to mioty is refused. Native radio settings remain on
  endpoints/Base Stations; the profile is not a speculative waveform model.
* `ListDevicesRequest.device_type = 10` and
  `ListGatewaysRequest.gateway_type = 8` are optional enums: omission means both;
  explicitly present 0 means LoRaWAN; 1 means mioty. Filtering applies to count
  and page rows, with the existing authorization checks.
* The native BSSCI listener persists bounded, allowlisted vendor/model/name/
  software/version/session-resume metadata from authenticated connect messages.
  It does not store arbitrary connect info, private keys, or inferred RF ranges.

See API_CONTRACT.md for RF/endpoint/event models and generation commands. REST
annotations require rebuilding the separately deployed REST gateway; this fork's
binary directly serves gRPC/gRPC-Web and the UI, not a new REST transcoder.

## RF policy and credential behavior

`TH920_925` is displayed as **Thailand 920–925 MHz (Experimental)**. The editor
uses MHz/kHz/decimal dB for operators and exact integer Hz/milli-units on the API.
It validates the entire occupied envelope, including half-Hz edges for odd
bandwidths, duplicates, resource bounds and EIRP. Optional blank power fields
stay absent. No hopping/TSMA defaults are invented.

Receive-only is the current supported mode. The backend reports TX unsupported
with blockers; the UI offers no bypass. Selecting a policy does not retune a
physical radio or authorize operation. Per-reception desired policy is displayed
separately from the Base Station's reported profile. Hardware bands, bandwidth,
licensing and unsupported certificate information show unavailable/not reported.

Endpoint keys use password inputs, are not filled from reads, and remain
write-only through the existing API. Empty keys on edit preserve stored keys.
Class A preattachment is required; Class Z downlink controls are absent. No keys
are logged by validation handlers or included in the UI fixture manifest/report.

## Validation and reproducible evidence

Initial checks: UI type-check and production build passed; 83/89 tests passed.
After the accessible-name repair all original 89 passed. Final checks on this
combined working tree:

| Check actually run | Result |
| --- | --- |
| `pnpm type-check` in `ui` | Passed. |
| `pnpm test` in `ui` | 103 passed in 9 test files. |
| `pnpm build` in `ui` | Passed; Vite reports the large bundle warning. |
| Full Rust tests, SQLite | 256 passed after the writer-lock fix. |
| Full Rust tests, PostgreSQL | 256 passed; the subsequent lock fix is SQLite-only. |
| Clippy, both backend feature variants | Passed with warnings; SQLite checked again after its fix. |
| SQLite backend build after the lock fix | Passed. |
| `cargo fmt --all -- --check`, `git diff --check` | Passed. |
| Canonical/Rust device, profile and gateway proto comparisons | Identical. |
| Real two-instance integration harness | 13 checks passed; [UI_E2E_REPORT.json](UI_E2E_REPORT.json). |
| HTTP smoke of backend-hosted production UI | Index, JS and CSS returned HTTP 200; [UI_HTTP_SMOKE.json](UI_HTTP_SMOKE.json). This does not execute browser JavaScript. |
| Whole UI `pnpm lint` | Failed: 454 errors and 4 warnings at the recorded attempt. This includes existing/earlier UI work and continuation files subsequently repaired; it is not an all-clean lint result. |
| Focused ESLint on seven continuation source/test files | Passed without suppressions; command below. |

Focused lint command, from `ui`:

```sh
pnpm exec eslint src/views/devices/DeviceEvents.tsx \
  src/views/devices/DeviceEvents.test.tsx src/views/gateways/MiotyRfPolicy.tsx \
  src/views/gateways/MiotyRfPolicy.test.tsx \
  src/views/device-profiles/DeviceProfileForm.test.tsx \
  src/views/gateways/GatewayForm.test.tsx src/components/Menu.test.tsx
```

Backend tests used Rust 1.98.1 in WSL, locked dependencies, an external target
directory and isolated PostgreSQL/Redis test endpoints. Run each variant with
`cargo +1.98.1 test -p chirpstack --locked --no-default-features --features
sqlite -- --test-threads=1` (replace `sqlite` with `postgres` for PostgreSQL),
with `TEST_POSTGRESQL_DSN`, `TEST_REDIS_URL`, `RUST_MIN_STACK=8388608` and `TZ=UTC`
set as described in VALIDATION.md. The repository toolchain file was not changed.

The first continuation E2E run failed with SQLite `database is locked` during a
real endpoint edit. After the storage fix and rebuilding the binary, a new fresh
fixture passed all 13 checks without edit retries. It verifies write-only keys,
tenant/RBAC isolation, profile ownership, gateway leases, decoded MQTT payloads,
authorized Live Events and cross-tenant denial, concurrent edits, crash recovery,
certificate rotation, and persisted TH receive-only/TX refusal. Five simulated
uplinks and two allowed transmissions occurred before selecting TH policy; no
transmission was allowed under that policy. All fixture processes were cleaned up.

Docker Engine 29.9.3 and Compose 5.7.0 are installed; daemon access and
`docker compose config --quiet` passed. No Compose containers were started.
The working WSL validation environment was retained for reproducible integration.

Browser tooling inventory returned no connected browsers and creating an in-app
browser failed with `Browser is not available: iab`. After Docker installation,
browser inventory was checked again and remained empty. No browser screenshots or
successful browser automation are claimed. Component DOM tests and real-service
API/stream/MQTT tests are separate evidence; manual browser reproduction follows.

## Operator workflow and manual smoke test

1. Install locked dependencies and generate grpc-web clients with the repository
   Makefiles. Run `pnpm type-check`, `pnpm test`, `pnpm build` in `ui`. Build the
   SQLite backend in Linux/WSL (native Windows has existing Unix dependencies).
2. From the repository root, run the isolated harness with a **new** work directory:

   ```sh
   /home/meaw/chirpstack-validation/venv/bin/python tools/mioty/e2e.py \
     --chirpstack /home/meaw/chirpstack-validation/target/debug/chirpstack \
     --work-dir /home/meaw/chirpstack-validation/ui-review --serve-ui
   ```

3. Wait for `ui_ready`. The generated `ui-fixture.json` gives the URL, tenant,
   application/profile/endpoint IDs and RF/Events paths. Use the seeded `admin` /
   `admin` account in this disposable loopback test database. No existing server
   or account is modified. Keep the process running during inspection.
4. Open the tenant's mioty Network and Network Health pages. Inspect Base Station
   identity, session metadata, actual counts and the RF policy link. Verify old
   LoRaWAN region/profile/deep links still open.
5. Open the fixture's RF path. Confirm TH920_925, 920000000–925000000 Hz, receive-only
   mode and backend blockers. Try a center of 920 MHz with positive bandwidth:
   saving must fail at the occupied band edge. Remove that test row afterwards.
6. In Device Profiles, select mioty and verify no LoRaWAN MAC/ADR/join controls.
   Create a codec profile, then add a class Z End Point inside the application.
   Assign that profile, supply a new EUI and a test AES-128 network key. Retrieve
   it through Edit; key inputs must be blank and technology must be locked.
7. Open the original fixture endpoint's Events path. Its simulated uplink should
   show mioty packet counter, payload, Base Station RX, desired TH920_925 policy
   and separately reported eu1 profile. JSON/hex tabs and filters must work. The
   peer is network-only: this is not a Thailand RF interoperability claim.
8. Inspect a class Z downlink page: enqueuing is unavailable. The fixture's class A
   queue supports inspection but TH policy prevents transmission. Server-reported
   sent results refer to Base Station transmission, not endpoint ACKs.
9. Create the `stop-ui` file named in the manifest. The harness cleans up its
   disposable processes and writes its final report. Do not reuse this fixture's
   credentials/configuration for deployment.

## Unsupported features and remaining work

* ALB import/schema validation/association/decoding and a standalone codec-test RPC
  have no backend contract in this fork. The profile UI states the ALB limitation
  and retains the working JavaScript payload codec/editor. Actual simulated
  uplinks exercise decoding; no standalone decode-test utility or pretend
  blueprint success controls are claimed.
* Endpoint-level regional association, preferred Base Station binding, verified
  hardware ranges and regulatory approval remain unavailable. TH policy is per
  Base Station; select it on every station that could serve Thailand endpoints.
* There is no tenant-wide/global Live Events API, application-by-protocol server
  filter, integration-delivery health API, or protocol-specific failure-count API.
  Reuse existing per-device streams and monitoring exports; do not present invented
  totals, live delivery guarantees or unsupported UI controls.
* Hardware interfaces of a hybrid gateway remain separate logical registry
  entries with their own IDs. No physical-gateway grouping model is invented.
* Broad overview listings are intentionally bounded and report partial coverage.
  Large fleets need server-side aggregate health/count contracts and bounded
  request concurrency rather than unbounded client-side aggregation.
* No real RF, vendor interoperability certification, legal approval or browser
  visual QA has been performed. Existing full-repository ESLint debt is documented
  with the final checks; relevant continuation modules are checked separately.
