import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createToolPresentation } from "../../src/adapters/ag-ui/tool-presentation.js";
import { createSessionHistory, pruneJunkAgentStatusFromJsonlFile } from "../../src/adapters/pi/session-history.js";
import { createStatusObserver } from "../../src/adapters/pi/status-observer.js";
import { createDataLayout } from "../../src/adapters/storage/data-layout.js";
import { loadConfig } from "../../src/config/load-config.js";
import { AGENT_STATUS_ENTRY_TYPE } from "../../src/features/conversation/types.js";
import { isMeaningfulExecutionRun, summarizeRunSteps, type SessionStatus } from "../../src/features/workspace/session-status.js";
import { createWorkspaceEvents } from "../../src/features/workspace/workspace-events.js";

test("createStatusObserver records sanitized allowlisted step details, hides hidden tool names, and closes open steps on cancel", () => {
  const events = createWorkspaceEvents();
  const run = events.beginRun({ sessionId: "main", runId: "run-sanitize", source: "chat" });
  const presentation = createToolPresentation({
    default: "summary",
    overrides: { database: "hidden" },
  });
  const observer = createStatusObserver(run, presentation, null, null);

  observer({
    type: "tool_execution_start",
    toolCallId: "tc-search",
    toolName: "search_web",
    args: { query: "pi muse roadmap", secretHeader: "bearer-xyz" },
  } as unknown as AgentSessionEvent);
  observer({
    type: "tool_execution_end",
    toolCallId: "tc-search",
    toolName: "search_web",
    result: { details: {} },
    isError: false,
  } as unknown as AgentSessionEvent);

  observer({
    type: "tool_execution_start",
    toolCallId: "tc-fetch",
    toolName: "web_fetch",
    args: { url: "https://example.com/news/item?token=secret123#frag" },
  } as unknown as AgentSessionEvent);
  observer({
    type: "tool_execution_end",
    toolCallId: "tc-fetch",
    toolName: "web_fetch",
    result: { details: {} },
    isError: false,
  } as unknown as AgentSessionEvent);

  observer({
    type: "tool_execution_start",
    toolCallId: "tc-db",
    toolName: "database",
    args: { database: "main", sql: "SELECT * FROM private_users WHERE token = 'topsecret'" },
  } as unknown as AgentSessionEvent);
  observer({
    type: "tool_execution_end",
    toolCallId: "tc-db",
    toolName: "database",
    result: { details: {} },
    isError: false,
  } as unknown as AgentSessionEvent);

  observer({
    type: "tool_execution_start",
    toolCallId: "tc-write",
    toolName: "write",
    args: { path: "notes/plan.md", content: "SUPER SECRET BODY" },
  } as unknown as AgentSessionEvent);
  observer({
    type: "tool_execution_end",
    toolCallId: "tc-write",
    toolName: "write",
    result: { details: {} },
    isError: false,
  } as unknown as AgentSessionEvent);

  // An in-flight approval + running tool must close cleanly to cancelled on abort.
  observer({
    type: "tool_execution_start",
    toolCallId: "tc-pending",
    toolName: "edit",
    args: { path: "notes/draft.md", oldText: "a", newText: "b" },
  } as unknown as AgentSessionEvent);
  run.observe({
    kind: "approval",
    phase: "start",
    id: "approval:ap-1",
    parentId: "main:tool:tc-pending",
    approvalId: "ap-1",
    title: "等待确认编辑文件",
    detail: "notes/draft.md",
    status: "waiting_approval",
    result: null,
  });

  const cancelled = run.finish("cancelled");
  assert.equal(cancelled.status, "cancelled");

  const byId = new Map(cancelled.steps.map((s) => [s.id, s]));
  const search = byId.get("main:tool:tc-search")!;
  assert.deepEqual([search.kind, search.toolName, search.detail, search.status], ["tool", "search_web", "pi muse roadmap", "succeeded"]);

  const fetchStep = byId.get("main:tool:tc-fetch")!;
  assert.equal(fetchStep.detail, "example.com/news/item");
  assert.doesNotMatch(JSON.stringify(fetchStep), /secret123|frag/);

  const dbStep = byId.get("main:tool:tc-db")!;
  assert.equal(dbStep.toolName, null);
  assert.equal(dbStep.title, "操作数据库");
  assert.equal(dbStep.detail, "main");
  assert.doesNotMatch(JSON.stringify(dbStep), /SELECT|private_users|topsecret/);

  const commitStep = byId.get("main:tool:tc-write:commit")!;
  assert.equal(commitStep.kind, "file_commit");
  assert.equal(commitStep.detail, "notes/plan.md");
  assert.equal(commitStep.status, "succeeded");
  assert.doesNotMatch(JSON.stringify(cancelled.steps), /SUPER SECRET BODY/);

  const pendingTool = byId.get("main:tool:tc-pending")!;
  const pendingApproval = byId.get("approval:ap-1")!;
  assert.equal(pendingTool.status, "cancelled");
  assert.ok(pendingTool.endedAt);
  assert.equal(pendingApproval.status, "cancelled");
  assert.ok(pendingApproval.endedAt);
});

