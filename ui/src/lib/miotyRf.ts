// Exact-integer helpers for the mioty regional RF policy (GatewayService
// GetMiotyRfConfig / UpdateMiotyRfConfig).
//
// The API carries frequencies as integer Hz and power values as integer
// milli-units. Operators type MHz / kHz / dB decimals. Every conversion here is
// done on the decimal string, never through binary floating point, so that
// e.g. "920.1" is exactly 920100000 Hz and "14.7" dBm is exactly 14700 mdBm.
//
// The validation mirrors chirpstack/src/mioty/rf.rs. It exists to give the
// operator immediate feedback; the backend remains the authority and repeats
// every check. Nothing in this file can enable transmission.

export const MAX_CHANNELS = 128;

const UINT32_MAX = 4294967295;
const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

export type ParseResult = { ok: true; value: number } | { ok: false; error: string };

function parseScaledDecimal(
  input: string,
  fractionDigits: number,
  opts: { allowNegative: boolean; unit: string; resolution: string },
): ParseResult {
  const text = input.trim();
  if (text === "") {
    return { ok: false, error: "A value is required." };
  }

  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) {
    return { ok: false, error: `Enter a plain decimal number in ${opts.unit}.` };
  }

  const negative = m[1] === "-";
  if (negative && !opts.allowNegative) {
    return { ok: false, error: "The value must not be negative." };
  }

  const whole = m[2].replace(/^0+(?=\d)/, "");
  const fraction = m[3] ?? "";
  if (fraction.length > fractionDigits && /[1-9]/.test(fraction.slice(fractionDigits))) {
    return { ok: false, error: `The finest supported resolution is ${opts.resolution}.` };
  }
  // 10 digits of whole part already exceeds every range accepted below.
  if (whole.length > 10) {
    return { ok: false, error: "The value is out of range." };
  }

  const scaled = whole + fraction.slice(0, fractionDigits).padEnd(fractionDigits, "0");
  // At most 16 significant digits: exactly representable as a JS integer.
  const magnitude = Number(scaled);
  if (!Number.isSafeInteger(magnitude)) {
    return { ok: false, error: "The value is out of range." };
  }

  return { ok: true, value: negative && magnitude !== 0 ? -magnitude : magnitude };
}

function formatScaled(value: number, fractionDigits: number, minFractionDigits: number): string {
  const negative = value < 0;
  const digits = Math.abs(value).toString().padStart(fractionDigits + 1, "0");
  const whole = digits.slice(0, digits.length - fractionDigits);
  let fraction = digits.slice(digits.length - fractionDigits);
  while (fraction.length > minFractionDigits && fraction.endsWith("0")) {
    fraction = fraction.slice(0, -1);
  }
  return `${negative ? "-" : ""}${whole}${fraction.length > 0 ? "." + fraction : ""}`;
}

/** "920.1" (MHz) -> 920100000 (Hz). Rejects anything finer than 1 Hz. */
export function parseMhzToHz(input: string): ParseResult {
  const r = parseScaledDecimal(input, 6, { allowNegative: false, unit: "MHz", resolution: "1 Hz (0.000001 MHz)" });
  if (r.ok && r.value > UINT32_MAX) {
    return { ok: false, error: "The value is out of range." };
  }
  return r;
}

/** "200" (kHz) -> 200000 (Hz). Rejects anything finer than 1 Hz. */
export function parseKhzToHz(input: string): ParseResult {
  const r = parseScaledDecimal(input, 3, { allowNegative: false, unit: "kHz", resolution: "1 Hz (0.001 kHz)" });
  if (r.ok && r.value > UINT32_MAX) {
    return { ok: false, error: "The value is out of range." };
  }
  return r;
}

/** 920100000 -> "920.100". Always exact; at least kHz precision is shown. */
export function formatHzAsMhz(hz: number): string {
  return formatScaled(hz, 6, 3);
}

/** 200000 -> "200". Always exact. */
export function formatHzAsKhz(hz: number): string {
  return formatScaled(hz, 3, 0);
}

/**
 * Format a frequency expressed in half-Hz units (2 x Hz). Channel edges are
 * center +/- width/2, which is a half-integer for odd widths.
 */
export function formatHalfHzAsMhz(twiceHz: number): string {
  // twiceHz * 5 is the frequency in units of 0.1 Hz, i.e. 7 fraction digits of MHz.
  return formatScaled(twiceHz * 5, 7, 3);
}

