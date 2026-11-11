import { useEffect, useState } from "react";

import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  Popconfirm,
  Radio,
  Row,
  Skeleton,
  Space,
  Tag,
  Typography,
} from "antd";
import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";

import type { Gateway, GetMiotyRfConfigResponse } from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";
import {
  GetMiotyRfConfigRequest,
  UpdateMiotyRfConfigRequest,
} from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";

import GatewayStore from "../../stores/GatewayStore";
import SessionStore from "../../stores/SessionStore";
import { onFinishFailed } from "../helpers";
import type { Band } from "../../lib/miotyRf";
import {
  MAX_CHANNELS,
  channelEdgesTwiceHz,
  eirpMdbm,
  formatHalfHzAsMhz,
  formatHzAsMhz,
  formatMilliUnits,
  parseKhzToHz,
  parseMhzToHz,
  parseMilliUnits,
  validateChannel,
  validatePowerBudget,
} from "../../lib/miotyRf";
import type { ChannelFormValue, RfFormValues } from "../../lib/miotyRfForm";
import { configToFormValues, formValuesToConfig, parseChannel, parsePowerBudget } from "../../lib/miotyRfForm";

// The only regional profile offered by the backend (chirpstack/src/mioty/rf.rs).
// Its display name, band limits and capability flags are read from the API.
export const TH_PROFILE_ID = "TH920_925";

interface IProps {
  gateway: Gateway;
}

function MiotyRfPolicy(props: IProps) {
  // Each Base Station owns its editor state; navigation cannot reuse another
  // station's form or an in-flight response from its previous editor.
  return <RfPolicyEditor key={props.gateway.getGatewayId()} {...props} />;
}

