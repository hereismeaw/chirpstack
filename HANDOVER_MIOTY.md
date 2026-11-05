# Handover: Native Mioty support in ChirpStack

## สถานะล่าสุด — 5 พฤศจิกายน 2026 (Asia/Bangkok)

ผู้ใช้สั่งให้ทำต่อแล้ว และยืนยันว่า **ยังไม่มี Gateway / Device จริง** สำหรับทดสอบ
ส่วนที่ 1–10 ด้านล่างเป็นบันทึกประวัติวันที่ 4 พฤศจิกายน ให้ใช้สถานะส่วนนี้เป็นหลัก

- เพิ่ม `chirpstack/src/mioty/server.rs` แล้ว: native mTLS listener, certificate binding กับ gateway ที่ลงทะเบียน, BSSCI connect/status/ping, operation IDs/deadlines, attach/detach propagation และ uplink/downlink สำหรับ preattached Class A/Z
- เพิ่ม SQL outbox ให้ uplink event กับ counter commit พร้อมกัน และ retry integrations ด้วย deduplication ID เดิม
- รอบทำต่อเพิ่ม `mioty/events.rs`: TX result และ failure log ใช้ outbox ด้วย โดย commit พร้อมการเปลี่ยนคิว; event ที่ส่งไม่ผ่านไม่ขวางรายการถัดไป และบันทึก RX aggregation key ตอนรับ event เพื่อไม่ lookup session ผิดภายหลัง
- เพิ่ม migration `2026-11-05-000000_mioty_delivery` ทั้ง PostgreSQL/SQLite สำหรับชนิด event และ RX key โดย event เดิม default เป็น uplink
- เพิ่ม persistent downlink correlation / atomic reservation / last-downlink counter ป้องกันจอง receive window ซ้ำ และเก็บคิวเมื่อ socket หลุด
- เมื่อ reconnect ใช้ session ใหม่ (`snResume=false`) และ retry ได้ใน counter ถัดไป จึงยังมีโอกาสส่งคำสั่งซ้ำเมื่อผลส่งเดิมไม่แน่นอน
- Device create และ settings update รวมใน transaction เดียวกัน; settings ไม่เขียนทับ runtime counters ที่อ่านเก่ามา และ blank keys preserve ค่าปัจจุบันภายใน transaction
- Flush queue ตรวจ pending ใน transaction; gateway delete ปฏิเสธเมื่อมี downlink ค้าง
- เพิ่มตัวกรอง Mioty ออกจาก LoRaWAN scheduler, multicast และ FUOTA
- UI มี crypto modes / radio flags ครบตาม proto และ regenerate grpc-web แล้ว; application key optional เมื่อ crypto=0
- เพิ่ม config template และคู่มือ `MIOTY.md`; ปรับ tokio-rustls ใช้ ring และ regenerate Cargo.lock แล้ว
- ลบเฉพาะ google proto ที่ copy ซ้ำ หลังตรวจว่าเนื้อหาตรงกับ canonical file
- แก้ test setup ของ SQLite `:memory:` ให้ใช้ connection เดียว แทนเปิดหลายฐานข้อมูลโดยไม่ตั้งใจ
- รอบ simulator เพิ่ม `tools/mioty/simulator.py` และคู่มือ `tools/mioty/README.md`: CLI Python ที่เชื่อม mTLS จริง, JSON/MessagePack, preattached Device crypto=0, ส่ง uplink/ผล downlink, reconnect และใช้ไฟล์ counter แบบ atomic พร้อม process lock
- เพิ่ม Rust test เรียก CLI เป็นโปรเซสแยกกับ native listener จริง ตรวจ restart/counter persistence, queue retirement, integration events และปฏิเสธ hostname ที่ไม่ตรง certificate; listener คืน bound address เพื่อทดสอบด้วย port 0 ได้

ผลตรวจที่ผ่านจริงในรอบนี้:

