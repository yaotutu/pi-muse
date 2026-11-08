export const MAIN_SESSION_ID = "main";
export type SessionRecord = { id: string; title: string; createdAt: string; updatedAt: string; isMain: boolean };
export type SessionRepository = {
  read(): Promise<SessionRecord[]>;
  update<T>(change: (sessions: SessionRecord[]) => { sessions?: SessionRecord[]; result: T }): Promise<T>;
};
export type SessionStorage = {
  initialize(sessionId: string): Promise<void>;
  clearHistory(sessionId: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
};
export class SessionError extends Error {
  constructor(public readonly status: 400 | 404 | 409, public readonly code: string, message: string) { super(message); }
}
