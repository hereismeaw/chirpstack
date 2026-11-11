import { useState, useEffect } from "react";

import { Route, Routes, Link, useParams, useNavigate, useLocation } from "react-router";

import { Space, Breadcrumb, Card, Button, Menu } from "antd";

import type { Tenant } from "@chirpstack/chirpstack-api-grpc-web/api/tenant_pb";
import type { Gateway, GetGatewayResponse } from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";
import { GetGatewayRequest, DeleteGatewayRequest, GatewayType } from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";

import GatewayStore from "../../stores/GatewayStore";
import DeleteConfirm from "../../components/DeleteConfirm";

import GatewayDashboard from "./GatewayDashboard";
import MiotyGatewayDashboard from "./MiotyGatewayDashboard";
import MiotyRfPolicy from "./MiotyRfPolicy";
import ProtocolTag from "../../components/ProtocolTag";
import EditGateway from "./EditGateway";
import GatewayFrames from "./GatewayFrames";
import GatewayCertificate from "./GatewayCertificate";
import Admin from "../../components/Admin";
import SessionStore from "../../stores/SessionStore";
import { useTitle } from "../helpers";
import PageHeader from "../../components/PageHeader";

interface IProps {
  tenant: Tenant;
}

function GatewayLayout(props: IProps) {
  const { gatewayId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [gateway, setGateway] = useState<Gateway | undefined>(undefined);
  const [lastSeenAt, setLastSeenAt] = useState<Date | undefined>(undefined);
  useTitle("Tenants", props.tenant.getName(), "Gateways", gateway?.getName());

  useEffect(() => {
    const req = new GetGatewayRequest();
    req.setGatewayId(gatewayId!);

    GatewayStore.get(req, (resp: GetGatewayResponse) => {
      setGateway(resp.getGateway());

      if (resp.getLastSeenAt() !== undefined) {
        setLastSeenAt(resp.getLastSeenAt()!.toDate());
      } else {
        setLastSeenAt(undefined);
      }
    });
  }, [props, gatewayId]);

  const deleteGateway = () => {
    const req = new DeleteGatewayRequest();
    req.setGatewayId(gatewayId!);

    GatewayStore.delete(req, () => {
      navigate(`/tenants/${props.tenant.getId()}/gateways`);
    });
  };

  const tenant = props.tenant;
  const gw = gateway;
  if (!gw) {
    return null;
  }

  const isMioty = gw.getGatewayType() === GatewayType.MIOTY;
  const path = location.pathname;
  let tab = "dashboard";

  if (path.endsWith("/edit")) {
    tab = "edit";
  }
  if (path.endsWith("/certificate")) {
    tab = "cert";
  }
  if (path.endsWith("/frames")) {
    tab = "frames";
  }
  if (path.endsWith("/rf")) {
    tab = "rf";
  }

  const isGatewayAdmin =
    SessionStore.isAdmin() ||
    SessionStore.isTenantAdmin(props.tenant.getId()) ||
    SessionStore.isTenantGatewayAdmin(props.tenant.getId());

  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="large">
      <PageHeader
        breadcrumbRender={() => (
          <Breadcrumb
            items={[
              { title: "Tenants" },
              { title: <Link to={`/tenants/${props.tenant.getId()}`}>{props.tenant.getName()}</Link> },
              { title: <Link to={`/tenants/${props.tenant.getId()}/gateways`}>Gateways / Base Stations</Link> },
              { title: gw.getName() },
            ]}
          />
        )}
        title={gw.getName()}
        subTitle={
          <Space>
            <ProtocolTag protocol={isMioty ? "mioty" : "lorawan"} />
            {`${isMioty ? "base station eui" : "gateway id"}: ${gw.getGatewayId()}`}
          </Space>
        }
        extra={[
          <Admin tenantId={props.tenant.getId()} isGatewayAdmin key="delete-gateway">
            <DeleteConfirm confirm={gw.getName()} typ="gateway" onConfirm={deleteGateway}>
              <Button danger type="primary">
                {isMioty ? "Delete Base Station" : "Delete gateway"}
              </Button>
            </DeleteConfirm>
          </Admin>,
        ]}
      />
      <Card>
        <Menu
          mode="horizontal"
          selectedKeys={[tab]}
          style={{ marginBottom: 24 }}
          items={[
            {
              key: "dashboard",
              label: <Link to={`/tenants/${tenant.getId()}/gateways/${gw.getGatewayId()}`}>Dashboard</Link>,
            },
            {
              key: "edit",
              label: <Link to={`/tenants/${tenant.getId()}/gateways/${gw.getGatewayId()}/edit`}>Configuration</Link>,
            },
            {
              key: "cert",
              disabled: !isGatewayAdmin,
              label: (
                <Link to={`/tenants/${tenant.getId()}/gateways/${gw.getGatewayId()}/certificate`}>TLS certificate</Link>
              ),
            },
            {
              key: "rf",
              label: <Link to={`/tenants/${tenant.getId()}/gateways/${gw.getGatewayId()}/rf`}>RF policy</Link>,
            },
            {
              key: "frames",
              label: <Link to={`/tenants/${tenant.getId()}/gateways/${gw.getGatewayId()}/frames`}>LoRaWAN frames</Link>,
            },
          ].filter(item => (isMioty ? item.key !== "frames" : item.key !== "rf"))}
        />
        <Routes>
          <Route path="/" element={isMioty ? <MiotyGatewayDashboard gateway={gw} lastSeenAt={lastSeenAt} /> : <GatewayDashboard gateway={gw} lastSeenAt={lastSeenAt} />} />
          <Route path="/edit" element={<EditGateway gateway={gw} />} />
          <Route path="/certificate" element={<GatewayCertificate gateway={gw} />} />
          {!isMioty && <Route path="/frames" element={<GatewayFrames gateway={gw} />} />}
          {isMioty && <Route path="/rf" element={<MiotyRfPolicy gateway={gw} />} />}
        </Routes>
      </Card>
    </Space>
  );
}

export default GatewayLayout;
