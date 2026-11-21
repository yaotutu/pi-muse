import { createHash, randomUUID } from "node:crypto";
import { isSessionId } from "../conversation/session-id.js";
import type { SessionHub } from "../conversation/conversation-hub.js";
import type { JobService } from "../jobs/job-service.js";
import type { MonitorService } from "../monitors/monitor-service.js";
import type { ActionService } from "../actions/action-service.js";
import type { MessageFeedbackRepository } from "../messages/types.js";
import { MAIN_SESSION_ID, SessionError, type ScheduleDisposition, type SessionDeletion, type SessionRecord, type SessionRepository, type SessionSchedules, type SessionStorage, type StoredSessionRecord } from "./types.js";

export type SessionService = {
  list(): Promise<SessionRecord[]>;
  get(sessionId: string): Promise<SessionRecord | undefined>;
  create(title?: string): Promise<SessionRecord>;
  rename(sessionId: string, title: string): Promise<SessionRecord>;
  reset(sessionId: string): Promise<SessionRecord>;
  schedules(sessionId: string): Promise<SessionSchedules>;
  remove(sessionId: string, scheduleDisposition: ScheduleDisposition, scheduleRevision: string): Promise<SessionRemoval>;
  recoverDeletions(): Promise<void>;
  isScheduleBlocked(scheduleId: string): boolean;
};
type SessionRemoval = {
  removed: { sessions: number; jobs: number; monitors: number };
  moved: { jobs: number; monitors: number };
};
type Dependencies = {
  repository: SessionRepository; storage: SessionStorage; hub: SessionHub;
  jobs: JobService; monitors: MonitorService; actions: ActionService; feedback: MessageFeedbackRepository;
  pauseMain: () => { stopped: Promise<void>; resume(): void };
  forgetPresence: (sessionId: string) => void;
  isJobRunning: (sessionId: string) => boolean;
  settleMonitorDeliveries: (sessionId: string) => Promise<void>;
};
const validate = (id: string) => { if (!isSessionId(id)) throw new SessionError(400, "INVALID_SESSION_ID", "Invalid sessionId"); };
const titleOf = (title: string) => {
  const value = title.trim();
  if (!value || value.length > 200) throw new SessionError(400, "INVALID_TITLE", "Title must be 1–200 characters");
  return value;
};
const publicRecord = ({ id, title, createdAt, updatedAt, isMain }: StoredSessionRecord): SessionRecord =>
  ({ id, title, createdAt, updatedAt, isMain });