- Mioty tests บน WSL ผ่าน **16 รายการต่อ backend** ทั้ง SQLite และ PostgreSQL 18 จริง รวม live local mTLS handshake, certificate binding, protocol simulator JSON/MessagePack, tenant isolation, crypto vector, replay/outbox/queue lifecycle, atomic rollback, recovery ของ failed event และ concurrent Gateway reservation
- Existing storage device tests **11 ผ่าน** และ LoRaWAN Class A tests **16 ผ่าน**
- UI type-check และ production build ผ่าน
- Migration compatibility / constraints / rollback ผ่านทั้ง SQLite และ PostgreSQL โดยตรวจว่า event เดิมไม่หายเมื่อเพิ่ม/ถอดชนิด event
- `cargo +1.98.1 fmt --all -- --check` และ `git diff --check` ผ่าน
- Rust SQLite backend compile ผ่าน (รวมใน test build)
- PostgreSQL ผ่านทั้ง compile และ database tests จริงแล้ว; ฐานข้อมูลทดสอบแยกถูกลบหลังใช้งาน และหยุดบริการทดสอบที่เริ่มไว้แล้ว (ติดตั้ง PostgreSQL 18 ใน WSL สำหรับรอบนี้)
- รอบ simulator ล่าสุด: native Mioty tests **17 ผ่านบน SQLite**, live CLI ผ่านแยกอีกครั้งด้วย MessagePack; Python tests **7 ผ่านบน WSL**, Windows ผ่าน 6 และ skip optional MessagePack 1 (ยังไม่ได้ติดตั้ง package บน Windows)
- PostgreSQL 16 tests ด้านบนเป็นผลรอบก่อน simulator; รอบนี้ไม่ได้แก้ SQL และไม่ได้รัน PostgreSQL ซ้ำ

ข้อจำกัดที่ยังเหลือ:

- OTA attach/detach authentication ยังไม่ implement; Class A ต้อง pre-attach และ unsupported BSSCI operations ตอบ error
- ยังไม่รองรับ session resume, PFS, agnosticity, optional subchannels และ multi-process gateway session ownership / configuration notification
- การส่ง integrations เป็น at-least-once ทั้ง uplink/TX/failure logs; ต้อง deduplicate ที่ consumer ตามรายละเอียดใน `MIOTY.md`
- ยังไม่มีการทดสอบ radio / firmware / Gateway / Device จริง; **อย่าอ้างว่า production-ready**
- ไม่ได้ deploy, apply migrations ในฐานข้อมูลผู้ใช้ หรือ commit งาน

รายละเอียดการตั้งค่าและ semantics ล่าสุดอยู่ใน `MIOTY.md`

---

บันทึกวันที่ 4 พฤศจิกายน 2026 (Asia/Bangkok) ตามคำขอผู้ใช้ให้หยุดงานและส่งต่อให้ Grok

## 1. ข้อกำหนดล่าสุดของผู้ใช้ — ยึดส่วนนี้เป็นหลัก

- งานหลักคือ **เพิ่มการรองรับทั้ง Mioty Gateway และ Mioty Device บน ChirpStack**
- Mioty Gateway ต้องอยู่ในเมนู Gateways เดิม
- ตอนเพิ่ม Gateway ต้องเลือกได้ระหว่าง `LoRaWAN Gateway` และ `Mioty Gateway`
- Mioty Device ต้องจัดการใน Applications / Devices เดิม และส่ง Downlink ได้
- ใช้ Tenant / User / authorization ของ ChirpStack และส่งข้อมูลเข้า MQTT / integrations เดิม
- **ไม่ใช้ KiloCenter เลย ต้องทำ Mioty backend ภายใน ChirpStack** ไม่ใช่แค่ซ่อนชื่อหรือเปลี่ยนแบรนด์
- ไม่ต้องสร้างหน้าเว็บหรือระบบบัญชีแยก ไม่ต้องสร้าง dependency ไปยัง service center ภายนอก
- ผู้ใช้ขอให้บันทึก handover และหยุดไว้ก่อน ยังไม่ได้ขอให้พัฒนาต่อหลัง handover

เดิมเริ่มทำ external adapter ตาม repository ที่ผู้ใช้ให้ แต่ผู้ใช้แก้ข้อกำหนดภายหลัง จึงถอด adapter และกำลังเปลี่ยนเป็น native implementation อย่าย้อนกลับไป external adapter

