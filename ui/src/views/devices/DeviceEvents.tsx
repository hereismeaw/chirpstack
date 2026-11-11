import { useEffect, useState } from "react";

import type { Device } from "@chirpstack/chirpstack-api-grpc-web/api/device_pb";
import type { LogItem } from "@chirpstack/chirpstack-api-grpc-web/api/internal_pb";
import { StreamDeviceEventsRequest } from "@chirpstack/chirpstack-api-grpc-web/api/internal_pb";

import InternalStore from "../../stores/InternalStore";
import LogTable from "../../components/LogTable";

interface IProps {
  device: Device;
}

export const MAX_DEVICE_EVENTS = 500;

/** Redis IDs contain two integers; concatenating them loses ordering and precision. */
export function newerEventId(candidate: string, previous: string): boolean {
  const pattern = /^(\d+)-(\d+)$/;
  const next = pattern.exec(candidate);
  const last = pattern.exec(previous);
  if (!next || !last) return false;
  const nextTime = BigInt(next[1]);
  const lastTime = BigInt(last[1]);
  return nextTime > lastTime || (nextTime === lastTime && BigInt(next[2]) > BigInt(last[2]));
}

function DeviceEvents(props: IProps) {
  const devEui = props.device.getDevEui();
  const [stream, setStream] = useState<{ devEui: string; events: LogItem[] }>({ devEui, events: [] });
  const events = stream.devEui === devEui ? stream.events : [];

  useEffect(() => {
    let active = true;
    const req = new StreamDeviceEventsRequest();
    req.setDevEui(devEui);

    const cancelFunc = InternalStore.streamDeviceEvents(req, l => {
      if (!active) return;
      setStream(current => {
        const previous = current.devEui === devEui ? current.events : [];
        return previous.length === 0 || newerEventId(l.getId(), previous[0].getId())
          ? { devEui, events: [l, ...previous].slice(0, MAX_DEVICE_EVENTS) }
          : current;
      });
    });

    return () => {
      active = false;
      cancelFunc();
    };
  }, [devEui]);

  return <LogTable logs={events} mode="events" />;
}

export default DeviceEvents;
