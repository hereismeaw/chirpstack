// Interpretation of the gateway properties the native mioty listener stores
// for a Base Station (chirpstack/src/mioty/server.rs). All values are optional:
// they exist only after the Base Station has connected, and the descriptive
// ones are self-reported in its BSSCI connect message.

export interface BaseStationInfo {
  /** "online" / "offline" as last written by the listener. */
  status?: string;
  bidirectional?: boolean;
  vendor?: string;
  model?: string;
  name?: string;
  softwareVersion?: string;
  bssciVersion?: string;
  sessionResumed?: boolean;
}

function bool(v: string | undefined): boolean | undefined {
  if (v === "true") {
    return true;
  }
  if (v === "false") {
    return false;
  }
  return undefined;
}

function text(v: string | undefined): string | undefined {
  return v !== undefined && v !== "" ? v : undefined;
}

/** Accepts the `[key, value][]` form produced by jspb map `toObject()`. */
export function baseStationInfo(properties: [string, string][]): BaseStationInfo {
  const p = new Map(properties);
  return {
    status: text(p.get("mioty_status")),
    bidirectional: bool(p.get("mioty_bidi")),
    vendor: text(p.get("mioty_vendor")),
    model: text(p.get("mioty_model")),
    name: text(p.get("mioty_name")),
    softwareVersion: text(p.get("mioty_sw_version")),
    bssciVersion: text(p.get("mioty_bssci_version")),
    sessionResumed: bool(p.get("mioty_session_resumed")),
  };
}
