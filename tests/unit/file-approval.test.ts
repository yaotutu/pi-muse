import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createActionService, type ActionService } from "../../src/features/actions/action-service.js";
import type { ActionRepository, PendingAction } from "../../src/features/actions/types.js";
import {
  awaitFileApproval,
  commitApprovedFile,
  deniedResult,
  MAX_TEXT_FILE_BYTES,
  readFileSnapshot,
  type ApprovalActions,
  type ApprovalContext,
} from "../../src/adapters/pi/tools/file-approval.js";
import { createWritableFileTools } from "../../src/adapters/pi/tools/files-writable.js";
import { resolveWorkspacePath, safeWorkspacePath } from "../../src/adapters/pi/tools/workspace-path.js";
import { createWorkspaceCommitQueue } from "../../src/adapters/workspace/file-commit-queue.js";

type Tools = ReturnType<typeof createWritableFileTools>;
type Params = { path: string; content: string } | { path: string; oldText: string; newText: string };

/** 本地测试夹具：保留对审批门控（awaitFileApproval + commitApprovedFile）的完整单测覆盖。 */
const safeTarget = async (root: string, path: string, boundaryDir?: string) => {
  if (!path.trim()) throw new Error("Unsafe path");
  const selected = resolveWorkspacePath(root, path);
  if (!selected || selected.path === selected.base) throw new Error("Unsafe path");
  return safeWorkspacePath(selected.base, selected.path, { allowMissing: true, boundaryDir });
};

const createApprovalTestTools = (
  root: string,
  actions: ApprovalActions,
  timeoutMs: number,
  context?: ApprovalContext,
) => ([
  {
    name: "write",
    async execute(_id: string, params: { path: string; content: string }, signal?: AbortSignal) {
      if (signal?.aborted) return deniedResult("Operation aborted; nothing was written.");
      if (Buffer.byteLength(params.content, "utf8") > MAX_TEXT_FILE_BYTES)
        return deniedResult("File too large: writes are limited to 100KB.");
      let target: string;
      let original;
      try {
        target = await safeTarget(root, params.path);
        original = await readFileSnapshot(target);
      } catch {
        return deniedResult("Access denied");
      }
      const approved = await awaitFileApproval(
        actions,
        "file_write",
        `写入 ${params.path}`,
        {
          path: params.path,
          content: params.content,
          originalContent: original?.content ?? "",
          baseVersion: original?.version ?? "missing",
          beforeExists: String(original !== undefined),
        },
        timeoutMs,
        signal,
        { ...context, toolCallId: _id },
      );
      if (!approved) return deniedResult("Write not approved (denied, expired or cancelled); nothing was written.");
      return commitApprovedFile({
        target,
        successPath: params.path,
        original,
        content: params.content,
        approval: approved,
        actions,
        signal,
        validateTarget: async (candidate) => (await safeTarget(root, params.path)) === candidate,
      });
    },
  },
  {
    name: "edit",
    async execute(_id: string, params: { path: string; oldText: string; newText: string }, signal?: AbortSignal) {
      if (signal?.aborted) return deniedResult("Operation aborted; nothing was written.");
      let target: string;
      let original;
      try {
        target = await safeTarget(root, params.path);
        original = await readFileSnapshot(target);
      } catch {
        return deniedResult("Access denied");
      }
      if (!original) return deniedResult("File not found.");
      const first = original.content.indexOf(params.oldText);
      if (first < 0) return deniedResult("oldText not found in the file.");
      if (original.content.indexOf(params.oldText, first + 1) >= 0)
        return deniedResult("oldText appears more than once; make it unique first.");
      const content = original.content.slice(0, first) + params.newText + original.content.slice(first + params.oldText.length);
      if (Buffer.byteLength(content, "utf8") > MAX_TEXT_FILE_BYTES)
        return deniedResult("File too large: edited files are limited to 100KB.");
      const approved = await awaitFileApproval(
        actions,
        "file_edit",
        `编辑 ${params.path}`,
        {
          path: params.path,
          oldText: params.oldText,
          newText: params.newText,
          originalContent: original.content,
          content,
          baseVersion: original.version,
          beforeExists: "true",
        },
        timeoutMs,
        signal,
        { ...context, toolCallId: _id },
      );
      if (!approved) return deniedResult("Edit not approved (denied, expired or cancelled); nothing was written.");
      return commitApprovedFile({
        target,
        successPath: params.path,
        original,
        content,
        approval: approved,
        actions,
        signal,
        validateTarget: async (candidate) => (await safeTarget(root, params.path)) === candidate,
      });
    },
  },
] as const);

