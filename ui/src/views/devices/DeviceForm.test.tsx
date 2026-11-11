import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Device, DeviceType, MiotyDevice } from "@chirpstack/chirpstack-api-grpc-web/api/device_pb";
import { Tenant } from "@chirpstack/chirpstack-api-grpc-web/api/tenant_pb";

const mocks = vi.hoisted(() => ({
  profileSelectProps: vi.fn(),
}));

const PROFILE_ID = "0b1e2d3c-4f5a-4b6c-8d7e-9f0a1b2c3d4e";

// The real selector loads profiles from the API; the form only needs the
// cascader path it stores in `deviceProfileId`.
vi.mock("../../components/DeviceProfileSelect", async () => {
  const { Form } = await import("antd");
  const { useEffect } = await import("react");
  return {
    default: (props: { name: string; protocol?: string }) => {
      const form = Form.useFormInstance();
      mocks.profileSelectProps(props);
      useEffect(() => {
        form.setFieldValue(props.name, ["tenant", "0b1e2d3c-4f5a-4b6c-8d7e-9f0a1b2c3d4e"]);
      }, [form, props.name]);
      return (
        <Form.Item name={props.name} hidden>
          <input />
        </Form.Item>
      );
    },
  };
});
vi.mock("../../stores/DeviceProfileStore", () => ({ default: { getByProfileId: vi.fn() } }));
vi.mock("@yudiel/react-qr-scanner", () => ({ Scanner: () => null }));

import DeviceForm from "./DeviceForm";

const NETWORK_KEY = "000102030405060708090a0b0c0d0e0f";
const APPLICATION_KEY = "f0e0d0c0b0a090807060504030201000";

function tenant(): Tenant {
  const t = new Tenant();
  t.setId("52f14cd4-c6f1-4fbd-8f87-4025e1d49242");
  return t;
}

function newDevice(): Device {
  const d = new Device();
  d.setApplicationId("17c82e96-be03-4f38-aef3-f83d48582d97");
  return d;
}

// A stored End Point as returned by DeviceService.Get: keys are never included.
function storedEndPoint(epClass = "A"): Device {
  const d = newDevice();
  d.setDevEui("70b3d56770000001");
  d.setName("ep-1");
  d.setDeviceType(DeviceType.MIOTY_DEVICE);
  d.setDeviceProfileId(PROFILE_ID);
  const m = new MiotyDevice();
  m.setEpClass(epClass);
  m.setShortAddress(4660);
  m.setPreAttach(true);
  m.setApplicationCrypto(17);
  m.setRepetition(true);
  d.setMioty(m);
  return d;
}

async function selectOption(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByTitle(option));
}

function lastSubmitted(onFinish: ReturnType<typeof vi.fn>): Device {
  return onFinish.mock.calls[onFinish.mock.calls.length - 1][0] as Device;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DeviceForm protocol selector", () => {
  it("defaults to LoRaWAN and shows only LoRaWAN fields", () => {
    render(<DeviceForm tenant={tenant()} initialValues={newDevice()} onFinish={vi.fn()} />);

    expect(screen.getByText("LoRaWAN device")).toBeInTheDocument();
    expect(screen.getByLabelText("Device EUI (EUI64)")).toBeInTheDocument();
    expect(screen.getByLabelText("Join EUI (EUI64)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan QR-code" })).toBeInTheDocument();
    expect(screen.queryByLabelText("End Point class")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Network key")).not.toBeInTheDocument();
    expect(mocks.profileSelectProps).toHaveBeenLastCalledWith(expect.objectContaining({ protocol: "lorawan" }));
  });

  it("shows mioty fields and hides LoRaWAN fields after selecting mioty", async () => {
    const user = userEvent.setup();
    render(<DeviceForm tenant={tenant()} initialValues={newDevice()} onFinish={vi.fn()} />);

    await selectOption(user, "Technology", "mioty End Point");

    expect(await screen.findByLabelText("End Point class")).toBeInTheDocument();
    expect(screen.getByLabelText("End Point EUI (EUI64)")).toBeInTheDocument();
    expect(screen.getByLabelText("Short address")).toBeInTheDocument();
    expect(screen.getByLabelText("Network key")).toBeInTheDocument();
    expect(screen.getByLabelText("Pre-attach")).toBeChecked();
    // LoRaWAN identifiers and controls are not offered for an End Point.
    expect(screen.queryByLabelText("Join EUI (EUI64)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Device EUI (EUI64)")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scan QR-code" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Disable frame-counter validation").closest(".ant-form-item")).toHaveClass(
      "ant-form-item-hidden",
    );
    expect(mocks.profileSelectProps).toHaveBeenLastCalledWith(expect.objectContaining({ protocol: "mioty" }));
  });

  it("locks the technology of an existing device", () => {
    render(<DeviceForm tenant={tenant()} initialValues={storedEndPoint()} onFinish={vi.fn()} update />);
    expect(screen.getByRole("combobox", { name: "Technology" })).toBeDisabled();
    expect(screen.getByLabelText("End Point EUI (EUI64)")).toBeDisabled();
  });
});

