import { Children, useState } from "react";

import { Form, Input, Row, Col, Button, Tabs, Switch, Modal, Space, notification, Select, InputNumber } from "antd";
import type { TabsProps } from "antd/lib";
import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { Scanner } from "@yudiel/react-qr-scanner";
import type { IDetectedBarcode } from "@yudiel/react-qr-scanner";

import { GetDeviceProfileByProfileIdRequest } from "@chirpstack/chirpstack-api-grpc-web/api/device_profile_pb";
import {
  GetDeviceProfileByProfileIdResponse,
  DeviceProfile,
} from "@chirpstack/chirpstack-api-grpc-web/api/device_profile_pb";
import type { Tenant } from "@chirpstack/chirpstack-api-grpc-web/api/tenant_pb";
import { Device, DeviceType, MiotyDevice } from "@chirpstack/chirpstack-api-grpc-web/api/device_pb";

import { onFinishFailed } from "../helpers";
import EuiInput from "../../components/EuiInput";
import DeviceProfileSelect from "../../components/DeviceProfileSelect";
import DeviceProfileStore from "../../stores/DeviceProfileStore";

interface IProps {
  tenant: Tenant;
  initialValues: Device;
  onFinish: (obj: Device) => void;
  update?: boolean;
  disabled?: boolean;
}