/** 模拟真实 repository 的串行读改写和序列化隔离，不触碰用户实例/配置。 */
const memoryRepository = (initial: PendingAction[] = []): ActionRepository => {
  let items = structuredClone(initial);
  let tail = Promise.resolve();
  return {
    read: async () => { await tail; return structuredClone(items); },
    update: <T>(change: (items: PendingAction[]) => { items?: PendingAction[]; result: T }) => {
      const result = tail.then(() => {
        const next = change(structuredClone(items));
        if (next.items) items = structuredClone(next.items);
        return next.result;
      });
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const bounded = <T>(promise: Promise<T>, ms = 500) => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Operation did not finish promptly")), ms);
  })]).finally(() => clearTimeout(timer));
};
const fixture = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "file-approval-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "workspace");
  await mkdir(root);
  return { directory, root, actions: createActionService(memoryRepository()) };
};
type ToolExecuteResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
};
const execute = (
  tools: Tools | ReturnType<typeof createApprovalTestTools>,
  name: "write" | "edit",
  params: Params,
  signal?: AbortSignal,
): Promise<ToolExecuteResult> =>
  (
    tools.find((tool) => tool.name === name)!.execute as (
      toolCallId: string,
      params: never,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => Promise<ToolExecuteResult>
  )("test-call", params as never, signal, undefined, {} as never);

/** 自动决定只用于工具单测提速，仍通过真实审批服务状态机，不绕过 decide。 */
const approving = (
  actions: ActionService,
  beforeApprove: (action: PendingAction) => Promise<void> = async () => {},
): Pick<ActionService, "submit" | "poll" | "cancel" | "markExecuting" | "finishExecution"> => ({
  ...actions,
  submit: async (...args) => {
    const action = await actions.submit(...args);
    await beforeApprove(action);
    await actions.decide(action.id, "approve");
    return action;
  },
});

// 审批状态机：时效与取消必须在 repository 的同一更新中执行。
test("approval records explicit deadline and run ownership; late approve cannot revive it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const actions = createActionService(memoryRepository());
  const action = await actions.submit("file_write", "write", {}, { timeoutMs: 500, sessionId: "agent-a", runId: "run-a" });
  assert.equal(action.expiresAt, new Date(1_500).toISOString());
  assert.equal(action.sessionId, "agent-a");
  assert.equal(action.runId, "run-a");
  t.mock.timers.tick(500);
  assert.equal(await actions.decide(action.id, "approve"), undefined);
  assert.deepEqual(await actions.poll(action.id), { status: "expired" });
  const [expired] = await actions.list();
  // 过期是系统失效而不是人的决定：只写 resolvedAt，decidedAt 必须保持 null。
  assert.equal(expired.status, "expired");
  assert.equal(expired.revision, 2);
  assert.equal(expired.resolvedAt, new Date(1_500).toISOString());
  assert.equal(expired.decidedAt, null);
});

test("approval decision respects the stored deadline and fails closed for invalid deadlines", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const actions = createActionService(memoryRepository());
  const action = await actions.submit("file_edit", "edit", {}, { timeoutMs: 10 });
  t.mock.timers.tick(10);
  assert.deepEqual(await actions.poll(action.id), { status: "expired" });
  const { expiresAt: _, ...invalid } = action;
  const restored = createActionService(memoryRepository([invalid as PendingAction]));
  assert.equal(await restored.decide(action.id, "approve"), undefined);
  assert.deepEqual(await restored.poll(action.id), { status: "expired" });
});

