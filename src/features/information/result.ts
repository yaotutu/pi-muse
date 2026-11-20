import { InformationError } from "./errors.js";
import type { InformationSubmittedResult } from "./types.js";

export const INFORMATION_REASON_MAX_LENGTH = 1000;
export const INFORMATION_NOTIFICATION_TEXT_MAX_LENGTH = 4000;
export const INITIAL_BRIEFING_MAX_LENGTH = 1200;
export const INFORMATION_MAX_NOTIFICATIONS = 20;

/** PI 无关的唯一结构化结果校验；SDK 工具与业务持久化共用，不能漂移出两套规则。 */
export const parseInformationResult = (
  value: unknown,
  itemIds: readonly string[],
  mode: "notifications" | "recommendations" = "notifications",
  options?: { requireNotificationCoverage?: boolean },
): InformationSubmittedResult => {
  const requireCoverage = options?.requireNotificationCoverage ?? (mode === "notifications");
  const expected = new Set(itemIds);
  const decided = new Set<string>();
  const notifyIds = new Set<string>();
  if (!value || typeof value !== "object") throw new InformationError("INVALID_INPUT", "Invalid information result");
  const source = value as { decisions?: unknown; notifications?: unknown };
  if (!Array.isArray(source.decisions) || source.decisions.length !== expected.size) {
    throw new InformationError("INVALID_INPUT", "Information decisions must cover every batch item exactly once");
  }
  const decisions = source.decisions.map((raw) => {
    if (!raw || typeof raw !== "object") throw new InformationError("INVALID_INPUT", "Invalid information decision");
    const decision = raw as { itemId?: unknown; decision?: unknown; reason?: unknown };
    if (typeof decision.itemId !== "string" || !expected.has(decision.itemId) || decided.has(decision.itemId)) {
      throw new InformationError("INVALID_INPUT", "Information decisions must reference batch items exactly once");
    }
    if (decision.decision !== "silent" && decision.decision !== "notify") {
      throw new InformationError("INVALID_INPUT", "Invalid information decision type");
    }
    const type = decision.decision as "silent" | "notify";
    const reason = decision.reason;
    if (typeof reason !== "string" || !reason.trim() || reason.length > INFORMATION_REASON_MAX_LENGTH) {
      throw new InformationError("INVALID_INPUT", "Information decision reason is blank or too long");
    }
    decided.add(decision.itemId);
    if (decision.decision === "notify") notifyIds.add(decision.itemId);
    return { itemId: decision.itemId, decision: type, reason };
  });
  if (!Array.isArray(source.notifications) || source.notifications.length > INFORMATION_MAX_NOTIFICATIONS) {
    throw new InformationError("INVALID_INPUT", "Information notifications are invalid or too numerous");
  }
  const covered = new Set<string>();
  const notifications = source.notifications.map((raw) => {
    if (!raw || typeof raw !== "object") throw new InformationError("INVALID_INPUT", "Invalid information notification");
    const notification = raw as { itemIds?: unknown; text?: unknown };
    if (typeof notification.text !== "string" || !notification.text.trim() ||
      notification.text.length > INFORMATION_NOTIFICATION_TEXT_MAX_LENGTH) {
      throw new InformationError("INVALID_INPUT", "Information notification text is blank or too long");
    }
    if (!Array.isArray(notification.itemIds) || !notification.itemIds.length) {
      throw new InformationError("INVALID_INPUT", "Information notification must reference at least one notify item");
    }
    for (const itemId of notification.itemIds) {
      if (typeof itemId !== "string") {
        throw new InformationError("INVALID_INPUT", "Notification itemId must be a string");
      }
      if (!notifyIds.has(itemId)) {
        throw new InformationError(
          "INVALID_INPUT",
          "Every itemId in notifications must have decision='notify' in decisions; do not include silent items",
        );
      }
      if (covered.has(itemId)) {
        throw new InformationError("INVALID_INPUT", "Duplicate itemId across notifications");
      }
      covered.add(itemId);
    }
    return { itemIds: notification.itemIds as string[], text: notification.text };
  });
  if (requireCoverage && covered.size !== notifyIds.size) {
    throw new InformationError("INVALID_INPUT", "Every notify item must be covered exactly once");
  }
  const rawLearnedNotes = (value as { learnedNotes?: unknown }).learnedNotes;
  if ((mode === "recommendations" && typeof rawLearnedNotes !== "string") ||
      (rawLearnedNotes !== undefined && (typeof rawLearnedNotes !== "string" || rawLearnedNotes.length > 4000))) {
    throw new InformationError("INVALID_INPUT", "Information preference summary is invalid");
  }
  if (mode === "recommendations" && notifications.length) {
    throw new InformationError("INVALID_INPUT", "Recommendation mode must not submit notifications");
  }
  return {
    decisions,
    notifications,
    ...(rawLearnedNotes === undefined ? {} : { learnedNotes: rawLearnedNotes }),
  };
};

/** 首轮全局终审简报校验：严格限制在 1200 字符内，且关联条目只能来自候选待办集合（可为空）。 */
export const parseInitialBriefingResult = (
  value: unknown,
  allowedItemIds: readonly string[],
): { text: string; itemIds: string[] } => {
  if (!value || typeof value !== "object") {
    throw new InformationError("INVALID_INPUT", "Invalid initial briefing result");
  }
  const source = value as { text?: unknown; itemIds?: unknown };
  if (typeof source.text !== "string") {
    throw new InformationError("INVALID_INPUT", "Initial briefing text must be a string");
  }
  const text = source.text.trim();
  if (!text || text.length > INITIAL_BRIEFING_MAX_LENGTH) {
    throw new InformationError("INVALID_INPUT", "Initial briefing text is blank or exceeds limit");
  }
  if (!Array.isArray(source.itemIds)) {
    throw new InformationError("INVALID_INPUT", "Initial briefing itemIds must be an array");
  }
  const allowed = new Set(allowedItemIds);
  const seen = new Set<string>();
  const itemIds: string[] = [];
  for (const id of source.itemIds) {
    if (typeof id !== "string" || !allowed.has(id) || seen.has(id)) {
      throw new InformationError("INVALID_INPUT", "Initial briefing itemIds contain invalid or duplicate item");
    }
    seen.add(id);
    itemIds.push(id);
  }
  return { text, itemIds };
};
