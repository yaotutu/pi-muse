/**
 * 审批存储 schema 与 repository 测试：只覆盖 storage 域自身（reader 与存储边界）。
 *
 * 不触碰 HTTP/服务/pi；不 mock 算法。验证事项：
 * - 必填关联字段（sessionId/runId/toolCallId/subagentId/activityId）
 *   必须是 string|null，缺省视为损坏；pending 必须 resolvedAt/decidedAt 全为 null；
 *   终态必须 resolvedAt 是合法日期；只有 approved/denied 才允许 decidedAt；
 * - execution 字段只在 status==='approved' 上合法；status 枚举合法；
 *   running/unknown 强制 finishedAt=null；其他终态 finishedAt 是合法日期；
 *   result 是字符串或 null；
 * - repository 在非法记录上拒绝写入，不修复、不截断已存记录。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { InvalidDocumentError } from "../../src/adapters/storage/document-schemas.js";
import { parseActions } from "../../src/adapters/storage/actions-schema.js";
import { openActionStore } from "./actions-sqlite-fixture.js";
import type { PendingAction } from "../../src/features/actions/types.js";

const at = "2026-10-19T00:00:00.000Z";

/** 构造测试用 PendingAction：默认 pending，所有 nullable 字段置 null。 */
const record = (changes: Partial<PendingAction> = {}): PendingAction => ({
  id: "approval-1",
  kind: "file_write",
  title: "Write draft",
  payload: { path: "draft.md", content: "after" },
  status: "pending",
  revision: 1,
  createdAt: at,
  expiresAt: "2026-10-19T00:05:00.000Z",
  resolvedAt: null,
  decidedAt: null,
  sessionId: null,
  runId: null,
  toolCallId: null,
  subagentId: null,
  activityId: null,
  ...changes,
});

test("action document accepts valid pending and terminal records including execution on approved", () => {
  const valid: PendingAction[] = [record()];

  // 四种 human/auto 终态：除 approved/denied 之外 decidedAt 必须为 null。
  for (const status of ["approved", "denied", "expired", "cancelled"] as const) {
    const decidedAt = status === "approved" || status === "denied" ? at : null;
    valid.push(record({
      id: `terminal-${status}`,
      status,
      revision: 2,
      resolvedAt: at,
      decidedAt,
    }));
  }

  // execution 仅允许挂在 approved 上：每个 status 都验证一遍。
  for (const status of ["running", "succeeded", "failed", "cancelled", "unknown"] as const) {
    valid.push(record({
      id: `execution-${status}`,
      status: "approved",
      revision: 3,
      resolvedAt: at,
      decidedAt: at,
      execution: {
        status,
        startedAt: at,
        // 仍在执行或中断后无法确认：finishedAt 必为 null；终态则必须是合法日期。
        finishedAt: status === "running" || status === "unknown" ? null : at,
        // 进行中的结果必为 null；已终态则允许任意字符串摘要（含 null 表示无附加信息）。
        result: status === "running" ? null : "Recorded outcome",
      },
    }));
  }

  assert.deepEqual(parseActions(valid), valid);
  assert.deepEqual(parseActions([]), []);

  // 文件不存在/不可读语义由 repository 处理；reader 接受裸数组。
  const ok = parseActions(valid);
  assert.equal(ok.length, valid.length);
});

test("action document rejects records missing mandatory nullable context fields or breaking status/time invariants", () => {
  const invalid: unknown[] = [
    {},
    { schemaVersion: 1, actions: [] },
    // 缺 createdAt / expiresAt
    [record({ createdAt: undefined as unknown as string })],
    [record({ expiresAt: "not-a-date" })],
    [record({ expiresAt: "2026-10-19" })], // 只有日期、无时间部分：canonical ISO 失效
    // pending 上不应有 decidedAt / resolvedAt
    [record({ decidedAt: at })],
    // 终态但缺 resolvedAt
    [record({ status: "approved" })],
    // denied/approved 缺 decidedAt 等于人工决定缺失
    [record({ status: "denied", decidedAt: "invalid" })],
    // payload 不是字符串键值
    [record({ payload: { content: 42 } as unknown as Record<string, string> })],
    // 必填关联字段类型非法
    [record({ sessionId: 42 as unknown as string | null })],
    [record({ runId: 42 as unknown as string | null })],
    [record({ toolCallId: 42 as unknown as string | null })],
    [record({ subagentId: 42 as unknown as string | null })],
    [record({ activityId: 42 as unknown as string | null })],
  ];

  for (const value of invalid) {
    assert.throws(() => parseActions(value), InvalidDocumentError, `expected reject: ${JSON.stringify(value)}`);
  }
});

