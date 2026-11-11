// Mapping between the RF policy form (operator-facing decimal strings) and the
// MiotyRfConfig API message (exact integers). Blank optional power inputs stay
// absent in the message; they are never converted to zero.

import { MiotyRfChannel, MiotyRfConfig } from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";

import type { Band, Channel, PowerBudget } from "./miotyRf";
import {
  formatHzAsKhz,
  formatHzAsMhz,
  formatMilliUnits,
  parseKhzToHz,
  parseMhzToHz,
  parseMilliUnits,
  validateChannels,
  validatePowerBudget,
} from "./miotyRf";

export interface ChannelFormValue {
  centerMhz?: string;
  bandwidthKhz?: string;
}

export interface RfFormValues {
  txEnabled: boolean;
  channels: ChannelFormValue[];
  conductedPowerDbm?: string;
  antennaGainDbi?: string;
  cableLossDb?: string;
  maxEirpDbm?: string;
}

export function emptyFormValues(): RfFormValues {
  return { txEnabled: false, channels: [], conductedPowerDbm: "", antennaGainDbi: "", cableLossDb: "", maxEirpDbm: "" };
}

/** Values shown in the form for a persisted policy (or the empty form when none is selected). */
export function configToFormValues(config: MiotyRfConfig | undefined): RfFormValues {
  if (!config) {
    return emptyFormValues();
  }
  return {
    txEnabled: config.getTxEnabled(),
    channels: config.getChannelsList().map(ch => ({
      centerMhz: formatHzAsMhz(ch.getCenterFrequencyHz()),
      bandwidthKhz: formatHzAsKhz(ch.getOccupiedBandwidthHz()),
    })),
    conductedPowerDbm: config.hasConductedPowerMdbm() ? formatMilliUnits(config.getConductedPowerMdbm()) : "",
    antennaGainDbi: config.hasAntennaGainMdbi() ? formatMilliUnits(config.getAntennaGainMdbi()) : "",
    cableLossDb: config.hasCableLossMdb() ? formatMilliUnits(config.getCableLossMdb()) : "",
    maxEirpDbm: config.hasMaxEirpMdbm() ? formatMilliUnits(config.getMaxEirpMdbm()) : "",
  };
}

function isBlank(v: string | undefined): boolean {
  return v === undefined || v.trim() === "";
}

/** Parses one channel row; undefined while either input is missing or malformed. */
export function parseChannel(v: ChannelFormValue | undefined): Channel | undefined {
  const center = parseMhzToHz(v?.centerMhz ?? "");
  const width = parseKhzToHz(v?.bandwidthKhz ?? "");
  if (!center.ok || !width.ok) {
    return undefined;
  }
  return { centerHz: center.value, occupiedBandwidthHz: width.value };
}

/** Parses the power inputs that are present and well-formed; others stay undefined. */
export function parsePowerBudget(v: Partial<RfFormValues>): PowerBudget {
  const opt = (s: string | undefined, kind: "int32" | "uint32") => {
    if (isBlank(s)) {
      return undefined;
    }
    const r = parseMilliUnits(s!, kind);
    return r.ok ? r.value : undefined;
  };
  return {
    conductedPowerMdbm: opt(v.conductedPowerDbm, "int32"),
    antennaGainMdbi: opt(v.antennaGainDbi, "int32"),
    cableLossMdb: opt(v.cableLossDb, "uint32"),
    maxEirpMdbm: opt(v.maxEirpDbm, "int32"),
  };
}

export type BuildResult = { ok: true; config: MiotyRfConfig } | { ok: false; errors: string[] };

/**
 * Builds the API message from form values, repeating every validation. A form
 * with errors never produces a message. `txSupported` is the backend's
 * capability report: transmission cannot be requested without it.
 */
export function formValuesToConfig(
  profileId: string,
  values: RfFormValues,
  band: Band,
  txSupported: boolean,
): BuildResult {
  const errors: string[] = [];
  const config = new MiotyRfConfig();
  config.setProfileId(profileId);

  if (values.txEnabled && !txSupported) {
    errors.push("Transmission is not supported for this regional profile and cannot be enabled.");
  }
  config.setTxEnabled(values.txEnabled && txSupported);

  const channels: Channel[] = [];
  (values.channels ?? []).forEach((row, i) => {
    const center = parseMhzToHz(row?.centerMhz ?? "");
    const width = parseKhzToHz(row?.bandwidthKhz ?? "");
    if (!center.ok) {
      errors.push(`Channel ${i + 1} center frequency: ${center.error}`);
    }
    if (!width.ok) {
      errors.push(`Channel ${i + 1} occupied bandwidth: ${width.error}`);
    }
    if (center.ok && width.ok) {
      channels.push({ centerHz: center.value, occupiedBandwidthHz: width.value });
    }
  });

  if (errors.length === 0) {
    const result = validateChannels(channels, band);
    result.perChannel.forEach((err, i) => {
      if (err) {
        errors.push(`Channel ${i + 1}: ${err}`);
      }
    });
    if (result.list) {
      errors.push(result.list);
    }
  }

  config.setChannelsList(
    channels.map(ch => {
      const c = new MiotyRfChannel();
      c.setCenterFrequencyHz(ch.centerHz);
      c.setOccupiedBandwidthHz(ch.occupiedBandwidthHz);
      return c;
    }),
  );

  const power = (
    label: string,
    input: string | undefined,
    kind: "int32" | "uint32",
    set: (v: number) => void,
  ): number | undefined => {
    if (isBlank(input)) {
      return undefined;
    }
    const r = parseMilliUnits(input!, kind);
    if (!r.ok) {
      errors.push(`${label}: ${r.error}`);
      return undefined;
    }
    set(r.value);
    return r.value;
  };

  const budget: PowerBudget = {
    conductedPowerMdbm: power("Conducted TX power", values.conductedPowerDbm, "int32", v =>
      config.setConductedPowerMdbm(v),
    ),
    antennaGainMdbi: power("Antenna gain", values.antennaGainDbi, "int32", v => config.setAntennaGainMdbi(v)),
    cableLossMdb: power("Cable loss", values.cableLossDb, "uint32", v => config.setCableLossMdb(v)),
    maxEirpMdbm: power("EIRP ceiling", values.maxEirpDbm, "int32", v => config.setMaxEirpMdbm(v)),
  };
  const budgetError = validatePowerBudget(budget);
  if (budgetError) {
    errors.push(budgetError);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, config };
}
