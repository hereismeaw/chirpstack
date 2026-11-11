import { useEffect, useState } from "react";

import { Typography } from "antd";

import type { ListDevicesResponse } from "@chirpstack/chirpstack-api-grpc-web/api/device_pb";
import { ListDevicesRequest } from "@chirpstack/chirpstack-api-grpc-web/api/device_pb";
import type { DeviceType } from "@chirpstack/chirpstack-api-grpc-web/api/device_pb";

import DeviceStore from "../stores/DeviceStore";
import { format_dt_from_secs } from "../views/helpers";

/** Number of devices of one technology in an application (DeviceService.List total_count). */
export function fetchDeviceCount(applicationId: string, deviceType: DeviceType, callbackFunc: (count: number) => void) {
  const req = new ListDevicesRequest();
  req.setApplicationId(applicationId);
  req.setDeviceType(deviceType);
  // Only the total is needed; one row keeps the request valid for every backend.
  req.setLimit(1);
  DeviceStore.list(req, (resp: ListDevicesResponse) => callbackFunc(resp.getTotalCount()));
}

interface CountProps {
  applicationId: string;
  deviceType: DeviceType;
}

/** Lazily loaded per-technology device count for a table cell. */
export function DeviceCount(props: CountProps) {
  const [count, setCount] = useState<number | undefined>(undefined);

  useEffect(() => {
    let active = true;
    fetchDeviceCount(props.applicationId, props.deviceType, c => {
      if (active) {
        setCount(c);
      }
    });
    return () => {
      active = false;
    };
  }, [props.applicationId, props.deviceType]);

  if (count === undefined) {
    return <Typography.Text type="secondary">…</Typography.Text>;
  }
  return <>{count}</>;
}

/** Most recent uplink of any device in the application (DeviceService.List ordered by last seen). */
export function LastUplink(props: { applicationId: string }) {
  const [state, setState] = useState<{ loaded: boolean; seconds?: number }>({ loaded: false });

  useEffect(() => {
    let active = true;
    const req = new ListDevicesRequest();
    req.setApplicationId(props.applicationId);
    req.setLimit(1);
    req.setOrderBy(ListDevicesRequest.OrderBy.LAST_SEEN_AT);
    req.setOrderByDesc(true);
    DeviceStore.list(req, (resp: ListDevicesResponse) => {
      if (active) {
        setState({ loaded: true, seconds: resp.getResultList()[0]?.getLastSeenAt()?.getSeconds() });
      }
    });
    return () => {
      active = false;
    };
  }, [props.applicationId]);

  if (!state.loaded) {
    return <Typography.Text type="secondary">…</Typography.Text>;
  }
  if (state.seconds === undefined) {
    return <Typography.Text type="secondary">Never</Typography.Text>;
  }
  return <>{format_dt_from_secs(state.seconds)}</>;
}
