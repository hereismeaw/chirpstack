import { useState, useEffect, useCallback } from "react";
import { Link, useLocation, useNavigate } from "react-router";

import type { MenuProps } from "antd";
import { Menu, Typography } from "antd";
import {
  HomeOutlined,
  UserOutlined,
  DashboardOutlined,
  KeyOutlined,
  WifiOutlined,
  ControlOutlined,
  AppstoreOutlined,
  CompassOutlined,
  RadarChartOutlined,
  HeartOutlined,
  ClusterOutlined,
  ProfileOutlined,
  TeamOutlined,
} from "@ant-design/icons";

import type { GetTenantResponse, ListTenantsResponse } from "@chirpstack/chirpstack-api-grpc-web/api/tenant_pb";
import { ListTenantsRequest } from "@chirpstack/chirpstack-api-grpc-web/api/tenant_pb";

import type { GetVersionResponse } from "@chirpstack/chirpstack-api-grpc-web/api/internal_pb";

import type { OptionCallbackFunc, OptionsCallbackFunc } from "../components/Autocomplete";
import Autocomplete from "../components/Autocomplete";
import Admin from "../components/Admin";
import TenantStore from "../stores/TenantStore";
import SessionStore from "../stores/SessionStore";
import InternalStore from "../stores/InternalStore";

type MenuItems = NonNullable<MenuProps["items"]>;

/**
 * Navigation for both technologies. Server-wide entries are only offered to
 * global administrators; tenant entries require a selected tenant. All routes
 * are the existing ChirpStack URLs plus the two tenant overview pages.
 */
export function buildMenuItems(isAdmin: boolean, tenantId: string): MenuItems {
  const hasTenant = tenantId !== "";

  const overview: MenuItems = [];
  if (isAdmin) {
    overview.push({
      key: "ns-dashboard",
      icon: <DashboardOutlined />,
      label: <Link to="/dashboard">Server dashboard</Link>,
    });
  }
  if (hasTenant) {
    overview.push(
      {
        key: "tenant-dashboard",
        icon: <DashboardOutlined />,
        label: <Link to={`/tenants/${tenantId}`}>Tenant dashboard</Link>,
      },
      {
        key: "tenant-network-health",
        icon: <HeartOutlined />,
        label: <Link to={`/tenants/${tenantId}/network-health`}>Network health</Link>,
      },
    );
  }

  const management: MenuItems = [];
  if (isAdmin) {
    management.push({
      key: "ns-tenants",
      icon: <HomeOutlined />,
      label: <Link to="/tenants">Tenants</Link>,
    });
  }
  if (hasTenant) {
    management.push(
      {
        key: "tenant-applications",
        icon: <AppstoreOutlined />,
        label: <Link to={`/tenants/${tenantId}/applications`}>Applications and devices</Link>,
      },
      {
        key: "tenant-gateways",
        icon: <WifiOutlined />,
        label: <Link to={`/tenants/${tenantId}/gateways`}>Gateways / Base Stations</Link>,
      },
      {
        key: "tenant-gateways-mesh",
        icon: <RadarChartOutlined />,
        label: <Link to={`/tenants/${tenantId}/gateways/mesh/relays`}>Gateway Mesh (LoRaWAN)</Link>,
      },
    );
  }

  const networks: MenuItems = [];
  if (hasTenant) {
    networks.push({
      key: "tenant-device-profiles",
      icon: <ControlOutlined />,
      label: <Link to={`/tenants/${tenantId}/device-profiles`}>Device Profiles</Link>,
    });
  }
  if (isAdmin) {
    networks.push({
      key: "ns-device-profiles",
      icon: <ProfileOutlined />,
      label: <Link to="/device-profiles/vendors">Device Profile Templates</Link>,
    });
  }
  networks.push({
    key: "ns-regions",
    icon: <CompassOutlined />,
    label: <Link to="/regions">LoRaWAN Regions</Link>,
  });
  if (hasTenant) {
    networks.push({
      key: "tenant-mioty",
      icon: <ClusterOutlined />,
      label: <Link to={`/tenants/${tenantId}/mioty`}>mioty Network</Link>,
    });
  }

  const system: MenuItems = [];
  if (isAdmin) {
    system.push(
      {
        key: "ns-users",
        icon: <UserOutlined />,
        label: <Link to="/users">Users</Link>,
      },
      {
        key: "ns-api-keys",
        icon: <KeyOutlined />,
        label: <Link to="/api-keys">Server API Keys</Link>,
      },
    );
  }
  if (hasTenant) {
    system.push(
      {
        key: "tenant-users",
        icon: <TeamOutlined />,
        label: <Link to={`/tenants/${tenantId}/users`}>Tenant Users</Link>,
      },
      {
        key: "tenant-api-keys",
        icon: <KeyOutlined />,
        label: <Link to={`/tenants/${tenantId}/api-keys`}>Tenant API Keys</Link>,
      },
    );
  }

  const groups: MenuItems = [
    { type: "group", key: "overview", label: "Overview", children: overview },
    { type: "group", key: "management", label: "Management", children: management },
    { type: "group", key: "networks", label: "Networks", children: networks },
    { type: "group", key: "system", label: "System", children: system },
  ];

  return groups.filter(g => g !== null && "children" in g && (g.children?.length ?? 0) > 0);
}

