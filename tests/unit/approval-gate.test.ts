import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createActionService } from "../../src/features/actions/action-service.js";
import { awaitApproval, encodeProposalPayload, type ApprovalObservation } from "../../src/features/actions/approval-gate.js";
import { createActionRepository } from "../../src/adapters/storage/action-repository.js";
import { actionsModule } from "../../src/adapters/storage/actions-schema.js";
import { openSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import { presentApproval } from "../../src/http/approval-presenters.js";

test("awaitApproval supports generic proposal workflows (approve, deny, abort cancel) and emits step events", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-approval-gate-"));
  const managed = await openSqliteDatabase(join(dir, "main.sqlite"));
  t.after(async () => {
    await managed.close();
    await rm(dir, { recursive: true, force: true });
  });
  await managed.serialize(() => ensureSqliteModules(managed, [actionsModule]));
  const actions = createActionService(createActionRepository(managed));

  const payload = encodeProposalPayload({
    category: "habit_learning",
    summary: "以后汇总技术调研时默认先给一句结论，再分条列细节。",
    target: "USER.md",
    items: [
      { label: "依据", value: "最近 3 次对话反馈" },
      { label: "变更", value: "新增 1 条表达偏好" },
    ],
    confirmLabel: "采纳",
    denyLabel: "暂不",
  });

  // 1) Approve flow
  const eventsApprove: ApprovalObservation[] = [];
  const waitApprove = awaitApproval({
    actions,
    kind: "proposal",
    title: "是否采纳学习到的表达偏好",
    payload,
    timeoutMs: 60_000,
    context: { sessionId: "main", runId: "run-1" },
    observe: (event) => eventsApprove.push(event),
  });
  await new Promise((r) => setTimeout(r, 40));
  const [pending1] = (await actions.list()).filter((a) => a.status === "pending");
  assert.equal(pending1.kind, "proposal");
  const view1 = presentApproval(pending1);
  assert.deepEqual(view1.preview, {
    type: "proposal",
    category: "habit_learning",
    summary: "以后汇总技术调研时默认先给一句结论，再分条列细节。",
    target: "USER.md",
    items: [
      { label: "依据", value: "最近 3 次对话反馈" },
      { label: "变更", value: "新增 1 条表达偏好" },
    ],
    confirmLabel: "采纳",
    denyLabel: "暂不",
  });
  await actions.decide(pending1.id, "approve");
  const res1 = await waitApprove;
  assert.equal(res1.status, "approved");
  assert.deepEqual(eventsApprove.map((e) => [e.phase, e.status]), [["start", "waiting_approval"], ["end", "succeeded"]]);

  // 2) Deny flow
  const eventsDeny: ApprovalObservation[] = [];
  const waitDeny = awaitApproval({
    actions,
    kind: "proposal",
    title: "再次建议",
    payload,
    timeoutMs: 60_000,
    observe: (event) => eventsDeny.push(event),
  });
  await new Promise((r) => setTimeout(r, 40));
  const [pending2] = (await actions.list()).filter((a) => a.status === "pending");
  await actions.decide(pending2.id, "deny");
  const res2 = await waitDeny;
  assert.equal(res2.status, "denied");
  assert.deepEqual(eventsDeny.map((e) => [e.phase, e.status]), [["start", "waiting_approval"], ["end", "denied"]]);

  // 3) Abort signal cancellation
  const abort = new AbortController();
  const eventsCancel: ApprovalObservation[] = [];
  const waitCancel = awaitApproval({
    actions,
    kind: "action",
    title: "待取消动作",
    payload: encodeProposalPayload({ summary: "执行外部发布前确认" }),
    timeoutMs: 60_000,
    signal: abort.signal,
    observe: (event) => eventsCancel.push(event),
  });
  await new Promise((r) => setTimeout(r, 40));
  abort.abort();
  const res3 = await waitCancel;
  assert.equal(res3.status, "cancelled");
  assert.deepEqual(eventsCancel.map((e) => [e.phase, e.status]), [["start", "waiting_approval"], ["end", "cancelled"]]);
});
