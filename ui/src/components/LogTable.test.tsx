import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Timestamp } from "google-protobuf/google/protobuf/timestamp_pb";

import { LogItem } from "@chirpstack/chirpstack-api-grpc-web/api/internal_pb";

import LogTable, { rowProperties } from "./LogTable";
import { eventView } from "../lib/eventLog";

function item(id: string, description: string, body: object, properties: [string, string][] = []): LogItem {
  const l = new LogItem();
  l.setId(id);
  l.setDescription(description);
  l.setBody(JSON.stringify(body));
  const ts = new Timestamp();
  ts.setSeconds(1794391200);
  l.setTime(ts);
  for (const [k, v] of properties) {
    l.getPropertiesMap().set(k, v);
  }
  return l;
}

const miotyUp = {
  deduplicationId: "3ac7e3c4-4401-4b8b-9386-a5c902f9202d",
  time: "2026-11-11T10:00:00Z",
  deviceInfo: { devEui: "70b3d56770000001", deviceName: "ep-1", tags: { protocol: "mioty" } },
  data: "AQID",
  object: { temperature: 21.5 },
  rxInfo: [
    {
      gatewayId: "0202020202020202",
      rssi: -97,
      snr: 8.5,
      metadata: { regional_profile: "TH920_925", regional_profile_source: "desired_policy", profile: "eu1" },
    },
  ],
  mioty: { packetCounter: 42, rawUserData: "/wAB" },
};

const lorawanUp = {
  deduplicationId: "0d6cf5b1-6b0f-4a4c-9c0e-b5d7a0b1d5c1",
  deviceInfo: { devEui: "0102030405060708", tags: {} },
  devAddr: "01020304",
  dr: 5,
  fCnt: 10,
  fPort: 1,
  data: "3q2+7w==",
  rxInfo: [{ gatewayId: "0101010101010101", rssi: -60, snr: 9 }],
  txInfo: { frequency: 868100000 },
};

const miotyLog = {
  deviceInfo: { devEui: "70b3d56770000001", tags: { protocol: "mioty" } },
  level: "ERROR",
  code: "DOWNLINK_GATEWAY",
  description: "transmission failed",
  context: { queue_item_id: "q-1" },
};

// As emitted by chirpstack/src/stream/event.rs for every uplink.
const lorawanProps: [string, string][] = [
  ["DR", "5"],
  ["FPort", "1"],
  ["FCnt", "10"],
];
const compatProps: [string, string][] = [
  ["DR", "0"],
  ["FPort", "0"],
  ["FCnt", "0"],
];

function logs() {
  return [
    item("3-0", "log", miotyLog, [
      ["Level", "ERROR"],
      ["Code", "DOWNLINK_GATEWAY"],
    ]),
    item("2-0", "up", lorawanUp, lorawanProps),
    item("1-0", "up", miotyUp, compatProps),
  ];
}

describe("rowProperties", () => {
  it("replaces LoRaWAN compatibility properties on mioty uplinks with mioty fields", () => {
    expect(rowProperties("up", compatProps, eventView(miotyUp))).toEqual([
      ["Packet counter", "42"],
      ["Base Stations", "1"],
      ["RSSI", "-97 dBm"],
      ["Regional profile", "TH920_925"],
    ]);
  });

  it("keeps LoRaWAN properties untouched", () => {
    expect(rowProperties("up", lorawanProps, eventView(lorawanUp))).toBe(lorawanProps);
  });

  it("keeps stream properties for other mioty event types", () => {
    const props: [string, string][] = [["Level", "ERROR"]];
    expect(rowProperties("log", props, eventView(miotyLog))).toBe(props);
  });

  it("describes a mioty txack by counter and Base Station", () => {
    const v = eventView({ gatewayId: "0202020202020202", mioty: { packetCounter: 9 } });
    expect(rowProperties("txack", [], v)).toEqual([
      ["Packet counter", "9"],
      ["Base Station", "0202020202020202"],
    ]);
  });
});

