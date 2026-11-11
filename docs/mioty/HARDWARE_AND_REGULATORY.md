# Thailand profile: evidence and unresolved requirements

Checked 11 November 2026. `TH920_925` is a custom experimental policy, not an
Alliance regional profile or an equipment authorization. No real RF transmission
is required or performed by the automated tests.

## Hardware

| Hardware/path | Verified scope | Thailand status |
| --- | --- | --- |
| Miromico miro EdgeCard mioty | Vendor documents a self-contained Base Station, BSSCI and TLS/mTLS via a USB network link. | No verified TH920_925 firmware, RF front-end range or endpoint interoperability. |
| RAK WisGate Connect + mioty EdgeCard | ConnectOS configures the card's Base Station destination, certificates and profile; Service Center mode is a separate card operating mode. | Host support does not establish a supported Thailand radio profile. |
| SDR/miotyGO | Development BSSCI uplink peer; restrictions are described in ARCHITECTURE.md. | SDR tuning range alone does not validate waveform, MAC, emissions, licensing or end-device support. |
| Other BSSCI Base Stations | Native interface is independent of hardware drivers. | Require a firmware-specific capability/configuration adapter and interoperability tests. |
| SX1302/SX1303, RAK5146, WM1302 LoRaWAN concentrators | No mioty demodulator is implemented by this fork. | No direct mioty/telegram-splitting support claimed. |

Primary references: [Miromico card documentation](https://docs.miromico.ch/gateways-cards/miro-edgecard-mioty/),
[RAK ConnectOS mioty guide](https://docs.rakwireless.com/product-categories/software-apis-and-libraries/connectos/mioty/),
[RAK 868 MHz card listing](https://store.rakwireless.com/products/miro-edgecard-mioty-868-mhz).
The last listing is expressly an 868 MHz product; it provides no evidence of
Thailand operation. No hardware purchase or retuning recommendation is made.

## NBTC evidence

The [official standards index](https://standard.nbtc.go.th/Standards/มาตรฐานทางเทคนิคของเครื่องโทรคมนาคม.aspx)
still lists NBTC TS 1033-2560 for IoT. Its linked file is named `1033-2565.pdf.aspx`,
but the [document contents](https://standard.nbtc.go.th/getattachment/Standards/มาตรฐานทางเทคนิคของเครื่องโทรคมนาคม/1033-2565.pdf.aspx?lang=th-TH)
identify TS 1033-2560, published 24 November 2017. It addresses non-RFID
920–925 MHz devices. Sections 2.1–2.3 specify a 4 W EIRP ceiling, unwanted-emission
alternatives, and spectrum access. The duty-cycle route uses a one-hour window
and bandwidth up to 500 kHz: below 50 mW, 1%; above 50 mW through 4 W, 10%.
The separate FHSS route has channel-count, bandwidth, dwell-time and occupancy
requirements. Do not assume TSMA qualifies as FHSS. Section 3 distinguishes
SDoC up to 50 mW and Class A above 50 mW through 4 W. The document also requires
electrical and radiation safety compliance. This is not a universal permission
to transmit at 4 W, nor a mioty waveform certification.

The current [NBTC Class A service page](https://standard.nbtc.go.th/บริการออนไลน์/ClassA.aspx)
also identifies 1033-2560 for IoT gateways. TS 1010-2560 is the separately listed
RFID standard and must not be silently substituted for a non-RFID mioty device.

## Required before implementing TX

Obtain and review the applicable band-use authorization notice referenced by the
technical standard, current amendments, installation/import/operation permissions,
and the precise equipment approval route for the chosen gateway and endpoint.
This milestone has not established that the index exhausts all current notices.

A qualified review must resolve the exact-50-mW duty-cycle boundary, whether
mioty bursts use the duty-cycle or FHSS route, bandwidth measurement of the complete
telegram envelope versus individual bursts, applicable emission masks and test
methods, and duty-cycle enforcement for autonomous firmware responses. Do not
apply the preliminary table directly as a radio scheduler configuration.

Separately require vendor-approved frequency plan, modulation/TSMA parameters,
occupied bandwidth including frequency error, conducted power range, antenna gain,
cable loss, calibrated front-end support, firmware configuration readback, and
endpoint agreement. Test actual BSSCI interoperability and RF emissions. No
current backend field can attest to these validations or bypass the TX block.

The software validates supplied occupied envelopes and operator power ceilings;
it does not measure RF, apply a band plan to hardware, enforce a verified NBTC
airtime scheduler, or claim regulatory compliance. Keep channels and power
explicitly unconfigured until authoritative parameters are available.