test("createSessionHistory tolerates legacy pi-muse.activity entries and normalizes agent-status entries missing steps", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-legacy-jsonl-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const layout = createDataLayout(dir);
  const { manager, history } = await createSessionHistory(layout, "main");
  history.appendNotification({ id: "seed-msg", text: "seed fact" });
  manager.appendCustomEntry("pi-muse.activity", { id: "act-1", status: "completed" });
  manager.appendCustomEntry(AGENT_STATUS_ENTRY_TYPE, {
    sessionId: "main",
    runId: "legacy-run",
    source: "chat",
    jobId: null,
    status: "succeeded",
    phase: null,
    label: "已完成",
    title: "旧轮次",
    tools: [],
    subagents: [],
    pendingApprovalIds: [],
    activityId: "act-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:05.000Z",
    revision: 2,
  });

  const reopened = await createSessionHistory(layout, "main");
  const statuses = reopened.history.sessionStatuses?.() ?? [];
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].runId, "legacy-run");
  assert.deepEqual(statuses[0].steps, []);
  assert.equal(Object.hasOwn(statuses[0], "activityId"), false);
  assert.equal(reopened.history.history().length, 1);
});

test("loadConfig defaults tools.writable.actionTimeoutMs to 24h and supports up to 7 days", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-timeout-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const defaultPath = join(dir, "default.json");
  await writeFile(defaultPath, JSON.stringify({}), { mode: 0o600 });
  assert.equal(loadConfig(defaultPath).writable.actionTimeoutMs, 86_400_000);

  const sevenDaysPath = join(dir, "seven-days.json");
  await writeFile(sevenDaysPath, JSON.stringify({ tools: { writable: { actionTimeoutMs: 604_800_000 } } }), { mode: 0o600 });
  assert.equal(loadConfig(sevenDaysPath).writable.actionTimeoutMs, 604_800_000);

  const eightDaysPath = join(dir, "eight-days.json");
  await writeFile(eightDaysPath, JSON.stringify({ tools: { writable: { actionTimeoutMs: 691_200_000 } } }), { mode: 0o600 });
  assert.throws(() => loadConfig(eightDaysPath));
});