test("approval cancellation is terminal and startup cleanup preserves settled decisions", async () => {
  const actions = createActionService(memoryRepository());
  const pending = await actions.submit("file_write", "pending", {});
  const cancelled = await actions.submit("file_write", "cancelled", {});
  const approved = await actions.submit("file_write", "approved", {});
  const denied = await actions.submit("file_edit", "denied", {});
  await actions.decide(approved.id, "approve");
  await actions.decide(denied.id, "deny");
  await actions.cancel(cancelled.id);
  await actions.cancel(cancelled.id);
  await actions.cancel("unknown");
  assert.equal(await actions.decide(cancelled.id, "approve"), undefined);
  await actions.cancelPending();
  const once = await actions.list();
  await actions.cancelPending();
  assert.deepEqual(await actions.list(), once);
  assert.deepEqual(once.map((action) => [action.id, action.status]), [
    [pending.id, "cancelled"], [cancelled.id, "cancelled"], [approved.id, "approved"], [denied.id, "denied"],
  ]);
});

test("approval rejects invalid durations", async () => {
  const actions = createActionService(memoryRepository());
  for (const timeoutMs of [0, -1, NaN, Infinity])
    await assert.rejects(actions.submit("file_write", "write", {}, { timeoutMs }));
  assert.deepEqual(await actions.list(), []);
});

test("workspace write and edit commit directly inside workspace without requesting approval", async (t) => {
  const { root } = await fixture(t);
  const queue = createWorkspaceCommitQueue();
  const tools = createWritableFileTools(root, { sessionId: "agent", runId: "run" }, root, queue);
  const bomContent = `\uFEFF${"正文".repeat(1_000)}`;
  const created = await execute(tools, "write", { path: "nested/note.md", content: bomContent });
  assert.equal(created.isError, undefined);
  assert.equal(await readFile(join(root, "nested/note.md"), "utf8"), bomContent);

  const edited = await execute(tools, "edit", {
    path: "nested/note.md",
    oldText: "\uFEFF正文正文",
    newText: "updated",
  });
  assert.equal(edited.isError, undefined);
  assert.equal(
    await readFile(join(root, "nested/note.md"), "utf8"),
    `updated${"正文".repeat(998)}`,
  );
  assert.deepEqual(await readdir(join(root, "nested")), ["note.md"]);
});

test("workspace write and edit enforce path safety, size, uniqueness and concurrent write detection", async (t) => {
  const { directory, root } = await fixture(t);
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "file"), "original");
  await symlink(join(outside, "file"), join(root, "linked-file"));
  await symlink(outside, join(root, "linked-parent"));
  const alias = join(directory, "alias");
  await symlink(root, alias);

  const queue = createWorkspaceCommitQueue();
  const tools = createWritableFileTools(root, undefined, root, queue);
  for (const path of ["linked-file", "linked-parent/file", "../outside/file", join(outside, "file"), ".", ""]) {
    assert.equal((await execute(tools, "write", { path, content: "mine" })).isError, true);
    assert.equal((await execute(tools, "edit", { path, oldText: "original", newText: "mine" })).isError, true);
  }
  assert.equal((await execute(createWritableFileTools(alias), "write", { path: "file", content: "mine" })).isError, true);
  assert.equal(await readFile(join(outside, "file"), "utf8"), "original");

  await writeFile(join(root, "file"), "a".repeat(99_999) + "x");
  assert.equal((await execute(tools, "edit", { path: "file", oldText: "x", newText: "中" })).isError, true);
  assert.equal((await execute(tools, "write", { path: "other", content: "中".repeat(33_334) })).isError, true);
  assert.equal((await execute(tools, "edit", { path: "file", oldText: "aa", newText: "b" })).isError, true);
  assert.equal((await execute(tools, "edit", { path: "file", oldText: "missing", newText: "b" })).isError, true);
  assert.equal((await execute(tools, "edit", { path: "file", oldText: "x", newText: "y" })).isError, undefined);
  assert.equal(Buffer.byteLength(await readFile(join(root, "file"), "utf8")), 100_000);
});

