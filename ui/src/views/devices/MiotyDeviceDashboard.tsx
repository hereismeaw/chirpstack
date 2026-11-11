import { Link } from "react-router";
import { Badge, Descriptions, Space, Tag, Typography } from "antd";

import type { Device } from "@chirpstack/chirpstack-api-grpc-web/api/device_pb";
import type { DeviceProfile } from "@chirpstack/chirpstack-api-grpc-web/api/device_profile_pb";
import { CodecRuntime, ProfileProtocol } from "@chirpstack/chirpstack-api-grpc-web/api/device_profile_pb";

import ProtocolTag from "../../components/ProtocolTag";
import { APPLICATION_CRYPTO_OPTIONS } from "./MiotyDeviceFields";

interface IProps {
  device: Device;
  deviceProfile?: DeviceProfile;
  tenantId?: string;
  lastSeenAt?: Date;
}

function codecLabel(dp: DeviceProfile): string {
  switch (dp.getPayloadCodecRuntime()) {
    case CodecRuntime.JS:
      return "JavaScript functions";
    case CodecRuntime.CAYENNE_LPP:
      return "Cayenne LPP";
    default:
      return "None (payload is not decoded)";
  }
}

/** Overview of a mioty End Point built only from Device / DeviceProfile API data. */
function MiotyDeviceDashboard(props: IProps) {
  const settings = props.device.getMioty();
  const dp = props.deviceProfile;
  const epClass = settings?.getEpClass();
  const crypto = APPLICATION_CRYPTO_OPTIONS.find(o => o.value === settings?.getApplicationCrypto());

  const radioOptions = settings
    ? [
        settings.getDualChannel() ? "Dual channel" : undefined,
        settings.getWideCarrierOffset() ? "Wide carrier offset" : undefined,
        settings.getRepetition() ? "Downlink repetition" : undefined,
        settings.getLongBlockDistance() ? "Long downlink block distance" : undefined,
      ].filter((o): o is string => o !== undefined)
    : [];

  return (
    <Descriptions
      bordered
      column={1}
      items={[
        { key: "protocol", label: "Technology", children: <ProtocolTag protocol="mioty" /> },
        {
          key: "eui",
          label: "End Point EUI",
          children: <Typography.Text copyable>{props.device.getDevEui()}</Typography.Text>,
        },
        {
          key: "status",
          label: "Status",
          children: props.device.getIsDisabled() ? (
            <Badge status="default" text="Disabled (uplinks are ignored)" />
          ) : (
            <Badge status="success" text="Enabled" />
          ),
        },
        {
          key: "lastSeen",
          label: "Last uplink",
          children: props.lastSeenAt?.toLocaleString() ?? <Typography.Text type="secondary">Never</Typography.Text>,
        },
        {
          key: "class",
          label: "End Point class",
          children:
            epClass === "A" ? "A (bidirectional)" : epClass === "Z" ? "Z (uplink only)" : (epClass ?? "Unknown"),
        },
        { key: "address", label: "Short address", children: settings?.getShortAddress() },
        {
          key: "attach",
          label: "Attachment",
          children: settings?.getPreAttach() ? "Pre-attached" : "Not pre-attached (over-the-air attachment is not supported)",
        },
        {
          key: "downlink",
          label: "Downlink",
          children:
            epClass === "A" ? (
              "Supported: queued payloads are sent in the receive window after an uplink"
            ) : (
              <Typography.Text type="secondary">Not supported for this End Point class</Typography.Text>
            ),
        },
        { key: "crypto", label: "Application cryptography", children: crypto?.label ?? "Unknown" },
        {
          key: "keys",
          label: "Credentials",
          children: (
            <Typography.Text type="secondary">
              Keys are write-only and are never returned by the server. Replace them under Configuration.
            </Typography.Text>
          ),
        },
        {
          key: "radio",
          label: "Radio options",
          children:
            radioOptions.length > 0 ? (
              <Space size="small" wrap>
                {radioOptions.map(o => (
                  <Tag key={o}>{o}</Tag>
                ))}
              </Space>
            ) : (
              <Typography.Text type="secondary">None enabled</Typography.Text>
            ),
        },
        {
          key: "profile",
          label: "Device profile",
          children: dp ? (
            <Space size="small" wrap>
              {props.tenantId && dp.getTenantId() !== "" ? (
                <Link to={`/tenants/${props.tenantId}/device-profiles/${dp.getId()}/edit`}>{dp.getName()}</Link>
              ) : (
                dp.getName()
              )}
              <ProtocolTag protocol={dp.getProtocol() === ProfileProtocol.PROFILE_MIOTY ? "mioty" : "lorawan"} />
            </Space>
          ) : (
            <Typography.Text type="secondary">Not loaded</Typography.Text>
          ),
        },
        ...(dp ? [{ key: "codec", label: "Payload decoding", children: codecLabel(dp) }] : []),
        {
          key: "rf",
          label: "Regional radio profile",
          children: (
            <Typography.Text type="secondary">
              Selected per Base Station. The profile that applied to a reception is shown with each uplink under
              Events.
            </Typography.Text>
          ),
        },
      ]}
    />
  );
}

export default MiotyDeviceDashboard;
