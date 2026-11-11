import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  Gateway,
  GatewayType,
  GetMiotyRfConfigResponse,
  MiotyRfChannel,
  MiotyRfConfig,
} from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";
import type {
  GetMiotyRfConfigRequest,
  UpdateMiotyRfConfigRequest,
} from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";

const mocks = vi.hoisted(() => ({
  getMiotyRfConfig: vi.fn(),
  updateMiotyRfConfig: vi.fn(),
  isAdmin: vi.fn(),
  isTenantAdmin: vi.fn(),
  isTenantGatewayAdmin: vi.fn(),
}));

vi.mock("../../stores/GatewayStore", () => ({
  default: { getMiotyRfConfig: mocks.getMiotyRfConfig, updateMiotyRfConfig: mocks.updateMiotyRfConfig },
}));
vi.mock("../../stores/SessionStore", () => ({
  default: {
    isAdmin: mocks.isAdmin,
    isTenantAdmin: mocks.isTenantAdmin,
    isTenantGatewayAdmin: mocks.isTenantGatewayAdmin,
  },
}));

import MiotyRfPolicy from "./MiotyRfPolicy";

const GATEWAY_ID = "0202020202020202";

function gateway(): Gateway {
  const gw = new Gateway();
  gw.setGatewayId(GATEWAY_ID);
  gw.setTenantId("52f14cd4-c6f1-4fbd-8f87-4025e1d49242");
  gw.setGatewayType(GatewayType.MIOTY);
  return gw;
}

// Response as produced by chirpstack/src/api/gateway.rs get_mioty_rf_config.
function response(config?: MiotyRfConfig, opts: { txSupported?: boolean; bidi?: boolean } = {}) {
  const resp = new GetMiotyRfConfigResponse();
  resp.setDisplayName("Thailand 920–925 MHz (Experimental)");
  resp.setMinFrequencyHz(920_000_000);
  resp.setMaxFrequencyHz(925_000_000);
  resp.setExperimental(true);
  resp.setTxSupported(opts.txSupported ?? false);
  resp.setTxBlockersList([
    "No verified TH920_925 hardware/firmware capability and channel-plan driver",
    "Thailand interoperability and applicable NBTC requirements remain unvalidated",
  ]);
  if (opts.bidi !== undefined) {
    resp.setReportedBidirectional(opts.bidi);
  }
  if (config) {
    resp.setConfig(config);
  }
  return resp;
}

function persistedConfig() {
  const config = new MiotyRfConfig();
  config.setProfileId("TH920_925");
  const ch = new MiotyRfChannel();
  ch.setCenterFrequencyHz(922_500_001);
  ch.setOccupiedBandwidthHz(100_500);
  config.setChannelsList([ch]);
  config.setConductedPowerMdbm(14_000);
  config.setAntennaGainMdbi(2_150);
  config.setCableLossMdb(500);
  return config;
}

function serve(resp: GetMiotyRfConfigResponse) {
  mocks.getMiotyRfConfig.mockImplementation(
    (_req: GetMiotyRfConfigRequest, cb: (r: GetMiotyRfConfigResponse) => void) => cb(resp),
  );
}

function lastUpdate(): UpdateMiotyRfConfigRequest {
  const calls = mocks.updateMiotyRfConfig.mock.calls;
  return calls[calls.length - 1][0] as UpdateMiotyRfConfigRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAdmin.mockReturnValue(true);
  mocks.isTenantAdmin.mockReturnValue(false);
  mocks.isTenantGatewayAdmin.mockReturnValue(false);
  mocks.updateMiotyRfConfig.mockImplementation((_req: UpdateMiotyRfConfigRequest, cb: () => void) => cb());
});

