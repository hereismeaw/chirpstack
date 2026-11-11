import { DeviceType } from "@chirpstack/chirpstack-api-grpc-web/api/device_pb";
import { GatewayType } from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";

export type Protocol = "lorawan" | "mioty";

export const PROTOCOLS: Protocol[] = ["lorawan", "mioty"];

export function protocolLabel(p: Protocol): string {
  return p === "mioty" ? "mioty" : "LoRaWAN";
}

export function deviceProtocol(t: DeviceType): Protocol {
  return t === DeviceType.MIOTY_DEVICE ? "mioty" : "lorawan";
}

export function gatewayProtocol(t: GatewayType): Protocol {
  return t === GatewayType.MIOTY ? "mioty" : "lorawan";
}

/** Name of the radio access node in the vocabulary of each technology. */
export function gatewayNoun(p: Protocol): string {
  return p === "mioty" ? "Base Station" : "Gateway";
}

/** Name of the field device in the vocabulary of each technology. */
export function deviceNoun(p: Protocol): string {
  return p === "mioty" ? "End Point" : "Device";
}
