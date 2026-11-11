import { useState } from "react";

import { Struct } from "google-protobuf/google/protobuf/struct_pb";
import { format } from "date-fns";
import { Timestamp } from "google-protobuf/google/protobuf/timestamp_pb";

import { Alert, Switch, notification } from "antd";
import type { DatePickerProps } from "antd";
import { Button, Tabs, Space, Card, Row, Form, Input, InputNumber, Popconfirm, DatePicker } from "antd";
import type { TabsProps } from "antd/lib";
import type { ColumnsType } from "antd/es/table";
import { RedoOutlined, DeleteOutlined } from "@ant-design/icons";
import { Buffer } from "buffer";

import type { GetDeviceQueueItemsResponse, Device } from "@chirpstack/chirpstack-api-grpc-web/api/device_pb";
import {
  EnqueueDeviceQueueItemRequest,
  GetDeviceQueueItemsRequest,
  FlushDeviceQueueRequest,
  DeviceQueueItem,
  DeviceType,
} from "@chirpstack/chirpstack-api-grpc-web/api/device_pb";

import { onFinishFailed } from "../helpers";
import type { GetPageCallbackFunc } from "../../components/DataTable";
import DataTable from "../../components/DataTable";
import DeviceStore from "../../stores/DeviceStore";
import CodeEditor from "../../components/CodeEditor";

interface IProps {
  device: Device;
}

interface FormRules {
  confirmed: boolean;
  fPort: number;
  isEncrypted: boolean;
  fCntDown: number;
  hex: string;
  base64: string;
  json: string;
  expiresAt?: DatePickerProps["value"];
}