describe("mioty End Point registration", () => {
  it("does not submit hidden LoRaWAN settings after switching technology", async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<DeviceForm tenant={tenant()} initialValues={newDevice()} onFinish={onFinish} />);
    await user.type(screen.getByLabelText("Join EUI (EUI64)"), "0807060504030201");
    await user.click(screen.getByLabelText("Disable frame-counter validation"));
    await selectOption(user, "Technology", "mioty End Point");
    await user.type(screen.getByLabelText("Name"), "ep-switch");
    await user.type(screen.getByLabelText("End Point EUI (EUI64)"), "70b3d56770000001");
    await user.type(screen.getByLabelText("Network key"), NETWORK_KEY);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onFinish).toHaveBeenCalledOnce());
    expect(lastSubmitted(onFinish).getJoinEui()).toBe("");
    expect(lastSubmitted(onFinish).getSkipFcntCheck()).toBe(false);
  });

  it("submits the End Point with its mioty settings", async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<DeviceForm tenant={tenant()} initialValues={newDevice()} onFinish={onFinish} />);

    await selectOption(user, "Technology", "mioty End Point");
    await user.type(await screen.findByLabelText("Name"), "ep-1");
    await user.type(screen.getByLabelText("End Point EUI (EUI64)"), "70b3d56770000001");
    await user.clear(screen.getByLabelText("Short address"));
    await user.type(screen.getByLabelText("Short address"), "4660");
    await user.type(screen.getByLabelText("Network key"), NETWORK_KEY);
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
    const d = lastSubmitted(onFinish);
    expect(d.getDeviceType()).toBe(DeviceType.MIOTY_DEVICE);
    expect(d.getDevEui()).toBe("70b3d56770000001");
    expect(d.getName()).toBe("ep-1");
    expect(d.getDeviceProfileId()).toBe(PROFILE_ID);
    expect(d.getJoinEui()).toBe("");
    const m = d.getMioty()!;
    expect(m.getEpClass()).toBe("Z");
    expect(m.getShortAddress()).toBe(4660);
    expect(m.getNetworkKey()).toBe(NETWORK_KEY);
    expect(m.getApplicationKey()).toBe("");
    expect(m.getApplicationCrypto()).toBe(0);
    expect(m.getPreAttach()).toBe(true);
    expect(m.getRepetition()).toBe(false);
    expect(m.getLongBlockDistance()).toBe(false);
  });

  it("requires a 32 character hexadecimal network key", async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<DeviceForm tenant={tenant()} initialValues={newDevice()} onFinish={onFinish} />);

    await selectOption(user, "Technology", "mioty End Point");
    await user.type(await screen.findByLabelText("Name"), "ep-1");
    await user.type(screen.getByLabelText("End Point EUI (EUI64)"), "70b3d56770000001");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Please enter the network key!")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Network key"), "0011zz");
    expect(await screen.findByText("Enter 32 hexadecimal characters (AES-128 key).")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("asks for the application key only when application cryptography is used", async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<DeviceForm tenant={tenant()} initialValues={newDevice()} onFinish={onFinish} />);

    await selectOption(user, "Technology", "mioty End Point");
    await screen.findByLabelText("Network key");
    expect(screen.queryByLabelText("Application key")).not.toBeInTheDocument();

    await selectOption(user, "Application cryptography", "Confidentiality and authenticity (17)");
    const appKey = await screen.findByLabelText("Application key");

    await user.type(screen.getByLabelText("Name"), "ep-1");
    await user.type(screen.getByLabelText("End Point EUI (EUI64)"), "70b3d56770000001");
    await user.type(screen.getByLabelText("Network key"), NETWORK_KEY);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Please enter the application key!")).toBeInTheDocument();
    expect(onFinish).not.toHaveBeenCalled();

    await user.type(appKey, APPLICATION_KEY);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
    const m = lastSubmitted(onFinish).getMioty()!;
    expect(m.getApplicationCrypto()).toBe(17);
    expect(m.getApplicationKey()).toBe(APPLICATION_KEY);
  });

  it("requires pre-attach for class A and offers downlink options only for class A", async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<DeviceForm tenant={tenant()} initialValues={newDevice()} onFinish={onFinish} />);

    await selectOption(user, "Technology", "mioty End Point");
    await screen.findByLabelText("End Point class");
    expect(screen.queryByLabelText("Downlink repetition")).not.toBeInTheDocument();

    await selectOption(user, "End Point class", "A (bidirectional, downlink after uplink)");
    expect(await screen.findByLabelText("Downlink repetition")).toBeInTheDocument();
    expect(screen.getByLabelText("Long downlink block distance")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Pre-attach"));
    expect(await screen.findByText("Class A End Points require pre-attach.")).toBeInTheDocument();
  });
});

