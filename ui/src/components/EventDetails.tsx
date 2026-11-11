import type { ReactNode } from "react";

import { Alert, Descriptions, Space, Table, Typography } from "antd";

import type { EventView, RxView } from "../lib/eventLog";
import { formatHexDump } from "../lib/eventLog";
import { formatHzAsMhz } from "../lib/miotyRf";
import { deviceNoun, gatewayNoun } from "../lib/protocol";
import ProtocolTag from "./ProtocolTag";

interface IProps {
  type: string;
  view: EventView;
}

/** Explicit placeholder for metadata the backend did not provide. */
export function NotReported(props: { text?: string }) {
  return <Typography.Text type="secondary">{props.text ?? "Not reported"}</Typography.Text>;
}

function value(v: string | number | undefined, unit?: string): ReactNode {
  if (v === undefined) {
    return <NotReported />;
  }
  return unit ? `${v} ${unit}` : v;
}

export function HexBlock(props: { hex: string | undefined; emptyText?: string }) {
  if (props.hex === undefined) {
    return <NotReported />;
  }
  if (props.hex === "") {
    return <NotReported text={props.emptyText ?? "Empty"} />;
  }
  return (
    <Typography.Paragraph copyable={{ text: props.hex }} style={{ marginBottom: 0 }}>
      <pre style={{ whiteSpace: "pre-wrap", display: "inline-block", verticalAlign: "top" }}>
        {formatHexDump(props.hex)}
      </pre>
    </Typography.Paragraph>
  );
}

function logAlertType(level: string | undefined): "error" | "warning" | "info" {
  if (level === "ERROR") {
    return "error";
  }
  if (level === "WARNING") {
    return "warning";
  }
  return "info";
}

/** Protocol-aware summary of one device event. Only backend-provided fields are shown. */
function EventDetails(props: IProps) {
  const { view, type } = props;
  const isMioty = view.protocol === "mioty";
  const gwNoun = gatewayNoun(view.protocol);

  const items = [
    { key: "protocol", label: "Protocol", children: <ProtocolTag protocol={view.protocol} /> },
    { key: "type", label: "Event type", children: type },
    {
      key: "dev",
      label: isMioty ? `${deviceNoun("mioty")} EUI` : "DevEUI",
      children: view.devEui ? <Typography.Text copyable>{view.devEui}</Typography.Text> : <NotReported />,
    },
    { key: "time", label: "Timestamp", children: value(view.time) },
  ];

  if (view.deduplicationId) {
    items.push({
      key: "dedup",
      label: "Deduplication ID",
      children: <Typography.Text copyable>{view.deduplicationId}</Typography.Text>,
    });
  }

  if (view.mioty) {
    if (view.mioty.legacy) {
      items.push({
        key: "legacy",
        label: "Packet counter",
        children: (
          <NotReported text="Unavailable: this event was stored before typed mioty fields existed (see JSON)" />
        ),
      });
    } else {
      items.push({ key: "counter", label: "Packet counter", children: value(view.mioty.packetCounter) });
      if (type === "up") {
        items.push({
          key: "format",
          label: "Application payload format",
          children: value(view.mioty.applicationFormat),
        });
      }
    }
  }

  if (view.lorawan && type === "up") {
    items.push(
      { key: "devAddr", label: "DevAddr", children: value(view.lorawan.devAddr) },
      { key: "fCnt", label: "FCnt", children: value(view.lorawan.fCnt ?? 0) },
      { key: "fPort", label: "FPort", children: value(view.lorawan.fPort ?? 0) },
      { key: "dr", label: "Data-rate", children: value(view.lorawan.dr ?? 0) },
    );
  }

  if (type === "up") {
    items.push({
      key: "freq",
      label: "Frequency",
      children:
        view.frequencyHz !== undefined ? (
          `${formatHzAsMhz(view.frequencyHz)} MHz`
        ) : (
          <NotReported text={isMioty ? "Not reported by the Base Station" : "Not reported"} />
        ),
    });
  }

  const rxColumns = [
    {
      title: `${gwNoun} ID`,
      dataIndex: "gatewayId",
      key: "gatewayId",
      render: (v: string | undefined) => (v ? <Typography.Text copyable>{v}</Typography.Text> : <NotReported />),
    },
    {
      title: "RSSI",
      dataIndex: "rssi",
      key: "rssi",
      render: (v: number | undefined) => value(v, "dBm"),
    },
    {
      title: "SNR",
      dataIndex: "snr",
      key: "snr",
      render: (v: number | undefined) => value(v, "dB"),
    },
    ...(isMioty
      ? [
          {
            title: "Regional profile",
            key: "regionalProfile",
            render: (_: unknown, r: RxView) =>
              r.regionalProfile ? (
                <Space orientation="vertical" size={0}>
                  {r.regionalProfile}
                  <Typography.Text type="secondary">
                    {r.regionalProfileSource === "desired_policy"
                      ? "desired policy, not measured"
                      : (r.regionalProfileSource ?? "")}
                  </Typography.Text>
                </Space>
              ) : (
                <NotReported text="None selected" />
              ),
          },
          {
            title: "Reported by Base Station",
            key: "reported",
            render: (_: unknown, r: RxView) => {
              const parts = [
                r.reportedProfile ? `profile ${r.reportedProfile}` : undefined,
                r.reportedMode ? `mode ${r.reportedMode}` : undefined,
                r.eqSnr ? `eqSnr ${r.eqSnr}` : undefined,
                r.rxDuration ? `rxDuration ${r.rxDuration}` : undefined,
              ].filter(p => p !== undefined);
              return parts.length > 0 ? parts.join(", ") : <NotReported />;
            },
          },
        ]
      : []),
  ];

  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="large">
      {view.log && (
        <Alert
          type={logAlertType(view.log.level)}
          showIcon
          title={`${view.log.level ?? "LOG"}${view.log.code ? ` · ${view.log.code}` : ""}`}
          description={
            <Space orientation="vertical" size="small">
              <span>{view.log.description ?? "No description"}</span>
              {view.log.context && Object.keys(view.log.context).length > 0 && (
                <Descriptions
                  size="small"
                  column={1}
                  items={Object.entries(view.log.context).map(([k, v]) => ({ key: k, label: k, children: v }))}
                />
              )}
            </Space>
          }
        />
      )}
      <Descriptions bordered size="small" column={1} items={items} />
      {type === "up" && (
        <>
          <div>
            <Typography.Title level={5}>
              {isMioty ? "Receiving Base Stations" : "Receiving gateways"} ({view.rx.length})
            </Typography.Title>
            <Table<RxView>
              size="small"
              pagination={false}
              rowKey={r => r.gatewayId ?? "unknown"}
              dataSource={view.rx}
              columns={rxColumns}
              locale={{ emptyText: "No reception metadata reported" }}
            />
          </div>
          <div>
            <Typography.Title level={5}>Decoded payload</Typography.Title>
            {view.object !== undefined && view.object !== null ? (
              <Typography.Paragraph copyable={{ text: JSON.stringify(view.object, null, 2) }}>
                <pre style={{ whiteSpace: "pre-wrap", display: "inline-block", verticalAlign: "top" }}>
                  {JSON.stringify(view.object, null, 2)}
                </pre>
              </Typography.Paragraph>
            ) : (
              <NotReported text="Not decoded (the device profile codec produced no object)" />
            )}
          </div>
        </>
      )}
    </Space>
  );
}

export default EventDetails;
