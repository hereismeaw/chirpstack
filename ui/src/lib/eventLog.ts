// Interpretation of the device event stream (InternalService.StreamDeviceEvents).
//
// Each LogItem carries the integration event as protobuf-JSON in `body`. This
// module only reads fields the backend actually emits; anything absent is
// reported as undefined so the UI can render an explicit "not reported" state.

import type { Protocol } from "./protocol";

export const MAX_BODY_BYTES = 1024 * 1024;

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Parses an event body. Never throws; oversized or invalid input yields undefined. */
export function parseBody(body: string | null | undefined): Json | undefined {
  if (!body || body.length > MAX_BODY_BYTES) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Decodes standard base64 into a lowercase hex string. Invalid input yields undefined. */
export function base64ToHex(b64: unknown): string | undefined {
  if (typeof b64 !== "string") {
    return undefined;
  }
  if (b64 === "") {
    return "";
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    return undefined;
  }
  try {
    const bin = atob(b64);
    let out = "";
    for (let i = 0; i < bin.length; i++) {
      out += bin.charCodeAt(i).toString(16).padStart(2, "0");
    }
    return out;
  } catch {
    return undefined;
  }
}

/** "0a1b2c" -> "0a 1b 2c", 16 bytes per line. */
export function formatHexDump(hex: string): string {
  const bytes = hex.match(/.{1,2}/g) ?? [];
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push(bytes.slice(i, i + 16).join(" "));
  }
  return lines.join("\n");
}

/**
 * Protocol of a device event. Native mioty events carry a typed `mioty`
 * message; events persisted by the earlier preview only carry the
 * `deviceInfo.tags.protocol=mioty` tag. Everything else on this stream is LoRaWAN.
 */
export function eventProtocol(body: Json | undefined): Protocol {
  if (!body) {
    return "lorawan";
  }
  if (isObject(body.mioty)) {
    return "mioty";
  }
  const info = body.deviceInfo;
  if (isObject(info) && isObject(info.tags) && info.tags.protocol === "mioty") {
    return "mioty";
  }
  return "lorawan";
}

export interface RxView {
  gatewayId?: string;
  rssi?: number;
  snr?: number;
  time?: string;
  /** Regional profile selected as desired policy on the Base Station (not measured RF). */
  regionalProfile?: string;
  regionalProfileSource?: string;
  /** Values reported by the Base Station itself. */
  reportedProfile?: string;
  reportedMode?: string;
  eqSnr?: string;
  rxDuration?: string;
}

export interface EventView {
  protocol: Protocol;
  devEui?: string;
  deviceName?: string;
  time?: string;
  deduplicationId?: string;
  gatewayIds: string[];
  rx: RxView[];
  /** Application payload after decryption, hex. */
  dataHex?: string;
  /** Decoded object produced by the device-profile codec. */
  object?: unknown;
  /** Frequency in Hz, only when the backend reported a non-zero value. */
  frequencyHz?: number;
  mioty?: {
    packetCounter?: number;
    applicationFormat?: number;
    /** BSSCI userData before application decryption, hex. */
    rawUserDataHex?: string;
    /** True for events stored before typed mioty fields existed. */
    legacy: boolean;
  };
  lorawan?: {
    fCnt?: number;
    fPort?: number;
    dr?: number;
    devAddr?: string;
  };
  log?: {
    level?: string;
    code?: string;
    description?: string;
    context?: Record<string, string>;
  };
}

function rxView(entry: unknown, protocol: Protocol): RxView | undefined {
  if (!isObject(entry)) {
    return undefined;
  }
  const md = isObject(entry.metadata) ? entry.metadata : {};
  // protobuf-JSON omits zero values. For native mioty receptions the backend
  // rejects uplinks without RSSI/SNR, so an omitted value is a reported zero.
  const zeroIfOmitted = protocol === "mioty" ? 0 : undefined;
  return {
    gatewayId: str(entry.gatewayId),
    rssi: num(entry.rssi) ?? zeroIfOmitted,
    snr: num(entry.snr) ?? zeroIfOmitted,
    time: str(entry.gwTime) ?? str(entry.nsTime),
    regionalProfile: str(md.regional_profile),
    regionalProfileSource: str(md.regional_profile_source),
    reportedProfile: str(md.profile),
    reportedMode: str(md.mode),
    eqSnr: str(md.eqSnr),
    rxDuration: str(md.rxDuration),
  };
}

/** Builds the protocol-aware summary of one event from its JSON body. */
export function eventView(body: Json | undefined): EventView {
  const protocol = eventProtocol(body);
  const view: EventView = { protocol, gatewayIds: [], rx: [] };
  if (!body) {
    return view;
  }

  const info = isObject(body.deviceInfo) ? body.deviceInfo : {};
  view.devEui = str(info.devEui);
  view.deviceName = str(info.deviceName);
  view.time = str(body.time);
  view.deduplicationId = str(body.deduplicationId);
  view.dataHex = base64ToHex(body.data);
  view.object = body.object;

  if (Array.isArray(body.rxInfo)) {
    view.rx = body.rxInfo.map(e => rxView(e, protocol)).filter((e): e is RxView => e !== undefined);
  }
  const ids = view.rx.map(r => r.gatewayId).filter((id): id is string => id !== undefined);
  // txack / other events reference a single gateway.
  const single = str(body.gatewayId);
  if (single) {
    ids.push(single);
  }
  view.gatewayIds = Array.from(new Set(ids));

  const txInfo = isObject(body.txInfo) ? body.txInfo : {};
  const frequency = num(txInfo.frequency);
  if (frequency !== undefined && frequency > 0) {
    view.frequencyHz = frequency;
  }

  if (protocol === "mioty") {
    const m = isObject(body.mioty) ? body.mioty : undefined;
    view.mioty = {
      packetCounter: m ? (num(m.packetCounter) ?? 0) : undefined,
      applicationFormat: m ? (num(m.applicationFormat) ?? 0) : undefined,
      rawUserDataHex: m ? base64ToHex(m.rawUserData) : undefined,
      legacy: m === undefined,
    };
  } else {
    view.lorawan = {
      fCnt: num(body.fCnt),
      fPort: num(body.fPort),
      dr: num(body.dr),
      devAddr: str(body.devAddr),
    };
  }

  if (str(body.level) || str(body.code) || str(body.description)) {
    const context: Record<string, string> = {};
    if (isObject(body.context)) {
      for (const [k, v] of Object.entries(body.context)) {
        if (typeof v === "string") {
          context[k] = v;
        }
      }
    }
    view.log = {
      level: str(body.level),
      code: str(body.code),
      description: str(body.description),
      context,
    };
  }

  return view;
}

export interface EventFilter {
  protocol?: Protocol;
  types?: string[];
  gatewayId?: string;
}

export function matchesFilter(type: string, view: EventView, f: EventFilter): boolean {
  if (f.protocol && view.protocol !== f.protocol) {
    return false;
  }
  if (f.types && f.types.length > 0 && !f.types.includes(type)) {
    return false;
  }
  if (f.gatewayId && !view.gatewayIds.includes(f.gatewayId)) {
    return false;
  }
  return true;
}