## 2. สถานะสำคัญ

**งานยังไม่เสร็จ และ backend ปัจจุบันยัง build ไม่ได้**

จุดค้างที่ชัดเจนที่สุด: `chirpstack/src/mioty/mod.rs` ประกาศ `mod server;` และเรียกหลายฟังก์ชันใน `server` แต่ **ยังไม่มีไฟล์ `chirpstack/src/mioty/server.rs`** ผู้ใช้สั่งทำ handover ก่อนเริ่มเขียนไฟล์นี้

มี UI / API / schema และโครง native protocol บางส่วนแล้ว แต่ยังไม่มี native TLS listener, session engine หรือการทดสอบกับ Gateway จริง อย่ารายงานว่าใช้งาน Mioty end-to-end ได้แล้ว

## 3. Repository และ working tree

- Workspace: `C:\Users\meawk\Desktop\chirpstack`
- Shell: PowerShell
- Git branch: `master`
- Base commit: `6b7ac904` — `Bump version to 4.20.1-test.2`
- ตอนเริ่มงาน working tree สะอาด การเปลี่ยนแปลงในรอบนี้ยัง **ไม่ได้ commit**
- ไม่พบ `AGENTS.md` จากการค้นหาเริ่มต้น
- ไม่มีการ deploy และไม่ได้ apply migrations ไปยังฐานข้อมูลของผู้ใช้
- ดูรายการจริงด้วย `git status --short -uall` รวมไฟล์ใหม่ที่ยัง untracked ด้วย

### ไฟล์ชั่วคราวที่ต้องระวัง

- `.references/kilo-service-center/`: clone ไว้เพื่ออ่านอ้างอิงก่อนเปลี่ยน requirement เป็น native อยู่ใน hidden directory ที่ gitignore ไม่ใช่ runtime dependency
- `.mioty-edit.py`, `.mioty-device-edit.py`, `.mioty-ui-edit.py`, `.mioty-native-storage.py`: สคริปต์แก้ไฟล์ที่รันไปแล้ว อยู่ใน hidden files ที่ถูก ignore **ห้ามรันซ้ำ** โดยเฉพาะสคริปต์เก่าที่สร้าง external adapter
- มีไฟล์ untracked ที่เกิดจาก copy proto เกินมา:
  - `api/rust/proto/chirpstack/google/api/annotations.proto`
  - `api/rust/proto/chirpstack/google/api/http.proto`
  ทั้งสองไม่ใช่งาน feature ควรเอาออกอย่างระมัดระวังเมื่อจัด working tree
- Generated JS / TS ใน `api/grpc-web/` และ `node_modules` ถูก ignore ตามรูปแบบ repo ต้อง regenerate จาก proto ก่อน build

## 4. ส่วนที่แก้ไว้แล้ว

### API / protobuf

Canonical proto และสำเนาที่ใช้ Rust build ถูกแก้คู่กัน:

- `api/proto/api/gateway.proto`
- `api/rust/proto/chirpstack/api/gateway.proto`
  - เพิ่ม `GatewayType`: `LORAWAN = 0`, `MIOTY = 1`
  - `Gateway.gateway_type = 10`
  - `GatewayListItem.gateway_type = 12`
- `api/proto/api/device.proto`
- `api/rust/proto/chirpstack/api/device.proto`
  - เพิ่ม `DeviceType`: `LORAWAN_DEVICE = 0`, `MIOTY_DEVICE = 1`
  - `Device.device_type = 11`, `Device.mioty = 12`
  - `DeviceListItem.device_type = 11`
  - เพิ่ม `MiotyDevice`: class A/Z, short address, write-only network/application keys, pre-attach, radio flags, application crypto mode
  - Application crypto ที่โครง native รองรับ: 0 = none, 1 = confidentiality, 17 = authenticity

ค่า enum 0 ทำให้ข้อมูลและ clients เดิมยัง default เป็น LoRaWAN

**Generated grpc-web ล่าสุดยังไม่ตรงกับ proto รอบ native**: มี radio flags / application_crypto เพิ่มหลัง UI build ที่ผ่าน ต้อง regenerate อีกครั้ง

### Database / storage

