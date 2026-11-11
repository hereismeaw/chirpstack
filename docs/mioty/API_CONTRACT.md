# Backend contract and UI handoff

Source of truth: `api/proto/api/gateway.proto` and
`api/proto/integration/integration.proto`. Rust proto copies under
`api/rust/proto/chirpstack` must match. Existing Gateway/Device create, update,
certificate, queue and tenant contracts remain in place.

## RF policy operations

| gRPC method on `api.GatewayService` | REST mapping |
| --- | --- |
| `GetMiotyRfConfig(GetMiotyRfConfigRequest)` | `GET /api/gateways/{gateway_id}/mioty/rf` |
| `UpdateMiotyRfConfig(UpdateMiotyRfConfigRequest)` | `PUT /api/gateways/{gateway_id}/mioty/rf`, body `*` |

These HTTP annotations are for the existing generated REST gateway deployment.
ChirpStack's binary provides gRPC/gRPC-Web; annotations alone do not install an
HTTP JSON transcoder. Regenerate/rebuild the separately deployed REST gateway.

Both requests require `gateway_id`: exactly 16 hexadecimal digits. Read requires
existing gateway Read permission; Update requires gateway Update permission
(global admin, tenant admin or gateway admin). Authorization precedes policy
lookup/validation. LoRaWAN gateways are rejected. Update replaces the whole
configuration atomically and returns protobuf Empty. No delete/reset-to-legacy
operation is exposed; omitting config does not remove the safety policy.

`UpdateMiotyRfConfigRequest.config` is a required `MiotyRfConfig`:

| Field | Protobuf type | Meaning |
| --- | --- | --- |
| `profile_id` | string | Required, exactly `TH920_925` |
| `tx_enabled` | bool | Defaults false; true is currently refused |
| `channels` | repeated MiotyRfChannel | Optional/unconfigured empty list; max 128 |
| `conducted_power_mdbm` | optional int32 | Conducted power in 0.001 dBm |
| `antenna_gain_mdbi` | optional int32 | Antenna gain in 0.001 dBi |
| `cable_loss_mdb` | optional uint32 | Nonnegative cable loss in 0.001 dB |
| `max_eirp_mdbm` | optional int32 | Operator ceiling, not a legal authorization |

`MiotyRfChannel` has uint32 `center_frequency_hz` and
`occupied_bandwidth_hz`. Width must be positive. The complete envelope
`center ± width/2` must be inside inclusive 920000000..925000000 Hz. Duplicate
centers are rejected. There is no arbitrary spacing constraint or default plan.
Supplying channels does not claim they are supported by hardware or configure it.

Power inputs can remain absent. When all three EIRP inputs and a ceiling are
present, validate `conducted + antenna - cable <= ceiling` using signed i64
arithmetic. Omission does not authorize transmission. All TX remains unsupported.

`GetMiotyRfConfigResponse`:

| Field | Behavior |
| --- | --- |
| `config` | Optional persisted config; absent means no selected policy |
| `display_name` | `Thailand 920–925 MHz (Experimental)` |
| `min_frequency_hz`, `max_frequency_hz` | 920000000, 925000000 |
| `experimental` | true |
| `tx_supported` | true for the offered Thailand profile; the operator can save transmit-enabled mode |
| `tx_blockers` | Empty while transmission is offered |
| `reported_bidirectional` | Optional bool, last authenticated BSSCI `bidi`; absent until reported |

Display metadata describes the offered experimental profile even when config is
absent. `tx_supported=true` means this server accepts a transmit-enabled TH920_925
policy. It does not describe the legacy behavior of an unconfigured gateway. Reported bidirectionality does not
verify any RF band, bandwidth, power range or regional interoperability.

Error contract:

* `INVALID_ARGUMENT`: malformed EUI; missing config; unsupported profile; invalid
  channel envelope/count/duplicates; EIRP above supplied ceiling; LoRaWAN gateway;
  pending downlink prevents replacement (existing storage error mapping).
* `FAILED_PRECONDITION`: request attempts `tx_enabled=true`.
* Existing validator authentication/authorization statuses apply unchanged,
  including unauthenticated callers and callers in another tenant.
* Authorized missing gateway: existing NOT_FOUND behavior; storage failures:
  INTERNAL. Invalid requests leave the previous policy unchanged.

Example JSON body (protobuf JSON uses camelCase; zero/false fields may be omitted):

```json
{
  "gatewayId": "0202020202020202",
  "config": {
    "profileId": "TH920_925",
    "txEnabled": false,
    "channels": []
  }
}
```

No channel center or power value is prescribed by this example. Select the policy
on each relevant Base Station before any Thailand simulation/receive-only test.

## Existing native endpoint API

