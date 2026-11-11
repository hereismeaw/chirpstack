import { useMemo, useState } from "react";

import { format } from "date-fns";
import { JSONTree as JSONTreeOriginal } from "react-json-tree";
import fileDownload from "js-file-download";

import { Tag, Drawer, Button, Table, Spin, Space, Select, Tabs, Descriptions, Typography, notification } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ZoomInOutlined, CopyOutlined } from "@ant-design/icons";

import type { LogItem } from "@chirpstack/chirpstack-api-grpc-web/api/internal_pb";

import type { EventFilter, EventView } from "../lib/eventLog";
import { eventView, matchesFilter, parseBody } from "../lib/eventLog";
import type { Protocol } from "../lib/protocol";
import { PROTOCOLS, protocolLabel } from "../lib/protocol";
import ProtocolTag from "./ProtocolTag";
import EventDetails, { HexBlock } from "./EventDetails";

interface IProps {
  logs: LogItem[];
  // "frames" (default) keeps the original LoRaWAN frame log. "events" adds the
  // protocol column, filters and the protocol-aware detail view for the
  // device event stream.
  mode?: "frames" | "events";
}

interface Row {
  id: string;
  time?: { seconds: number };
  description: string;
  body: string;
  properties: [string, string][];
  view?: EventView;
}

const theme = {
  scheme: "google",
  author: "seth wright (http://sethawright.com)",
  base00: "#ffffff",
  base01: "#282a2e",
  base02: "#373b41",
  base03: "#969896",
  base04: "#b4b7b4",
  base05: "#c5c8c6",
  base06: "#e0e0e0",
  base07: "#ffffff",
  base08: "#CC342B",
  base09: "#F96A38",
  base0A: "#FBA922",
  base0B: "#198844",
  base0C: "#3971ED",
  base0D: "#3971ED",
  base0E: "#A36AC7",
  base0F: "#3971ED",
};

function formatTime(time: { seconds: number } | undefined): string {
  if (time === undefined) {
    return "";
  }
  const ts = new Date(0);
  ts.setUTCSeconds(time.seconds);
  return format(ts, "yyyy-MM-dd HH:mm:ss");
}

/**
 * Properties shown in the table. The stream attaches LoRaWAN-specific
 * properties (DR / FPort / FCnt) to every uplink; for mioty events these are
 * compatibility defaults, so the row is described from the event body instead.
 */
export function rowProperties(description: string, properties: [string, string][], view?: EventView): [string, string][] {
  if (!view || view.protocol !== "mioty" || (description !== "up" && description !== "txack")) {
    return properties;
  }

  const out: [string, string][] = [];
  if (view.mioty?.packetCounter !== undefined) {
    out.push(["Packet counter", String(view.mioty.packetCounter)]);
  }
  if (description === "up") {
    out.push(["Base Stations", String(view.rx.length)]);
    const best = view.rx.reduce<number | undefined>(
      (acc, r) => (r.rssi !== undefined && (acc === undefined || r.rssi > acc) ? r.rssi : acc),
      undefined,
    );
    if (best !== undefined) {
      out.push(["RSSI", `${best} dBm`]);
    }
    const profile = view.rx.find(r => r.regionalProfile)?.regionalProfile;
    if (profile) {
      out.push(["Regional profile", profile]);
    }
  } else if (view.gatewayIds.length > 0) {
    out.push(["Base Station", view.gatewayIds[0]]);
  }
  return out;
}