describe("LogTable in events mode", () => {
  it("labels each event with its protocol and shows protocol-appropriate properties", () => {
    render(<LogTable logs={logs()} mode="events" />);

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("mioty")).toBeInTheDocument();
    expect(within(rows[1]).getByText("LoRaWAN")).toBeInTheDocument();
    expect(within(rows[2]).getByText("mioty")).toBeInTheDocument();

    expect(within(rows[1]).getByText("FCnt: 10")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Packet counter: 42")).toBeInTheDocument();
    expect(within(rows[2]).queryByText(/FCnt/)).not.toBeInTheDocument();
    expect(within(rows[2]).queryByText(/FPort/)).not.toBeInTheDocument();
    expect(screen.getByText("3 of 3 events")).toBeInTheDocument();
  });

  it("filters by protocol", async () => {
    const user = userEvent.setup();
    render(<LogTable logs={logs()} mode="events" />);

    await user.click(screen.getByRole("combobox", { name: "Filter by protocol" }));
    await user.click(await screen.findByTitle("LoRaWAN"));

    expect(screen.getByText("1 of 3 events")).toBeInTheDocument();
    expect(screen.getByText("FCnt: 10")).toBeInTheDocument();
    expect(screen.queryByText("Packet counter: 42")).not.toBeInTheDocument();
  });

  it("filters by event type and by Base Station", async () => {
    const user = userEvent.setup();
    render(<LogTable logs={logs()} mode="events" />);

    await user.click(screen.getByRole("combobox", { name: "Filter by event type" }));
    await user.click(await screen.findByTitle("log"));
    expect(screen.getByText("1 of 3 events")).toBeInTheDocument();
    expect(screen.getByText("Code: DOWNLINK_GATEWAY")).toBeInTheDocument();
    await user.keyboard("{Backspace}{Escape}");
    expect(screen.getByText("3 of 3 events")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Filter by gateway or Base Station" }));
    await user.click(await screen.findByTitle("0202020202020202"));
    expect(screen.getByText("1 of 3 events")).toBeInTheDocument();
    expect(screen.getByText("Packet counter: 42")).toBeInTheDocument();
  });

  it("shows verified mioty fields and explicit unavailable states in the detail view", async () => {
    const user = userEvent.setup();
    render(<LogTable logs={[item("1-0", "up", miotyUp, compatProps)]} mode="events" />);

    await user.click(screen.getByRole("button", { name: /up/ }));
    const drawer = await screen.findByRole("dialog");

    expect(within(drawer).getByText("End Point EUI")).toBeInTheDocument();
    expect(within(drawer).getByText("70b3d56770000001")).toBeInTheDocument();
    expect(within(drawer).getByText("3ac7e3c4-4401-4b8b-9386-a5c902f9202d")).toBeInTheDocument();
    expect(within(drawer).getByText("Packet counter")).toBeInTheDocument();
    expect(within(drawer).getByText("42")).toBeInTheDocument();
    expect(within(drawer).getByText("Not reported by the Base Station")).toBeInTheDocument();
    expect(within(drawer).getByText("0202020202020202")).toBeInTheDocument();
    expect(within(drawer).getByText("-97 dBm")).toBeInTheDocument();
    expect(within(drawer).getByText("8.5 dB")).toBeInTheDocument();
    expect(within(drawer).getByText("TH920_925")).toBeInTheDocument();
    expect(within(drawer).getByText("desired policy, not measured")).toBeInTheDocument();
    expect(within(drawer).getByText("profile eu1")).toBeInTheDocument();
    expect(within(drawer).getByText(/"temperature": 21.5/)).toBeInTheDocument();
    // No LoRaWAN MAC fields on a mioty event.
    expect(within(drawer).queryByText("FCnt")).not.toBeInTheDocument();
    expect(within(drawer).queryByText("DevAddr")).not.toBeInTheDocument();

    await user.click(within(drawer).getByRole("tab", { name: "Payload (hex)" }));
    expect(await within(drawer).findByText("01 02 03")).toBeInTheDocument();
    expect(within(drawer).getByText("ff 00 01")).toBeInTheDocument();
  });

  it("keeps LoRaWAN fields in the detail view of a LoRaWAN event", async () => {
    const user = userEvent.setup();
    render(<LogTable logs={[item("2-0", "up", lorawanUp, lorawanProps)]} mode="events" />);

    await user.click(screen.getByRole("button", { name: /up/ }));
    const drawer = await screen.findByRole("dialog");

    expect(within(drawer).getByText("DevEUI")).toBeInTheDocument();
    expect(within(drawer).getByText("DevAddr")).toBeInTheDocument();
    expect(within(drawer).getByText("01020304")).toBeInTheDocument();
    expect(within(drawer).getByText("868.100 MHz")).toBeInTheDocument();
    expect(within(drawer).getByText("Receiving gateways (1)")).toBeInTheDocument();
    expect(within(drawer).queryByText("Packet counter")).not.toBeInTheDocument();
    expect(within(drawer).queryByText("Regional profile")).not.toBeInTheDocument();
  });

  it("presents log events for error inspection", async () => {
    const user = userEvent.setup();
    render(<LogTable logs={[item("3-0", "log", miotyLog)]} mode="events" />);

    await user.click(screen.getByRole("button", { name: /log/ }));
    const drawer = await screen.findByRole("dialog");

    expect(within(drawer).getByText("ERROR · DOWNLINK_GATEWAY")).toBeInTheDocument();
    expect(within(drawer).getByText("transmission failed")).toBeInTheDocument();
    expect(within(drawer).getByText("q-1")).toBeInTheDocument();
  });

  it("does not crash on an event with an unparsable body", () => {
    const broken = new LogItem();
    broken.setId("9-0");
    broken.setDescription("up");
    broken.setBody("{not json");
    render(<LogTable logs={[broken]} mode="events" />);
    expect(screen.getByText("1 of 1 events")).toBeInTheDocument();
  });
});

describe("LogTable in frames mode (LoRaWAN frame log, unchanged)", () => {
  it("renders stream properties as-is without protocol column or filters", () => {
    render(<LogTable logs={[item("2-0", "UnconfirmedDataUp", { phyPayload: {} }, [["DevAddr", "01020304"]])]} />);

    expect(screen.getByText("DevAddr: 01020304")).toBeInTheDocument();
    expect(screen.queryByText("LoRaWAN")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText(/of 1 events/)).not.toBeInTheDocument();
  });
});
