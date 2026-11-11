import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DeviceProfile,
  ProfileProtocol,
  ListDeviceProfileAdrAlgorithmsResponse,
} from "@chirpstack/chirpstack-api-grpc-web/api/device_profile_pb";
import { ListRegionsResponse } from "@chirpstack/chirpstack-api-grpc-web/api/internal_pb";

vi.mock("../../stores/InternalStore", () => ({
  default: {
    listRegions: (callback: (value: ListRegionsResponse) => void) => callback(new ListRegionsResponse()),
  },
}));
vi.mock("../../stores/DeviceProfileStore", () => ({
  default: {
    listAdrAlgorithms: (callback: (value: ListDeviceProfileAdrAlgorithmsResponse) => void) =>
      callback(new ListDeviceProfileAdrAlgorithmsResponse()),
  },
}));
vi.mock("../../components/CodeEditor", () => ({ default: () => <div>Payload codec editor</div> }));

import DeviceProfileForm from "./DeviceProfileForm";

function profile(protocol = ProfileProtocol.PROFILE_LORAWAN) {
  const value = new DeviceProfile();
  value.setName("test profile");
  value.setProtocol(protocol);
  return value;
}

describe("protocol-aware device profiles", () => {
  it("retains LoRaWAN MAC configuration by default", () => {
    render(<DeviceProfileForm initialValues={profile()} onFinish={vi.fn()} />);
    expect(screen.getByLabelText(/MAC version/)).toBeInTheDocument();
    expect(screen.getByLabelText("Region")).toBeInTheDocument();
  });

  it("switches to mioty without presenting LoRaWAN radio settings and submits the protocol", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<DeviceProfileForm initialValues={profile()} onFinish={save} />);
    await user.click(screen.getByRole("combobox", { name: "Technology" }));
    await user.click(await screen.findByTitle("mioty"));
    expect(screen.queryByLabelText(/MAC version/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Region")).not.toBeInTheDocument();
    expect(screen.getByText("mioty device profile")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const value = save.mock.calls[0][0] as DeviceProfile;
    expect(value.getProtocol()).toBe(ProfileProtocol.PROFILE_MIOTY);
    expect(value.getName()).toBe("test profile");
    expect(value.getSupportsOtaa()).toBe(false);
    expect(value.getSupportsClassB()).toBe(false);
  });

  it("keeps a read-only mioty profile disabled", () => {
    render(<DeviceProfileForm initialValues={profile(ProfileProtocol.PROFILE_MIOTY)} onFinish={vi.fn()} disabled />);
    expect(screen.getByRole("combobox", { name: "Technology" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
  });
});
