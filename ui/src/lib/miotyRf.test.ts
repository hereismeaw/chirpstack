import { describe, expect, it } from "vitest";

import {
  MAX_CHANNELS,
  channelEdgesTwiceHz,
  eirpMdbm,
  formatHalfHzAsMhz,
  formatHzAsKhz,
  formatHzAsMhz,
  formatMilliUnits,
  parseKhzToHz,
  parseMhzToHz,
  parseMilliUnits,
  validateChannel,
  validateChannels,
  validatePowerBudget,
} from "./miotyRf";

// Band as reported by GetMiotyRfConfigResponse for TH920_925.
const TH = { minHz: 920_000_000, maxHz: 925_000_000 };

describe("MHz / kHz <-> Hz conversion", () => {
  it("converts decimal MHz to exact integer Hz", () => {
    expect(parseMhzToHz("920")).toEqual({ ok: true, value: 920_000_000 });
    expect(parseMhzToHz("920.1")).toEqual({ ok: true, value: 920_100_000 });
    expect(parseMhzToHz("922.500001")).toEqual({ ok: true, value: 922_500_001 });
    expect(parseMhzToHz(" 924.999999 ")).toEqual({ ok: true, value: 924_999_999 });
    expect(parseMhzToHz("0920.1000000")).toEqual({ ok: true, value: 920_100_000 });
  });

  it("is not affected by binary floating point", () => {
    // Naive scaling is inexact for these inputs: 1.001 * 1000 === 1000.9999999999999
    // and 1.005 * 1000 === 1004.9999999999999 in IEEE-754.
    expect(1.001 * 1000).not.toBe(1001);
    expect(parseKhzToHz("1.001")).toEqual({ ok: true, value: 1_001 });
    expect(parseKhzToHz("1.005")).toEqual({ ok: true, value: 1_005 });
    expect(parseMilliUnits("1.001", "int32")).toEqual({ ok: true, value: 1_001 });
    expect(parseMilliUnits("1.003", "int32")).toEqual({ ok: true, value: 1_003 });
    expect(parseMhzToHz("921.299999")).toEqual({ ok: true, value: 921_299_999 });
  });

  it("round-trips every tested Hz value exactly", () => {
    for (const hz of [920_000_000, 920_000_001, 920_100_000, 922_499_999, 923_700_000, 925_000_000]) {
      const r = parseMhzToHz(formatHzAsMhz(hz));
      expect(r).toEqual({ ok: true, value: hz });
    }
  });

  it("rejects sub-Hz resolution instead of rounding", () => {
    expect(parseMhzToHz("920.0000001").ok).toBe(false);
    expect(parseKhzToHz("200.0001").ok).toBe(false);
  });

  it("rejects non-decimal input", () => {
    for (const bad of ["", " ", "abc", "920,1", "9.2e2", "0x1", "920.", ".5", "-920", "NaN", "Infinity"]) {
      expect(parseMhzToHz(bad).ok, bad).toBe(false);
    }
  });

  it("rejects values that do not fit the uint32 API field", () => {
    expect(parseMhzToHz("4294.967295")).toEqual({ ok: true, value: 4_294_967_295 });
    expect(parseMhzToHz("4294.967296").ok).toBe(false);
    expect(parseMhzToHz("99999999999999999999").ok).toBe(false);
  });

  it("converts kHz to Hz", () => {
    expect(parseKhzToHz("200")).toEqual({ ok: true, value: 200_000 });
    expect(parseKhzToHz("0.001")).toEqual({ ok: true, value: 1 });
    expect(parseKhzToHz("100.5")).toEqual({ ok: true, value: 100_500 });
  });

  it("formats Hz for display", () => {
    expect(formatHzAsMhz(920_000_000)).toBe("920.000");
    expect(formatHzAsMhz(920_100_000)).toBe("920.100");
    expect(formatHzAsMhz(922_500_001)).toBe("922.500001");
    expect(formatHzAsKhz(200_000)).toBe("200");
    expect(formatHzAsKhz(100_500)).toBe("100.5");
    expect(formatHzAsKhz(1)).toBe("0.001");
  });

  it("formats half-Hz channel edges", () => {
    expect(formatHalfHzAsMhz(2 * 920_000_000)).toBe("920.000");
    expect(formatHalfHzAsMhz(2 * 920_000_000 + 1)).toBe("920.0000005");
    expect(formatHalfHzAsMhz(2 * 924_999_999 + 1)).toBe("924.9999995");
  });
});

