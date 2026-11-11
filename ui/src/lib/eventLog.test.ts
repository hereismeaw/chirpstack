import { describe, expect, it } from "vitest";

import { base64ToHex, eventProtocol, eventView, formatHexDump, matchesFilter, parseBody } from "./eventLog";

// Shape produced by chirpstack/src/mioty/uplink.rs (protobuf-JSON, camelCase).
const miotyUp = {
  deduplicationId: "3ac7e3c4-4401-4b8b-9386-a5c902f9202d",
  time: "2026-11-11T10:00:00Z",
  deviceInfo: {
    tenantId: "52f14cd4-c6f1-4fbd-8f87-4025e1d49242",
    applicationId: "17c82e96-be03-4f38-aef3-f83d48582d97",
    deviceName: "ep-1",
    devEui: "70b3d56770000001",
    tags: { protocol: "mioty" },
  },
  data: "AQID",
  object: { temperature: 21.5 },
  rxInfo: [
    {
      gatewayId: "0202020202020202",
      gwTime: "2026-11-11T10:00:00Z",
      rssi: -97,
      snr: 8.5,
      metadata: {
        protocol: "mioty",
        format: "0",
        regional_profile: "TH920_925",
        regional_profile_source: "desired_policy",
        regional_tx_enabled: "false",
        profile: "eu1",
        mode: "A",
      },
    },
    { gatewayId: "0303030303030303", metadata: { protocol: "mioty", format: "0" } },
  ],
  mioty: { packetCounter: 42, rawUserData: "/wAB" },
};

const lorawanUp = {
  deduplicationId: "0d6cf5b1-6b0f-4a4c-9c0e-b5d7a0b1d5c1",
  time: "2026-11-11T10:00:05Z",
  deviceInfo: { devEui: "0102030405060708", deviceName: "lw-1", tags: {} },
  devAddr: "01020304",
  dr: 5,
  fCnt: 10,
  fPort: 1,
  data: "3q2+7w==",
  rxInfo: [{ gatewayId: "0101010101010101", rssi: -60, snr: 9 }],
  txInfo: { frequency: 868100000 },
};

describe("parseBody", () => {
  it("returns undefined for invalid, non-object, empty or oversized bodies", () => {
    expect(parseBody("{not json")).toBeUndefined();
    expect(parseBody("[1,2]")).toBeUndefined();
    expect(parseBody('"x"')).toBeUndefined();
    expect(parseBody("")).toBeUndefined();
    expect(parseBody(null)).toBeUndefined();
    expect(parseBody(`{"a":"${"x".repeat(1024 * 1024)}"}`)).toBeUndefined();
  });

  it("parses an object body", () => {
    expect(parseBody('{"a":1}')).toEqual({ a: 1 });
  });
});

describe("base64ToHex", () => {
  it("decodes bytes to lowercase hex", () => {
    expect(base64ToHex("AQID")).toBe("010203");
    expect(base64ToHex("3q2+7w==")).toBe("deadbeef");
    expect(base64ToHex("")).toBe("");
  });

  it("returns undefined for non-base64 input", () => {
    expect(base64ToHex("***")).toBeUndefined();
    expect(base64ToHex("abc")).toBeUndefined();
    expect(base64ToHex(undefined)).toBeUndefined();
    expect(base64ToHex(123)).toBeUndefined();
  });

  it("formats a hex dump with 16 bytes per line", () => {
    expect(formatHexDump("010203")).toBe("01 02 03");
    expect(formatHexDump("00".repeat(17)).split("\n")).toHaveLength(2);
    expect(formatHexDump("")).toBe("");
  });
});

describe("eventProtocol", () => {
  it("identifies native mioty events by the typed mioty message", () => {
    expect(eventProtocol({ mioty: { packetCounter: 1 } })).toBe("mioty");
    // A zero counter is omitted by protobuf-JSON, leaving an empty message.
    expect(eventProtocol({ mioty: {} })).toBe("mioty");
  });

  it("identifies legacy preview events by the protocol tag", () => {
    expect(eventProtocol({ deviceInfo: { tags: { protocol: "mioty" } } })).toBe("mioty");
  });

  it("treats everything else as LoRaWAN", () => {
    expect(eventProtocol(lorawanUp)).toBe("lorawan");
    expect(eventProtocol({ deviceInfo: { tags: { protocol: "other" } } })).toBe("lorawan");
    expect(eventProtocol(undefined)).toBe("lorawan");
  });
});