describe("MiotyRfPolicy", () => {
  it("ignores a previous Base Station's late response after navigation", async () => {
    const callbacks: ((resp: GetMiotyRfConfigResponse) => void)[] = [];
    mocks.getMiotyRfConfig.mockImplementation(
      (_req: GetMiotyRfConfigRequest, cb: (resp: GetMiotyRfConfigResponse) => void) => {
        callbacks.push(cb);
      },
    );
    const { rerender } = render(<MiotyRfPolicy gateway={gateway()} />);
    const nextGateway = gateway();
    nextGateway.setGatewayId("0303030303030303");
    rerender(<MiotyRfPolicy gateway={nextGateway} />);
    const latest = persistedConfig();
    latest.getChannelsList()[0].setCenterFrequencyHz(923_000_000);
    act(() => callbacks[1](response(latest)));
    expect(await screen.findByDisplayValue("923.000")).toBeInTheDocument();
    act(() => callbacks[0](response(persistedConfig())));
    expect(screen.getByDisplayValue("923.000")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("922.500001")).not.toBeInTheDocument();
  });

  it("keeps transmission disabled when a capability flag conflicts with policy blockers", () => {
    serve(response(undefined, { txSupported: true, bidi: true }));
    render(<MiotyRfPolicy gateway={gateway()} />);
    expect(screen.getByRole("radio", { name: "Transmit-enabled" })).toBeDisabled();
  });
  it("requests the policy of the displayed Base Station", () => {
    serve(response());
    render(<MiotyRfPolicy gateway={gateway()} />);
    expect(mocks.getMiotyRfConfig).toHaveBeenCalledTimes(1);
    expect((mocks.getMiotyRfConfig.mock.calls[0][0] as GetMiotyRfConfigRequest).getGatewayId()).toBe(GATEWAY_ID);
  });

  it("shows the experimental disclaimer, boundaries and server-reported blockers", () => {
    serve(response());
    render(<MiotyRfPolicy gateway={gateway()} />);

    expect(screen.getByText(/is a custom, experimental regional profile/)).toBeInTheDocument();
    expect(screen.getByText(/not an official mioty Alliance regional profile/)).toBeInTheDocument();
    expect(screen.getByText(/does not establish regulatory authorization/)).toBeInTheDocument();
    expect(screen.getByText("920.000 MHz (920000000 Hz)")).toBeInTheDocument();
    expect(screen.getByText("925.000 MHz (925000000 Hz)")).toBeInTheDocument();
    expect(screen.getByText("Not selected")).toBeInTheDocument();
    expect(screen.getByText(/No verified TH920_925 hardware\/firmware capability/)).toBeInTheDocument();
    expect(screen.getByText(/NBTC requirements remain unvalidated/)).toBeInTheDocument();
    expect(screen.getByText(/Not reported \(the Base Station has not connected yet\)/)).toBeInTheDocument();
  });

  it("keeps transmit-enabled unavailable while the server reports no TX support", () => {
    serve(response(undefined, { bidi: true }));
    render(<MiotyRfPolicy gateway={gateway()} />);

    expect(screen.getByRole("radio", { name: "Receive-only" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Transmit-enabled" })).toBeDisabled();
    expect(screen.getByText(/Transmit-enabled is unavailable/)).toBeInTheDocument();
  });

  it("does not let a bidirectional declaration enable transmission", async () => {
    const user = userEvent.setup();
    serve(response(persistedConfig(), { bidi: true }));
    render(<MiotyRfPolicy gateway={gateway()} />);

    await user.click(screen.getByRole("radio", { name: "Transmit-enabled" })).catch(() => undefined);
    await user.click(screen.getByRole("button", { name: "Update RF policy" }));

    await waitFor(() => expect(mocks.updateMiotyRfConfig).toHaveBeenCalledTimes(1));
    expect(lastUpdate().getConfig()!.getTxEnabled()).toBe(false);
  });

  it("offers transmit-enabled only when the server reports TX support", () => {
    const ready = response(persistedConfig(), { txSupported: true });
    ready.setTxBlockersList([]);
    serve(ready);
    render(<MiotyRfPolicy gateway={gateway()} />);
    expect(screen.getByRole("radio", { name: "Transmit-enabled" })).toBeEnabled();
  });

  it("populates the form from the persisted policy with exact values", async () => {
    serve(response(persistedConfig()));
    render(<MiotyRfPolicy gateway={gateway()} />);

    expect(screen.getByText("Selected")).toBeInTheDocument();
    expect(await screen.findByDisplayValue("922.500001")).toBeInTheDocument();
    expect(screen.getByDisplayValue("100.5")).toBeInTheDocument();
    expect(screen.getByLabelText("Conducted TX power")).toHaveValue("14.0");
    expect(screen.getByLabelText("Antenna gain")).toHaveValue("2.15");
    expect(screen.getByLabelText("Cable loss")).toHaveValue("0.5");
    // The ceiling was never set: it is shown empty, not as zero.
    expect(screen.getByLabelText("EIRP ceiling")).toHaveValue("");
    await waitFor(() => expect(screen.getByTestId("calculated-eirp")).toHaveTextContent("15.65 dBm"));
    expect(screen.getByTestId("channel-0-range")).toHaveTextContent("922.449751 – 922.550251 MHz");
  });

  it("rejects a channel whose occupied bandwidth crosses the band edge and does not call the API", async () => {
    const user = userEvent.setup();
    serve(response(persistedConfig()));
    render(<MiotyRfPolicy gateway={gateway()} />);

    const center = await screen.findByDisplayValue("922.500001");
    await user.clear(center);
    await user.type(center, "920.05");
    const width = screen.getByDisplayValue("100.5");
    await user.clear(width);
    await user.type(width, "200");

    await user.click(screen.getByRole("button", { name: "Update RF policy" }));

    expect(
      await screen.findByText(/lower edge of the occupied bandwidth \(919.950 MHz\) is below/),
    ).toBeInTheDocument();
    expect(mocks.updateMiotyRfConfig).not.toHaveBeenCalled();
  });

  it("rejects a center frequency outside 920–925 MHz", async () => {
    const user = userEvent.setup();
    serve(response(persistedConfig()));
    render(<MiotyRfPolicy gateway={gateway()} />);

    const center = await screen.findByDisplayValue("922.500001");
    await user.clear(center);
    await user.type(center, "925.1");
    await user.click(screen.getByRole("button", { name: "Update RF policy" }));

    expect(
      await screen.findByText(/upper edge of the occupied bandwidth .* is above the 920.000–925.000 MHz band/),
    ).toBeInTheDocument();
    expect(mocks.updateMiotyRfConfig).not.toHaveBeenCalled();
  });

  it("rejects an EIRP above the ceiling", async () => {
    const user = userEvent.setup();
    serve(response(persistedConfig()));
    render(<MiotyRfPolicy gateway={gateway()} />);

    await screen.findByDisplayValue("922.500001");
    await user.type(screen.getByLabelText("EIRP ceiling"), "15.649");
    await user.click(screen.getByRole("button", { name: "Update RF policy" }));

    expect(
      await screen.findByText(/calculated EIRP \(15.65 dBm\) exceeds the configured ceiling \(15.649 dBm\)/),
    ).toBeInTheDocument();
    expect(mocks.updateMiotyRfConfig).not.toHaveBeenCalled();
  });

  it("sends exact integers, keeps blank power inputs absent, and reloads after saving", async () => {
    const user = userEvent.setup();
    serve(response(persistedConfig()));
    render(<MiotyRfPolicy gateway={gateway()} />);

    await screen.findByDisplayValue("922.500001");
    await user.click(screen.getByRole("button", { name: /Add channel/ }));
    await user.type(screen.getByLabelText("Channel 2 center frequency"), "920.1");
    const widths = screen.getAllByLabelText("Occupied bandwidth");
    await user.type(widths[1], "200");
    await user.clear(screen.getByLabelText("Cable loss"));
    await user.click(screen.getByRole("button", { name: "Update RF policy" }));

    await waitFor(() => expect(mocks.updateMiotyRfConfig).toHaveBeenCalledTimes(1));
    const req = lastUpdate();
    const config = req.getConfig()!;
    expect(req.getGatewayId()).toBe(GATEWAY_ID);
    expect(config.getProfileId()).toBe("TH920_925");
    expect(config.getTxEnabled()).toBe(false);
    expect(config.getChannelsList().map(c => [c.getCenterFrequencyHz(), c.getOccupiedBandwidthHz()])).toEqual([
      [922_500_001, 100_500],
      [920_100_000, 200_000],
    ]);
    expect(config.getConductedPowerMdbm()).toBe(14_000);
    expect(config.getAntennaGainMdbi()).toBe(2_150);
    expect(config.hasCableLossMdb()).toBe(false);
    expect(config.hasMaxEirpMdbm()).toBe(false);
    // Initial load + reload after the successful update.
    expect(mocks.getMiotyRfConfig).toHaveBeenCalledTimes(2);
  });

  it("asks for confirmation before the first selection and sends an empty receive-only policy", async () => {
    const user = userEvent.setup();
    serve(response());
    render(<MiotyRfPolicy gateway={gateway()} />);

    await user.click(screen.getByRole("button", { name: "Select TH920_925 policy" }));
    expect(mocks.updateMiotyRfConfig).not.toHaveBeenCalled();
    expect(await screen.findByText(/the API offers no way to remove it/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Select policy" }));
    await waitFor(() => expect(mocks.updateMiotyRfConfig).toHaveBeenCalledTimes(1));
    const config = lastUpdate().getConfig()!;
    expect(config.getProfileId()).toBe("TH920_925");
    expect(config.getTxEnabled()).toBe(false);
    expect(config.getChannelsList()).toHaveLength(0);
    expect(config.hasConductedPowerMdbm()).toBe(false);
    expect(config.hasAntennaGainMdbi()).toBe(false);
  });

  it("is read-only without gateway administration permission", async () => {
    mocks.isAdmin.mockReturnValue(false);
    serve(response(persistedConfig()));
    render(<MiotyRfPolicy gateway={gateway()} />);

    expect(await screen.findByDisplayValue("922.500001")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Update RF policy" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Add channel/ })).toBeDisabled();
    expect(screen.getByText(/You have read-only access/)).toBeInTheDocument();
  });

  it("allows a tenant gateway admin to edit", async () => {
    mocks.isAdmin.mockReturnValue(false);
    mocks.isTenantGatewayAdmin.mockReturnValue(true);
    serve(response(persistedConfig()));
    render(<MiotyRfPolicy gateway={gateway()} />);

    expect(await screen.findByDisplayValue("922.500001")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Update RF policy" })).toBeEnabled();
    expect(mocks.isTenantGatewayAdmin).toHaveBeenCalledWith("52f14cd4-c6f1-4fbd-8f87-4025e1d49242");
  });

  it("shows the server error when the update is refused and keeps the form", async () => {
    const user = userEvent.setup();
    serve(response(persistedConfig()));
    mocks.updateMiotyRfConfig.mockImplementation(
      (_req: UpdateMiotyRfConfigRequest, _cb: () => void, errCb: (e: { message: string }) => void) =>
        errCb({ message: "config.tx_enabled: TH920_925 transmission is unsupported" }),
    );
    render(<MiotyRfPolicy gateway={gateway()} />);

    await screen.findByDisplayValue("922.500001");
    await user.click(screen.getByRole("button", { name: "Update RF policy" }));

    const alert = await screen.findByText("The RF policy was not saved");
    expect(alert).toBeInTheDocument();
    expect(screen.getByText(/TH920_925 transmission is unsupported/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("922.500001")).toBeInTheDocument();
  });

  it("renders an inline error state when the policy cannot be loaded", () => {
    mocks.getMiotyRfConfig.mockImplementation(
      (_req: GetMiotyRfConfigRequest, _cb: unknown, errCb: (e: { message: string }) => void) =>
        errCb({ message: "RF policy requires a mioty gateway" }),
    );
    render(<MiotyRfPolicy gateway={gateway()} />);

    expect(screen.getByText("The RF policy of this Base Station could not be loaded")).toBeInTheDocument();
    expect(screen.getByText("RF policy requires a mioty gateway")).toBeInTheDocument();
    expect(within(document.body).queryByRole("button", { name: /RF policy$/ })).not.toBeInTheDocument();
  });
});
