import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createActionService } from "../../src/features/actions/action-service.js";
import { commitApprovedFile } from "../../src/adapters/pi/tools/file-approval.js";
import { openActionStore } from "./actions-sqlite-fixture.js";

const isErrorResult = (res: unknown): boolean => Boolean((res as { isError?: boolean })?.isError);

const setup = async (t: TestContext) => {
  const store = await openActionStore("pi-muse-approval-sql-authority-");
  t.after(() => store.close());
  const actions = createActionService(store.repository);
  const target = join(store.directory, "approved.txt");
  const content = "Only the content actually previewed may be written";
  const request = await actions.submit("file_write", "Write approved.txt", { path: "approved.txt", content }, { sessionId: "main" });
  const commit = (authority = actions) => commitApprovedFile({
    target, successPath: "approved.txt", content,
    approval: { id: request.id, expiresAt: Date.parse(request.expiresAt) }, actions: authority,
  });
  return { ...store, actions, request, target, content, commit };
};

test("a legal SQL approved state cannot manufacture a human file authorization", async (t) => {
  const fixture = await setup(t);
  await fixture.managed.serialize(() => fixture.managed.database.prepare(
    "UPDATE actions SET status='approved', decided_at=?, resolved_at=?, revision=revision+1 WHERE id=?",
  ).run(new Date().toISOString(), new Date().toISOString(), fixture.request.id));
  await assert.rejects(fixture.actions.get(fixture.request.id), /outside its decision flow/);
  assert.equal((await fixture.actions.poll(fixture.request.id)).status, "denied");
  assert.equal(isErrorResult(await fixture.commit()), true);
  await assert.rejects(stat(fixture.target), { code: "ENOENT" });
});

test("SQL preview changes cannot obtain authorization for the original tool content", async (t) => {
  const fixture = await setup(t);
  await fixture.managed.serialize(() => fixture.managed.database.prepare(
    "UPDATE actions SET payload_json=? WHERE id=?",
  ).run(JSON.stringify({ path: "approved.txt", content: "Different harmless preview" }), fixture.request.id));
  await assert.rejects(fixture.actions.get(fixture.request.id), /changed outside/);
  await assert.rejects(fixture.actions.snapshotPending(), /changed outside/);
  await assert.rejects(fixture.actions.resolveDecision(fixture.request.id, "approve"), /preview changed/);
  assert.equal(await fixture.actions.markExecuting(fixture.request.id), false);
  await assert.rejects(stat(fixture.target), { code: "ENOENT" });

  await fixture.managed.serialize(() => fixture.managed.database.prepare("UPDATE actions SET payload_json=? WHERE id=?")
    .run(JSON.stringify(fixture.request.payload), fixture.request.id));
  assert.equal((await fixture.actions.get(fixture.request.id))?.payload.content, fixture.content);
  assert.equal((await fixture.actions.resolveDecision(fixture.request.id, "approve")).ok, true);
  assert.equal(isErrorResult(await fixture.commit()), false);
  assert.equal(await readFile(fixture.target, "utf8"), fixture.content);
});

test("clearing the execution audit with SQL cannot reuse a consumed authorization", async (t) => {
  const fixture = await setup(t);
  await fixture.actions.resolveDecision(fixture.request.id, "approve");
  assert.equal(isErrorResult(await fixture.commit()), false);
  assert.equal(await readFile(fixture.target, "utf8"), fixture.content);
  await fixture.managed.serialize(() => fixture.managed.database.prepare(
    "UPDATE actions SET execution_status=NULL,execution_started_at=NULL,execution_finished_at=NULL,execution_result=NULL WHERE id=?",
  ).run(fixture.request.id));
  await rm(fixture.target);
  assert.equal(await fixture.actions.markExecuting(fixture.request.id), false);
  assert.equal(isErrorResult(await fixture.commit()), true);
  await assert.rejects(stat(fixture.target), { code: "ENOENT" });
});

test("SQL cannot change an approved expiry or hide its original session from cancellation", async (t) => {
  const fixture = await setup(t);
  await fixture.actions.resolveDecision(fixture.request.id, "approve");
  await fixture.managed.serialize(() => fixture.managed.database.prepare(
    "UPDATE actions SET expires_at=?,session_id='other' WHERE id=?",
  ).run("2099-01-01T00:00:00.000Z", fixture.request.id));
  await fixture.actions.cancelBySessionId("main");
  assert.equal(await fixture.actions.markExecuting(fixture.request.id), false);
  assert.equal(isErrorResult(await fixture.commit()), true);
  await assert.rejects(stat(fixture.target), { code: "ENOENT" });
});

test("a recreated service does not recover executable authorizations from audit rows", async (t) => {
  const fixture = await setup(t);
  await fixture.actions.resolveDecision(fixture.request.id, "approve");
  const reopened = createActionService(fixture.repository);
  await reopened.cancelPending();
  assert.equal(await reopened.markExecuting(fixture.request.id), false);
  assert.equal(isErrorResult(await fixture.commit(reopened)), true);
  await assert.rejects(stat(fixture.target), { code: "ENOENT" });
});

test("failure after a physical commit records unknown and never replays the write", async (t) => {
  const fixture = await setup(t);
  await fixture.actions.resolveDecision(fixture.request.id, "approve");
  const result = await commitApprovedFile({
    target: fixture.target, successPath: "approved.txt", content: fixture.content,
    approval: { id: fixture.request.id, expiresAt: Date.parse(fixture.request.expiresAt) },
    actions: fixture.actions, afterCommit: async () => { throw new Error("synthetic post-commit failure"); },
  });
  assert.equal(isErrorResult(result), true);
  assert.equal(await readFile(fixture.target, "utf8"), fixture.content);
  assert.equal((await fixture.actions.get(fixture.request.id))?.execution?.status, "unknown");
  assert.equal(await fixture.actions.markExecuting(fixture.request.id), false);
});
