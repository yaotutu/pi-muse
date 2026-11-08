/** Dream 是实例后台服务；状态与待决项全局保存，不属于某个会话目录。 */
export type DreamRunStatus = "running" | "completed" | "failed" | "partial";
export type DreamTarget = "user" | "soul" | "instructions" | "memory";
export type DreamPending = {
  id: string; text: string; suggestedTarget: DreamTarget;
  reason: "ambiguous" | "global_from_session" | "no_purpose";
  createdAt: string; sourceSessionId?: string;
};
export type DreamRun = { at: string; status: DreamRunStatus; changed: DreamTarget[]; processed: number; error?: string };
export type DreamState = { enabled: boolean; cursors: Record<string, string>; lastRun?: DreamRun; pending: DreamPending[] };
export const defaultDreamState = (): DreamState => ({ enabled: true, cursors: {}, pending: [] });
export type DreamRepository = {
  read(): Promise<DreamState>;
  update<T>(change: (state: DreamState) => { state?: DreamState; result: T }): Promise<T>;
};
export type DreamMessage = { id: string; role: "user" | "assistant"; text: string };
export type DreamWindow = { summary?: string; context: DreamMessage[]; fresh: DreamMessage[]; lastId?: string };