function DeviceQueue(props: IProps) {
  const isMioty = props.device.getDeviceType() === DeviceType.MIOTY_DEVICE;
  // Capability of the End Point class as stored by the server (Device.mioty.ep_class).
  const miotyClass = props.device.getMioty()?.getEpClass();
  const miotyDownlinkSupported = isMioty && miotyClass === "A";
  const canEnqueue = !isMioty || miotyDownlinkSupported;
  const [refreshCounter, setRefreshCounter] = useState<number>(0);
  const [isEncrypted, setIsEncrypted] = useState<boolean>(false);
  const [form] = Form.useForm<FormRules>();

  const columns: ColumnsType<DeviceQueueItem.AsObject> = [
    {
      title: "ID",
      dataIndex: "id",
      key: "id",
      width: 350,
    },
    {
      title: "Pending",
      dataIndex: "isPending",
      key: "isPending",
      width: 100,
      render: (text, record) => {
        if (record.isPending) {
          return "yes";
        } else {
          return "no";
        }
      },
    },
    {
      title: "Encrypted",
      dataIndex: "isEncrypted",
      key: "isEncrypted",
      width: 100,
      render: (text, record) => {
        if (record.isEncrypted) {
          return "yes";
        } else {
          return "no";
        }
      },
    },
    {
      title: "Frame-counter",
      dataIndex: "fCntDown",
      key: "fCntDown",
      width: 200,
      render: (text, record) => {
        if (record.isPending === true || record.isEncrypted === true) {
          return record.fCntDown;
        } else {
          return "";
        }
      },
    },
    {
      title: "Confirmed",
      dataIndex: "confirmed",
      key: "confirmed",
      width: 100,
      render: (text, record) => {
        if (record.confirmed) {
          return "yes";
        } else {
          return "no";
        }
      },
    },
    {
      title: "FPort",
      dataIndex: "fPort",
      key: "fPort",
      width: 100,
    },
    {
      title: "Data (HEX)",
      dataIndex: "data",
      key: "data",
      render: (text, record) => {
        return Buffer.from(record.data as string, "base64").toString("hex");
      },
    },
    {
      title: "Expires at",
      dataIndex: "expiresAt",
      key: "expiresAt",
      width: 250,
      render: (_text, record) => {
        if (record.expiresAt !== undefined) {
          const ts = new Date(0);
          ts.setUTCSeconds(record.expiresAt.seconds);
          return format(ts, "yyyy-MM-dd HH:mm:ss");
        } else {
          return "Never";
        }
      },
    },
  ];

  const getPage = (
    limit: number,
    offset: number,
    filters: object,
    orderBy: string | void,
    orderByDesc: boolean | void,
    callbackFunc: GetPageCallbackFunc,
  ) => {
    const req = new GetDeviceQueueItemsRequest();
    req.setDevEui(props.device.getDevEui());

    DeviceStore.getQueue(req, (resp: GetDeviceQueueItemsResponse) => {
      const obj = resp.toObject();
      callbackFunc(obj.totalCount, obj.resultList);
    });
  };

  const refreshQueue = () => {
    setRefreshCounter(refreshCounter + 1);
  };

  const flushQueue = () => {
    const req = new FlushDeviceQueueRequest();
    req.setDevEui(props.device.getDevEui());
    DeviceStore.flushQueue(req, () => {
      refreshQueue();
    });
  };

  const onEnqueue = (values: FormRules) => {
    const req = new EnqueueDeviceQueueItemRequest();
    const item = new DeviceQueueItem();

    item.setDevEui(props.device.getDevEui());
    item.setFPort(isMioty ? 0 : values.fPort);
    item.setConfirmed(isMioty ? false : values.confirmed);
    item.setIsEncrypted(isMioty ? false : values.isEncrypted);
    item.setFCntDown(isMioty ? 0 : values.fCntDown);

    if (values.expiresAt !== null && values.expiresAt !== undefined && !Array.isArray(values.expiresAt)) {
      item.setExpiresAt(Timestamp.fromDate(values.expiresAt.toDate()));
    }

    if (values.hex !== undefined) {
      item.setData(new Uint8Array(Buffer.from(values.hex, "hex")));
    }

    if (values.base64 !== undefined) {
      item.setData(new Uint8Array(Buffer.from(values.base64, "base64")));
    }

    if (values.json !== undefined) {
      try {
        const obj = JSON.parse(values.json);
        const struct = Struct.fromJavaScript(obj);

        item.setObject(struct);
      } catch (err) {
        if (err instanceof Error) {
          notification.error({
            message: "Error",
            description: err.message,
            duration: 3,
          });
        }
      }
    }

    req.setQueueItem(item);

    DeviceStore.enqueue(req, _ => {
      form.resetFields();
      setIsEncrypted(false);
      refreshQueue();
    });
  };

  const tabItems: TabsProps["items"] = [
    {
      key: "1",
      label: "HEX",
      children: (
        <Form.Item
          name="hex"
          rules={
            isMioty
              ? [
                  {
                    pattern: /^(?:[0-9a-fA-F]{2})*$/,
                    message: "Enter an even number of hexadecimal characters.",
                  },
                ]
              : undefined
          }
        >
          <Input />
        </Form.Item>
      ),
    },
    {
      key: "2",
      label: "BASE64",
      children: (
        <Form.Item name="base64">
          <Input />
        </Form.Item>
      ),
    },
    {
      key: "3",
      label: "JSON",
      children: <CodeEditor name="json" mode="json" />,
    },
  ];

  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="large">
      {isMioty && !miotyDownlinkSupported && (
        <Alert
          type="info"
          showIcon
          title="Downlink is not available for this End Point"
          description={`This End Point is configured as class ${miotyClass ?? "unknown"}. Only bidirectional class A End Points can receive downlinks; the server rejects downlinks for other classes.`}
        />
      )}
      {miotyDownlinkSupported && (
        <Alert
          type="info"
          showIcon
          title="mioty downlink"
          description={
            <ul style={{ margin: 0, paddingInlineStart: 20 }}>
              <li>
                A queued payload is sent in the receive window that follows an uplink of the End Point. There is no
                FPort, confirmation flag or expiry time.
              </li>
              <li>
                A transmission result (txack event under Events) reports that a Base Station sent the payload. It is
                not an acknowledgement from the End Point.
              </li>
              <li>
                Base Stations with a selected TH920_925 RF policy do not transmit. If no other Base Station of the
                tenant can serve the End Point, the payload stays queued.
              </li>
              <li>The queue cannot be flushed while a transmission is pending.</li>
            </ul>
          }
        />
      )}
      {canEnqueue && (
      <Card title="Enqueue">
        <Form
          layout="horizontal"
          onFinish={onEnqueue}
          onFinishFailed={onFinishFailed}
          form={form}
          initialValues={{ fPort: 1 }}
        >
          {!isMioty && <Row>
            <Space orientation="horizontal" style={{ width: "100%" }} size="large">
              <Form.Item name="confirmed" label="Confirmed" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item name="fPort" label="FPort">
                <InputNumber min={1} max={254} />
              </Form.Item>
              <Form.Item
                name="isEncrypted"
                label="Is encrypted"
                valuePropName="checked"
                tooltip="Only enable this in case the payload that you would like to enqueue has already been encrypted. In this case you also must enter the downlink frame-counter which has been used for the encryption."
              >
                <Switch onChange={setIsEncrypted} />
              </Form.Item>
              {isEncrypted && (
                <Form.Item
                  name="fCntDown"
                  label="Downlink frame-counter used for encryption"
                  rules={[{ required: true, message: "Please enter a downlink frame-counter!" }]}
                >
                  <InputNumber min={0} />
                </Form.Item>
              )}
              <Form.Item
                name="expiresAt"
                label="Expires at"
                tooltip="If set, the queue-item will automatically expire at the given timestamp if it wasn't sent yet."
              >
                <DatePicker showTime />
              </Form.Item>
            </Space>
          </Row>}
          <Tabs defaultActiveKey="1" items={tabItems} />
          <Button type="primary" htmlType="submit">
            Enqueue
          </Button>
        </Form>
      </Card>
      )}
      <Row justify="end">
        <Space orientation="horizontal" size="large">
          <Button icon={<RedoOutlined />} onClick={refreshQueue}>
            Reload
          </Button>
          <Popconfirm title="Are you sure you want to flush the queue?" placement="left" onConfirm={flushQueue}>
            <Button icon={<DeleteOutlined />}>Flush queue</Button>
          </Popconfirm>
        </Space>
      </Row>
      <DataTable columns={isMioty ? columns.filter(col => !["isEncrypted", "fCntDown", "fPort", "expiresAt"].includes(String(col.key))) : columns} getPage={getPage} refreshKey={refreshCounter} rowKey="id" noPagination />
    </Space>
  );
}

export default DeviceQueue;