/** 把跨存储删除意图写入会话目录后才关停执行；恢复时只补写幂等清理。 */
export const createSessionService = (deps: Dependencies): SessionService => {
  const get = async (id: string) => { validate(id); return (await deps.repository.read()).find((s) => s.id === id); };
  const requireSession = async (id: string) => {
    const record = await get(id);
    if (!record) throw new SessionError(404, "SESSION_NOT_FOUND", "Session not found");
    return record;
  };
  const blockedSchedules = new Set<string>();
  const setBlocked = ({ schedules }: SessionDeletion, blocked: boolean) => {
    for (const { id } of [...schedules.jobs, ...schedules.monitors]) {
      if (blocked) blockedSchedules.add(id);
      else blockedSchedules.delete(id);
    }
  };
  const readSchedules = async (id: string): Promise<SessionSchedules> => {
    const [allJobs, allMonitors] = await Promise.all([deps.jobs.list(), deps.monitors.list()]);
    const belongs = (item: { originSessionId?: string }) => (item.originSessionId ?? MAIN_SESSION_ID) === id;
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    const jobs = allJobs.filter(belongs).map(({ id, prompt }) => ({ id, title: prompt.slice(0, 80) })).sort(byId);
    const monitors = allMonitors.filter(belongs).map(({ id, title }) => ({ id, title })).sort(byId);
    const scheduleRevision = createHash("sha256").update(JSON.stringify({ jobs, monitors })).digest("hex");
    return { jobs, monitors, scheduleRevision };
  };
  const completeDeletion = async (id: string, deletion: SessionDeletion): Promise<SessionRemoval> => {
    // 先释放旧会话内排队的监控投递，再转移仍处于待投递状态的通知。
    await deps.settleMonitorDeliveries(id);
    await deps.actions.cancelBySessionId(id);
    const { scheduleDisposition, schedules } = deletion;
    if (scheduleDisposition === "move-to-main") {
      await deps.jobs.moveByOriginSessionId(id, MAIN_SESSION_ID);
      await deps.monitors.moveByOriginSessionId(id, MAIN_SESSION_ID);
    } else {
      await deps.jobs.removeByOriginSessionId(id);
      await deps.monitors.removeByOriginSessionId(id);
    }
    await deps.feedback.removeSession(id);
    await deps.storage.remove(id);
    await deps.repository.update((sessions) => ({ sessions: sessions.filter((s) => s.id !== id), result: undefined }));
    setBlocked(deletion, false);
    deps.forgetPresence(id);
    const counts = { jobs: schedules.jobs.length, monitors: schedules.monitors.length };
    const none = { jobs: 0, monitors: 0 };
    return {
      removed: { sessions: 1, ...(scheduleDisposition === "delete" ? counts : none) },
      moved: scheduleDisposition === "move-to-main" ? counts : none,
    };
  };
  return {
    get: async (id) => { const record = await get(id); return record && publicRecord(record); },
    list: async () => (await deps.repository.read()).map(publicRecord).sort((a, b) => Number(b.isMain) - Number(a.isMain) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)),
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
    reset: async (id) => {
      await requireSession(id);
      const pause = id === MAIN_SESSION_ID ? deps.pauseMain() : undefined;
      await pause?.stopped;
      try {
        return await deps.hub.resetSession(id, async ({ closeCurrent, reopen }) => {
          if ((await requireSession(id)).deletion) throw new SessionError(409, "SESSION_DELETING", "Session deletion is pending");
          await deps.actions.cancelBySessionId(id);
          await closeCurrent();
          await deps.actions.cancelBySessionId(id);
          await deps.storage.clearHistory(id);
          await deps.feedback.removeSession(id);
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
    schedules: async (id) => {
      const record = await requireSession(id);
      return record.deletion?.schedules ?? readSchedules(id);
    },
    isScheduleBlocked: (id) => blockedSchedules.has(id),
    recoverDeletions: async () => {
      for (const { id, deletion } of await deps.repository.read()) {
        if (!deletion) continue;
        setBlocked(deletion, true);
        await deps.hub.deleteSession(id, () => completeDeletion(id, deletion));
      }
    },
    remove: async (id, scheduleDisposition, scheduleRevision) => {
      validate(id);
      if (id === MAIN_SESSION_ID) throw new SessionError(409, "CANNOT_DELETE_MAIN_SESSION", "Cannot delete main session");
      let admitted: SessionDeletion | undefined;
      return deps.hub.deleteSession(id, () => completeDeletion(id, admitted!), async () => {
        const record = await requireSession(id);
        const schedules = record.deletion?.schedules ?? await readSchedules(id);
        if (schedules.scheduleRevision !== scheduleRevision)
          throw new SessionError(409, "SESSION_SCHEDULES_CHANGED", "Session schedules changed; review them again");
        if (record.deletion && record.deletion.scheduleDisposition !== scheduleDisposition)
          throw new SessionError(409, "SESSION_DELETION_IN_PROGRESS", "Resume deletion with the original schedule choice");
        if (scheduleDisposition === "move-to-main" && deps.isJobRunning(id))
          throw new SessionError(409, "SESSION_JOB_RUNNING", "Wait for the session's scheduled job to finish before moving its schedules");
        admitted = record.deletion ?? { scheduleDisposition, schedules };
        if (!record.deletion) await deps.repository.update((sessions) => ({
          sessions: sessions.map((session) => session.id === id ? { ...session, deletion: admitted } : session),
          result: undefined,
        }));
        setBlocked(admitted, true);
      });
    },
  };
};
