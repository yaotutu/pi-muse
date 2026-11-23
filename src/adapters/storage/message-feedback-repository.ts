import type {
  MessageFeedbackDocument,
  MessageFeedbackFilter,
  MessageFeedbackRepository,
} from "../../features/messages/types.js";
import {
  applyMessageFeedbackDocument,
  ensureMessageFeedbackModule,
  listMessageFeedbackStates,
  readMessageFeedbackDocument,
  removeSessionMessageFeedback,
  validateAllMessageFeedback,
} from "./message-feedback-schema.js";
import type { ManagedSqliteDatabase } from "./sqlite-database.js";

/**
 * 基于 main.sqlite 的消息行为仓储：保留完整 append-only 原始事件流与索引状态视图；
 * 全流程串行并在短事务内提交，不修改 pi 会话 JSONL。
 */
export const createMessageFeedbackRepository = (
  managed: ManagedSqliteDatabase,
): MessageFeedbackRepository => {
  let ready = false;
  const ensureReady = (): void => {
    if (ready) return;
    ensureMessageFeedbackModule(managed);
    ready = true;
  };
  return {
    read: (sessionId, piSessionId) =>
      managed.serialize(() => {
        ensureReady();
        return readMessageFeedbackDocument(managed, sessionId, piSessionId);
      }),
    update: (sessionId, piSessionId, change) =>
      managed.serialize(() => {
        ensureReady();
        const current = readMessageFeedbackDocument(managed, sessionId, piSessionId);
        const changed = change(current);
        if (changed.document) {
          const next: MessageFeedbackDocument = changed.document;
          managed.transaction(() => {
            applyMessageFeedbackDocument(managed, sessionId, piSessionId, current, next);
          });
        }
        return changed.result;
      }),
    listStates: (sessionId, piSessionId, filter?: MessageFeedbackFilter) =>
      managed.serialize(() => {
        ensureReady();
        return listMessageFeedbackStates(managed, sessionId, piSessionId, filter);
      }),
    removeSession: (sessionId) =>
      managed.serialize(() => {
        ensureReady();
        managed.transaction(() => removeSessionMessageFeedback(managed, sessionId));
      }),
    validateAll: () =>
      managed.serialize(() => {
        validateAllMessageFeedback(managed);
        ready = true;
      }),
  };
};
