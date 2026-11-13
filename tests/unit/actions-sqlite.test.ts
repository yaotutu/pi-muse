/**
 * 审批记录的 SQLite 仓储回归：表结构约束、行级 diff 提交与重启保持。
 *
 * 只覆盖 storage 域自身（main.sqlite 的 actions 表），不触碰 HTTP/服务/pi，
 * 不发外部调用，也不读取任何真实实例数据。
 *
 * 覆盖事项：
 * - 新增审批后可读回且字段完全一致；payload 键序与内容保真；
 * - 状态机非法组合由数据库 CHECK 直接拒绝（pending 带 resolved_at、
 *   approved 缺 decided_at、unknown 带 finished_at 等）；
 * - execution 只允许挂在 approved 上，各状态的 finished_at/result 约束成立；
 * - 未命中 update 不写库；更新只改变化行；内容未变化时不产生任何写入；
 * - 同 id 重复拒绝；重启后数据仍在；按 position 保序读回。
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createActionRepository } from "../../src/adapters/storage/action-repository.js";
import { openActionStore } from "./actions-sqlite-fixture.js";
import { openSqliteDatabase, type ManagedSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import { actionsModule } from "../../src/adapters/storage/actions-schema.js";
import type { PendingAction } from "../../src/features/actions/types.js";

const at = "2026-10-19T00:00:00.000Z";
const expires = "2026-10-19T00:05:00.000Z";

/** 构造测试用 PendingAction：默认 pending，所有归属字段为 null。 */
const record = (changes: Partial<PendingAction> = {}): PendingAction => ({
  id: "approval-1",
  kind: "file_write",
  title: "Write draft",
  payload: { path: "draft.md", content: "after" },
  status: "pending",
  revision: 1,
  createdAt: at,
  expiresAt: expires,
  resolvedAt: null,
  decidedAt: null,
  sessionId: null,
  runId: null,
  toolCallId: null,
  subagentId: null,
  activityId: null,
  ...changes,
});