- เพิ่ม migrations ทั้ง PostgreSQL และ SQLite:
  - `chirpstack/migrations_postgres/2026-11-04-000000_add_mioty/{up,down}.sql`
  - `chirpstack/migrations_sqlite/2026-11-04-000000_add_mioty/{up,down}.sql`
- เพิ่ม `gateway.gateway_type` และ `device.device_type` เป็น SMALLINT default 0 พร้อม CHECK
- เพิ่ม table `mioty_device` สำหรับ native endpoint state โดย FK ไป device และ cascade delete:
  - class / short address / network key / application key / network session key
  - application crypto mode / session context (nonce + signature)
  - attach counter / packet counter / pre-attach / attached / radio flags / serving gateway
- แก้ Diesel schemas ทั้งสอง backend และเพิ่ม `chirpstack/src/storage/mioty.rs`
- `storage/mioty.rs` มี CRUD, query ตาม tenant และ conditional UPDATE สำหรับ accept uplink / attach เพื่อกัน duplicate/replay แบบ atomic
- `storage/device_queue.rs` เริ่มอนุญาต FPort 0 สำหรับ Mioty โดยไม่ใช้ LoRaWAN encryption / confirmed flags
- Gateway `get_meta` กรองเฉพาะ LoRaWAN เพื่อไม่เลือก Mioty เป็น LoRaWAN downlink gateway
- LoRaWAN PHY payload lookup กรอง `device_type = 0`

### Backend API / authorization

- `chirpstack/src/api/gateway.rs`
  - เก็บ/คืน gateway type ใน create/get/list
  - ป้องกันเปลี่ยน type ของ gateway ที่สร้างไปแล้ว
  - ใช้ authorization เดิมของ ChirpStack
  - Gateway certificate กลับมาใช้ `certificate::client_cert_for_gateway_id` เดิมแล้ว ไม่เรียก external certificate API
  - ยังมี calls ไป `mioty::create_gateway/update_gateway/delete_gateway` ซึ่ง native module รับไว้เป็น validation / session notification
- `chirpstack/src/api/device.rs`
  - เก็บ/คืน device type และ native endpoint config
  - CRUD เรียก native `mioty` module
  - ป้องกันเปลี่ยน device type และย้าย Mioty ข้าม tenant
  - dispatch queue enqueue/get/flush สำหรับ Mioty
  - ปฏิเสธ LoRaWAN-only key / activation operations สำหรับ Mioty
  - หลัง update เรียก `mioty::device_updated` เพื่อ reconcile gateway state
- `chirpstack/src/integration/mod.rs`
  - MQTT down command ของ Mioty ส่งเข้า `mioty::send_downlink`
  - ใช้ topic / payload application ownership check เดิมก่อน dispatch
  - Mioty down command ปัจจุบันต้อง fPort=0, confirmed=false, ไม่มี expiry / caller-supplied ID
- `chirpstack/src/uplink/join.rs`: ป้องกัน LoRaWAN join สำหรับ Mioty Device
- `chirpstack/src/uplink/stats.rs`: ป้องกัน LoRaWAN stats สำหรับ Mioty Gateway

### Native module ที่มีแล้ว แต่ยังไม่ verify compile

`chirpstack/src/mioty/mod.rs`

- local management wrapper ใช้ `storage::mioty` ไม่เรียก external service
- ตรวจ keys / class / short address / crypto mode
- create/get/update native endpoint settings โดยไม่คืน secrets ผ่าน read API
- native downlink เข้า device queue เดิม พร้อม reject Class Z
- flush ปฏิเสธหากมี pending radio downlink แทนลบ local row แล้วทำเหมือน revoke สำเร็จ
- อ้างถึง `server::start`, `server::disconnect`, `server::reconcile`, `server::detach` ซึ่งยังไม่ได้เขียน

`chirpstack/src/mioty/wire.rs`

- BSSCI framing: magic `MIOTYB01` 8 bytes + payload length LE32 4 bytes
- JSON และ MessagePack โดยรักษา full-range unsigned EUI64
- จำกัด frame size ก่อน allocate
- helpers สำหรับอ่าน field uint/int/bool/byte arrays
- มี unit tests roundtrip / EUI u64::MAX / header / oversized frames แต่ **ยังไม่ได้รัน**