describe("TH920_925 occupied-envelope validation", () => {
  // Same table as chirpstack/src/mioty/rf.rs validates_entire_envelope_including_half_hz_edges.
  const cases: [number, number, boolean][] = [
    [TH.minHz, 1, false],
    [TH.minHz + 1, 2, true],
    [TH.minHz + 1, 3, false],
    [TH.maxHz - 1, 2, true],
    [TH.maxHz - 1, 3, false],
    [TH.maxHz, 1, false],
    [922_500_000, 5_000_000, true],
    [922_500_000, 5_000_001, false],
    [4_294_967_295, 4_294_967_295, false],
    [0, 4_294_967_295, false],
    [922_500_000, 0, false],
  ];

  it.each(cases)("center %i Hz, width %i Hz -> valid=%s (matches backend)", (centerHz, occupiedBandwidthHz, valid) => {
    expect(validateChannel({ centerHz, occupiedBandwidthHz }, TH) === undefined).toBe(valid);
  });

  it("rejects a center inside the band whose occupied bandwidth crosses the lower edge", () => {
    const err = validateChannel({ centerHz: 920_050_000, occupiedBandwidthHz: 200_000 }, TH);
    expect(err).toContain("lower edge");
    expect(err).toContain("919.950");
    expect(err).toContain("920.000–925.000 MHz");
  });

  it("rejects a center inside the band whose occupied bandwidth crosses the upper edge", () => {
    const err = validateChannel({ centerHz: 924_950_000, occupiedBandwidthHz: 200_000 }, TH);
    expect(err).toContain("upper edge");
    expect(err).toContain("925.050");
  });

  it("accepts a channel that touches both edges exactly", () => {
    expect(validateChannel({ centerHz: 920_100_000, occupiedBandwidthHz: 200_000 }, TH)).toBeUndefined();
    expect(validateChannel({ centerHz: 924_900_000, occupiedBandwidthHz: 200_000 }, TH)).toBeUndefined();
  });

  it("rejects centers outside the band regardless of bandwidth", () => {
    expect(validateChannel({ centerHz: 919_999_999, occupiedBandwidthHz: 1 }, TH)).toBeDefined();
    expect(validateChannel({ centerHz: 925_000_001, occupiedBandwidthHz: 1 }, TH)).toBeDefined();
    // LoRaWAN AS923 default channels are outside or at the edge of what fits here; no AS923 assumption is made.
    expect(validateChannel({ centerHz: 923_200_000, occupiedBandwidthHz: 125_000 }, TH)).toBeUndefined();
    expect(validateChannel({ centerHz: 925_000_000, occupiedBandwidthHz: 125_000 }, TH)).toBeDefined();
  });

  it("rejects non-integer Hz", () => {
    expect(validateChannel({ centerHz: 922_500_000.5, occupiedBandwidthHz: 100 }, TH)).toBeDefined();
    expect(validateChannel({ centerHz: Number.NaN, occupiedBandwidthHz: 100 }, TH)).toBeDefined();
  });

  it("computes edges in half-Hz units", () => {
    expect(channelEdgesTwiceHz({ centerHz: 922_500_000, occupiedBandwidthHz: 3 })).toEqual({
      lower: 1_844_999_997,
      upper: 1_845_000_003,
    });
  });

  it("flags duplicate centers on the later channel only", () => {
    const r = validateChannels(
      [
        { centerHz: 921_000_000, occupiedBandwidthHz: 100_000 },
        { centerHz: 922_000_000, occupiedBandwidthHz: 100_000 },
        { centerHz: 921_000_000, occupiedBandwidthHz: 50_000 },
      ],
      TH,
    );
    expect(r.perChannel[0]).toBeUndefined();
    expect(r.perChannel[1]).toBeUndefined();
    expect(r.perChannel[2]).toContain("already used");
    expect(r.list).toBeUndefined();
  });

  it("enforces the 128 channel limit", () => {
    const channels = Array.from({ length: MAX_CHANNELS + 1 }, (_, i) => ({
      centerHz: 920_100_000 + i * 10_000,
      occupiedBandwidthHz: 1_000,
    }));
    expect(validateChannels(channels, TH).list).toContain("128");
    expect(validateChannels(channels.slice(0, MAX_CHANNELS), TH).list).toBeUndefined();
  });

  it("accepts an empty channel list (unconfigured receive-only policy)", () => {
    expect(validateChannels([], TH)).toEqual({ perChannel: [], list: undefined });
  });
});

