import { useEffect, useState } from "react";
import { Link } from "react-router";

import { Alert, Badge, Breadcrumb, Button, Card, Descriptions, Empty, Space, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";

import type { Tenant } from "@chirpstack/chirpstack-api-grpc-web/api/tenant_pb";
import type {
  GatewayListItem,
  GetMiotyRfConfigResponse,
  ListGatewaysResponse,
} from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";
import {
  GatewayState,
  GatewayType,
  GetMiotyRfConfigRequest,
  ListGatewaysRequest,
} from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";

import type { GetPageCallbackFunc } from "../../components/DataTable";
import DataTable from "../../components/DataTable";
import PageHeader from "../../components/PageHeader";
import Admin from "../../components/Admin";
import GatewayStore from "../../stores/GatewayStore";
import { baseStationInfo } from "../../lib/baseStation";
import { formatHzAsMhz } from "../../lib/miotyRf";
import { format_dt_from_secs, useTitle } from "../helpers";
import { RfPolicySummary } from "../gateways/MiotyGatewayDashboard";
import { TH_PROFILE_ID } from "../gateways/MiotyRfPolicy";

interface IProps {
  tenant: Tenant;
}

function useRfConfig(gatewayId: string | undefined) {
  const [state, setState] = useState<{ resp?: GetMiotyRfConfigResponse; failed: boolean }>({ failed: false });

  useEffect(() => {
    if (!gatewayId) {
      return;
    }
    let active = true;
    const req = new GetMiotyRfConfigRequest();
    req.setGatewayId(gatewayId);
    GatewayStore.getMiotyRfConfig(
      req,
      resp => active && setState({ resp, failed: false }),
      () => active && setState({ failed: true }),
    );
    return () => {
      active = false;
    };
  }, [gatewayId]);

  return state;
}

function RfPolicyCell(props: { gatewayId: string }) {
  const { resp, failed } = useRfConfig(props.gatewayId);
  return <RfPolicySummary resp={resp} failed={failed} />;
}

export function StateBadge(props: { state: GatewayState }) {
  if (props.state === GatewayState.ONLINE) {
    return <Badge status="success" text="Online" />;
  }
  if (props.state === GatewayState.OFFLINE) {
    return <Badge status="error" text="Offline" />;
  }
  return <Badge status="warning" text="Never seen" />;
}

/** Regional radio profile offered by the server, as reported through a Base Station of the tenant. */
function RegionalProfiles(props: { gatewayId: string | undefined }) {
  const { resp, failed } = useRfConfig(props.gatewayId);

  if (!props.gatewayId) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Regional radio profiles are assigned per Base Station. Register a mioty Base Station to select one."
      />
    );
  }
  if (failed) {
    return <Alert type="error" showIcon title="The regional profile information could not be loaded" />;
  }
  if (!resp) {
    return <Typography.Text type="secondary">Loading</Typography.Text>;
  }

  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="middle">
      <Descriptions
        bordered
        size="small"
        column={{ xs: 1, md: 2 }}
        items={[
          { key: "id", label: "Region identifier", children: <code>{TH_PROFILE_ID}</code> },
          {
            key: "name",
            label: "Name",
            children: (
              <Space size="small" wrap>
                {resp.getDisplayName()}
                {resp.getExperimental() && <Tag color="orange">Experimental</Tag>}
              </Space>
            ),
          },
          {
            key: "band",
            label: "Frequency boundaries",
            children: `${formatHzAsMhz(resp.getMinFrequencyHz())} – ${formatHzAsMhz(resp.getMaxFrequencyHz())} MHz`,
          },
          {
            key: "tx",
            label: "Transmission",
            children: resp.getTxSupported() ? (
              <Tag color="green">Supported by server</Tag>
            ) : (
              <Tag color="red">Not supported (receive-only)</Tag>
            ),
          },
        ]}
      />
      <Typography.Text type="secondary">
        {TH_PROFILE_ID} is a custom, experimental profile of this ChirpStack fork. It is not an official mioty Alliance
        regional profile and does not establish regulatory authorization. It is selected and configured per Base
        Station under its RF policy tab. Base Stations without a selected policy keep their native behaviour.
      </Typography.Text>
    </Space>
  );
}

