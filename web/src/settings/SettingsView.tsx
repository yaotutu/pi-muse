import { useEffect, useState } from "react";
import {
  addMemory,
  editMemory,
  forgetMemory,
  getSessionSnapshot,
  getDreamOverview,
  updateDream,
  runDream,
  resolveDreamPending,
  getProfile,
  getSessionInstructions,
  listMemories,
  saveIdentity,
  saveProfile,
  saveSessionInstructions,
  type DreamOverviewDto,
  type IdentityDto,
  type MemoryDto,
} from "../lib/api";

const TONES: { value: string; label: string }[] = [
  { value: "warm", label: "温和" },
  { value: "concise", label: "简洁" },
  { value: "thoughtful", label: "细致" },
];

const TARGET_LABELS: Record<"user" | "soul" | "instructions" | "memory", string> = {
  user: "USER.md（用户画像）",
  soul: "SOUL.md（助手人设）",
  instructions: "本会话 INSTRUCTIONS.md",
  memory: "memory.json（长期记忆）",
};

/** 设置页：身份、按需检索记忆、SOUL/USER 人设、会话指令与 Dream 后台记忆整理。 */
export const SettingsView = ({ sessionId = "main" }: { sessionId?: string }) => {
  const currentSessionId = sessionId;
  const [identity, setIdentity] = useState<IdentityDto | null>(null);
  const [memories, setMemories] = useState<MemoryDto[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [profile, setProfile] = useState<{ soul: string; user: string } | null>(null);
  const [instructions, setInstructions] = useState("");
  const [dreamOverview, setDreamOverview] = useState<DreamOverviewDto | null>(null);
  const [pendingTargets, setPendingTargets] = useState<
    Record<string, "user" | "soul" | "instructions" | "memory">
  >({});
  const [runningDream, setRunningDream] = useState(false);
  const [notice, setNotice] = useState("");

  const flash = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(""), 2500);
  };

  const reloadMemories = (query = searchQuery) => {
    void listMemories(query).then(setMemories, (e: Error) => flash(e.message));
  };

  const reload = () => {
    void getSessionSnapshot().then((data) => {
      setIdentity(data.identity);
    });
    reloadMemories();
    void getProfile().then(setProfile);
    void getSessionInstructions(currentSessionId).then((data) => setInstructions(data.instructions));
    void getDreamOverview().then(setDreamOverview);

  };

  useEffect(reload, [currentSessionId]);

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-2xl space-y-6">
        {notice && (
          <div className="rounded-lg bg-green-50 px-3 py-2 text-center text-sm text-green-700">
            {notice}
          </div>
        )}

        {identity && (
          <section className="rounded-2xl border border-stone-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-stone-700">身份</h2>
            <div className="mt-3 flex items-center gap-3">
              <label className="text-sm text-stone-600">名字</label>
              <input
                value={identity.name}
                onChange={(e) => setIdentity({ ...identity, name: e.target.value })}
                className="flex-1 rounded-lg border border-stone-300 px-3 py-1.5 text-sm outline-none focus:border-stone-500"
              />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <label className="text-sm text-stone-600">语气</label>
              {TONES.map((tone) => (
                <button
                  key={tone.value}
                  onClick={() => setIdentity({ ...identity, tone: tone.value })}
                  className={`rounded-lg px-3 py-1.5 text-sm ${
                    identity.tone === tone.value
                      ? "bg-stone-800 text-white"
                      : "border border-stone-300 text-stone-600 hover:bg-stone-50"
                  }`}
                >
                  {tone.label}
                </button>
              ))}
            </div>
            <button
              onClick={() =>
                void saveIdentity(identity).then(
                  () => flash("身份已保存，下一轮对话生效"),
                  (e: Error) => flash(e.message),
                )
              }
              className="mt-4 rounded-lg bg-stone-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-stone-700"
            >
              保存身份
            </button>
          </section>
        )}

        <section className="rounded-2xl border border-stone-200 bg-white p-5 space-y-3">
          <h2>当前会话指令</h2>
          <p className="text-xs">仅作用于当前会话；main 同时承载新闻与短信偏好。不能扩大权限。</p>
          <textarea className="w-full border p-2" rows={8} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          <button onClick={() => void saveSessionInstructions(currentSessionId, instructions).then(() => flash("已保存"), (e: Error) => flash(e.message))}>保存指令</button>
        </section>
        {dreamOverview && (
          <section className="rounded-2xl border border-stone-200 bg-white p-5 space-y-3">
            <h2>Dream 全局记忆整理（每 {dreamOverview.intervalHours} 小时）</h2>
            <label><input type="checkbox" checked={dreamOverview.enabled} onChange={(e) => void updateDream({ enabled: e.target.checked }).then(setDreamOverview, (e: Error) => flash(e.message))} />启用后台整理</label>
            <button disabled={runningDream} onClick={() => { setRunningDream(true); void runDream().then(setDreamOverview, (e: Error) => flash(e.message)).finally(() => setRunningDream(false)); }}>{runningDream ? "整理中" : "立即整理"}</button>
            {dreamOverview.lastRun && <p>最近结果：{dreamOverview.lastRun.status} · {dreamOverview.lastRun.processed} 条 {dreamOverview.lastRun.error}</p>}
            <textarea className="w-full border p-2" rows={8} value={dreamOverview.globalPrompt} placeholder={dreamOverview.defaultPrompt} onChange={(e) => setDreamOverview({ ...dreamOverview, globalPrompt: e.target.value })} />
            <button onClick={() => void updateDream({ prompt: dreamOverview.globalPrompt }).then(setDreamOverview, (e: Error) => flash(e.message))}>保存全局提示词</button>
            {dreamOverview.pending.map((item) => <div className="border p-2" key={item.id}>
              <p className="whitespace-pre-wrap">{item.text}</p>
              <select value={pendingTargets[item.id] ?? item.suggestedTarget} onChange={(e) => setPendingTargets({ ...pendingTargets, [item.id]: e.target.value as "user" | "soul" | "instructions" | "memory" })}>{Object.entries(TARGET_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
              <button onClick={() => void resolveDreamPending(item.id, { action: "apply", target: pendingTargets[item.id] ?? item.suggestedTarget }).then(setDreamOverview, (e: Error) => flash(e.message))}>应用</button>
              <button onClick={() => void resolveDreamPending(item.id, { action: "dismiss" }).then(setDreamOverview, (e: Error) => flash(e.message))}>忽略</button>
            </div>)}
          </section>
        )}

        <section className="rounded-2xl border border-stone-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-stone-700">长期记忆（沉淀库）</h2>
          <p className="mt-1 text-xs text-stone-400">
            按需通过 memory_search 检索，不再每轮全量携带；也可对助手说“记住/忘掉 …”。
          </p>
          <div className="mt-3 flex gap-2">
            <input
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                reloadMemories(e.target.value);
              }}
              placeholder="按关键词检索记忆…"
              className="flex-1 rounded-lg border border-stone-300 px-3 py-1.5 text-sm outline-none focus:border-stone-500"
            />
          </div>
          <div className="mt-3 space-y-2">
            {memories.length === 0 && (
              <p className="py-2 text-center text-sm text-stone-400">还没有匹配的记忆</p>
            )}
            {memories.map((memory) => (
              <div
                key={memory.id}
                className="rounded-lg border border-stone-200 px-3 py-2 text-sm"
              >
                {editing?.id === memory.id ? (
                  <div className="space-y-2">
                    <textarea
                      value={editing.text}
                      onChange={(e) => setEditing({ id: memory.id, text: e.target.value })}
                      rows={2}
                      className="w-full resize-none rounded border border-stone-300 px-2 py-1 text-sm outline-none focus:border-stone-500"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() =>
                          void editMemory(memory.id, editing.text).then(
                            () => {
                              setEditing(null);
                              reloadMemories();
                              flash("已修改");
                            },
                            (e: Error) => flash(e.message),
                          )
                        }
                        className="rounded bg-stone-800 px-3 py-1 text-xs font-medium text-white"
                      >
                        保存
                      </button>
                      <button
                        onClick={() => setEditing(null)}
                        className="rounded border border-stone-300 px-3 py-1 text-xs text-stone-600"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <p className="whitespace-pre-wrap text-stone-700">{memory.text}</p>
                    <div className="flex shrink-0 gap-1">
                      <button
                        onClick={() => setEditing({ id: memory.id, text: memory.text })}
                        className="rounded border border-stone-300 px-2 py-0.5 text-xs text-stone-600 hover:bg-stone-50"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() =>
                          void forgetMemory(memory.id).then(
                            () => {
                              reloadMemories();
                              flash("已删除");
                            },
                            (e: Error) => flash(e.message),
                          )
                        }
                        className="rounded border border-red-200 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
                      >
                        忘记
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim())
                  void addMemory(draft.trim()).then(
                    () => {
                      setDraft("");
                      reloadMemories();
                      flash("已记住");
                    },
                    (err: Error) => flash(err.message),
                  );
              }}
              placeholder="记住一些关于我的事…"
              className="flex-1 rounded-lg border border-stone-300 px-3 py-1.5 text-sm outline-none focus:border-stone-500"
            />
            <button
              onClick={() =>
                draft.trim() &&
                void addMemory(draft.trim()).then(
                  () => {
                    setDraft("");
                    reloadMemories();
                    flash("已记住");
                  },
                  (err: Error) => flash(err.message),
                )
              }
              className="rounded-lg bg-stone-800 px-4 py-1.5 text-sm font-medium text-white"
            >
              记住
            </button>
          </div>
        </section>

        {profile && (
          <section className="rounded-2xl border border-stone-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-stone-700">人设文件（SOUL / USER）</h2>
            <p className="mt-1 text-xs text-stone-400">
              自由文本，每轮注入 system prompt；清空内容等于移除该段人设。
            </p>
            {(
              [
                { key: "soul", label: "SOUL.md（助手性格）" },
                { key: "user", label: "USER.md（用户画像）" },
              ] as const
            ).map(({ key, label }) => (
              <div key={key} className="mt-3">
                <label className="text-xs font-medium text-stone-500">{label}</label>
                <textarea
                  value={profile[key]}
                  onChange={(e) => setProfile({ ...profile, [key]: e.target.value })}
                  rows={6}
                  className="mt-1 w-full resize-y rounded-lg border border-stone-300 px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-stone-500"
                />
              </div>
            ))}
            <button
              onClick={() =>
                void saveProfile(profile).then(
                  () => flash("人设已保存，下一轮对话生效"),
                  (e: Error) => flash(e.message),
                )
              }
              className="mt-3 rounded-lg bg-stone-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-stone-700"
            >
              保存人设
            </button>
          </section>
        )}
      </div>
    </div>
  );
};