`chirpstack/src/mioty/crypto.rs`

- AES block, truncated AES-CMAC, signature comparison, IV helper, session key derivation
- application encryption/decryption modes 0 / 1 / 17
- มี test vector จาก mioty Application Layer Specification annex 6.4 แต่ **ยังไม่ได้รัน**
- PFS / agnosticity modes ยังไม่ implement อย่าเปิดเป็นตัวเลือกหรืออ้างว่ารองรับครบทุก crypto mode

`chirpstack/src/mioty/uplink.rs`

- ตรวจว่า gateway กับ endpoint อยู่ tenant เดียวกัน / endpoint เป็น Mioty และไม่ disabled
- อ่าน BSSCI ulData, decrypt app payload, เช็ก packet counter, รวม RX info ผ่าน Redis ช่วง deduplication delay
- ส่งต่อ `integration::uplink_event` เดิม → MQTT / Redis event stream / integrations อื่น
- ใส่ tag `protocol=mioty`, FPort=0 และ format/profile/mode ใน RX metadata
- ฟังก์ชัน `receive` คืน endpoint/counter/dlOpen ให้ session engine ใช้ส่ง downlink
- **ยังต้อง review reliability**: counter ถูก advance ก่อนบางขั้นตอนที่อาจ fail จึงอาจสูญเสีย event เมื่อ retry; ควรทำ durable inbox/outbox หรือจัด transaction/acceptance boundary ให้ถูกต้อง

### Config / startup

- `config::Configuration` มี `mioty: Mioty`
- Native config มี enabled, bind, service_center_eui, server_cert, server_key, max_frame_size, max_connections, idle_timeout_secs
- default disabled; bind `0.0.0.0:5000`; SC EUI default zero ต้อง validate เมื่อ enable
- `cmd/root.rs` เรียก `mioty::setup()` หลัง integrations พร้อมแล้ว
- ยังไม่ได้เพิ่ม config template ใน `cmd/configfile.rs` และยังไม่มี example config / deployment docs
- เพิ่ม dependencies ใน `chirpstack/Cargo.toml`: `rmp-serde`, `rmpv`, `tokio-rustls`, `cmac`
- Cargo.lock ปัจจุบันยังมีผลจาก external adapter TLS feature รอบก่อน และยังไม่ได้ resolve native dependencies ใหม่ ตรวจและ regenerate
- ควรตั้ง `tokio-rustls` features ให้สอดคล้องกับ repo ที่ใช้ rustls ring เพื่อไม่ดึง provider ซ้ำโดยไม่ตั้งใจ

### UI

- GatewayForm เลือก LoRaWAN/Mioty, type แก้ไม่ได้หลัง create, ซ่อน LoRaWAN downlink priority เมื่อเป็น Mioty
- ListGateways แสดง gateway type
- GatewayLayout เลือก native Mioty dashboard และซ่อน LoRaWAN frames
- มี `MiotyGatewayDashboard.tsx` แสดง status / last seen / Service Center URL / RX metric / map
- DeviceForm เลือก LoRaWAN/Mioty, class A/Z, short address, pre-attach และ keys
- ListDevices แสดง device type
- DeviceLayout เลือก Mioty dashboard และซ่อน LoRaWAN keys / activation / frames รวมทั้ง guard direct routes
- CreateDevice ไม่ redirect Mioty ไปหน้า OTAA keys
- DeviceQueue ซ่อน LoRaWAN port / confirmed / encrypted / expiry สำหรับ Mioty
- มี `MiotyDeviceDashboard.tsx`
- **UI ยังไม่ตาม native settings รอบล่าสุด**: ต้องเพิ่ม application crypto selector, radio flags และ setters/getters; application key ต้อง optional เมื่อ crypto=0; key fields read เป็นค่าว่างและ update ค่าว่างต้อง preserve
- ปรับถ้อยคำ `Mioty Endpoint` เป็น `Mioty Device` ได้ตามเป้าหมายผู้ใช้ โดย EUI/class ยังอธิบายเป็น endpoint ได้

