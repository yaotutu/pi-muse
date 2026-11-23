import { isWorkspaceText } from "../../shared/workspace-text.js";
import { HabitError } from "../habits/errors.js";
import { parseHabitOperationsArray } from "../habits/operations.js";
import type { HabitOperation } from "../habits/types.js";
import { InformationError } from "./errors.js";
import type {
  InformationDecision,
  InformationModelResult,
  InformationNotificationDraft,
} from "./types.js";

export const INFORMATION_REASON_MAX_LENGTH = 1000;
export const INFORMATION_NOTIFICATION_TEXT_MAX_LENGTH = 4000;
export const ARCHIVE_BRIEFING_MAX_LENGTH = 1200;
export const INFORMATION_MAX_NOTIFICATIONS = 20;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type ParseInformationResultOptions = {
  allowNotifications: boolean;
  allowEmptyNotifications?: boolean;
  allowHabitOperations?: boolean;
  existingHabitIds?: ReadonlySet<string>;
};

/** 校验并规范化短信/信息模型单轮提交结果，拒绝未知字段、漏判、重复及未覆盖 notify 条目。 */
export const parseInformationResult = (
  raw: unknown,
  claimedIds: readonly string[],
  options: ParseInformationResultOptions,
): InformationModelResult => {
  if (!isPlainRecord(raw)) {
    throw new InformationError("INVALID_INPUT", "Invalid information result");
  }
  const allowedKeys = new Set<string>(["decisions"]);
  if (options.allowNotifications || options.allowEmptyNotifications) {
    allowedKeys.add("notifications");
  }
  if (options.allowHabitOperations) {
    allowedKeys.add("habitOperations");
  }
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw new InformationError("INVALID_INPUT", `Unexpected field in information result: ${key}`);
    }
  }
  if (!Array.isArray(raw.decisions)) {
    throw new InformationError("INVALID_INPUT", "Invalid information result decisions");
  }

  const expectedIds = new Set(claimedIds);
  const seenIds = new Set<string>();
  const notifyIds = new Set<string>();
  const decisions: InformationDecision[] = [];

  for (const entry of raw.decisions) {
    if (!isPlainRecord(entry)) {
      throw new InformationError("INVALID_INPUT", "Invalid information decision entry");
    }
    const { itemId, decision, reason, ...extra } = entry;
    if (Object.keys(extra).length > 0) {
      throw new InformationError("INVALID_INPUT", "Unexpected field in information decision");
    }
    if (typeof itemId !== "string" || !expectedIds.has(itemId) || seenIds.has(itemId)) {
      throw new InformationError("INVALID_INPUT", `Invalid or duplicate decision itemId: ${String(itemId)}`);
    }
    if (decision !== "silent" && decision !== "notify") {
      throw new InformationError("INVALID_INPUT", `Invalid decision type: ${String(decision)}`);
    }
    if (typeof reason !== "string" || !reason.trim() || reason.length > INFORMATION_REASON_MAX_LENGTH) {
      throw new InformationError("INVALID_INPUT", "Decision reason is blank or exceeds limit");
    }
    seenIds.add(itemId);
    if (decision === "notify") notifyIds.add(itemId);
    decisions.push({ itemId, decision, reason: reason.trim() });
  }

  if (seenIds.size !== expectedIds.size) {
    throw new InformationError("INVALID_INPUT", "Information decisions must match every claimed item");
  }

  let habitOperations: HabitOperation[] | undefined;
  if (options.allowHabitOperations && raw.habitOperations !== undefined) {
    try {
      habitOperations = parseHabitOperationsArray(raw.habitOperations, {
        existingIds: options.existingHabitIds,
      });
    } catch (error) {
      if (error instanceof HabitError) {
        throw new InformationError("INVALID_INPUT", error.message);
      }
      throw error;
    }
  }

  const notifications: InformationNotificationDraft[] = [];
  if (options.allowNotifications) {
    if (!Array.isArray(raw.notifications) || raw.notifications.length > INFORMATION_MAX_NOTIFICATIONS) {
      throw new InformationError("INVALID_INPUT", "Invalid information notifications array");
    }
    const coveredNotifyIds = new Set<string>();
    for (const entry of raw.notifications) {
      if (!isPlainRecord(entry)) {
        throw new InformationError("INVALID_INPUT", "Invalid information notification entry");
      }
      const { itemIds, text, ...extra } = entry;
      if (Object.keys(extra).length > 0) {
        throw new InformationError("INVALID_INPUT", "Unexpected field in information notification");
      }
      if (
        typeof text !== "string" ||
        !isWorkspaceText(text) ||
        !text.trim() ||
        text.length > INFORMATION_NOTIFICATION_TEXT_MAX_LENGTH
      ) {
        throw new InformationError("INVALID_INPUT", "Notification text is blank or exceeds limit");
      }
      if (!Array.isArray(itemIds) || itemIds.length === 0) {
        throw new InformationError("INVALID_INPUT", "Notification itemIds must be non-empty");
      }
      const normalizedIds: string[] = [];
      for (const id of itemIds) {
        if (typeof id !== "string" || !notifyIds.has(id) || coveredNotifyIds.has(id)) {
          throw new InformationError("INVALID_INPUT", `Notification references invalid or duplicate notify itemId: ${String(id)}`);
        }
        coveredNotifyIds.add(id);
        normalizedIds.push(id);
      }
      notifications.push({ itemIds: normalizedIds, text: text.trim() });
    }
    if (coveredNotifyIds.size !== notifyIds.size) {
      throw new InformationError("INVALID_INPUT", "Every notify item must be covered exactly once across notifications");
    }
  } else if (options.allowEmptyNotifications && raw.notifications !== undefined) {
    if (!Array.isArray(raw.notifications) || raw.notifications.length !== 0) {
      throw new InformationError("INVALID_INPUT", "Archive information result cannot emit notifications");
    }
  }

  return {
    decisions,
    notifications,
    ...(habitOperations !== undefined ? { habitOperations } : {}),
  };
};

/** 校验并规范化历史归档总览简报，限制正文 <= 1200 字且引用 ID 为候选子集。 */
export const parseInformationBriefingResult = (
  raw: unknown,
  candidateIds: readonly string[],
): { text: string; itemIds: string[] } => {
  if (!isPlainRecord(raw)) {
    throw new InformationError("INVALID_INPUT", "Invalid archive briefing result");
  }
  const allowedKeys = new Set(["text", "itemIds"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw new InformationError("INVALID_INPUT", `Unexpected field in archive briefing: ${key}`);
    }
  }
  if (typeof raw.text !== "string" || !isWorkspaceText(raw.text)) {
    throw new InformationError("INVALID_INPUT", "Archive briefing text must be a string");
  }
  const text = raw.text.trim();
  if (!text || text.length > ARCHIVE_BRIEFING_MAX_LENGTH) {
    throw new InformationError("INVALID_INPUT", "Archive briefing text is blank or exceeds limit");
  }
  if (!Array.isArray(raw.itemIds)) {
    throw new InformationError("INVALID_INPUT", "Archive briefing itemIds must be an array");
  }
  const allowedIds = new Set(candidateIds);
  const seen = new Set<string>();
  const itemIds: string[] = [];
  for (const id of raw.itemIds) {
    if (typeof id !== "string" || !allowedIds.has(id) || seen.has(id)) {
      throw new InformationError("INVALID_INPUT", "Archive briefing itemIds contain invalid or duplicate item");
    }
    seen.add(id);
    itemIds.push(id);
  }
  return { text, itemIds };
};