function DeviceForm(props: IProps) {
  const [form] = Form.useForm();
  const deviceType = Form.useWatch("deviceType", form) ?? props.initialValues.getDeviceType();
  const isMioty = deviceType === DeviceType.MIOTY_DEVICE;
  const applicationCrypto = Form.useWatch(["mioty", "applicationCrypto"], form) ?? props.initialValues.getMioty()?.getApplicationCrypto() ?? 0;
  const [showScanner, setShowScanner] = useState(false);
  const [deviceProfileId, setDeviceProfileId] = useState<string | null>(null);

  const onFinish = (values: Device.AsObject) => {
    const v = Object.assign(props.initialValues.toObject(), values);
    const d = new Device();

    d.setApplicationId(v.applicationId);
    d.setName(v.name);
    d.setDescription(v.description);
    d.setDevEui(v.devEui);
    d.setDeviceType(v.deviceType);
    if (v.deviceType === DeviceType.MIOTY_DEVICE && v.mioty) {
      const settings = new MiotyDevice();
      settings.setEpClass(v.mioty.epClass);
      settings.setShortAddress(v.mioty.shortAddress);
      settings.setNetworkKey(v.mioty.networkKey || "");
      settings.setApplicationKey(v.mioty.applicationKey || "");
      settings.setPreAttach(v.mioty.preAttach);
      settings.setApplicationCrypto(v.mioty.applicationCrypto);
      settings.setDualChannel(v.mioty.dualChannel);
      settings.setRepetition(v.mioty.repetition);
      settings.setWideCarrierOffset(v.mioty.wideCarrierOffset);
      settings.setLongBlockDistance(v.mioty.longBlockDistance);
      d.setMioty(settings);
    }
    d.setDeviceProfileId(v.deviceProfileId[v.deviceProfileId.length - 1]);
    d.setIsDisabled(v.isDisabled);
    d.setSkipFcntCheck(v.skipFcntCheck);
    d.setJoinEui(v.joinEui);

    // tags
    for (const elm of v.tagsMap) {
      d.getTagsMap().set(elm[0], elm[1]);
    }

    // variables
    for (const elm of v.variablesMap) {
      d.getVariablesMap().set(elm[0], elm[1]);
    }

    props.onFinish(d);
  };

  const onScannerError = (e: any) => {
    notification.error({
      message: "Error",
      description: e,
      duration: 3,
    });
  };

  const onScannerScan = (v: IDetectedBarcode[]) => {
    if (v.length === 0) {
      return;
    }
    setShowScanner(false);

    const barcode = v[0].rawValue;
    const barcodeBits = barcode.split(":");
    if (!barcode.startsWith("LW:D0") || barcodeBits.length < 5) {
      notification.error({
        message: "Error",
        description: "Invalid QR code",
        duration: 3,
      });
    }

    form.setFieldsValue({
      devEui: barcodeBits[3],
      joinEui: barcodeBits[2],
    });

    if (form.getFieldValue("name") === "") {
      form.setFieldValue("name", barcodeBits[3]);
    }

    const req = new GetDeviceProfileByProfileIdRequest();
    req.setVendorId(Number("0x" + barcodeBits[4].slice(0, 4)));
    req.setVendorProfileId(Number("0x" + barcodeBits[4].slice(4, 8)));
    DeviceProfileStore.getByProfileId(req, (resp: GetDeviceProfileByProfileIdResponse) => {
      const dp = resp.getDeviceProfile()!;
      setDeviceProfileId(dp.getId());
    });
  };

  const tabItems: TabsProps["items"] = [
    {
      key: "1",
      label: "Device",
      children: (
        <>
          <Form.Item label="Device type" name="deviceType" rules={[{ required: true }]}>
            <Select disabled={props.update || props.disabled} options={[
              { value: DeviceType.LORAWAN_DEVICE, label: "LoRaWAN Device" },
              { value: DeviceType.MIOTY_DEVICE, label: "Mioty Device" },
            ]} />
          </Form.Item>
          {isMioty && <>
            <Form.Item label="Endpoint class" name={["mioty", "epClass"]} rules={[{ required: true }]}>
              <Select disabled={props.disabled} options={[{ value: "Z", label: "Z (unidirectional)" }, { value: "A", label: "A (bidirectional)" }]} />
            </Form.Item>
            <Form.Item label="Short address" name={["mioty", "shortAddress"]} rules={[{ required: true }]}>
              <InputNumber min={0} max={65535} disabled={props.disabled} />
            </Form.Item>
            <Form.Item label="Pre-attach" name={["mioty", "preAttach"]} valuePropName="checked" extra="Use pre-attachment. Over-the-air attachment is not supported yet.">
              <Switch disabled={props.disabled} />
            </Form.Item>
            <Form.Item label="Network key" name={["mioty", "networkKey"]}
              extra={props.update ? "Leave empty to keep the current key." : undefined}
              rules={[{ required: !props.update }, { pattern: /^[a-fA-F0-9]{32}$/, message: "Enter 32 hexadecimal characters." }]}>
              <Input.Password autoComplete="new-password" disabled={props.disabled} />
            </Form.Item>
            <Form.Item label="Application cryptography" name={["mioty", "applicationCrypto"]} rules={[{ required: true }]}>
              <Select disabled={props.disabled} options={[
                { value: 0, label: "None (0)" },
                { value: 1, label: "Confidentiality (1)" },
                { value: 17, label: "Confidentiality and authenticity (17)" },
              ]} />
            </Form.Item>
            <Form.Item label="Application key" name={["mioty", "applicationKey"]}
              extra={props.update ? "Leave empty to keep the current key." : undefined}
              rules={[{ required: !props.update && applicationCrypto !== 0 }, { pattern: /^[a-fA-F0-9]{32}$/, message: "Enter 32 hexadecimal characters." }]}>
              <Input.Password autoComplete="new-password" disabled={props.disabled} />
            </Form.Item>
            <Form.Item label="Dual channel" name={["mioty", "dualChannel"]} valuePropName="checked">
              <Switch disabled={props.disabled} />
            </Form.Item>
            <Form.Item label="Downlink repetition" name={["mioty", "repetition"]} valuePropName="checked">
              <Switch disabled={props.disabled} />
            </Form.Item>
            <Form.Item label="Wide carrier offset" name={["mioty", "wideCarrierOffset"]} valuePropName="checked">
              <Switch disabled={props.disabled} />
            </Form.Item>
            <Form.Item label="Long downlink block distance" name={["mioty", "longBlockDistance"]} valuePropName="checked">
              <Switch disabled={props.disabled} />
            </Form.Item>
          </>}
          <Form.Item label="Name" name="name" rules={[{ required: true, message: "Please enter a name!" }]}>
            <Input disabled={props.disabled} />
          </Form.Item>
          <Form.Item label="Description" name="description">
            <Input.TextArea disabled={props.disabled} />
          </Form.Item>
          <Row gutter={24}>
            <Col span={12}>
              <EuiInput label="Device EUI (EUI64)" name="devEui" disabled={props.update} required />
            </Col>
            <Col span={12}>
              {!isMioty && <EuiInput
                label="Join EUI (EUI64)"
                name="joinEui"
                tooltip="The Join EUI will be automatically set / updated on OTAA. However, in some cases this field must be configured before OTAA (e.g. OTAA using a Relay)."
                disabled={props.disabled}
              />}
            </Col>
          </Row>
          {isMioty && <p>The device profile supplies payload codecs and integration settings for this endpoint.</p>}
          <DeviceProfileSelect
            label="Device profile"
            name="deviceProfileId"
            value={deviceProfileId || props.initialValues.getDeviceProfileId()}
            required
            tenant={props.tenant}
            disabled={props.disabled}
          />
          <Row gutter={24}>
            <Col span={12}>
              <Form.Item
                label="Device is disabled"
                name="isDisabled"
                valuePropName="checked"
                tooltip="Received uplink frames and join-requests will be ignored."
              >
                <Switch disabled={props.disabled} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                hidden={isMioty}
                label="Disable frame-counter validation"
                name="skipFcntCheck"
                valuePropName="checked"
                tooltip="You must re-activate your device before this setting becomes effective. Note that disabling the frame-counter validation will compromise security as it allows replay-attacks."
              >
                <Switch disabled={props.disabled} />
              </Form.Item>
            </Col>
          </Row>
        </>
      ),
    },
    {
      key: "2",
      label: "Tags",
      children: (
        <Form.List name="tagsMap">
          {(fields, { add, remove }) => (
            <>
              {fields.map(({ key, name, ...restField }) => (
                <Row gutter={24} key={key}>
                  <Col span={6}>
                    <Form.Item
                      {...restField}
                      name={[name, 0]}
                      rules={[{ required: true, message: "Please enter a key!" }]}
                    >
                      <Input placeholder="Key" disabled={props.disabled} />
                    </Form.Item>
                  </Col>
                  <Col span={16}>
                    <Form.Item
                      {...restField}
                      name={[name, 1]}
                      rules={[{ required: true, message: "Please enter a value!" }]}
                    >
                      <Input placeholder="Value" disabled={props.disabled} />
                    </Form.Item>
                  </Col>
                  <Col span={2}>{!props.disabled && <MinusCircleOutlined onClick={() => remove(name)} />}</Col>
                </Row>
              ))}
              <Form.Item>
                <Button type="dashed" onClick={() => add()} disabled={props.disabled} block icon={<PlusOutlined />}>
                  Add tag
                </Button>
              </Form.Item>
            </>
          )}
        </Form.List>
      ),
    },
    {
      key: "3",
      label: "Variables",
      children: (
        <Form.List name="variablesMap">
          {(fields, { add, remove }) => (
            <>
              {fields.map(({ key, name, ...restField }) => (
                <Row gutter={24} key={key}>
                  <Col span={6}>
                    <Form.Item
                      {...restField}
                      name={[name, 0]}
                      rules={[{ required: true, message: "Please enter a key!" }]}
                    >
                      <Input placeholder="Key" disabled={props.disabled} />
                    </Form.Item>
                  </Col>
                  <Col span={16}>
                    <Form.Item
                      {...restField}
                      name={[name, 1]}
                      rules={[{ required: true, message: "Please enter a value!" }]}
                    >
                      <Input placeholder="Value" disabled={props.disabled} />
                    </Form.Item>
                  </Col>
                  <Col span={2}>{!props.disabled && <MinusCircleOutlined onClick={() => remove(name)} />}</Col>
                </Row>
              ))}
              <Form.Item>
                <Button type="dashed" onClick={() => add()} disabled={props.disabled} block icon={<PlusOutlined />}>
                  Add variable
                </Button>
              </Form.Item>
            </>
          )}
        </Form.List>
      ),
    },
  ];

  return (
    <Form
      layout="vertical"
      initialValues={{ ...props.initialValues.toObject(), mioty: props.initialValues.getMioty()?.toObject() || {
        epClass: "Z", shortAddress: 0, networkKey: "", applicationKey: "", preAttach: true,
        applicationCrypto: 0, dualChannel: false, repetition: false, wideCarrierOffset: false, longBlockDistance: false,
      } }}
      onFinish={onFinish}
      onFinishFailed={onFinishFailed}
      form={form}
    >
      <Modal
        title="Scan QR-code"
        open={showScanner}
        onCancel={() => setShowScanner(false)}
        okButtonProps={{ style: { display: "none" } }}
      >
        <Space orientation="vertical">
          <Scanner onScan={onScannerScan} onError={onScannerError} />
        </Space>
      </Modal>
      <Tabs
        items={tabItems}
        tabBarExtraContent={
          <Button type="primary" disabled={props.update} onClick={() => setShowScanner(true)}>
            Scan QR-code
          </Button>
        }
      />
      <Form.Item>
        <Button type="primary" htmlType="submit" disabled={props.disabled}>
          Submit
        </Button>
      </Form.Item>
    </Form>
  );
}

export default DeviceForm;