## 5. Native session engine ที่ตั้งใจทำต่อ

นี่คือแผนที่ยังไม่ได้ implement ไม่ใช่ความสามารถที่สำเร็จแล้ว:

1. สร้าง `chirpstack/src/mioty/server.rs` ให้มี signatures ตาม callers ใน mod.rs
2. ใช้ TLS TCP listener ภายใน process และ mTLS ผ่าน CA ของ gateway เดิม ตรวจว่า peer certificate ผูกกับ Gateway EUI ที่ register แล้วและ gateway_type=MIOTY
3. ผูก certificate กับ stored `gateway.tls_certificate` (certificate ที่ generate จาก ChirpStack) เพื่อป้องกันใช้ cert ของ gateway หนึ่งอ้างเป็นอีก gateway; อย่าเชื่อ bsEui ใน payload อย่างเดียว
4. กำหนด limits: concurrent connections, handshake/read/write deadlines, frame size, pending operation counts
5. อ่าน frame ใน reader task แยก: **อย่า cancel `read_exact` กลาง frame ด้วย select ที่มี heartbeat/control branch** เพราะ framing จะเสีย
6. Implement con → conRsp → conCmp ก่อนอนุญาต operations อื่น; version negotiation 1.0.x; เริ่มด้วย snResume=false ได้ แต่ต้องจัดการ reset/reconcile ของ session ให้ถูกต้อง
7. BS op IDs positive increasing; SC IDs negative decreasing; con opId=0; ตรวจ pending response/completion และรองรับ retransmission อย่าง idempotent
8. ping / pingRsp / pingCmp, status request-response-complete, error / errorAck
9. หลัง conCmp propagate endpoint ที่ attached/pre-attached ของ tenant เดียวกันด้วย attPrp → attPrpRsp → attPrpCmp; reconcile เมื่อ create/update/disable/delete
10. OTA att: ตรวจ signature ด้วย network key, ป้องกัน attach-counter replay, derive network session key, ตอบ attRsp, จบ attCmp แล้ว propagate สู่ gateways อื่นใน tenant
11. ulData: เรียก uplink::receive, ตอบ ulDataRsp และรับ ulDataCmp; เรียก queue dispatch เมื่อ dlOpen=true
12. Native downlink: atomic reserve queue item เดียวต่อ endpoint / receive window, เลือก gateway ที่รับ uplink, ส่ง dlDataQue, ตรวจ response และ dlDataRes, ส่งผลเข้า integration เดิม และ retire/retry queue อย่างถูกต้อง
13. App crypto downlink ต้องใช้ counter ที่ตรง receive window และห้าม reuse counter สำหรับ payload ต่างกัน; set cntDepend และ packetCnt เมื่อจำเป็น
14. อย่าลบ pending queue เพียงเพราะ socket หลุด ต้องกำหนด reconnect/session reset/revoke semantics และจัดเก็บ correlation ระหว่าง local UUID / BSSCI queId / gateway / endpoint
15. อัปเดต gateway online/offline/last_seen และ metadata จาก native session เพื่อให้ dashboard และ counts เดิมทำงาน

## 6. Known gaps / จุดต้อง review ก่อนอ้างว่าเสร็จ

- ไม่มี `server.rs` จึง compile ไม่ผ่านแน่นอน
- Native module ใหม่อาจมี Rust type/API errors อื่น ต้อง compile จริงและแก้จาก diagnostics
- Device และ mioty_device update ยังไม่รวม transaction เดียว; create มี compensating delete แต่ update อาจ partial
- `storage::mioty::update` เป็น full changeset อาจ overwrite counters เมื่อ config update แข่งกับ uplink; ต้องแยก settings changeset กับ runtime state updates
- การเปลี่ยน network key / pre-attach / class ต้องนิยาม session reset และ counter behavior ให้ปลอดภัย
- Atomic accept_uplink เริ่มมี แต่ event delivery กับ counter advancement ยังไม่เป็น durable transaction
- การรวมหลาย gateway / RX metrics / duplicate handling ยังต้อง integration tests
- Gateway CRUD ยังมีชื่อ helper รูปแบบ adapter เก่า แม้ body เป็น native แล้ว ปรับโครงให้ตรง final architecture
- ยังไม่ได้ guard Mioty จาก LoRaWAN multicast / FUOTA API ทั้งหมด; ห้ามส่ง Mioty เข้า LoRaWAN-only radio flows
- LoRaWAN scheduler query ยังต้องตรวจและกรอง device_type=0 โดยเฉพาะ raw SQL
- Device-profile เดิมยังบังคับเลือกอยู่เพื่อใช้ codecs/integrations; ยังไม่ออกแบบ profile สำหรับ Mioty โดยเฉพาะ
- Crypto modes ที่ไม่รองรับต้อง reject ชัดเจน ห้าม silently decrypt ผิดหรือ expose key ใน tags / metadata / logs
- ยังไม่มี certificate/server config ตัวอย่าง, simulator หรือ hardware interoperability tests
- รูปแบบโค้ดยังไม่จัด format ครบ

