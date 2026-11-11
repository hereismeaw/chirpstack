import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Gateway, GatewayType } from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";

vi.mock("../../components/Map", () => ({ default: () => null, Marker: () => null }));
vi.mock("../../stores/LocationStore", () => ({
  default: {
    getLocation: (callback: (loc: [number, number]) => void) => callback([0, 0]),
  },
}));
import GatewayForm from "./GatewayForm";

function gateway() {
  const value = new Gateway();
  value.setTenantId("52f14cd4-c6f1-4fbd-8f87-4025e1d49242");
  value.setStatsInterval(30);
  value.setDownlinkPriority(10);
  return value;
}

describe("gateway technology", () => {
  it("preserves LoRaWAN registration as the default", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<GatewayForm initialValues={gateway()} onFinish={save} />);
    expect(screen.getByLabelText("Gateway ID (EUI64)")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "LoRaWAN gateway");
    await user.type(screen.getByLabelText("Gateway ID (EUI64)"), "0102030405060708");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect((save.mock.calls[0][0] as Gateway).getGatewayType()).toBe(GatewayType.LORAWAN);
  });

  it("registers a mioty Base Station with its own identity and existing tenant", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<GatewayForm initialValues={gateway()} onFinish={save} />);
    await user.click(screen.getByRole("combobox", { name: "Technology" }));
    await user.click(await screen.findByTitle("mioty Base Station"));
    expect(screen.queryByLabelText("Gateway ID (EUI64)")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "Base Station");
    await user.type(screen.getByLabelText("Base Station EUI (EUI64)"), "0202030405060708");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const saved = save.mock.calls[0][0] as Gateway;
    expect(saved.getGatewayType()).toBe(GatewayType.MIOTY);
    expect(saved.getGatewayId()).toBe("0202030405060708");
    expect(saved.getTenantId()).toBe(gateway().getTenantId());
  });

  it("locks technology and identity of existing Base Stations", () => {
    const existing = gateway();
    existing.setGatewayType(GatewayType.MIOTY);
    existing.setGatewayId("0202030405060708");
    render(<GatewayForm initialValues={existing} onFinish={vi.fn()} update />);
    expect(screen.getByRole("combobox", { name: "Technology" })).toBeDisabled();
    expect(screen.getByLabelText("Base Station EUI (EUI64)")).toBeDisabled();
  });
});