test("action document allows execution only on approved status with valid started/finished/result invariants", () => {
  // execution 挂在非 approved 上：必须被 reader 拒绝，避免把执行事实误标为批准。
  for (const status of ["pending", "denied", "expired", "cancelled"] as const) {
    // pending 没有 decidedAt；denied 有人工决定需要 decidedAt；expired/cancelled 都保持 null。
    const decidedAt = status === "denied" ? at : null;
    const bogus = record({
      id: `on-${status}`,
      status,
      resolvedAt: status === "pending" ? null : at,
      decidedAt,
      execution: { status: "succeeded", startedAt: at, finishedAt: at, result: "ok" },
    });
    assert.throws(() => parseActions([bogus]), InvalidDocumentError, `${status} must not carry execution`);
  }

  // execution 自身形状：状态枚举、startedAt 必为 ISO，finishedAt/null 约束，result 字符串或 null。
  const invalidExecution = [
    { status: "success", startedAt: at, finishedAt: at, result: "wrong status" },
    { status: "running", startedAt: at, finishedAt: at, result: null },
    { status: "running", startedAt: at, finishedAt: null, result: "not complete" },
    { status: "failed", startedAt: "invalid", finishedAt: at, result: "failed" },
    { status: "succeeded", startedAt: at, finishedAt: null, result: "not recorded" },
    { status: "unknown", startedAt: at, result: "missing finish field" },
  ];
  for (const execution of invalidExecution) {
    const bogus = record({
      id: `bad-exec-${(execution.status ?? "unknown").replace(/\W+/g, "_")}`,
      status: "approved",
      revision: 3,
      resolvedAt: at,
      decidedAt: at,
      execution: execution as unknown as PendingAction["execution"],
    });
    assert.throws(() => parseActions([bogus]), InvalidDocumentError, `bad execution: ${JSON.stringify(execution)}`);
  }

  // running / unknown 必须 finishedAt=null；非空字符串视为损坏。
  for (const status of ["running", "unknown"] as const) {
    const bogus = record({
      id: `running-${status}`,
      status: "approved",
      revision: 3,
      resolvedAt: at,
      decidedAt: at,
      execution: {
        status,
        startedAt: at,
        finishedAt: "2026-10-19T00:01:00.000Z", // 必须为 null
        result: status === "running" ? null : "verify manually",
      },
    });
    assert.throws(() => parseActions([bogus]), InvalidDocumentError, `${status} must keep finishedAt null`);
  }
});

test("approval repository rejects an invalid record without rewriting or repairing its stored rows", async (t) => {
  const store = await openActionStore("approval-storage-invalid-");
  t.after(() => store.close());
  assert.deepEqual(await store.repository.read(), []);

  // 状态机非法的记录被数据库约束拒绝：整笔写入回滚，已存记录原样保留。
  await store.repository.update((items) => ({ items: [...items, record()], result: undefined }));
  const cases: PendingAction[] = [
    record({ id: "bad", status: "denied" }),
    record({ id: "bad", payload: { content: 123 } as unknown as Record<string, string> }),
    record({ id: "bad", status: "approved", decidedAt: at, execution: { status: "succeeded" } as never }),
    record({ id: "bad", execution: { status: "running", startedAt: at, finishedAt: null, result: null } as never }),
  ];
  for (const invalid of cases) {
    await assert.rejects(
      store.repository.update((items) => ({ items: [...items, invalid], result: undefined })),
      // 非法状态组合由数据库 CHECK 拒绝；payload 取值类型在写入前的仓储边界拒绝。
      /CHECK constraint failed|Approval payload must be a string map/i,
      `damaged record must be rejected: ${JSON.stringify(invalid)}`,
    );
  }
  // 已存的合法记录没有被修复、替换或截断。
  assert.equal((await store.repository.read()).length, 1);
});

test("approval repository round-trips records with execution by parsing and preserving the execution block", async (t) => {
  const store = await openActionStore("approval-storage-exec-");
  t.after(() => store.close());

  const withExecution = record({
    id: "approved-executed",
    status: "approved",
    revision: 3,
    resolvedAt: at,
    decidedAt: at,
    execution: { status: "succeeded", startedAt: at, finishedAt: at, result: "ok" },
  });

  await store.repository.update((items) => ({ items: [withExecution], result: undefined }));
  const read = await store.repository.read();
  assert.equal(read.length, 1);
  assert.deepEqual(read[0], withExecution);
  // 多次读取不产生额外写入：记录内容保持稳定。
  await store.repository.read();
  assert.equal((await store.repository.read()).length, 1);
  assert.deepEqual((await store.repository.read())[0].execution, withExecution.execution);
});
