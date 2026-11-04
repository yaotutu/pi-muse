export type AgentPresence = {
  agentId: string;
  state: "idle" | "working" | "waiting" | "error";
  label: string;
  lastActiveAt: string | null;
};
export type WorkOutcome = "succeeded" | "failed" | "cancelled";
export type ObserveWork = (agentId: string, key: string, label: string) => (outcome: WorkOutcome, meaningful?: boolean) => void;
type Work = { state: Exclude<AgentPresence["state"], "idle">; label: string };
const priority = { working: 1, error: 2, waiting: 3 };
const ERROR_VISIBLE_MS = 5 * 60_000;

/** 只汇总展示事实，不持有执行锁、正文或任务队列；一次运行结束不清空同智能体的其他工作。 */
export const createAgentPresence = (changed: (value: AgentPresence) => void, initial: Record<string, string> = {},
  saveRecency: (value: Record<string, string>) => void = () => {}) => {
  const recent = new Map(Object.entries(initial));
  const work = new Map<string, Map<string, Work>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;
  const snapshot = (agentId: string): AgentPresence => {
    const current = [...(work.get(agentId)?.values() ?? [])].sort((a, b) => priority[b.state] - priority[a.state])[0];
    return { agentId, state: current?.state ?? "idle", label: current?.label ?? "空闲", lastActiveAt: recent.get(agentId) ?? null };
  };
  const emit = (id: string) => changed(snapshot(id));
  const touch = (id: string) => {
    recent.set(id, new Date().toISOString());
    saveRecency(Object.fromEntries(recent));
  };
  const set = (id: string, key: string, value: Work | null, meaningful = false) => {
    if (closed) return;
    const before = snapshot(id);
    const timerKey = JSON.stringify([id, key]);
    clearTimeout(timers.get(timerKey)); timers.delete(timerKey);
    const sources = work.get(id) ?? new Map<string, Work>();
    const previous = sources.get(key);
    if (value) sources.set(key, value); else sources.delete(key);
    if (sources.size) work.set(id, sources); else work.delete(id);
    // 新阻塞值得浮到前面；恢复已有待办或重复相同阶段不是新活动。
    if (meaningful || (value?.state === "error" && previous?.state !== "error")) touch(id);
    if (JSON.stringify(before) !== JSON.stringify(snapshot(id))) emit(id);
    // 失败只提示本次问题；历史错误不在重连或重启后永久霸占头像。
    if (value?.state === "error") {
      const timer = setTimeout(() => set(id, key, null), ERROR_VISIBLE_MS);
      timer.unref(); timers.set(timerKey, timer);
    }
  };
  const start = (id: string, key: string, label: string, meaningful = false) => {
    for (const [oldKey, value] of work.get(id) ?? []) if (oldKey.split(':')[0] === key.split(':')[0] && value.state === 'error') set(id, oldKey, null);
    set(id, key, { state: "working", label }, meaningful);
  };
  const observe: ObserveWork = (id, key, label) => {
    start(id, key, label);
    let ended = false;
    return (outcome, meaningful = outcome === "succeeded") => {
      if (ended) return; ended = true;
      set(id, key, outcome === "failed" ? { state: "error", label: `${label}失败，请查看相关详情` } : null, meaningful);
    };
  };
  return {
    set, start, observe,
    forget: (id: string) => {
      if (closed) return;
      for (const key of work.get(id)?.keys() ?? []) set(id, key, null);
      recent.delete(id); saveRecency(Object.fromEntries(recent)); emit(id);
    },
    touch: (id: string) => { if (!closed) { touch(id); emit(id); } },
    current: () => [...new Set([...recent.keys(), ...work.keys()])].map(snapshot),
    close: () => { closed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); },
  };
};