/** Menu key for a location, most specific match last. */
export function selectedKeyForPath(path: string): string {
  let key = "";

  if (path === "/dashboard") {
    key = "ns-dashboard";
  }
  if (/\/tenants(\/([\w-]{36}\/edit|create))?/g.exec(path)) {
    key = "ns-tenants";
  }
  if (/\/users(\/([\w-]{36}\/edit|create))?/g.exec(path)) {
    key = "ns-users";
  }
  if (/\/api-keys(\/([\w-]{36}\/edit|create))?/g.exec(path)) {
    key = "ns-api-keys";
  }
  if (/\/device-profiles\/vendors.*/g.exec(path)) {
    key = "ns-device-profiles";
  }
  if (/\/regions.*/g.exec(path)) {
    key = "ns-regions";
  }
  if (/\/tenants\/[\w-]{36}/g.exec(path)) {
    key = "tenant-dashboard";
  }
  if (/\/tenants\/[\w-]{36}\/network-health.*/g.exec(path)) {
    key = "tenant-network-health";
  }
  if (/\/tenants\/[\w-]{36}\/mioty.*/g.exec(path)) {
    key = "tenant-mioty";
  }
  if (/\/tenants\/[\w-]{36}\/users.*/g.exec(path)) {
    key = "tenant-users";
  }
  if (/\/tenants\/[\w-]{36}\/api-keys.*/g.exec(path)) {
    key = "tenant-api-keys";
  }
  if (/\/tenants\/[\w-]{36}\/device-profiles.*/g.exec(path)) {
    key = "tenant-device-profiles";
  }
  if (/\/tenants\/[\w-]{36}\/gateways.*/g.exec(path)) {
    key = "tenant-gateways";
  }
  if (/\/tenants\/[\w-]{36}\/gateways\/mesh.*/g.exec(path)) {
    key = "tenant-gateways-mesh";
  }
  if (/\/tenants\/[\w-]{36}\/applications.*/g.exec(path)) {
    key = "tenant-applications";
  }

  return key;
}

function SideMenu() {
  const [tenantId, setTenantId] = useState<string>("");
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [version, setVersion] = useState<string>("");

  const location = useLocation();
  const navigate = useNavigate();

  const setTenant = () => {
    setTenantId(SessionStore.getTenantId());
  };

  const getTenantOptions = (search: string, fn: OptionsCallbackFunc) => {
    const req = new ListTenantsRequest();
    req.setSearch(search);
    req.setLimit(10);

    TenantStore.list(req, (resp: ListTenantsResponse) => {
      const options = resp.getResultList().map((o, i) => {
        return { label: o.getName(), value: o.getId() };
      });
      fn(options);
    });
  };

  const getTenantOption = (id: string, fn: OptionCallbackFunc) => {
    TenantStore.get(id, (resp: GetTenantResponse) => {
      const tenant = resp.getTenant();
      if (tenant) {
        fn({ label: tenant.getName(), value: tenant.getId() });
      }
    });
  };

  const onTenantSelect = (value: string) => {
    SessionStore.setTenantId(value);
    navigate(`/tenants/${value}`);
  };

  const parseLocation = useCallback(() => {
    const path = location.pathname;
    const tenantRe = /\/tenants\/([\w-]{36})/g;
    const match = tenantRe.exec(path);

    if (match !== null && tenantId !== match[1]) {
      SessionStore.setTenantId(match[1]);
    }

    const key = selectedKeyForPath(path);
    if (key !== "") {
      setSelectedKey(key);
    }
  }, [location.pathname, tenantId]);

  useEffect(() => {
    SessionStore.on("tenant.change", setTenant);
    setTenant();
    parseLocation();

    if (SessionStore.isAdmin()) {
      InternalStore.getVersion((resp: GetVersionResponse) => {
        setVersion(resp.getVersion());
      });
    }

    return () => {
      SessionStore.removeListener("tenant.change", setTenant);
    };
  }, [parseLocation]);

  useEffect(() => {
    parseLocation();
  }, [location, parseLocation]);

  const items = buildMenuItems(SessionStore.isAdmin(), tenantId);

  return (
    <div>
      <Autocomplete
        placeholder="Select tenant"
        className="tenant-select"
        getOption={getTenantOption}
        getOptions={getTenantOptions}
        onSelect={onTenantSelect}
        value={tenantId}
      />
      <Menu mode="inline" selectedKeys={[selectedKey]} items={items} />
      <Admin>
        <Typography.Text type="secondary" className="version">
          Version: v{version}
        </Typography.Text>
      </Admin>
    </div>
  );
}

export default SideMenu;