function RfPolicyEditor(props: IProps) {
  const gatewayId = props.gateway.getGatewayId();
  const tenantId = props.gateway.getTenantId();
  const [form] = Form.useForm<RfFormValues>();
  const [resp, setResp] = useState<GetMiotyRfConfigResponse | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState<boolean>(false);
  const [submitErrors, setSubmitErrors] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);

  const watchedChannels = Form.useWatch("channels", form);
  const watchedConducted = Form.useWatch("conductedPowerDbm", form);
  const watchedGain = Form.useWatch("antennaGainDbi", form);
  const watchedLoss = Form.useWatch("cableLossDb", form);

  const canEdit =
    SessionStore.isAdmin() || SessionStore.isTenantAdmin(tenantId) || SessionStore.isTenantGatewayAdmin(tenantId);

  const load = () => {
    setResp(undefined);
    setLoadError(undefined);
    setSubmitErrors([]);
    setSaving(false);
    setRefresh(value => value + 1);
  };

  useEffect(() => {
    let active = true;
    const req = new GetMiotyRfConfigRequest();
    req.setGatewayId(gatewayId);
    GatewayStore.getMiotyRfConfig(
      req,
      r => {
        if (!active) return;
        setLoadError(undefined);
        setResp(r);
        form.setFieldsValue(configToFormValues(r.getConfig()));
      },
      err => {
        if (active) setLoadError(err.message);
      },
    );
    return () => {
      active = false;
    };
  }, [gatewayId, form, refresh]);

  if (loadError !== undefined) {
    return (
      <Alert
        type="error"
        showIcon
        title="The RF policy of this Base Station could not be loaded"
        description={loadError}
        action={<Button onClick={load}>Retry</Button>}
      />
    );
  }

  if (resp === undefined) {
    return <Skeleton active />;
  }

  const band: Band = { minHz: resp.getMinFrequencyHz(), maxHz: resp.getMaxFrequencyHz() };
  const bandText = `${formatHzAsMhz(band.minHz)}–${formatHzAsMhz(band.maxHz)} MHz`;
  const selected = resp.hasConfig();
  const blockers = resp.getTxBlockersList();
  const txSupported = resp.getTxSupported() && blockers.length === 0;
  const disabled = !canEdit || saving;

  const submit = () => {
    form
      .validateFields()
      .then(values => {
        const result = formValuesToConfig(
          TH_PROFILE_ID,
          { ...values, channels: values.channels ?? [] },
          band,
          txSupported,
        );
        if (!result.ok) {
          setSubmitErrors(result.errors);
          return;
        }
        setSubmitErrors([]);

        const req = new UpdateMiotyRfConfigRequest();
        req.setGatewayId(gatewayId);
        req.setConfig(result.config);

        setSaving(true);
        GatewayStore.updateMiotyRfConfig(
          req,
          () => {
            setSaving(false);
            // Re-read so that the form shows what the server persisted.
            load();
          },
          err => {
            setSaving(false);
            setSubmitErrors([err.message]);
          },
        );
      })
      .catch(() => onFinishFailed());
  };

  const channelRows: (ChannelFormValue | undefined)[] = watchedChannels ?? [];
  const eirp = eirpMdbm(
    parsePowerBudget({ conductedPowerDbm: watchedConducted, antennaGainDbi: watchedGain, cableLossDb: watchedLoss }),
  );

  const powerRule = (kind: "int32" | "uint32") => ({
    validator: (_: unknown, value: string | undefined) => {
      if (value === undefined || value.trim() === "") {
        return Promise.resolve();
      }
      const r = parseMilliUnits(value, kind);
      return r.ok ? Promise.resolve() : Promise.reject(new Error(r.error));
    },
  });

  const reportedBidi = resp.hasReportedBidirectional() ? (
    resp.getReportedBidirectional() ? (
      "Yes"
    ) : (
      "No"
    )
  ) : (
    <Typography.Text type="secondary">Not reported (the Base Station has not connected yet)</Typography.Text>
  );

  const submitButton = (
    <Button type="primary" disabled={disabled} loading={saving} onClick={selected ? submit : undefined}>
      {selected ? "Update RF policy" : `Select ${TH_PROFILE_ID} policy`}
    </Button>
  );

  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="large">
      <Alert
        type="warning"
        showIcon
        title={`${resp.getDisplayName()} is a custom, experimental regional profile`}
        description={
          <>
            {TH_PROFILE_ID} is defined by this ChirpStack fork. It is not an official mioty Alliance regional profile,
            and selecting or configuring it does not establish regulatory authorization (for example under NBTC rules)
            for any radio equipment. The values below are a desired policy stored by the server. They do not configure
            the radio firmware of the Base Station and are not measurements.
          </>
        }
      />

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={12}>
          <Card title="Regional profile" style={{ height: "100%" }}>
            <Descriptions
              column={1}
              size="small"
              items={[
                { key: "id", label: "Region identifier", children: <code>{TH_PROFILE_ID}</code> },
                {
                  key: "name",
                  label: "Name",
                  children: (
                    <Space>
                      {resp.getDisplayName()}
                      {resp.getExperimental() && <Tag color="orange">Experimental</Tag>}
                    </Space>
                  ),
                },
                {
                  key: "min",
                  label: "Lower frequency boundary",
                  children: `${formatHzAsMhz(band.minHz)} MHz (${band.minHz} Hz)`,
                },
                {
                  key: "max",
                  label: "Upper frequency boundary",
                  children: `${formatHzAsMhz(band.maxHz)} MHz (${band.maxHz} Hz)`,
                },
                {
                  key: "state",
                  label: "Policy on this Base Station",
                  children: selected ? (
                    <Tag color="green">Selected</Tag>
                  ) : (
                    <Space orientation="vertical" size={0}>
                      <Tag>Not selected</Tag>
                      <Typography.Text type="secondary">
                        Without a selected policy this Base Station keeps its previous native behaviour.
                      </Typography.Text>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="Capability and compliance" style={{ height: "100%" }}>
            <Descriptions
              column={1}
              size="small"
              items={[
                {
                  key: "tx",
                  label: "Transmission supported by server",
                  children: txSupported ? <Tag color="green">Yes</Tag> : <Tag color="red">No</Tag>,
                },
                {
                  key: "bidi",
                  label: "Base Station reports bidirectional",
                  children: reportedBidi,
                },
                {
                  key: "bands",
                  label: "Hardware RF capability",
                  children: (
                    <Typography.Text type="secondary">
                      Not reported. The Base Station interface does not report supported bands, bandwidths or power
                      ranges; a bidirectional declaration is not frequency support.
                    </Typography.Text>
                  ),
                },
                {
                  key: "reg",
                  label: "Regulatory compliance status",
                  children: (
                    <Typography.Text type="secondary">
                      Not validated. No equipment approval or compliance evidence is recorded by this system.
                    </Typography.Text>
                  ),
                },
              ]}
            />
            {blockers.length > 0 && (
              <Alert
                style={{ marginTop: 16 }}
                type="info"
                title="Transmission blockers reported by the server"
                description={
                  <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                    {blockers.map(b => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                }
              />
            )}
          </Card>
        </Col>
      </Row>

      <Form<RfFormValues> form={form} layout="vertical" disabled={disabled} onFinishFailed={onFinishFailed}>
        <Space orientation="vertical" style={{ width: "100%" }} size="large">
          <Card title="Operating mode">
            <Form.Item
              name="txEnabled"
              label="Operating mode"
              extra={
                txSupported
                  ? "The server validates all policy conditions again before accepting a transmit-enabled policy."
                  : "Transmit-enabled is unavailable: the server reports no transmission support for this profile. While this policy is selected, the server sends no downlinks through this Base Station; queued downlinks stay queued."
              }
              style={{ marginBottom: 0 }}
            >
              <Radio.Group
                options={[
                  { value: false, label: "Receive-only" },
                  { value: true, label: "Transmit-enabled", disabled: !txSupported },
                ]}
              />
            </Form.Item>
          </Card>

          <Card title="Channels (desired policy)">
            <Typography.Paragraph type="secondary">
              Channels are optional. No channel plan, hopping sequence or bandwidth is prescribed or verified for this
              profile, and none is pre-filled. For each channel enter the center frequency and the complete occupied
              emission bandwidth, including all frequency excursions. The whole occupied bandwidth must lie within{" "}
              {bandText}. At most {MAX_CHANNELS} channels.
            </Typography.Paragraph>
            <Form.List
              name="channels"
              rules={[
                {
                  validator: (_, rows: unknown[] | undefined) =>
                    (rows?.length ?? 0) > MAX_CHANNELS
                      ? Promise.reject(new Error(`At most ${MAX_CHANNELS} channels can be configured.`))
                      : Promise.resolve(),
                },
              ]}
            >
              {(fields, { add, remove }, { errors }) => (
                <>
                  {fields.map(({ key, name, ...restField }) => {
                    const parsed = parseChannel(channelRows[name]);
                    const edges = parsed ? channelEdgesTwiceHz(parsed) : undefined;
                    return (
                      <Row gutter={16} key={key} align="top">
                        <Col xs={24} md={8}>
                          <Form.Item
                            {...restField}
                            name={[name, "centerMhz"]}
                            label={`Channel ${name + 1} center frequency`}
                            dependencies={[["channels", name, "bandwidthKhz"]]}
                            validateFirst
                            rules={[
                              {
                                validator: (_, value: string | undefined) => {
                                  const r = parseMhzToHz(value ?? "");
                                  return r.ok ? Promise.resolve() : Promise.reject(new Error(r.error));
                                },
                              },
                              ({ getFieldValue }) => ({
                                validator: (_, value: string | undefined) => {
                                  const rows = (getFieldValue("channels") ?? []) as (ChannelFormValue | undefined)[];
                                  const center = parseMhzToHz(value ?? "");
                                  if (!center.ok) {
                                    return Promise.resolve();
                                  }
                                  const ch = parseChannel(rows[name]);
                                  if (ch) {
                                    const err = validateChannel(ch, band);
                                    if (err) {
                                      return Promise.reject(new Error(err));
                                    }
                                  } else if (center.value < band.minHz || center.value > band.maxHz) {
                                    return Promise.reject(
                                      new Error(`The center frequency is outside the ${bandText} band.`),
                                    );
                                  }
                                  const duplicate = rows.some((row, i) => {
                                    if (i >= name) {
                                      return false;
                                    }
                                    const other = parseMhzToHz(row?.centerMhz ?? "");
                                    return other.ok && other.value === center.value;
                                  });
                                  return duplicate
                                    ? Promise.reject(
                                        new Error("This center frequency is already used by another channel."),
                                      )
                                    : Promise.resolve();
                                },
                              }),
                            ]}
                          >
                            <Input suffix="MHz" inputMode="decimal" autoComplete="off" placeholder="e.g. 922.500" />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={7}>
                          <Form.Item
                            {...restField}
                            name={[name, "bandwidthKhz"]}
                            label="Occupied bandwidth"
                            validateFirst
                            rules={[
                              {
                                validator: (_, value: string | undefined) => {
                                  const r = parseKhzToHz(value ?? "");
                                  if (!r.ok) {
                                    return Promise.reject(new Error(r.error));
                                  }
                                  return r.value > 0
                                    ? Promise.resolve()
                                    : Promise.reject(new Error("The occupied bandwidth must be greater than zero."));
                                },
                              },
                            ]}
                          >
                            <Input suffix="kHz" inputMode="decimal" autoComplete="off" />
                          </Form.Item>
                        </Col>
                        <Col xs={20} md={7}>
                          <Form.Item label="Occupied range">
                            <Typography.Text
                              type={edges ? undefined : "secondary"}
                              data-testid={`channel-${name}-range`}
                            >
                              {edges
                                ? `${formatHalfHzAsMhz(edges.lower)} – ${formatHalfHzAsMhz(edges.upper)} MHz`
                                : "—"}
                            </Typography.Text>
                          </Form.Item>
                        </Col>
                        <Col xs={4} md={2}>
                          <Form.Item label=" ">
                            <Button
                              type="text"
                              icon={<MinusCircleOutlined />}
                              aria-label={`Remove channel ${name + 1}`}
                              onClick={() => remove(name)}
                            />
                          </Form.Item>
                        </Col>
                      </Row>
                    );
                  })}
                  <Form.Item style={{ marginBottom: 0 }}>
                    <Button
                      type="dashed"
                      onClick={() => add({ centerMhz: "", bandwidthKhz: "" })}
                      block
                      icon={<PlusOutlined />}
                      disabled={disabled || fields.length >= MAX_CHANNELS}
                    >
                      Add channel
                    </Button>
                    <Form.ErrorList errors={errors} />
                  </Form.Item>
                </>
              )}
            </Form.List>
          </Card>

          <Card title="Power budget (desired policy)">
            <Typography.Paragraph type="secondary">
              All values are optional and are stored with 0.001 dB resolution. An empty field stays unset; it is not
              treated as zero. The EIRP ceiling is an operator policy value, not a legal limit or an approval. No value
              here authorizes transmission.
            </Typography.Paragraph>
            <Row gutter={16}>
              <Col xs={24} sm={12} lg={6}>
                <Form.Item name="conductedPowerDbm" label="Conducted TX power" rules={[powerRule("int32")]}>
                  <Input suffix="dBm" inputMode="decimal" autoComplete="off" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} lg={6}>
                <Form.Item name="antennaGainDbi" label="Antenna gain" rules={[powerRule("int32")]}>
                  <Input suffix="dBi" inputMode="decimal" autoComplete="off" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} lg={6}>
                <Form.Item name="cableLossDb" label="Cable loss" rules={[powerRule("uint32")]}>
                  <Input suffix="dB" inputMode="decimal" autoComplete="off" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} lg={6}>
                <Form.Item
                  name="maxEirpDbm"
                  label="EIRP ceiling"
                  dependencies={["conductedPowerDbm", "antennaGainDbi", "cableLossDb"]}
                  validateFirst
                  rules={[
                    powerRule("int32"),
                    ({ getFieldsValue }) => ({
                      validator: () => {
                        const err = validatePowerBudget(parsePowerBudget(getFieldsValue() as RfFormValues));
                        return err ? Promise.reject(new Error(err)) : Promise.resolve();
                      },
                    }),
                  ]}
                >
                  <Input suffix="dBm" inputMode="decimal" autoComplete="off" />
                </Form.Item>
              </Col>
            </Row>
            <Descriptions
              size="small"
              column={1}
              items={[
                {
                  key: "eirp",
                  label: "Calculated EIRP",
                  children:
                    eirp !== undefined ? (
                      <span data-testid="calculated-eirp">{formatMilliUnits(eirp)} dBm</span>
                    ) : (
                      <Typography.Text type="secondary" data-testid="calculated-eirp">
                        Not calculated. Requires conducted TX power, antenna gain and cable loss.
                      </Typography.Text>
                    ),
                },
              ]}
            />
          </Card>

          {submitErrors.length > 0 && (
            <Alert
              type="error"
              showIcon
              title="The RF policy was not saved"
              description={
                <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                  {submitErrors.map(e => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              }
            />
          )}

          {!canEdit && (
            <Typography.Text type="secondary">
              You have read-only access. Changing the RF policy requires gateway administration permission.
            </Typography.Text>
          )}

          {selected ? (
            submitButton
          ) : (
            <Popconfirm
              title={`Select the ${TH_PROFILE_ID} policy for this Base Station?`}
              description={
                <div style={{ maxWidth: 420 }}>
                  Once selected, the server stops sending downlinks and other server-requested transmissions through
                  this Base Station. The policy can be edited afterwards, but the API offers no way to remove it.
                </div>
              }
              okText="Select policy"
              onConfirm={submit}
              disabled={disabled}
            >
              {submitButton}
            </Popconfirm>
          )}
        </Space>
      </Form>
    </Space>
  );
}

export default MiotyRfPolicy;