test("summarizeRunSteps and isMeaningfulExecutionRun format action trails and filter plain chat runs", () => {
  const base: SessionStatus = {
    sessionId: "main",
    runId: "r-1",
    revision: 2,
    source: "chat",
    jobId: null,
    title: "帮我查天气并写草稿",
    status: "succeeded",
    phase: null,
    label: "执行完成",
    tools: [],
    subagents: [],
    pendingApprovalIds: [],
    steps: [],
    startedAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:01.000Z",
    endedAt: "2026-11-26T00:00:01.000Z",
  };
  assert.equal(isMeaningfulExecutionRun(base), false);
  assert.equal(isMeaningfulExecutionRun({ ...base, status: "cancelled" }), true);
  assert.equal(isMeaningfulExecutionRun({ ...base, source: "job" }), true);

  const summary = summarizeRunSteps([
    { id: "1", parentId: null, kind: "tool", title: "搜索网页", detail: "北京天气", status: "succeeded", result: "已完成", toolName: "search_web", approvalId: null, startedAt: "2026-11-26T00:00:00.000Z", endedAt: "2026-11-26T00:00:01.000Z" },
    { id: "2", parentId: null, kind: "tool", title: "写入文件", detail: "shared/weather.md", status: "denied", result: "操作被拒绝", toolName: "write", approvalId: null, startedAt: "2026-11-26T00:00:01.000Z", endedAt: "2026-11-26T00:00:02.000Z" },
    { id: "3", parentId: "2", kind: "file_commit", title: "文件提交", detail: "shared/weather.md", status: "denied", result: "未批准，未写入文件", toolName: null, approvalId: null, startedAt: "2026-11-26T00:00:02.000Z", endedAt: "2026-11-26T00:00:02.000Z" },
  ]);
  assert.equal(summary, "搜索网页（北京天气） → 写入文件（shared/weather.md）·已拒绝");
});

test("pruneJunkAgentStatusFromJsonlFile physically deletes legacy junk while keeping tree parent chain and meaningful runs intact", async (t) => {
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-prune-jsonl-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const layout = createDataLayout(dir);
  const { manager, history } = await createSessionHistory(layout, "main");
  history.appendNotification({ id: "msg-before", text: "first message" });
  manager.appendCustomEntry(AGENT_STATUS_ENTRY_TYPE, {
    sessionId: "main", runId: "junk-legacy", source: "chat", jobId: null,
    status: "cancelled", phase: null, label: "执行已停止", title: "正在处理请求",
    tools: [], subagents: [], pendingApprovalIds: [], steps: [],
    startedAt: "2026-11-24T00:00:00.000Z", updatedAt: "2026-11-24T00:00:05.000Z", endedAt: "2026-11-24T00:00:05.000Z", revision: 2,
  });
  manager.appendCustomEntry(AGENT_STATUS_ENTRY_TYPE, {
    sessionId: "main", runId: "junk-plain", source: "chat", jobId: null,
    status: "succeeded", phase: null, label: "执行完成", title: "1+1等于几",
    tools: [], subagents: [], pendingApprovalIds: [], steps: [],
    startedAt: "2026-11-25T00:00:00.000Z", updatedAt: "2026-11-25T00:00:02.000Z", endedAt: "2026-11-25T00:00:02.000Z", revision: 2,
  });
  history.appendNotification({ id: "msg-after", text: "second message" });
  manager.appendCustomEntry(AGENT_STATUS_ENTRY_TYPE, {
    sessionId: "main", runId: "keep-tool", source: "chat", jobId: null,
    status: "succeeded", phase: null, label: "查询当前时间", title: "现在几点",
    tools: [], subagents: [], pendingApprovalIds: [],
    steps: [{ id: "s1", parentId: null, kind: "tool", title: "查询当前时间", detail: null, status: "succeeded", result: "已完成", toolName: null, approvalId: null, startedAt: "2026-11-26T00:00:00.000Z", endedAt: "2026-11-26T00:00:01.000Z" }],
    startedAt: "2026-11-26T00:00:00.000Z", updatedAt: "2026-11-26T00:00:01.000Z", endedAt: "2026-11-26T00:00:01.000Z", revision: 3,
  });

  const histDir = join(dir, "sessions/main/history");
  const jsonlFile = join(histDir, (await readdir(histDir)).find((f) => f.endsWith(".jsonl"))!);
  const result = await pruneJunkAgentStatusFromJsonlFile(jsonlFile);
  assert.equal(result.removed, 2);

  const content = await readFile(jsonlFile, "utf8");
  assert.doesNotMatch(content, /junk-legacy|junk-plain/);
  assert.match(content, /keep-tool/);

  const reopened = await createSessionHistory(layout, "main");
  assert.equal(reopened.history.history().length, 2);
  const statuses = reopened.history.sessionStatuses?.() ?? [];
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]!.runId, "keep-tool");
});
