import { randomUUID } from "node:crypto";
import { isSessionId } from "../conversation/session-id.js";
import type { SessionHub } from "../conversation/conversation-hub.js";
import type { JobService } from "../jobs/job-service.js";
import type { MonitorService } from "../monitors/monitor-service.js";
import type { ActionService } from "../actions/action-service.js";
import type { MessageFeedbackRepository } from "../messages/types.js";
import { MAIN_SESSION_ID, SessionError, type SessionRecord, type SessionRepository, type SessionStorage } from "./types.js";

export type SessionService = {
  list(): Promise<SessionRecord[]>;
  get(sessionId: string): Promise<SessionRecord | undefined>;
  create(title?: string): Promise<SessionRecord>;
  rename(sessionId: string, title: string): Promise<SessionRecord>;
  reset(sessionId: string, options?: { clearSchedules?: boolean }): Promise<SessionRecord>;
  remove(sessionId: string): Promise<{ removed: { sessions: number } }>;
};
type Dependencies = {
  repository: SessionRepository; storage: SessionStorage; hub: SessionHub;
  jobs: JobService; monitors: MonitorService; actions: ActionService; feedback: MessageFeedbackRepository;
  pauseMain: () => { stopped: Promise<void>; resume(): void };
  forgetPresence: (sessionId: string) => void;
};
const validate = (id: string) => { if (!isSessionId(id)) throw new SessionError(400, "INVALID_SESSION_ID", "Invalid sessionId"); };
const titleOf = (title: string) => {
  const value = title.trim();
  if (!value || value.length > 200) throw new SessionError(400, "INVALID_TITLE", "Title must be 1–200 characters");
  return value;
};
/** 元数据与执行生命周期分开；reset/delete 与指令保存共用 hub 的短锁。 */
export const createSessionService = (deps: Dependencies): SessionService => {
  const get = async (id: string) => { validate(id); return (await deps.repository.read()).find((s) => s.id === id); };
  const requireSession = async (id: string) => {
    const record = await get(id);
    if (!record) throw new SessionError(404, "SESSION_NOT_FOUND", "Session not found");
    return record;
  };
  return {
    get,
    list: async () => (await deps.repository.read()).sort((a, b) => Number(b.isMain) - Number(a.isMain) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)),
    create: async (title) => {
      const timestamp = new Date().toISOString();
      const record: SessionRecord = { id: randomUUID(), title: title === undefined ? "新会话" : titleOf(title), createdAt: timestamp, updatedAt: timestamp, isMain: false };
      await deps.storage.initialize(record.id);
      await deps.repository.update((sessions) => ({ sessions: [...sessions, record], result: undefined }));
      return record;
    },
    rename: async (id, title) => {
      validate(id);
      const nextTitle = titleOf(title);
      return deps.hub.withSession(id, async () => deps.repository.update((sessions) => {
        const record = sessions.find((s) => s.id === id);
        if (!record) throw new SessionError(404, "SESSION_NOT_FOUND", "Session not found");
        const next = { ...record, title: id === MAIN_SESSION_ID ? "默认会话" : nextTitle, updatedAt: new Date().toISOString() };
        return { sessions: sessions.map((s) => s.id === id ? next : s), result: next };
      }));
    },
    reset: async (id, options) => {
      await requireSession(id);
      const pause = id === MAIN_SESSION_ID ? deps.pauseMain() : undefined;
      await pause?.stopped;
      try {
        return await deps.hub.resetSession(id, async ({ closeCurrent, reopen }) => {
          await deps.actions.cancelBySessionId(id);
          await closeCurrent();
          await deps.actions.cancelBySessionId(id);
          await deps.storage.clearHistory(id);
          await deps.feedback.removeSession(id);
          if (options?.clearSchedules) {
            await deps.jobs.removeByOriginSessionId(id);
            await deps.monitors.removeByOriginSessionId(id);
          } else await deps.monitors.clearPendingByOriginSessionId(id);
          await reopen();
          deps.forgetPresence(id);
          return deps.repository.update((sessions) => {
            const current = sessions.find((s) => s.id === id);
            if (!current) throw new SessionError(404, "SESSION_NOT_FOUND", "Session not found");
            const record = { ...current, updatedAt: new Date().toISOString() };
            return { sessions: sessions.map((s) => s.id === id ? record : s), result: record };
          });
        });
      } finally { pause?.resume(); }
    },
    remove: async (id) => {
      validate(id);
      if (id === MAIN_SESSION_ID) throw new SessionError(409, "CANNOT_DELETE_MAIN_SESSION", "Cannot delete main session");
      return deps.hub.deleteSession(id, async () => {
        await requireSession(id);
        await deps.actions.cancelBySessionId(id);
        await deps.jobs.removeByOriginSessionId(id);
        await deps.monitors.removeByOriginSessionId(id);
        await deps.feedback.removeSession(id);
        await deps.storage.remove(id);
        await deps.repository.update((sessions) => ({ sessions: sessions.filter((s) => s.id !== id), result: undefined }));
        deps.forgetPresence(id);
        return { removed: { sessions: 1 } };
      });
    },
  };
};