## 7. ผลตรวจที่ทำไปจริง

ผลต่อไปนี้ **ส่วนใหญ่เป็นก่อน pivot เป็น native** จึงไม่ใช่หลักฐานว่า native backend ผ่าน:

- `npm run type-check --prefix ui` ผ่าน หลัง generate grpc-web และแก้ menu filter ที่เคยไปติด breadcrumb
- `npm run build --prefix ui` ผ่าน (Vite build สำเร็จ มี bundle size warning ของ app)
- `cargo +1.98.1 check -p chirpstack_api` ผ่านก่อนลบ external interoperability proto และก่อนเพิ่ม fields native รอบล่าสุด
- Python in-memory SQLite migration test ผ่านสำหรับสอง type columns: legacy defaults, Mioty values, CHECK invalid values, down migration **ก่อนเพิ่ม table mioty_device**
- Native Windows `cargo check -p chirpstack --no-default-features --features sqlite` ติด dependency `signal-hook-tokio` ที่ต้องใช้ UnixStream — เป็นข้อจำกัด Windows ของ repo ใช้ WSL/Linux build
- `cargo +1.98.1 fmt --all -- --check` ไม่ผ่านเพราะ formatting diffs; หลัง native ยังขาด server.rs ด้วย
- เคยเริ่ม WSL check แต่ session จบ exit 1 ไม่มี final diagnostics ที่ใช้ได้; `/tmp/chirpstack-native-check.log` ไม่อยู่แล้วเมื่อตรวจตอน handover จึง **ไม่มี native backend check ที่ผ่าน**
- Tests ใน wire.rs / crypto.rs / native storage ยังไม่รัน
- ไม่ได้ทดสอบ Gateway/Device จริง

## 8. Environment และคำสั่งที่ใช้ต่อได้

### Windows

- มี Node / npm, protoc 25.3, cargo/rustup, Python 3.13
- `cargo +1.98.1 --version` ใช้งานได้
- repo pin Rust 1.89.0 แต่ initial rustup download ของ 1.89 ล้มเหลว อย่าเสียเวลา sync ซ้ำถ้าใช้ installed 1.98.1 ได้
- Docker CLI มี แต่ Docker Desktop Linux engine ไม่ได้รัน ณ ตอนตรวจ
- `ui/node_modules` ติดตั้งแล้วด้วย `npm install --ignore-scripts --package-lock=false --legacy-peer-deps`
  ต้องใช้ legacy-peer-deps เพราะ upstream eslint 10 กับ eslint-plugin-react peer range ขัดกัน ไม่ได้แก้ package versions ของ repo
- `api/grpc-web/node_modules` ติดตั้งแล้ว และมี `protoc-gen-grpc-web` ที่ลง `--no-save --package-lock=false` เพื่อ generate บน Windows

ตัวอย่าง regenerate เฉพาะ device proto บน PowerShell (ใช้ **absolute paths ทั้ง input และ include**):

