import { useEffect, useState } from "react";
import { Link } from "react-router";

import { Alert, Breadcrumb, Card, Col, Row, Space, Statistic, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";

import type { Tenant } from "@chirpstack/chirpstack-api-grpc-web/api/tenant_pb";
import type { GatewayListItem, ListGatewaysResponse } from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";
import { GatewayState, GatewayType, ListGatewaysRequest } from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";
import type {
  ApplicationListItem,
  ListApplicationsResponse,
} from "@chirpstack/chirpstack-api-grpc-web/api/application_pb";
import { ListApplicationsRequest } from "@chirpstack/chirpstack-api-grpc-web/api/application_pb";
import { DeviceType } from "@chirpstack/chirpstack-api-grpc-web/api/device_pb";
import type { GetDevicesSummaryResponse } from "@chirpstack/chirpstack-api-grpc-web/api/internal_pb";
import { GetDevicesSummaryRequest } from "@chirpstack/chirpstack-api-grpc-web/api/internal_pb";

import PageHeader from "../../components/PageHeader";
import ProtocolTag from "../../components/ProtocolTag";
import { fetchDeviceCount } from "../../components/DeviceCount";
import GatewayStore from "../../stores/GatewayStore";
import ApplicationStore from "../../stores/ApplicationStore";
import InternalStore from "../../stores/InternalStore";
import { baseStationInfo } from "../../lib/baseStation";
import type { Protocol } from "../../lib/protocol";
import { gatewayNoun, gatewayProtocol } from "../../lib/protocol";
import { format_dt_from_secs, useTitle } from "../helpers";
import { StateBadge } from "../mioty/MiotyNetwork";

// Upper bounds of what this overview loads. Larger tenants see a notice
// instead of silently incomplete totals.
export const GATEWAY_LIMIT = 1000;
export const APPLICATION_LIMIT = 100;

interface IProps {
  tenant: Tenant;
}

export interface StateCounts {
  online: number;
  offline: number;
  neverSeen: number;
}

/** Tallies gateways / Base Stations by technology and state. */
export function countByProtocol(items: GatewayListItem.AsObject[]): Record<Protocol, StateCounts> {
  const counts: Record<Protocol, StateCounts> = {
    lorawan: { online: 0, offline: 0, neverSeen: 0 },
    mioty: { online: 0, offline: 0, neverSeen: 0 },
  };
  for (const item of items) {
    const c = counts[gatewayProtocol(item.gatewayType)];
    if (item.state === GatewayState.ONLINE) {
      c.online += 1;
    } else if (item.state === GatewayState.OFFLINE) {
      c.offline += 1;
    } else {
      c.neverSeen += 1;
    }
  }
  return counts;
}

interface DeviceCounts {
  lorawan?: number;
  mioty?: number;
}

function StateCard(props: { protocol: Protocol; counts?: StateCounts }) {
  const c = props.counts;
  return (
    <Card
      title={
        <Space size="small">
          <ProtocolTag protocol={props.protocol} />
          {gatewayNoun(props.protocol)}s
        </Space>
      }
      loading={c === undefined}
      style={{ height: "100%" }}
    >
      {c && (
        <Row gutter={16}>
          <Col span={8}>
            <Statistic title="Online" value={c.online} styles={{ content: { color: "#389e0d" } }} />
          </Col>
          <Col span={8}>
            <Statistic
              title="Offline"
              value={c.offline}
              styles={{ content: c.offline > 0 ? { color: "#cf1322" } : undefined }}
            />
          </Col>
          <Col span={8}>
            <Statistic title="Never seen" value={c.neverSeen} />
          </Col>
        </Row>
      )}
    </Card>
  );
}

function NetworkHealth(props: IProps) {
  const tenantId = props.tenant.getId();
  useTitle("Tenants", props.tenant.getName(), "Network health");

  const [gateways, setGateways] = useState<GatewayListItem.AsObject[] | undefined>(undefined);
  const [gatewayTotal, setGatewayTotal] = useState<number>(0);
  const [devices, setDevices] = useState<GetDevicesSummaryResponse | undefined>(undefined);
  const [applications, setApplications] = useState<ApplicationListItem.AsObject[] | undefined>(undefined);
  const [applicationTotal, setApplicationTotal] = useState<number>(0);
  const [deviceCounts, setDeviceCounts] = useState<Record<string, DeviceCounts>>({});

  useEffect(() => {
    let active = true;

    const gwReq = new ListGatewaysRequest();
    gwReq.setTenantId(tenantId);
    gwReq.setLimit(GATEWAY_LIMIT);
    GatewayStore.list(gwReq, (resp: ListGatewaysResponse) => {
      if (active) {
        const obj = resp.toObject();
        setGateways(obj.resultList);
        setGatewayTotal(obj.totalCount);
      }
    });

    const devReq = new GetDevicesSummaryRequest();
    devReq.setTenantId(tenantId);
    InternalStore.getDevicesSummary(devReq, (resp: GetDevicesSummaryResponse) => {
      if (active) {
        setDevices(resp);
      }
    });

    const appReq = new ListApplicationsRequest();
    appReq.setTenantId(tenantId);
    appReq.setLimit(APPLICATION_LIMIT);
    ApplicationStore.list(appReq, (resp: ListApplicationsResponse) => {
      if (!active) {
        return;
      }
      const obj = resp.toObject();
      setApplications(obj.resultList);
      setApplicationTotal(obj.totalCount);
      setDeviceCounts({});

      for (const app of obj.resultList) {
        const record = (protocol: Protocol) => (count: number) => {
          if (active) {
            setDeviceCounts(prev => ({ ...prev, [app.id]: { ...prev[app.id], [protocol]: count } }));
          }
        };
        fetchDeviceCount(app.id, DeviceType.LORAWAN_DEVICE, record("lorawan"));
        fetchDeviceCount(app.id, DeviceType.MIOTY_DEVICE, record("mioty"));
      }
    });

    return () => {
      active = false;
    };
  }, [tenantId]);

  const byProtocol = gateways ? countByProtocol(gateways) : undefined;
  const baseStations = (gateways ?? []).filter(g => g.gatewayType === GatewayType.MIOTY);

  const countsComplete =
    applications !== undefined &&
    applications.every(a => deviceCounts[a.id]?.lorawan !== undefined && deviceCounts[a.id]?.mioty !== undefined);
  const total = (protocol: Protocol) =>
    (applications ?? []).reduce((sum, a) => sum + (deviceCounts[a.id]?.[protocol] ?? 0), 0);

  const pending = <Typography.Text type="secondary">…</Typography.Text>;

  const applicationColumns: ColumnsType<ApplicationListItem.AsObject> = [
    {
      title: "Application",
      dataIndex: "name",
      key: "name",
      render: (text, record) => <Link to={`/tenants/${tenantId}/applications/${record.id}`}>{text}</Link>,
    },
    {
      title: "LoRaWAN devices",
      key: "lorawan",
      width: 180,
      align: "right",
      render: (_text, record) => deviceCounts[record.id]?.lorawan ?? pending,
    },
    {
      title: "mioty End Points",
      key: "mioty",
      width: 180,
      align: "right",
      render: (_text, record) => deviceCounts[record.id]?.mioty ?? pending,
    },
  ];

  const baseStationColumns: ColumnsType<GatewayListItem.AsObject> = [
    {
      title: "State",
      key: "state",
      width: 130,
      render: (_text, record) => <StateBadge state={record.state} />,
    },
    {
      title: "Base Station",
      dataIndex: "name",
      key: "name",
      render: (text, record) => <Link to={`/tenants/${tenantId}/gateways/${record.gatewayId}`}>{text}</Link>,
    },
    { title: "EUI", dataIndex: "gatewayId", key: "gatewayId", width: 190 },
    {
      title: "Connection reported by server",
      key: "connection",
      render: (_text, record) =>
        baseStationInfo(record.propertiesMap).status ?? <Typography.Text type="secondary">Not reported</Typography.Text>,
    },
    {
      title: "Last seen",
      key: "lastSeenAt",
      width: 190,
      render: (_text, record) =>
        record.lastSeenAt ? (
          format_dt_from_secs(record.lastSeenAt.seconds)
        ) : (
          <Typography.Text type="secondary">Never</Typography.Text>
        ),
    },
  ];

  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="large">
      <PageHeader
        breadcrumbRender={() => (
          <Breadcrumb
            items={[
              { title: "Tenants" },
              { title: <Link to={`/tenants/${tenantId}`}>{props.tenant.getName()}</Link> },
              { title: "Network health" },
            ]}
          />
        )}
        title="Network health"
      />

      {gatewayTotal > GATEWAY_LIMIT && (
        <Alert
          type="warning"
          showIcon
          title={`Gateway figures cover the first ${GATEWAY_LIMIT} of ${gatewayTotal} gateways and Base Stations of this tenant.`}
        />
      )}

      <Row gutter={[24, 24]}>
        <Col xs={24} lg={8}>
          <StateCard protocol="lorawan" counts={byProtocol?.lorawan} />
        </Col>
        <Col xs={24} lg={8}>
          <StateCard protocol="mioty" counts={byProtocol?.mioty} />
        </Col>
        <Col xs={24} lg={8}>
          <Card title="Device activity (all technologies)" loading={devices === undefined} style={{ height: "100%" }}>
            {devices && (
              <Row gutter={16}>
                <Col span={8}>
                  <Statistic title="Active" value={devices.getActiveCount()} />
                </Col>
                <Col span={8}>
                  <Statistic title="Inactive" value={devices.getInactiveCount()} />
                </Col>
                <Col span={8}>
                  <Statistic title="Never seen" value={devices.getNeverSeenCount()} />
                </Col>
              </Row>
            )}
          </Card>
        </Col>
      </Row>

      <Card
        title="Registered devices by technology"
        extra={
          applications !== undefined && (
            <Space size="large">
              <span>
                LoRaWAN: <strong>{countsComplete ? total("lorawan") : "…"}</strong>
              </span>
              <span>
                mioty: <strong>{countsComplete ? total("mioty") : "…"}</strong>
              </span>
            </Space>
          )
        }
      >
        {applicationTotal > APPLICATION_LIMIT && (
          <Alert
            style={{ marginBottom: 16 }}
            type="warning"
            showIcon
            title={`Showing the first ${APPLICATION_LIMIT} of ${applicationTotal} applications. Totals cover the listed applications only.`}
          />
        )}
        <Table<ApplicationListItem.AsObject>
          size="small"
          rowKey="id"
          loading={applications === undefined}
          dataSource={applications ?? []}
          columns={applicationColumns}
          pagination={false}
          locale={{ emptyText: "This tenant has no applications" }}
        />
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          A device is active while it has been seen within 1.5 times the expected uplink interval of its device profile.
        </Typography.Paragraph>
      </Card>

      <Card title="mioty Base Station connections" extra={<Link to={`/tenants/${tenantId}/mioty`}>mioty Network</Link>}>
        <Table<GatewayListItem.AsObject>
          size="small"
          rowKey="gatewayId"
          loading={gateways === undefined}
          dataSource={baseStations}
          columns={baseStationColumns}
          pagination={false}
          locale={{ emptyText: "No mioty Base Stations are registered for this tenant" }}
        />
      </Card>

      <Card title="Processing and delivery errors">
        <Typography.Paragraph>
          Errors that concern a device (payload codec failures, failed downlink transmissions, integration errors) are
          published as <code>log</code> events and are shown, per device, under <em>Events</em> with their level, code
          and context.
        </Typography.Paragraph>
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          Server-wide counters are exported through the existing Prometheus endpoint and are not available in this
          interface: <code>mioty_uplink_handled_total</code>, <code>mioty_uplink_rejected_total</code> and{" "}
          <code>mioty_rf_tx_blocked_total</code> (downlinks withheld by a regional RF policy), next to the existing ChirpStack
          metrics.
        </Typography.Paragraph>
      </Card>
    </Space>
  );
}

export default NetworkHealth;