function MiotyNetwork(props: IProps) {
  const tenantId = props.tenant.getId();
  // First Base Station of the tenant; used to read the profile the server offers.
  const [firstGatewayId, setFirstGatewayId] = useState<string | undefined>(undefined);
  useTitle("Tenants", props.tenant.getName(), "mioty Network");

  const columns: ColumnsType<GatewayListItem.AsObject> = [
    {
      title: "State",
      dataIndex: "state",
      key: "state",
      width: 130,
      render: (_text, record) => <StateBadge state={record.state} />,
    },
    {
      title: "Name",
      dataIndex: "name",
      key: "name",
      render: (text, record) => <Link to={`/tenants/${tenantId}/gateways/${record.gatewayId}`}>{text}</Link>,
    },
    {
      title: "Base Station EUI",
      dataIndex: "gatewayId",
      key: "gatewayId",
      width: 190,
    },
    {
      title: "Vendor / model",
      key: "hardware",
      render: (_text, record) => {
        const info = baseStationInfo(record.propertiesMap);
        const parts = [info.vendor, info.model].filter(p => p !== undefined);
        return parts.length > 0 ? parts.join(" ") : <Typography.Text type="secondary">Not reported</Typography.Text>;
      },
    },
    {
      title: "Bidirectional",
      key: "bidi",
      width: 130,
      render: (_text, record) => {
        const bidi = baseStationInfo(record.propertiesMap).bidirectional;
        return bidi === undefined ? <Typography.Text type="secondary">Not reported</Typography.Text> : bidi ? "Yes" : "No";
      },
    },
    {
      title: "RF policy",
      key: "rf",
      render: (_text, record) => (
        <Space size="small" wrap>
          <RfPolicyCell gatewayId={record.gatewayId} />
          <Link to={`/tenants/${tenantId}/gateways/${record.gatewayId}/rf`}>Configure</Link>
        </Space>
      ),
    },
    {
      title: "Last seen",
      dataIndex: "lastSeenAt",
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

  const getPage = (
    limit: number,
    offset: number,
    _filters: object,
    _orderBy: string | void,
    _orderByDesc: boolean | void,
    callbackFunc: GetPageCallbackFunc,
  ) => {
    const req = new ListGatewaysRequest();
    req.setTenantId(tenantId);
    req.setGatewayType(GatewayType.MIOTY);
    req.setLimit(limit);
    req.setOffset(offset);

    GatewayStore.list(req, (resp: ListGatewaysResponse) => {
      const obj = resp.toObject();
      if (offset === 0) {
        setFirstGatewayId(obj.resultList[0]?.gatewayId);
      }
      callbackFunc(obj.totalCount, obj.resultList);
    });
  };

  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="large">
      <PageHeader
        breadcrumbRender={() => (
          <Breadcrumb
            items={[
              { title: "Tenants" },
              { title: <Link to={`/tenants/${tenantId}`}>{props.tenant.getName()}</Link> },
              { title: "mioty Network" },
            ]}
          />
        )}
        title="mioty Network"
        extra={[
          <Admin tenantId={tenantId} isGatewayAdmin key="add-base-station">
            <Button type="primary">
              <Link to={`/tenants/${tenantId}/gateways/create`}>Add Base Station</Link>
            </Button>
          </Admin>,
        ]}
      />
      <Card title="Base Stations">
        <DataTable columns={columns} getPage={getPage} rowKey="gatewayId" />
      </Card>
      <Card title="Regional radio profiles">
        <RegionalProfiles gatewayId={firstGatewayId} />
      </Card>
      <Card title="End Points">
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          mioty End Points are registered as devices inside{" "}
          <Link to={`/tenants/${tenantId}/applications`}>applications</Link>, next to LoRaWAN devices. Select the
          technology <em>mioty End Point</em> when adding a device, and use the Technology filter of a device list to
          show only End Points.
        </Typography.Paragraph>
      </Card>
    </Space>
  );
}

export default MiotyNetwork;