/** 直接写一行原始数据，用来验证数据库约束本身（而不是仓储层的封装）。 */
const rawInsert = (managed: ManagedSqliteDatabase, overrides: Record<string, unknown> = {}): void => {
  const row: Record<string, unknown> = {
    id: "raw-1",
    session_id: null,
    run_id: null,
    tool_call_id: null,
    subagent_id: null,
    activity_id: null,
    kind: "file_write",
    status: "pending",
    title: "raw title",
    payload_json: "{}",
    revision: 1,
    position: 0,
    created_at: at,
    expires_at: expires,
    decided_at: null,
    resolved_at: null,
    execution_status: null,
    execution_started_at: null,
    execution_finished_at: null,
    execution_result: null,
    ...overrides,
  };
  const columns = Object.keys(row);
  managed.database.prepare(
    `INSERT INTO actions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((column) => row[column] as string | number | null));
};

/** 连接级累计变更行数；用于证明"没有写库"和"只改了变化行"。 */
const totalChanges = async (managed: ManagedSqliteDatabase): Promise<number> =>
  Number((managed.database.prepare("SELECT total_changes() AS changes").get() as { changes: number }).changes);

const store = async (t: TestContext) => {
  const opened = await openActionStore("pi-muse-actions-sqlite-");
  t.after(() => opened.close());
  return opened;
};

test("新增审批后可读回且字段完全一致", async (t) => {
  const opened = await store(t);
  const action = record({
    id: "a-1",
    kind: "file_edit",
    title: "写入 note.md",
    payload: { path: "note.md", content: "after", originalContent: "before" },
    sessionId: "main",
    runId: "run-1",
    toolCallId: "call-1",
    subagentId: "sub-1",
    activityId: "act-1",
  });

  await opened.repository.update((items) => ({ items: [...items, action], result: undefined }));
  const read = await opened.repository.read();
  assert.equal(read.length, 1);
  assert.deepEqual(read[0], action);

  // 终态与执行回执同样逐字段保真。
  const executed = record({
    id: "a-2",
    status: "approved",
    revision: 3,
    resolvedAt: at,
    decidedAt: at,
    execution: { status: "succeeded", startedAt: at, finishedAt: at, result: "committed" },
  });
  await opened.repository.update((items) => ({ items: [...items, executed], result: undefined }));
  const after = await opened.repository.read();
  assert.deepEqual(after[1], executed);
  assert.deepEqual(after[1].execution, executed.execution);
});

test("payload 键序与内容保真", async (t) => {
  const opened = await store(t);
  const payload = { path: "note.md", content: "多字节 ✓ 内容", originalContent: "", baseVersion: "v1" };
  await opened.repository.update((items) => ({ items: [...items, record({ id: "p-1", payload })], result: undefined }));

  const read = await opened.repository.read();
  assert.deepEqual(read[0].payload, payload);
  assert.deepEqual(Object.keys(read[0].payload), Object.keys(payload));
  const raw = opened.managed.database.prepare("SELECT payload_json FROM actions WHERE id = ?").get("p-1") as { payload_json: string };
  assert.equal(raw.payload_json, JSON.stringify(payload));
});

test("数据库拒绝非法状态机组合", async (t) => {
  const opened = await store(t);
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["pending 带 resolved_at", { status: "pending", resolved_at: at }],
    ["pending 带 decided_at", { status: "pending", decided_at: at }],
    ["终态缺 resolved_at", { status: "approved", decided_at: at }],
    ["approved 缺 decided_at", { status: "approved", resolved_at: at }],
    ["denied 缺 decided_at", { status: "denied", resolved_at: at }],
    ["expired 带 decided_at", { status: "expired", resolved_at: at, decided_at: at }],
    ["cancelled 带 decided_at", { status: "cancelled", resolved_at: at, decided_at: at }],
    ["resolved_at 非规范时刻", { status: "approved", decided_at: at, resolved_at: "2026-10-19" }],
    ["decided_at 非规范时刻", { status: "approved", resolved_at: at, decided_at: "2026-10-19T00:00:00+00:00" }],
    ["created_at 非规范时刻", { created_at: "2026-10-19" }],
    ["expires_at 非规范时刻", { expires_at: "not-a-date" }],
    ["revision 非正整数", { revision: 0 }],
    ["kind 非法", { kind: "shell" }],
    ["status 非法", { status: "unknown" }],
    ["payload 不是 JSON", { payload_json: "{broken" }],
    ["payload 不是对象", { payload_json: "[]" }],
  ];
  for (const [label, overrides] of invalid) {
    assert.throws(
      () => rawInsert(opened.managed, overrides),
      (error: unknown) => {
        assert.match(String((error as Error).message), /CHECK constraint failed/i, `${label} 必须被数据库拒绝`);
        return true;
      },
      `expected reject: ${label}`,
    );
  }
  assert.equal((await opened.repository.read()).length, 0);
});

test("仓储边界拒绝 payload 里的非字符串值", async (t) => {
  const opened = await store(t);
  await assert.rejects(
    opened.repository.update((items) => ({
      items: [...items, record({ id: "bad-payload", payload: { content: 42 } as unknown as Record<string, string> })],
      result: undefined,
    })),
    /Approval payload must be a string map|Invalid actions document/,
  );
  assert.equal((await opened.repository.read()).length, 0);
});

test("execution 只允许挂在 approved 上，且各状态的 finished_at/result 约束成立", async (t) => {
  const opened = await store(t);
  const approved = { status: "approved", resolved_at: at, decided_at: at } as const;
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["pending 携带执行事实", { ...approved, status: "pending", resolved_at: null, decided_at: null, execution_status: "running", execution_started_at: at }],
    ["denied 携带执行事实", { ...approved, status: "denied", execution_status: "running", execution_started_at: at }],
    ["expired 携带执行事实", { ...approved, status: "expired", decided_at: null, execution_status: "running", execution_started_at: at }],
    ["cancelled 携带执行事实", { ...approved, status: "cancelled", decided_at: null, execution_status: "running", execution_started_at: at }],
    ["缺少 started_at", { ...approved, execution_status: "running" }],
    ["running 带 finished_at", { ...approved, execution_status: "running", execution_started_at: at, execution_finished_at: at }],
    ["running 带 result", { ...approved, execution_status: "running", execution_started_at: at, execution_result: "ok" }],
    ["unknown 带 finished_at", { ...approved, execution_status: "unknown", execution_started_at: at, execution_finished_at: at }],
    ["succeeded 缺 finished_at", { ...approved, execution_status: "succeeded", execution_started_at: at }],
    ["succeeded 的 finished_at 非规范", { ...approved, execution_status: "succeeded", execution_started_at: at, execution_finished_at: "2026-10-19" }],
    ["failed 缺 finished_at", { ...approved, execution_status: "failed", execution_started_at: at }],
    ["cancelled 执行缺 finished_at", { ...approved, execution_status: "cancelled", execution_started_at: at }],
    ["execution 状态非法", { ...approved, execution_status: "success", execution_started_at: at }],
  ];
  for (const [label, overrides] of invalid) {
    assert.throws(
      () => rawInsert(opened.managed, overrides),
      (error: unknown) => {
        assert.match(String((error as Error).message), /CHECK constraint failed/i, `${label} 必须被数据库拒绝`);
        return true;
      },
      `expected reject: ${label}`,
    );
  }

  // 合法组合：五个执行状态都能落库并原样读回。
  const legal: PendingAction[] = (["running", "succeeded", "failed", "cancelled", "unknown"] as const).map((status, index) =>
    record({
      id: `exec-${status}`,
      status: "approved",
      revision: 3,
      resolvedAt: at,
      decidedAt: at,
      execution: {
        status,
        startedAt: at,
        finishedAt: status === "running" || status === "unknown" ? null : at,
        result: status === "running" ? null : "receipt",
      },
    }));
  await opened.repository.update((items) => ({ items: [...items, ...legal], result: undefined }));
  const read = await opened.repository.read();
  for (const [index, action] of legal.entries()) {
    assert.deepEqual(read[index].execution, action.execution);
  }
});

test("未命中 update 不写库，内容未变化的 update 也不产生写入", async (t) => {
  const opened = await store(t);
  await opened.repository.update((items) => ({ items: [...items, record({ id: "a-1" })], result: undefined }));
  const before = await totalChanges(opened.managed);

  // 未命中：回调不返回 items，绝不写库。
  await opened.repository.update(() => ({ result: "not-found" }));
  assert.equal(await totalChanges(opened.managed), before);

  // 返回完全相同的 items：行级 diff 不产生任何 UPDATE。
  await opened.repository.update((items) => ({ items, result: "unchanged" }));
  assert.equal(await totalChanges(opened.managed), before);
  assert.equal((await opened.repository.read()).length, 1);
});

test("更新只改变化行，其它行的 revision 与决定时间不受影响", async (t) => {
  const opened = await store(t);
  const first = record({ id: "a-1" });
  const second = record({ id: "a-2", title: "keep me" });
  await opened.repository.update((items) => ({ items: [...items, first, second], result: undefined }));
  const before = await totalChanges(opened.managed);

  await opened.repository.update((items) => {
    const target = items.find((item) => item.id === "a-1");
    if (!target) return { result: undefined };
    target.status = "approved";
    target.resolvedAt = at;
    target.decidedAt = at;
    target.revision += 1;
    return { items, result: undefined };
  });

  assert.equal(await totalChanges(opened.managed) - before, 1, "只应写入发生变化的一行");
  const read = await opened.repository.read();
  assert.equal(read[0].status, "approved");
  assert.equal(read[0].revision, 2);
  assert.equal(read[0].decidedAt, at);
  assert.deepEqual(read[1], second, "未变化的行必须逐字段保持原样");
});

test("同 id 重复拒绝", async (t) => {
  const opened = await store(t);
  await opened.repository.update((items) => ({ items: [...items, record({ id: "dup" })], result: undefined }));

  // 数据库主键约束：同一 id 不能再次插入。
  assert.throws(
    () => rawInsert(opened.managed, { id: "dup", position: 1 }),
    (error: unknown) => {
      assert.match(String((error as Error).message), /UNIQUE constraint failed/i);
      return true;
    },
  );

  // 仓储层：回调返回两条同 id 的新记录时整体失败，不落半条数据。
  await assert.rejects(
    opened.repository.update((items) => ({
      items: [...items, record({ id: "dup-new" }), record({ id: "dup-new" })],
      result: undefined,
    })),
    (error: unknown) => {
      assert.match(String((error as Error).message), /UNIQUE constraint failed/i);
      return true;
    },
  );
  assert.equal((await opened.repository.read()).length, 1, "重复 id 的事务必须整体回滚");
});

test("重启后数据仍在，且按 position 保序读回", async (t) => {
  const opened = await store(t);
  const actions = [
    record({ id: "a-1", title: "first" }),
    record({ id: "a-2", title: "second" }),
    record({ id: "a-3", title: "third" }),
  ];
  await opened.repository.update((items) => ({ items: [...items, ...actions], result: undefined }));
  await opened.managed.close();

  const reopened = await openSqliteDatabase(opened.databaseFile);
  t.after(() => reopened.close());
  await reopened.serialize(() => ensureSqliteModules(reopened, [actionsModule]));
  const repository = createActionRepository(reopened);
  const read = await repository.read();
  assert.deepEqual(read, actions);
  assert.deepEqual(read.map((action) => action.title), ["first", "second", "third"]);
});

test("onCommitted 在提交后调用，通知失败不回滚已提交的数据", async (t) => {
  const opened = await store(t);
  let calls = 0;
  const repository = createActionRepository(opened.managed, () => {
    calls++;
    throw new Error("notification failed");
  });
  await repository.update((items) => ({ items: [...items, record({ id: "a-1" })], result: undefined }));
  assert.equal(calls, 1);
  assert.equal((await repository.read()).length, 1, "通知失败不能回滚已提交的数据");

  // 未命中 update 不触发通知。
  await repository.update(() => ({ result: undefined }));
  assert.equal(calls, 1);
});
