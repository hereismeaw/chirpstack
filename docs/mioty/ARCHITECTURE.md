# Decisions and milestone scope

## Continue the native backend

The existing backend at `02c244f3` already supplies the shortest end-to-end path:
registered endpoint → mTLS BSSCI peer → replay-protected acceptance and SQL outbox
→ existing application integration. Keep this path and its simulator. LoRaWAN
protocol processing remains separate; shared inventory, tenant validators, codecs
and integration dispatch remain shared.

No external Service Center dependency has been introduced. A future MQTT adapter
must have its own ingress validation, authentication and delivery semantics, and
must identify the external center that verified the endpoint. It must not bypass
the native counter/security state or masquerade as a BSSCI session. No speculative
adapter trait is added without an actual verified external contract.

## Regional policy is not a radio driver

`chirpstack/src/mioty/rf.rs` validates desired policy only. A channel describes the
full occupied envelope, including frequency excursions, not an invented TSMA
waveform. Frequencies and bandwidths are integer Hz; power is in milli-dB units.
Bounds use doubled u64 arithmetic to preserve odd-bandwidth half-Hz edges.
No centers, spacing, symbol rate, hopping pattern, TSMA rule or guard band defaults
are supplied. The 128-channel limit is a resource limit, not a protocol limit.

`mioty_gateway_rf` stores the optional per-gateway policy as protobuf JSON on both
SQL backends. Existing gateways acquire no RF row and retain their prior behavior.
New RPCs use the existing GatewayService Read/Update tenant validators. Reads
distinguish the desired policy from the last authenticated BSSCI bidi declaration.
Neither a user flag nor a bidi declaration can authorize Thailand transmission.

All `TH920_925` TX requests are rejected. The downlink reservation transaction
checks the persisted policy under a gateway-row lock before consuming a receive
window or marking a queue item pending. Policy updates take the same lock and
refuse pending sends. Session fencing precedes that lock to retain session lock
ordering. SQLite obtains a write lock before policy reads. Corrupt persisted
configuration fails closed. Queued payloads remain visible for inspection/flush.

The gate prevents ChirpStack-requested downlinks through that gateway. It cannot
disable an autonomous Base Station transmitter or an endpoint radio. Configure
actual radios receive-only/offline separately. There is no endpoint-region binding
yet: select the policy on **every** Base Station that could serve Thailand endpoints.
Mixed-region tenants require the future endpoint/profile association milestone.

## Events and delivery

Native uplinks use additive `UplinkEvent.mioty` (field 17), with packet counter,
application format and raw BSSCI userData. Native transmission results use
`TxAckEvent.mioty` (field 8). LoRaWAN FCnt fields are no longer populated for new
mioty events. Normal LoRaWAN event serialization stays unchanged. Stored older
outbox events are still decoded and delivered with their original fields; no
historical payload rewrite occurs.

Native reservations also leave the shared queue's LoRaWAN FCnt column unset;
the mioty downlink table is the authority for packet-counter state.

Application plaintext and optional decoded object continue through the existing
integration pipeline. `deviceInfo.tags.protocol=mioty` remains for old consumers.
Region policy is recorded per reception in RX metadata, explicitly marked
`desired_policy`; a Base Station's optional `profile` remains independent.
No frequency, RSSI, SNR or decoded object is invented when unavailable.
JavaScript codecs receive the BSSCI format as their existing codec port argument;
this is an adapter convention, not a mioty port. ALB interpretation remains absent.

Delivery remains at least once. Deduplicate uplinks with `deduplicationId`; identify
TX results with queue UUID and mioty packet counter. A sent result is a Base Station
report, not an endpoint acknowledgement. Existing SQL/Redis replay and RX
aggregation behavior is retained.

Metrics added: `mioty_uplink_handled_total` (includes duplicate receptions),
`mioty_uplink_rejected_total` (validation/storage failures), and
`mioty_rf_tx_blocked_total` (reservation attempts blocked by policy). They register
lazily through the existing monitoring registry and contain no endpoint labels.

## Protocol evidence and reuse decision

Read [BSSCI 1.0.0 revision 1](https://developers.mioty-alliance.com/wp-content/uploads/2025/01/BSSCI_specification_v1.0.0_rev1.pdf)
before implementation. Sections 3–5 define persistent TLS, framed JSON/MessagePack,
operation sequencing and reception metadata. Section 5.5 leaves the status config
object unspecified; no Thailand retuning interface is inferred from it. Section
4.4 requires rejecting present invalid optional fields; the existing `format`
validation now follows this rule.

Reuse assessment, 11 November 2026:

| Candidate | Evidence and decision |
| --- | --- |
| [IronMate/mioty_BSSCI](https://github.com/IronMate/mioty_BSSCI) | Basic BSSCI implementation. Its [license](https://github.com/IronMate/mioty_BSSCI/blob/main/LICENSE) adds Commons Clause restrictions to MIT. Do not incorporate into this MIT fork. No full security/interoperability audit performed. |
| [KiloCenter](https://github.com/Kiloiot/kilo-service-center) | Alliance directory describes AGPL-3.0 community software with BSSCI/SCACI/MQTT. Different service/runtime and licensing boundary; not required for the existing native vertical slice. No source copied or production-completeness claim made. |
| [miotyGO](https://github.com/loriot/miotyGO) | Alliance directory describes an SDR development Base Station limited to uplinks and ten endpoints, without commercial use. Potential future lab peer, not a production RF driver or evidence of Thailand support. |

The [Alliance project directory](https://developers.mioty-alliance.com/build/#open-source-projects)
is an evaluation starting point, not a substitute for per-version licensing,
maintenance and interoperability review before any future reuse.