describe("eventView", () => {
  it("extracts the verified mioty uplink fields", () => {
    const v = eventView(miotyUp);
    expect(v.protocol).toBe("mioty");
    expect(v.devEui).toBe("70b3d56770000001");
    expect(v.deduplicationId).toBe("3ac7e3c4-4401-4b8b-9386-a5c902f9202d");
    expect(v.gatewayIds).toEqual(["0202020202020202", "0303030303030303"]);
    expect(v.dataHex).toBe("010203");
    expect(v.object).toEqual({ temperature: 21.5 });
    expect(v.mioty).toEqual({ packetCounter: 42, applicationFormat: 0, rawUserDataHex: "ff0001", legacy: false });
    expect(v.lorawan).toBeUndefined();
    expect(v.rx[0]).toMatchObject({
      gatewayId: "0202020202020202",
      rssi: -97,
      snr: 8.5,
      regionalProfile: "TH920_925",
      regionalProfileSource: "desired_policy",
      reportedProfile: "eu1",
      reportedMode: "A",
    });
  });

  it("does not invent RF values that were not reported", () => {
    const v = eventView(miotyUp);
    // No frequency is carried by mioty uplinks.
    expect(v.frequencyHz).toBeUndefined();
    // The second reception has no regional policy and no Base Station profile.
    expect(v.rx[1].regionalProfile).toBeUndefined();
    expect(v.rx[1].reportedProfile).toBeUndefined();
    expect(v.rx[1].eqSnr).toBeUndefined();
    // RSSI/SNR are mandatory for native receptions: an omitted value is a reported zero.
    expect(v.rx[1].rssi).toBe(0);
    expect(v.rx[1].snr).toBe(0);
  });

  it("marks legacy mioty events and leaves their typed fields unavailable", () => {
    const v = eventView({ deviceInfo: { devEui: "70b3d56770000001", tags: { protocol: "mioty" } }, fCnt: 7 });
    expect(v.protocol).toBe("mioty");
    expect(v.mioty).toEqual({
      packetCounter: undefined,
      applicationFormat: undefined,
      rawUserDataHex: undefined,
      legacy: true,
    });
    // The LoRaWAN fCnt compatibility slot is not presented as a mioty counter.
    expect(v.lorawan).toBeUndefined();
  });

  it("keeps the existing LoRaWAN fields for LoRaWAN events", () => {
    const v = eventView(lorawanUp);
    expect(v.protocol).toBe("lorawan");
    expect(v.mioty).toBeUndefined();
    expect(v.lorawan).toEqual({ fCnt: 10, fPort: 1, dr: 5, devAddr: "01020304" });
    expect(v.frequencyHz).toBe(868100000);
    expect(v.dataHex).toBe("deadbeef");
    expect(v.rx[0]).toMatchObject({ gatewayId: "0101010101010101", rssi: -60, snr: 9 });
  });

  it("does not default omitted LoRaWAN RSSI/SNR to zero", () => {
    const v = eventView({ rxInfo: [{ gatewayId: "0101010101010101" }] });
    expect(v.rx[0].rssi).toBeUndefined();
    expect(v.rx[0].snr).toBeUndefined();
  });

  it("exposes log events for error inspection", () => {
    const v = eventView({
      deviceInfo: { devEui: "70b3d56770000001", tags: { protocol: "mioty" } },
      level: "ERROR",
      code: "UPLINK_CODEC",
      description: "decode failed",
      context: { deduplication_id: "abc", ignored: 5 },
    });
    expect(v.log).toEqual({
      level: "ERROR",
      code: "UPLINK_CODEC",
      description: "decode failed",
      context: { deduplication_id: "abc" },
    });
  });

  it("uses the single gateway of a txack event and mioty tx counter", () => {
    const v = eventView({
      deviceInfo: { devEui: "70b3d56770000001", tags: { protocol: "mioty" } },
      gatewayId: "0202020202020202",
      queueItemId: "q1",
      mioty: { packetCounter: 9 },
    });
    expect(v.gatewayIds).toEqual(["0202020202020202"]);
    expect(v.mioty?.packetCounter).toBe(9);
  });

  it("tolerates malformed structures", () => {
    const v = eventView({ deviceInfo: "x", rxInfo: [null, 5, { gatewayId: 7 }], data: 12, mioty: [] });
    expect(v.protocol).toBe("lorawan");
    expect(v.rx).toHaveLength(1);
    expect(v.gatewayIds).toEqual([]);
    expect(v.dataHex).toBeUndefined();
    expect(eventView(undefined)).toEqual({ protocol: "lorawan", gatewayIds: [], rx: [] });
  });
});

describe("matchesFilter", () => {
  const mioty = eventView(miotyUp);
  const lorawan = eventView(lorawanUp);

  it("filters by protocol", () => {
    expect(matchesFilter("up", mioty, { protocol: "mioty" })).toBe(true);
    expect(matchesFilter("up", lorawan, { protocol: "mioty" })).toBe(false);
    expect(matchesFilter("up", lorawan, {})).toBe(true);
  });

  it("filters by event type", () => {
    expect(matchesFilter("up", mioty, { types: ["log", "txack"] })).toBe(false);
    expect(matchesFilter("log", mioty, { types: ["log", "txack"] })).toBe(true);
    expect(matchesFilter("up", mioty, { types: [] })).toBe(true);
  });

  it("filters by gateway / Base Station", () => {
    expect(matchesFilter("up", mioty, { gatewayId: "0303030303030303" })).toBe(true);
    expect(matchesFilter("up", mioty, { gatewayId: "0101010101010101" })).toBe(false);
  });
});
