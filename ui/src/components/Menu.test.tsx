import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Menu } from "antd";
import { buildMenuItems, selectedKeyForPath } from "./Menu";

const tenant = "52f14cd4-c6f1-4fbd-8f87-4025e1d49242";

describe("multi-protocol navigation", () => {
  it("offers tenant routes without server administration to a tenant user", () => {
    render(
      <MemoryRouter>
        <Menu items={buildMenuItems(false, tenant)} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "mioty Network" })).toHaveAttribute("href", `/tenants/${tenant}/mioty`);
    expect(screen.getByRole("link", { name: "Network health" })).toHaveAttribute(
      "href",
      `/tenants/${tenant}/network-health`,
    );
    expect(screen.getByRole("link", { name: "Applications and devices" })).toHaveAttribute(
      "href",
      `/tenants/${tenant}/applications`,
    );
    expect(screen.queryByRole("link", { name: "Server API Keys" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
  });

  it("preserves existing deep-link selection for both technologies", () => {
    expect(selectedKeyForPath(`/tenants/${tenant}/gateways/0102030405060708/rf`)).toBe("tenant-gateways");
    expect(selectedKeyForPath(`/tenants/${tenant}/gateways/mesh/relays/00000001`)).toBe("tenant-gateways-mesh");
    expect(
      selectedKeyForPath(
        `/tenants/${tenant}/applications/07070707-0707-0707-0707-070707070707/devices/0102030405060708/events`,
      ),
    ).toBe("tenant-applications");
    expect(selectedKeyForPath("/regions/eu868")).toBe("ns-regions");
  });
});
