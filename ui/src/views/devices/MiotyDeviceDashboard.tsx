import { Descriptions } from "antd";
import type { Device } from "@chirpstack/chirpstack-api-grpc-web/api/device_pb";

function MiotyDeviceDashboard(props: { device: Device; lastSeenAt?: Date }) {
  const settings = props.device.getMioty();
  return <Descriptions bordered column={1} items={[
    { key: "type", label: "Device type", children: "Mioty Device" },
    { key: "eui", label: "Endpoint EUI", children: props.device.getDevEui() },
    { key: "class", label: "Endpoint class", children: settings?.getEpClass() },
    { key: "address", label: "Short address", children: settings?.getShortAddress() },
    { key: "disabled", label: "Disabled", children: props.device.getIsDisabled() ? "Yes" : "No" },
    { key: "lastSeen", label: "Last seen", children: props.lastSeenAt?.toLocaleString() || "Never" },
  ]} />;
}

export default MiotyDeviceDashboard;