test("write approval exposes full content, version and execution context", async (t) => {
  const { root, actions } = await fixture(t);
  const original = "before".repeat(1_000);
  const content = "正文".repeat(1_000);
  await writeFile(join(root, "note.md"), original);
  const tools = createApprovalTestTools(root, approving(actions), 5_000, { sessionId: "agent", runId: "run" });
  const result = await execute(tools, "write", { path: "note.md", content });
  assert.equal(result.isError, undefined);
  const [action] = await actions.list();
  assert.deepEqual(action.payload, {
    path: "note.md", originalContent: original, content,
    baseVersion: action.payload.baseVersion, beforeExists: "true",
  });
  assert.notEqual(action.payload.baseVersion, "missing");
  assert.equal(action.sessionId, "agent");
  assert.equal(action.runId, "run");
  assert.equal(action.execution?.status, "succeeded");
  assert.equal(action.revision, 4);
  assert.equal(Date.parse(action.expiresAt) - Date.parse(action.createdAt), 5_000);
  assert.equal(await readFile(join(root, "note.md"), "utf8"), content);
  assert.deepEqual(await readdir(root), ["note.md"]);
});

test("new-file write approval records beforeExists=false with an empty before", async (t) => {
  const { root, actions } = await fixture(t);
  const result = await execute(createApprovalTestTools(root, approving(actions), 5_000), "write", { path: "nested/new.md", content: "new" });
  assert.equal(result.isError, undefined);
  const [action] = await actions.list();
  assert.deepEqual(action.payload, {
    path: "nested/new.md", originalContent: "", content: "new",
    baseVersion: "missing", beforeExists: "false",
  });
  assert.equal(await readFile(join(root, "nested/new.md"), "utf8"), "new");
});

test("execution claim failure stops file effects and receipt failure never reports that a committed file is absent", async (t) => {
  const { root, actions } = await fixture(t);
  const refused = { ...approving(actions), markExecuting: async () => false };
  const noClaim = await execute(createApprovalTestTools(root, refused, 5_000), "write", { path: "nested/file", content: "no claim" });
  assert.equal(noClaim.isError, true);
  assert.deepEqual(await readdir(root), []);

  const failedClaim = { ...approving(actions), markExecuting: async () => { throw new Error("private storage error"); } };
  await assert.rejects(execute(createApprovalTestTools(root, failedClaim, 5_000), "write", { path: "nested/file", content: "claim failed" }));
  assert.deepEqual(await readdir(root), []);

  const lostReceipt = { ...approving(actions), finishExecution: async () => { throw new Error("private storage error"); } };
  const committed = await execute(createApprovalTestTools(root, lostReceipt, 5_000), "write", { path: "committed.md", content: "saved" });
  assert.equal(committed.isError, true);
  assert.equal(await readFile(join(root, "committed.md"), "utf8"), "saved");
  assert.deepEqual(await readdir(root), ["committed.md"]);
  const text = committed.content[0];
  assert.equal(text.type, "text");
  if (text.type === "text") {
    assert.match(text.text ?? "", /File was committed/);
    assert.doesNotMatch(text.text ?? "", /nothing was written|private storage error/);
  }
  const last = (await actions.list()).at(-1)!;
  assert.equal(last.status, "approved");
  assert.equal(last.execution?.status, "running");
  await actions.cancelPending();
  assert.equal((await actions.get(last.id))?.execution?.status, "unknown");
});

