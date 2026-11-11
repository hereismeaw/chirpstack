import { Tag } from "antd";

import type { Protocol } from "../lib/protocol";
import { protocolLabel } from "../lib/protocol";

interface IProps {
  protocol: Protocol;
}

/** Consistent protocol marker used in inventories, headers and event tables. */
function ProtocolTag(props: IProps) {
  return (
    <Tag color={props.protocol === "mioty" ? "purple" : "blue"} style={{ marginInlineEnd: 0 }}>
      {protocolLabel(props.protocol)}
    </Tag>
  );
}

export default ProtocolTag;