describe("mioty End Point editing", () => {
  it("never pre-fills keys and keeps stored keys when they are left empty", async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<DeviceForm tenant={tenant()} initialValues={storedEndPoint()} onFinish={onFinish} update />);

    expect(screen.getByLabelText("Network key")).toHaveValue("");
    expect(screen.getByLabelText("Application key")).toHaveValue("");
    expect(screen.getAllByText(/Leave empty to keep the current key/)).toHaveLength(2);
    expect(screen.getByLabelText("Short address")).toHaveValue("4660");

    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
    const m = lastSubmitted(onFinish).getMioty()!;
    // Empty keys instruct the server to preserve the stored ones.
    expect(m.getNetworkKey()).toBe("");
    expect(m.getApplicationKey()).toBe("");
    expect(m.getEpClass()).toBe("A");
    expect(m.getShortAddress()).toBe(4660);
    expect(m.getApplicationCrypto()).toBe(17);
    expect(m.getRepetition()).toBe(true);
  });

  it("clears downlink options when the End Point is stored as class Z", async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<DeviceForm tenant={tenant()} initialValues={storedEndPoint("Z")} onFinish={onFinish} update />);

    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
    expect(lastSubmitted(onFinish).getMioty()!.getRepetition()).toBe(false);
  });
});

describe("LoRaWAN regression", () => {
  it("submits a LoRaWAN device without mioty settings", async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<DeviceForm tenant={tenant()} initialValues={newDevice()} onFinish={onFinish} />);

    await user.type(screen.getByLabelText("Name"), "lw-1");
    await user.type(screen.getByLabelText("Device EUI (EUI64)"), "0102030405060708");
    await user.type(screen.getByLabelText("Join EUI (EUI64)"), "0807060504030201");
    await user.click(screen.getByLabelText("Disable frame-counter validation"));
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
    const d = lastSubmitted(onFinish);
    expect(d.getDeviceType()).toBe(DeviceType.LORAWAN_DEVICE);
    expect(d.hasMioty()).toBe(false);
    expect(d.getDevEui()).toBe("0102030405060708");
    expect(d.getJoinEui()).toBe("0807060504030201");
    expect(d.getSkipFcntCheck()).toBe(true);
    expect(d.getDeviceProfileId()).toBe(PROFILE_ID);
    expect(d.getApplicationId()).toBe("17c82e96-be03-4f38-aef3-f83d48582d97");
  });
});
