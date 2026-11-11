import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Badge, Card, Col, Descriptions, Row, Space, Tag, Typography } from "antd";
import { Timestamp } from "google-protobuf/google/protobuf/timestamp_pb";
import { sub } from "date-fns";

import type {
  Gateway,
  GetGatewayMetricsResponse,
  GetMiotyRfConfigResponse,
} from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";
import {
  GetGatewayMetricsRequest,
  GetMiotyRfConfigRequest,
} from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";
import { Aggregation } from "@chirpstack/chirpstack-api-grpc-web/common/common_pb";

import GatewayStore from "../../stores/GatewayStore";
import MetricChart from "../../components/MetricChart";
import Map, { Marker } from "../../components/Map";
import ProtocolTag from "../../components/ProtocolTag";
import { baseStationInfo } from "../../lib/baseStation";

interface IProps {
  gateway: Gateway;
  lastSeenAt?: Date;
}

function notReported(text = "Not reported") {
  return <Typography.Text type="secondary">{text}</Typography.Text>;
}

/** Summary of the RF policy of a Base Station, with a link to the editor. */
export function RfPolicySummary(props: { resp?: GetMiotyRfConfigResponse; failed?: boolean }) {
  if (props.failed) {
    return notReported("Unavailable");
  }
  if (!props.resp) {
    return notReported("Loading");
  }
  const config = props.resp.getConfig();
  if (!config) {
    return <Tag>No regional policy selected</Tag>;
  }
  return (
    <Space size="small" wrap>
      <Tag color="orange">{config.getProfileId()}</Tag>
      {config.getTxEnabled() ? <Tag color="red">Transmit-enabled</Tag> : <Tag color="green">Receive-only</Tag>}
      <Typography.Text type="secondary">
        {config.getChannelsList().length} desired channel{config.getChannelsList().length === 1 ? "" : "s"}
      </Typography.Text>
    </Space>
  );
}

function MiotyGatewayDashboard(props: IProps) {
  const gatewayId = props.gateway.getGatewayId();
  const [metrics, setMetrics] = useState<GetGatewayMetricsResponse>();
  const [rf, setRf] = useState<GetMiotyRfConfigResponse>();
  const [rfFailed, setRfFailed] = useState<boolean>(false);

  useEffect(() => {
    const req = new GetGatewayMetricsRequest();
    req.setGatewayId(gatewayId);
    req.setStart(Timestamp.fromDate(sub(new Date(), { days: 30 })));
    req.setEnd(Timestamp.fromDate(new Date()));
    req.setAggregation(Aggregation.DAY);
    GatewayStore.getMetrics(req, setMetrics);

    const rfReq = new GetMiotyRfConfigRequest();
    rfReq.setGatewayId(gatewayId);
    GatewayStore.getMiotyRfConfig(
      rfReq,
      resp => {
        setRfFailed(false);
        setRf(resp);
      },
      () => setRfFailed(true),
    );
  }, [gatewayId]);

  const info = baseStationInfo(props.gateway.getMetadataMap().toObject() as [string, string][]);
  const seenRecently =
    !!props.lastSeenAt && Date.now() - props.lastSeenAt.getTime() < props.gateway.getStatsInterval() * 2000;
  const location = props.gateway.getLocation();
  const position: [number, number] = [location?.getLatitude() || 0, location?.getLongitude() || 0];
  const rfLink = `/tenants/${props.gateway.getTenantId()}/gateways/${gatewayId}/rf`;

  let connection = <Badge status="warning" text="Never connected" />;
  if (props.lastSeenAt) {
    connection =
      info.status === "online" && seenRecently ? (
        <Badge status="success" text="Connected" />
      ) : (
        <Badge status="error" text={info.status === "online" ? "No recent activity" : "Disconnected"} />
      );
  }

  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="large">
      <Row gutter={[24, 24]}>
        <Col xs={24} xl={12}>
          <Card title="Base Station" style={{ height: "100%" }}>
            <Descriptions
              column={1}
              size="small"
              items={[
                { key: "type", label: "Technology", children: <ProtocolTag protocol="mioty" /> },
                {
                  key: "eui",
                  label: "Base Station EUI",
                  children: <Typography.Text copyable>{gatewayId}</Typography.Text>,
                },
                { key: "vendor", label: "Vendor", children: info.vendor ?? notReported() },
                { key: "model", label: "Model", children: info.model ?? notReported() },
                { key: "name", label: "Reported name", children: info.name ?? notReported() },
                { key: "sw", label: "Software version", children: info.softwareVersion ?? notReported() },
                {
                  key: "license",
                  label: "Hardware capability and licensing",
                  children: notReported(
                    "Not reported. The Base Station interface carries no band, power or licence information.",
                  ),
                },
              ]}
            />
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
              Vendor, model, name and software version are self-reported by the Base Station when it connects.
            </Typography.Paragraph>
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="Connection" style={{ height: "100%" }}>
            <Descriptions
              column={1}
              size="small"
              items={[
                { key: "status", label: "Connection state", children: connection },
                {
                  key: "seen",
                  label: "Last seen",
                  children: props.lastSeenAt?.toLocaleString() ?? notReported("Never"),
                },
                {
                  key: "sc",
                  label: "Service Center",
                  children: "This ChirpStack server (native Service Center interface)",
                },
                {
                  key: "bssci",
                  label: "BSSCI version",
                  children: info.bssciVersion ?? notReported(),
                },
                {
                  key: "session",
                  label: "BSSCI session",
                  children:
                    info.sessionResumed === undefined
                      ? notReported()
                      : info.sessionResumed
                        ? "Resumed on last connect"
                        : "New session on last connect",
                },
                {
                  key: "bidi",
                  label: "Reports bidirectional",
                  children: info.bidirectional === undefined ? notReported() : info.bidirectional ? "Yes" : "No",
                },
                {
                  key: "rf",
                  label: "Radio policy",
                  children: (
                    <Space size="small" wrap>
                      <RfPolicySummary resp={rf} failed={rfFailed} />
                      <Link to={rfLink}>Open RF policy</Link>
                    </Space>
                  ),
                },
                {
                  key: "cert",
                  label: "TLS certificate",
                  children: notReported(
                    "Certificate metadata is not stored by the server. The expiry date is shown when a certificate is generated.",
                  ),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>
      {metrics?.getRxPackets() && (
        <Card title="Received uplinks">
          <MetricChart metric={metrics.getRxPackets()!} aggregation={Aggregation.DAY} />
        </Card>
      )}
      <Map height={400} center={position}>
        <Marker position={position} faIcon="wifi" color="blue" />
      </Map>
    </Space>
  );
}

export default MiotyGatewayDashboard;