function LogTable(props: IProps) {
  const eventsMode = props.mode === "events";
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [selected, setSelected] = useState<Row | null>(null);
  const [filter, setFilter] = useState<EventFilter>({});

  const rows: Row[] = useMemo(
    () =>
      props.logs.map(l => {
        const obj = l.toObject();
        const view = eventsMode ? eventView(parseBody(obj.body)) : undefined;
        return {
          id: obj.id,
          time: obj.time,
          description: obj.description,
          body: obj.body,
          properties: rowProperties(obj.description, obj.propertiesMap, view),
          view,
        };
      }),
    [props.logs, eventsMode],
  );

  const visibleRows = useMemo(
    () => (eventsMode ? rows.filter(r => matchesFilter(r.description, r.view!, filter)) : rows),
    [rows, filter, eventsMode],
  );

  const typeOptions = useMemo(
    () => Array.from(new Set(rows.map(r => r.description))).sort().map(t => ({ value: t, label: t })),
    [rows],
  );
  const gatewayOptions = useMemo(
    () =>
      Array.from(new Set(rows.flatMap(r => r.view?.gatewayIds ?? [])))
        .sort()
        .map(id => ({ value: id, label: id })),
    [rows],
  );

  const onDrawerClose = () => {
    setDrawerOpen(false);
  };

  const onDrawerOpen = (row: Row) => () => {
    setSelected(row);
    setDrawerOpen(true);
  };

  const selectedJson: unknown = selected ? (parseBody(selected.body) ?? null) : null;

  const downloadSingleFrame = () => {
    fileDownload(JSON.stringify(selectedJson, null, 4), "single-log.json", "application/json");
  };

  const downloadFrames = () => {
    const items = visibleRows.map(r => parseBody(r.body) ?? null);
    fileDownload(JSON.stringify(items, null, 4), "log.json");
  };

  const copySelected = () => {
    const text = JSON.stringify(selectedJson, null, 2);
    if (!navigator.clipboard) {
      notification.error({ message: "Clipboard is not available in this browser context", duration: 3 });
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => notification.success({ message: "Event JSON copied", duration: 2 }),
      () => notification.error({ message: "Copying to the clipboard was refused", duration: 3 }),
    );
  };

  const jsonTree = (
    <JSONTreeOriginal
      data={selectedJson}
      theme={theme}
      hideRoot={true}
      shouldExpandNodeInitially={() => {
        return true;
      }}
    />
  );

  const columns: ColumnsType<Row> = [
    {
      title: "Time",
      dataIndex: "time",
      key: "time",
      width: 200,
      render: (_text, obj) => formatTime(obj.time),
    },
    ...(eventsMode
      ? ([
          {
            title: "Protocol",
            key: "protocol",
            width: 110,
            render: (_text, obj) => <ProtocolTag protocol={obj.view!.protocol} />,
          },
        ] as ColumnsType<Row>)
      : []),
    {
      title: "Type",
      dataIndex: "description",
      key: "description",
      width: 200,
      render: (text, obj) => (
        <Button icon={<ZoomInOutlined />} type="primary" shape="round" size="small" onClick={onDrawerOpen(obj)}>
          {text}
        </Button>
      ),
    },
    {
      title: "Properties",
      dataIndex: "properties",
      key: "properties",
      render: (_text, obj) => (
        <Space orientation="horizontal" size="small" wrap>
          {obj.properties.map(p => {
            if (p[1] !== "") {
              return (
                <Tag key={p[0]} variant="outlined">
                  <pre>
                    {p[0]}: {p[1]}
                  </pre>
                </Tag>
              );
            }

            return null;
          })}
        </Space>
      ),
    },
  ];

  const view = selected?.view;

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Drawer
        title={`Details: ${selected ? formatTime(selected.time) : ""}`}
        placement="right"
        size={eventsMode ? 760 : 650}
        onClose={onDrawerClose}
        open={drawerOpen}
        extra={
          <Space>
            {eventsMode && (
              <Button icon={<CopyOutlined />} onClick={copySelected}>
                Copy JSON
              </Button>
            )}
            <Button onClick={downloadSingleFrame}>Download</Button>
          </Space>
        }
      >
        {eventsMode && selected && view ? (
          <Tabs
            defaultActiveKey="summary"
            key={selected.id}
            items={[
              {
                key: "summary",
                label: "Summary",
                children: <EventDetails type={selected.description} view={view} />,
              },
              { key: "json", label: "JSON", children: jsonTree },
              {
                key: "hex",
                label: "Payload (hex)",
                children: (
                  <Descriptions
                    bordered
                    size="small"
                    column={1}
                    layout="vertical"
                    items={[
                      {
                        key: "data",
                        label: view.protocol === "mioty" ? "Application payload (after decryption)" : "Payload (data)",
                        children: <HexBlock hex={view.dataHex} emptyText="Empty payload" />,
                      },
                      ...(view.protocol === "mioty"
                        ? [
                            {
                              key: "raw",
                              label: "Raw user data (as received, before application decryption)",
                              children: view.mioty?.legacy ? (
                                <Typography.Text type="secondary">
                                  Unavailable for events stored before typed mioty fields existed
                                </Typography.Text>
                              ) : (
                                <HexBlock hex={view.mioty?.rawUserDataHex} emptyText="Empty payload" />
                              ),
                            },
                          ]
                        : []),
                    ]}
                  />
                ),
              },
            ]}
          />
        ) : (
          jsonTree
        )}
      </Drawer>
      {eventsMode && rows.length !== 0 && (
        <Space orientation="horizontal" size="middle" wrap>
          <Select<Protocol>
            aria-label="Filter by protocol"
            placeholder="Protocol"
            allowClear
            style={{ width: 140 }}
            value={filter.protocol}
            onChange={v => setFilter(f => ({ ...f, protocol: v }))}
            options={PROTOCOLS.map(p => ({ value: p, label: protocolLabel(p) }))}
          />
          <Select<string[]>
            aria-label="Filter by event type"
            placeholder="Event type"
            mode="multiple"
            allowClear
            style={{ minWidth: 200 }}
            value={filter.types ?? []}
            onChange={v => setFilter(f => ({ ...f, types: v }))}
            options={typeOptions}
          />
          <Select<string>
            aria-label="Filter by gateway or Base Station"
            placeholder="Gateway / Base Station"
            allowClear
            showSearch
            style={{ width: 240 }}
            value={filter.gatewayId}
            onChange={v => setFilter(f => ({ ...f, gatewayId: v }))}
            options={gatewayOptions}
          />
          <Typography.Text type="secondary">
            {visibleRows.length} of {rows.length} events
          </Typography.Text>
        </Space>
      )}
      {rows.length !== 0 && (
        <Space orientation="horizontal" style={{ float: "right" }} size="large">
          <Spin size="small" />
          <Button onClick={downloadFrames}>Download</Button>
        </Space>
      )}
      <Table<Row>
        rowKey="id"
        showHeader={eventsMode}
        loading={rows.length === 0}
        dataSource={visibleRows}
        pagination={false}
        locale={eventsMode && rows.length !== 0 ? { emptyText: "No events match the selected filters" } : undefined}
        columns={columns}
      />
    </Space>
  );
}

export default LogTable;
