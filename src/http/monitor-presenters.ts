import type { Monitor } from "../features/monitors/types.js";
import type { MonitorDto } from "./contracts/responses.js";

/** 外部投影：脱敏调度器内部补通知状态 pendingNotification，规范化智能体字段。 */
export const presentMonitor = (monitor: Monitor): MonitorDto => {
  const { pendingNotification: _pending, ...rest } = monitor;
  const originAgentId = rest.originAgentId ?? "local-main";
  return {
    ...rest,
    originAgentId,
  };
};