/** "14.7" (dBm / dBi / dB) -> 14700 (milli-units). */
export function parseMilliUnits(input: string, kind: "int32" | "uint32"): ParseResult {
  const r = parseScaledDecimal(input, 3, {
    allowNegative: kind === "int32",
    unit: "dB",
    resolution: "0.001 dB",
  });
  if (!r.ok) {
    return r;
  }
  if (kind === "int32" && (r.value > INT32_MAX || r.value < INT32_MIN)) {
    return { ok: false, error: "The value is out of range." };
  }
  if (kind === "uint32" && r.value > UINT32_MAX) {
    return { ok: false, error: "The value is out of range." };
  }
  return r;
}

/** 14700 -> "14.7". Always exact. */
export function formatMilliUnits(value: number): string {
  return formatScaled(value, 3, 1);
}

export interface Band {
  minHz: number;
  maxHz: number;
}

export interface Channel {
  centerHz: number;
  occupiedBandwidthHz: number;
}

/** Channel edges in half-Hz units, so that odd bandwidths stay exact. */
export function channelEdgesTwiceHz(ch: Channel): { lower: number; upper: number } {
  return {
    lower: 2 * ch.centerHz - ch.occupiedBandwidthHz,
    upper: 2 * ch.centerHz + ch.occupiedBandwidthHz,
  };
}

/**
 * Validates the complete occupied envelope (center +/- width/2) against the
 * band reported by the backend. Returns an error message or undefined.
 */
export function validateChannel(ch: Channel, band: Band): string | undefined {
  if (!Number.isSafeInteger(ch.centerHz) || !Number.isSafeInteger(ch.occupiedBandwidthHz)) {
    return "Frequencies must be whole numbers of Hz.";
  }
  if (ch.occupiedBandwidthHz <= 0) {
    return "The occupied bandwidth must be greater than zero.";
  }

  const edges = channelEdgesTwiceHz(ch);
  const bandText = `${formatHzAsMhz(band.minHz)}–${formatHzAsMhz(band.maxHz)} MHz`;
  if (edges.lower < 2 * band.minHz) {
    return `The lower edge of the occupied bandwidth (${formatHalfHzAsMhz(edges.lower)} MHz) is below the ${bandText} band.`;
  }
  if (edges.upper > 2 * band.maxHz) {
    return `The upper edge of the occupied bandwidth (${formatHalfHzAsMhz(edges.upper)} MHz) is above the ${bandText} band.`;
  }
  return undefined;
}

/**
 * Validates a channel list. The returned array has one entry per channel
 * (undefined = valid); `list` carries errors that concern the list as a whole.
 */
export function validateChannels(channels: Channel[], band: Band): { perChannel: (string | undefined)[]; list?: string } {
  const seen = new Set<number>();
  const perChannel = channels.map(ch => {
    const err = validateChannel(ch, band);
    if (err) {
      return err;
    }
    if (seen.has(ch.centerHz)) {
      return "This center frequency is already used by another channel.";
    }
    seen.add(ch.centerHz);
    return undefined;
  });

  return {
    perChannel,
    list: channels.length > MAX_CHANNELS ? `At most ${MAX_CHANNELS} channels can be configured.` : undefined,
  };
}

export interface PowerBudget {
  conductedPowerMdbm?: number;
  antennaGainMdbi?: number;
  cableLossMdb?: number;
  maxEirpMdbm?: number;
}

/** conducted + antenna gain - cable loss, or undefined while any input is absent. */
export function eirpMdbm(p: PowerBudget): number | undefined {
  if (p.conductedPowerMdbm === undefined || p.antennaGainMdbi === undefined || p.cableLossMdb === undefined) {
    return undefined;
  }
  return p.conductedPowerMdbm + p.antennaGainMdbi - p.cableLossMdb;
}

/** Error message when a complete power budget exceeds the operator ceiling. */
export function validatePowerBudget(p: PowerBudget): string | undefined {
  const eirp = eirpMdbm(p);
  if (eirp !== undefined && p.maxEirpMdbm !== undefined && eirp > p.maxEirpMdbm) {
    return `The calculated EIRP (${formatMilliUnits(eirp)} dBm) exceeds the configured ceiling (${formatMilliUnits(p.maxEirpMdbm)} dBm).`;
  }
  return undefined;
}
