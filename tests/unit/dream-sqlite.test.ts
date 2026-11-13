import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDreamRepository } from "../../src/adapters/storage/dream-repository.js";
import { dreamModule } from "../../src/adapters/storage/dream-schema.js";
import { openSqliteDatabase, type ManagedSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import { defaultDreamState, type DreamState } from "../../src/features/dream/types.js";

const TIMESTAMP = "2026-11-01T08:00:00.000Z";
const SESSION = "00000000-0000-4000-8000-000000000001";

const tempDirectory = async (prefix: string) => mkdtemp(join(tmpdir(), `${prefix}-`));

const openDreamDatabase = async (directory: string): Promise<ManagedSqliteDatabase> => {
  const managed = await openSqliteDatabase(join(directory, "main.sqlite"));
  await managed.serialize(() => ensureSqliteModules(managed, [dreamModule]));
  return managed;
};

const fullState = (): DreamState => ({
  enabled: false,
  cursors: { main: "m-9", [SESSION]: "s-2" },
  lastRun: {
    at: TIMESTAMP,
    status: "partial",
    changed: ["user", "memory"],
    processed: 12,
    error: "INSTRUCTIONS.md was modified concurrently",
  },
  pending: [
    { id: "pending_1", text: "喜欢乌龙茶", suggestedTarget: "user", reason: "ambiguous", createdAt: TIMESTAMP },
    { id: "pending_2", text: "统一中文回复", suggestedTarget: "instructions", reason: "global_from_session", createdAt: TIMESTAMP, sourceSessionId: SESSION },
  ],
});

test("dream state round-trips the switch, cursors, pending items and last run", async (t) => {
  const directory = await tempDirectory("pi-muse-dream-sqlite-roundtrip");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const managed = await openDreamDatabase(directory);
  t.after(() => managed.close());

  const repository = createDreamRepository(managed);
  assert.deepEqual(await repository.read(), defaultDreamState());
  assert.equal("lastRun" in (await repository.read()), false);

  const expected = fullState();
  await repository.update(() => ({ state: expected, result: undefined }));
  const read = await repository.read();
  assert.deepEqual(read, expected);

  // 游标按会话保存并保留顺序；待决项与来源会话、错误信息都不丢失。
  assert.deepEqual(Object.entries(read.cursors), [["main", "m-9"], [SESSION, "s-2"]]);
  assert.deepEqual(read.pending.map((item) => item.id), ["pending_1", "pending_2"]);
  assert.equal(read.pending[0]?.sourceSessionId, undefined);
  assert.equal(read.pending[1]?.sourceSessionId, SESSION);
  assert.equal(read.lastRun?.error, "INSTRUCTIONS.md was modified concurrently");
  assert.deepEqual(read.lastRun?.changed, ["user", "memory"]);
});

test("startup reconcile fails an interrupted run without moving cursors or re-running", async (t) => {
  const directory = await tempDirectory("pi-muse-dream-sqlite-reconcile");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const managed = await openDreamDatabase(directory);
  t.after(() => managed.close());
  const repository = createDreamRepository(managed);

  const state = fullState();
  await repository.update(() => ({
    state: { ...state, lastRun: { at: TIMESTAMP, status: "running", changed: [], processed: 5 } },
    result: undefined,
  }));

  await repository.reconcileOnStart();
  const reconciled = await repository.read();
  assert.equal(reconciled.lastRun?.status, "failed");
  assert.match(reconciled.lastRun?.error ?? "", /Interrupted by service restart/);
  assert.equal(reconciled.lastRun?.at, TIMESTAMP);
  assert.equal(reconciled.lastRun?.processed, 5);
  // 游标与待决项不受重启影响，也不自动补跑。
  assert.deepEqual(Object.entries(reconciled.cursors), [["main", "m-9"], [SESSION, "s-2"]]);
  assert.deepEqual(reconciled.pending.map((item) => item.id), ["pending_1", "pending_2"]);

  // 已经收敛的状态再次校准不再写库。
  const settled = await repository.read();
  await repository.reconcileOnStart();
  assert.deepEqual(await repository.read(), settled);
});

test("dream state survives closing and reopening the database", async (t) => {
  const directory = await tempDirectory("pi-muse-dream-sqlite-restart");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await openDreamDatabase(directory);
  const expected = fullState();
  await createDreamRepository(first).update(() => ({ state: expected, result: undefined }));
  await first.close();

  const second = await openDreamDatabase(directory);
  t.after(() => second.close());
  assert.deepEqual(await createDreamRepository(second).read(), expected);
});

test("corrupted rows are rejected instead of silently reset", async (t) => {
  const directory = await tempDirectory("pi-muse-dream-sqlite-corrupt");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const managed = await openDreamDatabase(directory);
  t.after(() => managed.close());
  const repository = createDreamRepository(managed);
  await repository.update(() => ({ state: fullState(), result: undefined }));

  const database = managed.database;
  const restoreCursor = (database.prepare("SELECT cursor FROM dream_cursors WHERE session_id = 'main'").get() as { cursor: string }).cursor;
  database.prepare("UPDATE dream_cursors SET cursor = '' WHERE session_id = 'main'").run();
  await assert.rejects(repository.read(), /Invalid dream document/);
  database.prepare("UPDATE dream_cursors SET cursor = ? WHERE session_id = 'main'").run(restoreCursor);

  const lastRun = (database.prepare("SELECT last_run_json FROM dream_state").get() as { last_run_json: string }).last_run_json;
  for (const damage of ["not json", '{"at":"2026-11-01T08:00:00.000Z","status":"weird","changed":[],"processed":1}']) {
    database.prepare("UPDATE dream_state SET last_run_json = ?").run(damage);
    await assert.rejects(repository.read(), /Invalid dream document/);
  }
  database.prepare("UPDATE dream_state SET last_run_json = ?").run(lastRun);
  assert.deepEqual(await repository.read(), fullState());

  // 回调返回的坏结构必须被拒绝且不写库。
  await assert.rejects(
    repository.update((state) => ({ state: { ...state, enabled: "yes" as never }, result: undefined })),
    /Invalid dream document/,
  );
  assert.equal((await repository.read()).enabled, false);
});

test("a missing module registration is reported instead of silently creating tables", async (t) => {
  const directory = await tempDirectory("pi-muse-dream-sqlite-unregistered");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const managed = await openSqliteDatabase(join(directory, "main.sqlite"));
  t.after(() => managed.close());
  const repository = createDreamRepository(managed);
  await assert.rejects(repository.read(), /module dream is not registered|missing schema ledger/);

  assert.equal(dreamModule.id, "dream");
  assert.equal(dreamModule.version, 1);
  assert.deepEqual([...dreamModule.tables], ["dream_state", "dream_cursors", "dream_pending"]);
});