describe("power budget", () => {
  it("parses dB decimals into exact milli-units", () => {
    expect(parseMilliUnits("14.7", "int32")).toEqual({ ok: true, value: 14_700 });
    expect(parseMilliUnits("-3.125", "int32")).toEqual({ ok: true, value: -3_125 });
    expect(parseMilliUnits("0", "int32")).toEqual({ ok: true, value: 0 });
    expect(parseMilliUnits("-0", "int32")).toEqual({ ok: true, value: 0 });
    expect(parseMilliUnits("2.15", "uint32")).toEqual({ ok: true, value: 2_150 });
    expect(formatMilliUnits(14_700)).toBe("14.7");
    expect(formatMilliUnits(-3_125)).toBe("-3.125");
    expect(formatMilliUnits(0)).toBe("0.0");
    expect(formatMilliUnits(-500)).toBe("-0.5");
  });

  it("rejects negative cable loss, sub-milli resolution and out-of-range values", () => {
    expect(parseMilliUnits("-1", "uint32").ok).toBe(false);
    expect(parseMilliUnits("1.0001", "int32").ok).toBe(false);
    expect(parseMilliUnits("2147483.648", "int32").ok).toBe(false);
    expect(parseMilliUnits("2147483.647", "int32")).toEqual({ ok: true, value: 2_147_483_647 });
    expect(parseMilliUnits("-2147483.648", "int32")).toEqual({ ok: true, value: -2_147_483_648 });
    expect(parseMilliUnits("", "int32").ok).toBe(false);
  });

  it("calculates EIRP only when all three inputs are present", () => {
    expect(eirpMdbm({ conductedPowerMdbm: 14_000, antennaGainMdbi: 2_150, cableLossMdb: 500 })).toBe(15_650);
    expect(eirpMdbm({ conductedPowerMdbm: 14_000, antennaGainMdbi: 2_150 })).toBeUndefined();
    expect(eirpMdbm({ conductedPowerMdbm: 0, antennaGainMdbi: 0, cableLossMdb: 0 })).toBe(0);
    expect(eirpMdbm({})).toBeUndefined();
  });

  it("compares EIRP with the ceiling exactly at the boundary", () => {
    const base = { conductedPowerMdbm: 14_000, antennaGainMdbi: 2_150, cableLossMdb: 500 };
    expect(validatePowerBudget({ ...base, maxEirpMdbm: 15_650 })).toBeUndefined();
    expect(validatePowerBudget({ ...base, maxEirpMdbm: 15_649 })).toContain("exceeds");
    expect(validatePowerBudget(base)).toBeUndefined();
    expect(validatePowerBudget({ maxEirpMdbm: 10_000 })).toBeUndefined();
  });
});
