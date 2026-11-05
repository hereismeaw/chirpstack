import { useEffect, useState } from "react";
import { Card, Descriptions, Space } from "antd";
import { Timestamp } from "google-protobuf/google/protobuf/timestamp_pb";
import { sub } from "date-fns";
import type { Gateway, GetGatewayMetricsResponse } from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";
import { GetGatewayMetricsRequest } from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";
import { Aggregation } from "@chirpstack/chirpstack-api-grpc-web/common/common_pb";
import GatewayStore from "../../stores/GatewayStore";
import MetricChart from "../../components/MetricChart";
import Map, { Marker } from "../../components/Map";

function MiotyGatewayDashboard(props: { gateway: Gateway; lastSeenAt?: Date }) {
  const [metrics, setMetrics] = useState<GetGatewayMetricsResponse>();
  useEffect(() => {
    const req = new GetGatewayMetricsRequest();
    req.setGatewayId(props.gateway.getGatewayId());
    req.setStart(Timestamp.fromDate(sub(new Date(), { days: 30 })));
    req.setEnd(Timestamp.fromDate(new Date()));
    req.setAggregation(Aggregation.DAY);
    GatewayStore.getMetrics(req, setMetrics);
  }, [props.gateway]);
  const metadata = props.gateway.getMetadataMap();
  const online = !!props.lastSeenAt && Date.now() - props.lastSeenAt.getTime() < props.gateway.getStatsInterval() * 2000;
  const location = props.gateway.getLocation();
  const position: [number, number] = [location?.getLatitude() || 0, location?.getLongitude() || 0];
  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="large">
      <Descriptions bordered column={1} items={[
        { key: "type", label: "Gateway type", children: "Mioty Gateway" },
        { key: "status", label: "Status", children: online ? (metadata.get("mioty_status") || "Online") : "Offline" },
        { key: "seen", label: "Last seen", children: props.lastSeenAt?.toLocaleString() || "Never" },
      ]} />
      {metrics?.getRxPackets() && <Card title="Received uplinks"><MetricChart metric={metrics.getRxPackets()!} aggregation={Aggregation.DAY} /></Card>}
      <Map height={400} center={position}><Marker position={position} faIcon="wifi" color="blue" /></Map>
    </Space>
  );
}

export default MiotyGatewayDashboard;