test("edit approval exposes complete before/after and treats replacement syntax literally", async (t) => {
  const { root, actions } = await fixture(t);
  const oldText = "A".repeat(900);
  const newText = "$&$`$'" + "B".repeat(900);
  const original = "prefix:" + oldText + ":suffix";
  const content = "prefix:" + newText + ":suffix";
  await writeFile(join(root, "note.md"), original);
  const result = await execute(createApprovalTestTools(root, approving(actions), 5_000), "edit", { path: "note.md", oldText, newText });
  assert.equal(result.isError, undefined);
  const [action] = await actions.list();
  assert.equal(action.payload.oldText, oldText);
  assert.equal(action.payload.newText, newText);
  assert.equal(action.payload.originalContent, original);
  assert.equal(action.payload.content, content);
  assert.equal(action.payload.beforeExists, "true");
  assert.equal(await readFile(join(root, "note.md"), "utf8"), content);
});

test("approval abort before, during polling and during submit leaves no filesystem side effects", async (t) => {
  const { root, actions } = await fixture(t);
  const aborted = await execute(createApprovalTestTools(root, actions, 5_000), "write", { path: "nested/file", content: "new" }, AbortSignal.abort());
  assert.equal(aborted.isError, true);
  assert.deepEqual(await actions.list(), []);

  const polling = deferred<void>();
  const controller = new AbortController();
  const wrapped = { ...actions, poll: async (id: string) => { const res = await actions.poll(id); polling.resolve(); return res; } };
  const result = execute(createApprovalTestTools(root, wrapped, 5_000), "write", { path: "nested/file", content: "new" }, controller.signal);
  await polling.promise;
  controller.abort();
  assert.equal((await bounded(result)).isError, true);
  assert.deepEqual(await readdir(root), []);
});

test("denied, expired, or version-changed approvals never overwrite files", async (t) => {
  const { root, actions } = await fixture(t);
  const denying = { ...actions, submit: async (...args: Parameters<ActionService["submit"]>) => {
    const action = await actions.submit(...args);
    await actions.decide(action.id, "deny");
    return action;
  } };
  assert.equal((await execute(createApprovalTestTools(root, denying, 5_000), "write", { path: "file", content: "new" })).isError, true);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const expiring = { ...actions, submit: async (...args: Parameters<ActionService["submit"]>) => {
    const action = await actions.submit(...args);
    t.mock.timers.tick(10);
    return action;
  } };
  assert.equal((await execute(createApprovalTestTools(root, expiring, 10), "write", { path: "file", content: "new" })).isError, true);
  assert.deepEqual(await readdir(root), []);

  await writeFile(join(root, "file"), "original");
  const changed = approving(actions, async () => { await writeFile(join(root, "file"), "external"); });
  assert.equal((await execute(createApprovalTestTools(root, changed, 5_000), "write", { path: "file", content: "mine" })).isError, true);
  assert.equal(await readFile(join(root, "file"), "utf8"), "external");

  await writeFile(join(root, "same"), "original");
  const replaced = approving(actions, async () => {
    await writeFile(join(root, "replacement"), "original");
    await rename(join(root, "replacement"), join(root, "same"));
  });
  assert.equal((await execute(createApprovalTestTools(root, replaced, 5_000), "write", { path: "same", content: "mine" })).isError, true);
  assert.equal(await readFile(join(root, "same"), "utf8"), "original");
});

for (const name of ["write", "edit"] as const) {
  test(`${name} approvals from separate tools share a canonical workspace path commit queue`, async (t) => {
    const { root, actions } = await fixture(t);
    await writeFile(join(root, "file"), "original");
    const ready = deferred<void>();
    let count = 0;
    const wrapped = approving(actions, async () => { if (++count === 2) ready.resolve(); await ready.promise; });
    const first = createApprovalTestTools(root, wrapped, 5_000);
    const second = createApprovalTestTools(root, wrapped, 5_000);
    const params = (content: string): Params => name === "write"
      ? { path: "file", content }
      : { path: "file", oldText: "original", newText: content };
    const results = await Promise.all([execute(first, name, params("first")), execute(second, name, params("second"))]);
    assert.equal(results.filter((result) => !result.isError).length, 1);
    assert.equal(results.filter((result) => result.isError).length, 1);
    assert.match(await readFile(join(root, "file"), "utf8"), /^(first|second)$/);
  });
}
