import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Device } from "@chirpstack/chirpstack-api-grpc-web/api/device_pb";
import type { StreamDeviceEventsRequest } from "@chirpstack/chirpstack-api-grpc-web/api/internal_pb";
import { LogItem } from "@chirpstack/chirpstack-api-grpc-web/api/internal_pb";

const mocks = vi.hoisted(() => ({
  stream: vi.fn<(req: StreamDeviceEventsRequest, receive: (log: LogItem) => void) => () => void>(),
}));
vi.mock("../../stores/InternalStore", () => ({ default: { streamDeviceEvents: mocks.stream } }));
vi.mock("../../components/LogTable", () => ({
  default: ({ logs }: { logs: LogItem[] }) => (
    <output data-testid="events">{logs.map(l => l.getId()).join(",")}</output>
  ),
}));

import DeviceEvents, { MAX_DEVICE_EVENTS, newerEventId } from "./DeviceEvents";

function device(eui: string) {
  const value = new Device();
  value.setDevEui(eui);
  return value;
}
function event(id: string) {
  const value = new LogItem();
  value.setId(id);
  return value;
}

beforeEach(() => mocks.stream.mockReset());

describe("device live event subscription", () => {
  it("compares both Redis ID parts without losing integer precision", () => {
    expect(newerEventId("100-1", "99-999")).toBe(true);
    expect(newerEventId("100-10", "100-9")).toBe(true);
    expect(newerEventId("100-9007199254740993", "100-9007199254740992")).toBe(true);
    expect(newerEventId("100-9", "100-9")).toBe(false);
    expect(newerEventId("99-999", "100-0")).toBe(false);
    expect(newerEventId("bad-id", "100-0")).toBe(false);
  });

  it("switches endpoints without retaining events or accepting callbacks from the old stream", () => {
    const cancel = vi.fn();
    mocks.stream.mockReturnValue(cancel);
    const { rerender, unmount } = render(<DeviceEvents device={device("0101010101010101")} />);
    const first = mocks.stream.mock.calls[0][1];
    act(() => first(event("100-1")));
    expect(screen.getByTestId("events")).toHaveTextContent("100-1");
    rerender(<DeviceEvents device={device("0101010101010101")} />);
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    rerender(<DeviceEvents device={device("0202020202020202")} />);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("events")).toBeEmptyDOMElement();
    act(() => first(event("101-1")));
    expect(screen.getByTestId("events")).toBeEmptyDOMElement();
    expect(mocks.stream.mock.calls[1][0].getDevEui()).toBe("0202020202020202");
    unmount();
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("bounds the event buffer and ignores replays", () => {
    mocks.stream.mockReturnValue(vi.fn());
    render(<DeviceEvents device={device("0101010101010101")} />);
    const receive = mocks.stream.mock.calls[0][1];
    act(() => {
      for (let i = 0; i <= MAX_DEVICE_EVENTS; i++) receive(event(`100-${i}`));
      receive(event("100-0"));
      receive(event(`100-${MAX_DEVICE_EVENTS}`));
    });
    const ids = screen.getByTestId("events").textContent.split(",");
    expect(ids).toHaveLength(MAX_DEVICE_EVENTS);
    expect(ids[0]).toBe(`100-${MAX_DEVICE_EVENTS}`);
    expect(ids.at(-1)).toBe("100-1");
  });
});
