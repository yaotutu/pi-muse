export const MAIN_SESSION_ID = "main";
export type SessionRecord = { id: string; title: string; createdAt: string; updatedAt: string; isMain: boolean };
export type ScheduleDisposition = "delete" | "move-to-main";
export type ScheduleSummary = { id: string; title: string };
export type SessionSchedules = { jobs: ScheduleSummary[]; monitors: ScheduleSummary[]; scheduleRevision: string };
export type SessionDeletion = { scheduleDisposition: ScheduleDisposition; schedules: SessionSchedules };
export type StoredSessionRecord = SessionRecord & { deletion?: SessionDeletion };
export type SessionRepository = {
  read(): Promise<StoredSessionRecord[]>;
  update<T>(change: (sessions: StoredSessionRecord[]) => { sessions?: StoredSessionRecord[]; result: T }): Promise<T>;
};
export type SessionStorage = {
  initialize(sessionId: string): Promise<void>;
  clearHistory(sessionId: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
};
export class SessionError extends Error {
  constructor(public readonly status: 400 | 404 | 409, public readonly code: string, message: string) { super(message); }
}
