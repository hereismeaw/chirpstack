import { Alert, Col, Form, Input, InputNumber, Row, Select, Switch } from "antd";

interface IProps {
  update?: boolean;
  disabled?: boolean;
}

const HEX_KEY = /^[a-fA-F0-9]{32}$/;

export const EP_CLASS_OPTIONS = [
  { value: "Z", label: "Z (uplink only)" },
  { value: "A", label: "A (bidirectional, downlink after uplink)" },
];

export const APPLICATION_CRYPTO_OPTIONS = [
  { value: 0, label: "None (0)" },
  { value: 1, label: "Confidentiality (1)" },
  { value: 17, label: "Confidentiality and authenticity (17)" },
];

/** Default mioty settings for a new End Point, matching the Device.mioty API message. */
export const DEFAULT_MIOTY_VALUES = {
  epClass: "Z",
  shortAddress: 0,
  networkKey: "",
  applicationKey: "",
  preAttach: true,
  applicationCrypto: 0,
  dualChannel: false,
  repetition: false,
  wideCarrierOffset: false,
  longBlockDistance: false,
};

/**
 * mioty End Point settings (Device.mioty). Keys are write-only: the API never
 * returns them, the inputs are never pre-filled, and an empty value on update
 * keeps the stored key.
 */
function MiotyDeviceFields(props: IProps) {
  const form = Form.useFormInstance();
  const epClass: string = Form.useWatch(["mioty", "epClass"], form) ?? "Z";
  const applicationCrypto: number = Form.useWatch(["mioty", "applicationCrypto"], form) ?? 0;

  const keyExtra = props.update
    ? "Write-only. The stored key is never displayed. Leave empty to keep the current key."
    : "Write-only. The key cannot be read back after it has been saved.";

  return (
    <>
      <Row gutter={24}>
        <Col xs={24} md={12}>
          <Form.Item
            label="End Point class"
            name={["mioty", "epClass"]}
            rules={[{ required: true, message: "Please select an End Point class!" }]}
          >
            <Select disabled={props.disabled} options={EP_CLASS_OPTIONS} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item
            label="Short address"
            name={["mioty", "shortAddress"]}
            tooltip="16-bit short address of the End Point (0 - 65535)."
            rules={[
              { required: true, message: "Please enter a short address!" },
              { type: "integer", min: 0, max: 65535, message: "Enter a whole number between 0 and 65535." },
            ]}
          >
            <InputNumber min={0} max={65535} precision={0} disabled={props.disabled} style={{ width: "100%" }} />
          </Form.Item>
        </Col>
      </Row>
      <Form.Item
        label="Pre-attach"
        name={["mioty", "preAttach"]}
        valuePropName="checked"
        dependencies={[["mioty", "epClass"]]}
        extra="The End Point is attached using the keys configured here. Over-the-air attachment is not supported by this server."
        rules={[
          ({ getFieldValue }) => ({
            validator: (_, checked: boolean) =>
              getFieldValue(["mioty", "epClass"]) === "A" && !checked
                ? Promise.reject(new Error("Class A End Points require pre-attach."))
                : Promise.resolve(),
          }),
        ]}
      >
        <Switch disabled={props.disabled} />
      </Form.Item>
      <Row gutter={24}>
        <Col xs={24} md={12}>
          <Form.Item
            label="Network key"
            name={["mioty", "networkKey"]}
            extra={keyExtra}
            rules={[
              { required: !props.update, message: "Please enter the network key!" },
              { pattern: HEX_KEY, message: "Enter 32 hexadecimal characters (AES-128 key)." },
            ]}
          >
            <Input.Password autoComplete="new-password" spellCheck={false} disabled={props.disabled} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item
            label="Application cryptography"
            name={["mioty", "applicationCrypto"]}
            rules={[{ required: true, message: "Please select an application cryptography mode!" }]}
          >
            <Select disabled={props.disabled} options={APPLICATION_CRYPTO_OPTIONS} />
          </Form.Item>
        </Col>
      </Row>
      {applicationCrypto !== 0 && (
        <Form.Item
          label="Application key"
          name={["mioty", "applicationKey"]}
          extra={keyExtra}
          rules={[
            { required: !props.update, message: "Please enter the application key!" },
            { pattern: HEX_KEY, message: "Enter 32 hexadecimal characters (AES-128 key)." },
          ]}
        >
          <Input.Password autoComplete="new-password" spellCheck={false} disabled={props.disabled} />
        </Form.Item>
      )}
      <Row gutter={24}>
        <Col xs={12} md={6}>
          <Form.Item label="Dual channel" name={["mioty", "dualChannel"]} valuePropName="checked">
            <Switch disabled={props.disabled} />
          </Form.Item>
        </Col>
        <Col xs={12} md={6}>
          <Form.Item label="Wide carrier offset" name={["mioty", "wideCarrierOffset"]} valuePropName="checked">
            <Switch disabled={props.disabled} />
          </Form.Item>
        </Col>
        {epClass === "A" && (
          <>
            <Col xs={12} md={6}>
              <Form.Item label="Downlink repetition" name={["mioty", "repetition"]} valuePropName="checked">
                <Switch disabled={props.disabled} />
              </Form.Item>
            </Col>
            <Col xs={12} md={6}>
              <Form.Item
                label="Long downlink block distance"
                name={["mioty", "longBlockDistance"]}
                valuePropName="checked"
              >
                <Switch disabled={props.disabled} />
              </Form.Item>
            </Col>
          </>
        )}
      </Row>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 24 }}
        title="Radio profile and Base Stations"
        description="An End Point is not bound to a Base Station or a regional radio profile. Any mioty Base Station of this tenant can receive it. The regional RF policy (for example TH920_925) is selected on each Base Station."
      />
    </>
  );
}

export default MiotyDeviceFields;