`Device.device_type=MIOTY_DEVICE` and `Device.mioty` retain their existing fields:
`ep_class` A/Z, uint32 `short_address` (0..65535), `network_key` and
`application_key` hexadecimal AES-128 write-only strings, `pre_attach`, radio
flags `dual_channel`, `repetition`, `wide_carrier_offset`, `long_block_distance`,
and `application_crypto` (0, 1, 17). Empty keys on update preserve existing keys;
normal Get responses never return them. Class A requires preattachment. Existing
RBAC, application ownership, disabled-device checks and cross-tenant move guards
remain. Profiles currently supply codecs, not mioty waveform configuration.

Existing queue methods/MQTT commands use raw payloads, fPort=0 and confirmed=false
as compatibility request slots. LoRaWAN encryption/activation/expiry options are
not mioty semantics. Class Z downlinks are rejected. Under a selected TH policy,
enqueued payloads remain queued and are not reserved or transmitted.

## Application events

Existing integration topics and event names remain unchanged. Protocol is
identified by presence of `UplinkEvent.mioty` or `TxAckEvent.mioty` and by the
existing `deviceInfo.tags.protocol=mioty` tag. Context, endpoint EUI, receive time,
plaintext `data`, optional decoded `object`, RX Base Station IDs and deduplication
UUID remain in the standard envelope.

`MiotyUplinkInfo`: uint32 `packet_counter` (field 1), uint32 `application_format`
(2), bytes `raw_user_data` (3). JSON encodes bytes as base64. `MiotyTxInfo`:
uint32 `packet_counter` (1). New mioty events leave LoRaWAN `fCnt`/`fCntDown` at
their default; migrate consumers of the earlier fork preview to these typed
fields. Old persisted outbox payloads retain their original representation.
LoRaWAN events do not acquire mioty metadata.

When reading historical mioty events without the typed field, the existing
protocol tag identifies the older preview format; consumers needing those old
counters can explicitly handle that legacy representation during migration.

Each RX entry may have `metadata.regional_profile=TH920_925`,
`regional_profile_source=desired_policy`, `regional_tx_enabled=false`.
Base Station `profile`, `mode`, `eqSnr`, `rxDuration` retain their separate reported
meaning when supplied. Missing RF values are not inferred from desired settings.
At-least-once outbox delivery requires consumer deduplication.

## Generation and UI work

Use the repository's language Makefiles: `make -C api rust`,
`make -C api grpc-web`, `make -C api go`, etc. Rust generation occurs during Cargo
build; grpc-web output is ignored/generated. Build existing UI with
`make -C ui build` (pnpm), then backend, because Rust embeds `ui/build`.

The earlier backend milestone handed off the following UI requirements (now
implemented in the UI continuation; see UI_IMPLEMENTATION.md): add a gateway RF
settings view using the new methods and current
permissions. Show the experimental label and blockers. Keep TX disabled. Preserve
absence of optional power inputs; do not convert blank values to zero. Show
desired channels separately from actual hardware support, and last reported bidi
as a limited capability. Never render secret keys from normal device reads.
Render mioty packet counters from the new event fields. Frontend source was not
rewritten in that earlier backend milestone.

## UI continuation contracts (12 November 2026)

`DeviceProfile.protocol` and `DeviceProfileListItem.protocol`, both field 100,
use `ProfileProtocol`: `PROFILE_LORAWAN=0`, `PROFILE_MIOTY=1`. The default preserves
existing LoRaWAN profiles. Both SQL backends add a constrained SMALLINT through
`2026-11-11-000001_device_profile_protocol`. Create/update reject unknown enum
values before narrowing to SQL integers. LoRaWAN devices cannot use mioty
profiles; a profile used by LoRaWAN devices cannot be converted to mioty. Native
mioty endpoints may retain legacy LoRaWAN-typed profiles for existing codecs.

`ListDevicesRequest.device_type` (optional enum, field 10) and
`ListGatewaysRequest.gateway_type` (optional enum, field 8) filter both counts and
rows. Omission means all protocols; explicitly present zero selects LoRaWAN and
one selects mioty. Unknown values fail validation. Existing tenant/application
authorization remains authoritative; no tenant-global event stream was added.

Authenticated native BSSCI connect metadata persists only bounded, allowlisted
identity/software/version/resume fields. These are self-reported device data,
not verified RF capabilities. No arbitrary connect object or private key is
returned as metadata. The existing JavaScript codec works for native uplinks;
there is no ALB schema/import contract or standalone codec-test RPC.

The UI uses the existing gRPC-Web stores and generated clients. Rebuild a
separately deployed REST gateway to expose the updated annotated contracts;
that external gateway runtime was not tested in this continuation. New routes,
permission behavior and actual validation are in [UI_IMPLEMENTATION.md](UI_IMPLEMENTATION.md).
