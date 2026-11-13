import type { Identity } from "../../features/identity/types.js";

/**
 * 仍然以 JSON 文档落盘的领域校验：身份设置与网页监控。
 * 已迁入 SQLite 的领域（任务、目标、审批、短信、Dream、记忆）各自在
 * 对应 schema 文件内校验，不再共用这里的“文档”读取器。
 */
export class InvalidDocumentError extends Error {
  constructor(kind: "memory-markdown" | "identity" | "jobs" | "goals" | "actions" | "monitors" | "skills-overrides" | "dream") {
    super(`Invalid ${kind} document; restore a valid backup before writing`);
    this.name = "InvalidDocumentError";
  }
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * identity.json 的完整业务形状：四个字段必须齐全且类型正确。
 * 身份是配置型文档，缺字段或类型不符一律拒绝，不补默认值、不静默忽略未知字段。
 */
export const readIdentityDocument = (value: unknown): Identity => {
  if (!isObject(value) ||
    Object.keys(value).some((key) => !["name", "tone", "avatar", "showChatUpdates"].includes(key)) ||
    typeof value.name !== "string" || typeof value.tone !== "string" ||
    typeof value.avatar !== "string" || typeof value.showChatUpdates !== "boolean")
    throw new InvalidDocumentError("identity");
  return value as unknown as Identity;
};

/** monitors 裸数组；条件/状态形状校验。 */
export const readMonitorsDocument = (
  value: unknown,
): import("../../features/monitors/types.js").Monitor[] => {
  if (!Array.isArray(value)) throw new InvalidDocumentError("monitors");
  const statuses = ["active", "paused", "stopped"];
  const conditions = ["change", "contains"];
  const list = value.filter(
    (item): item is import("../../features/monitors/types.js").Monitor =>
      isObject(item) &&
      typeof item.id === "string" &&
      typeof item.title === "string" &&
      typeof item.url === "string" &&
      typeof item.condition === "string" &&
      conditions.includes(item.condition) &&
      typeof item.intervalMinutes === "number" &&
      typeof item.status === "string" &&
      statuses.includes(item.status) &&
      typeof item.checks === "number",
  );
  if (list.length !== value.length) throw new InvalidDocumentError("monitors");
  return list;
};
