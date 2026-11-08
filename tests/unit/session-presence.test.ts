import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionPresence, type SessionPresence } from "../../src/features/workspace/session-presence.js";
import { loadSessionRecency } from "../../src/adapters/storage/session-recency.js";
import { createWorkspaceEvents } from "../../src/features/workspace/workspace-events.js";
import { createWorkspaceEventRoutes } from "../../src/http/routes/events.js";

test("presence: 多来源按等待、错误、工作聚合，取消一个来源不影响其他工作", () => {
  const values: SessionPresence[] = [];
  const presence = createSessionPresence((value) => values.push(value));
  try {
    const rss = presence.observe("main", "rss", "正在收集新闻");
    const model = presence.observe("main", "information", "正在整理信息");
    assert.equal(values.at(-1)?.state, "working");
    assert.equal(values.at(-1)?.lastActiveAt, null, "后台开始和排队不算新结果");
    rss("cancelled");
    assert.equal(values.at(-1)?.state, "working");
    presence.set("main", "pending", { state: "waiting", label: "等待确认" });
    model("failed");
    assert.equal(values.at(-1)?.state, "waiting");
    presence.set("main", "pending", null);
    assert.equal(values.at(-1)?.state, "error");
    const retry = presence.observe("main", "information", "正在整理信息");
    assert.equal(values.at(-1)?.state, "working");
    retry("succeeded");
    assert.equal(values.at(-1)?.state, "idle");
    assert.ok(values.at(-1)?.lastActiveAt);
    assert.ok(values.every((value) => value.sessionId === "main"), "不归属通知的 main 承接者");
  } finally { presence.close(); }
});

test("presence: 相同进度不推帧、不改变有效活动；过期错误清除，关闭后迟到回调无效", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const values: SessionPresence[] = [];
  const presence = createSessionPresence((value) => values.push(value));
  const finish = presence.observe("a", "job", "工作中");
  const count = values.length;
  presence.set("a", "job", { state: "working", label: "工作中" });
  assert.equal(values.length, count);
  finish("failed");
  t.mock.timers.tick(300_000);
  assert.equal(values.at(-1)?.state, "idle");
  presence.close();
  presence.set("a", "late", { state: "error", label: "旧回调" });
  assert.equal(values.at(-1)?.state, "idle");
});

test("presence: 最近有效活动持久化，状态与历史错误不跨重启恢复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-recency-"));
  try {
    const file = join(dir, "session-recency.json");
    const repository = await loadSessionRecency(file);
    const presence = createSessionPresence(() => {}, repository.initial, repository.save);
    presence.touch("main");
    presence.set("main", "run", { state: "error", label: "失败" });
    await repository.flush();
    presence.close();
    const next = await loadSessionRecency(file);
    const restarted = createSessionPresence(() => {}, next.initial);
    assert.equal(restarted.current()[0].state, "idle");
    assert.ok(restarted.current()[0].lastActiveAt);
    restarted.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("presence: 真实 SSE ready 完整替换与后台工作增量，不增加通知连接", async () => {
  const events = createWorkspaceEvents();
  const finish = events.presence.observe("main", "rss", "正在收集新闻");
  const response = await createWorkspaceEventRoutes(events).request("/api/events");
  const reader = response.body!.getReader();
  try {
    const ready = new TextDecoder().decode((await reader.read()).value);
    assert.match(ready, /event: ready/);
    assert.match(ready, /"sessionPresences":\[\{"sessionId":"main","state":"working"/);
    finish("succeeded", true);
    const update = new TextDecoder().decode((await reader.read()).value);
    assert.match(update, /event: session_presence_updated/);
    assert.match(update, /"state":"idle"/);
    assert.match(update, /"sessionId":"main"/);
  } finally { await reader.cancel(); events.close(); }
});