```powershell
$protoRoot = (Resolve-Path api/proto).Path
$grpcPlugin = (Resolve-Path api/grpc-web/node_modules/protoc-gen-grpc-web/bin/protoc-gen-grpc-web.exe).Path
$deviceProto = (Resolve-Path api/proto/api/device.proto).Path
& api/grpc-web/node_modules/grpc-tools/bin/protoc.exe "-I=$protoRoot" --js_out=import_style=commonjs:api/grpc-web --plugin="protoc-gen-grpc-web=$grpcPlugin" --grpc-web_out=import_style=commonjs+dts,mode=grpcwebtext:api/grpc-web $deviceProto
npm run type-check --prefix ui
npm run build --prefix ui
```

ถ้าต้อง generate ทั้งหมด ให้ loop proto ใน api/common/gw/integration/google/api ตาม Makefile เดิม และตรวจ exit code ทุกครั้ง

การเตรียม Rust proto ต้องทำตาม `api/rust/Makefile` ซึ่งวาง google protos แยกใน `proto/google/google/...` อย่า copy wildcard จนได้ duplicate google tree อีก

### WSL

- distro `Ubuntu-26.04`; workspace path `/mnt/c/Users/meawk/Desktop/chirpstack`
- ตรวจพบ `/root/.cargo/bin/cargo +1.98.1` ใช้งานได้
- รัน apt install dependencies สำหรับ build ไปแล้ว: build-essential, pkg-config, libssl-dev, libpq-dev, libsqlite3-dev, protobuf-compiler, cmake, clang, curl, ca-certificates; ตรวจสถานะจริงอีกครั้ง
- แนะนำ target directory ใน Linux filesystem เพื่อความเร็ว; เก็บ log ใน workspace ที่ ignore แทน /tmp หากต้องการให้อ่านข้าม session ได้

```powershell
wsl -d Ubuntu-26.04 -u root -- bash -lc 'cd /mnt/c/Users/meawk/Desktop/chirpstack && CARGO_TARGET_DIR=/root/chirpstack-target /root/.cargo/bin/cargo +1.98.1 check -p chirpstack --no-default-features --features sqlite'
```

เมื่อ build ผ่าน ให้ตรวจทั้ง postgres/sqlite และรัน tests ที่เหมาะสมกับ native protocol, tenant isolation, migrations, queue lifecycle และ LoRaWAN regression

## 9. Primary specifications ที่อ่านแล้ว

ใช้มาตรฐานเป็น reference สำหรับ native implementation โดยไม่ผูก runtime หรือ copy service implementation จากระบบภายนอก:

- BSSCI 1.0.0 rev1:
  https://developers.mioty-alliance.com/wp-content/uploads/2025/01/BSSCI_specification_v1.0.0_rev1.pdf
- Application Layer 1.1.0 (รวม annex test vectors):
  https://mioty-alliance.com/wp-content/uploads/2026/07/MIOTY_Application_Layer_Specification_v1.1.0.pdf
- Developer architecture overview:
  https://developers.mioty-alliance.com/explore/
- MAC and higher layers:
  https://mioty-alliance.com/wp-content/uploads/2025/07/public_Mioty-Mac_and_Higher_Layers.pdf

## 10. ลำดับเริ่มงานต่อที่แนะนำ

1. อ่านข้อกำหนดล่าสุดและ git diff ก่อน อย่าถือว่า native implementation พร้อมใช้
2. ตัดสินใจรายละเอียด native session / persistence จากสเปก แล้วเขียน server.rs ให้ครบเส้นทาง Gateway + Device + uplink/downlink
3. แก้ transaction/counter/queue/security gaps ข้างต้น พร้อม meaningful protocol tests และ simulator
4. ทำ UI ให้ตรง proto ใหม่ และ regenerate clients
5. เพิ่ม config example / TLS provisioning guide / ขอบเขต feature ที่รองรับจริง
6. Build/test บน Linux ทั้ง DB backends และตรวจ LoRaWAN regression
7. ขอข้อมูลยี่ห้อ/รุ่น/firmware Gateway และอุปกรณ์จากผู้ใช้เมื่อต้องทดสอบ interoperability จริง ไม่ต้องขออนุมัติซ้ำสำหรับงานพัฒนาที่ผู้ใช้สั่งไว้แล้ว

อย่า deploy หรืออ้างว่า production-ready ก่อนผ่านการทดสอบ native และ hardware ที่จำเป็น
