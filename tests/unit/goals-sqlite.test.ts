import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createGoalRepository } from "../../src/adapters/storage/goal-repository.js";
import { goalsModule } from "../../src/adapters/storage/goals-schema.js";
import { openSqliteDatabase, type ManagedSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import { createGoalService } from "../../src/features/goals/goal-service.js";
import type { Goal } from "../../src/features/goals/types.js";

const TIMESTAMP = "2026-11-01T08:00:00.000Z";

const goal = (id: string, overrides: Partial<Goal> = {}): Goal => ({
  id,
  title: `目标 ${id}`,
  description: `描述 ${id}`,
  category: "general",
  status: "active",
  milestones: [
    { id: `${id}_m1`, title: "第一步", done: false },
    { id: `${id}_m2`, title: "第二步", done: true, doneAt: TIMESTAMP },
  ],
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  ...overrides,
});

const tempDirectory = async (prefix: string) => mkdtemp(join(tmpdir(), `${prefix}-`));

/** 隔离的 main.sqlite；测试不触碰真实实例目录。 */
const openFixture = async (t: TestContext, prefix: string) => {
  const directory = await tempDirectory(prefix);
  const file = join(directory, "main.sqlite");
  const managed = await openSqliteDatabase(file);
  t.after(async () => {
    await managed.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, file, managed };
};

const totalChanges = (managed: ManagedSqliteDatabase): number =>
  Number((managed.database.prepare("SELECT total_changes() AS count").get() as { count: number }).count);

/** 审计触发器：记录每次行级写入，验证 diff 不重写未变化的行。 */
const installAudit = (managed: ManagedSqliteDatabase): void => {
  const database = managed.database;
  database.exec(
    "CREATE TABLE goals_audit (kind TEXT NOT NULL, id TEXT NOT NULL);" +
    "CREATE TRIGGER goals_audit_goal_insert AFTER INSERT ON goals BEGIN INSERT INTO goals_audit (kind, id) VALUES ('insert', NEW.id); END;" +
    "CREATE TRIGGER goals_audit_goal_update AFTER UPDATE ON goals BEGIN INSERT INTO goals_audit (kind, id) VALUES ('update', NEW.id); END;" +
    "CREATE TRIGGER goals_audit_goal_delete AFTER DELETE ON goals BEGIN INSERT INTO goals_audit (kind, id) VALUES ('delete', OLD.id); END;" +
    "CREATE TRIGGER goals_audit_milestone_insert AFTER INSERT ON goal_milestones BEGIN INSERT INTO goals_audit (kind, id) VALUES ('insert', NEW.id); END;" +
    "CREATE TRIGGER goals_audit_milestone_update AFTER UPDATE ON goal_milestones BEGIN INSERT INTO goals_audit (kind, id) VALUES ('update', NEW.id); END;" +
    "CREATE TRIGGER goals_audit_milestone_delete AFTER DELETE ON goal_milestones BEGIN INSERT INTO goals_audit (kind, id) VALUES ('delete', OLD.id); END;",
  );
};

const auditRows = (managed: ManagedSqliteDatabase): Array<{ kind: string; id: string }> =>
  (managed.database.prepare("SELECT kind, id FROM goals_audit ORDER BY rowid").all() as Array<{ kind: string; id: string }>)
    .map((row) => ({ kind: row.kind, id: row.id }));

test("the goals module is registered in the schema ledger and starts empty", async (t) => {
  const { managed } = await openFixture(t, "pi-muse-goals-sqlite-ledger");
  const repository = createGoalRepository(managed);
  assert.deepEqual(await repository.read(), []);

  const ledger = (
    managed.database.prepare("SELECT module, version FROM app_schema_migrations").all() as Array<{ module: string; version: number }>
  ).map((row) => ({ module: row.module, version: row.version }));
  assert.deepEqual(ledger, [{ module: "goals", version: 1 }]);
  for (const table of goalsModule.tables) {
    assert.ok(
      managed.database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table),
      `missing table ${table}`,
    );
  }
});

test("a goal with milestones round-trips completely and keeps its stored order", async (t) => {
  const { managed } = await openFixture(t, "pi-muse-goals-sqlite-roundtrip");
  const repository = createGoalRepository(managed);
  const expected = goal("g1");
  await repository.update(() => ({ items: [expected], result: undefined }));
  assert.deepEqual(await repository.read(), [expected]);

  // 顺序语义与旧 JSON 数组一致：先写入的目标排在前面。
  const second = goal("g2");
  await repository.update(() => ({ items: [expected, second], result: undefined }));
  assert.deepEqual((await repository.read()).map((item) => item.id), ["g1", "g2"]);
});

test("milestone title and done flag are updated without touching other rows", async (t) => {
  const { managed } = await openFixture(t, "pi-muse-goals-sqlite-milestone");
  const repository = createGoalRepository(managed);
  const first = goal("g1");
  const second = goal("g2");
  await repository.update(() => ({ items: [first, second], result: undefined }));
  installAudit(managed);

  const changed = structuredClone(first);
  changed.milestones[0]!.done = true;
  changed.milestones[0]!.doneAt = TIMESTAMP;
  changed.milestones[1]!.title = "改过的第二步";
  await repository.update(() => ({ items: [changed, second], result: undefined }));

  // 只重写发生变化的那一行里程碑，目标行与其它目标的行都不被触碰。
  assert.deepEqual(auditRows(managed), [{ kind: "update", id: "g1_m1" }, { kind: "update", id: "g1_m2" }]);
  const read = await repository.read();
  assert.equal(read[0]!.milestones[0]!.done, true);
  assert.equal(read[0]!.milestones[0]!.doneAt, TIMESTAMP);
  assert.equal(read[0]!.milestones[1]!.title, "改过的第二步");
  assert.deepEqual(read[1], second);
});

test("deleting a goal removes its milestones through the database cascade", async (t) => {
  const { managed } = await openFixture(t, "pi-muse-goals-sqlite-cascade");
  const repository = createGoalRepository(managed);
  await repository.update(() => ({ items: [goal("g1"), goal("g2")], result: undefined }));

  await repository.update((items) => ({ items: items.filter((item) => item.id !== "g1"), result: true }));
  assert.deepEqual((await repository.read()).map((item) => item.id), ["g2"]);
  const left = managed.database
    .prepare("SELECT COUNT(*) AS count FROM goal_milestones WHERE goal_id = 'g1'")
    .get() as { count: number };
  assert.equal(left.count, 0, "milestones must not survive their goal");
  assert.equal(
    (managed.database.prepare("SELECT COUNT(*) AS count FROM goal_milestones").get() as { count: number }).count,
    2,
  );
});

test("an update that returns no items never writes to the database", async (t) => {
  const { managed } = await openFixture(t, "pi-muse-goals-sqlite-nohit");
  const repository = createGoalRepository(managed);
  const stored = goal("g1");
  await repository.update(() => ({ items: [stored], result: undefined }));
  const before = totalChanges(managed);
  installAudit(managed);

  const result = await repository.update((items) => {
    // 未命中：回调不返回 items。
    assert.equal(items.find((item) => item.id === "missing"), undefined);
    return { result: "miss" };
  });
  assert.equal(result, "miss");
  assert.equal(totalChanges(managed), before, "a missed update must not touch any row");
  assert.deepEqual(auditRows(managed), []);
  assert.deepEqual(await repository.read(), [stored]);
});

test("invalid status, empty title and duplicate ids are rejected without writing", async (t) => {
  const { managed } = await openFixture(t, "pi-muse-goals-sqlite-strict");
  const repository = createGoalRepository(managed);
  const stored = goal("g1");
  await repository.update(() => ({ items: [stored], result: undefined }));
  const before = totalChanges(managed);

  const invalidStatus = { ...stored, status: "done" as Goal["status"] };
  await assert.rejects(repository.update(() => ({ items: [invalidStatus], result: undefined })), /Invalid goals document/);

  const emptyTitle = { ...stored, title: "   " };
  await assert.rejects(repository.update(() => ({ items: [emptyTitle], result: undefined })), /Invalid goals document/);

  const duplicateGoal = { ...stored, milestones: [] };
  await assert.rejects(
    repository.update(() => ({ items: [duplicateGoal, { ...duplicateGoal }], result: undefined })),
    /Invalid goals document/,
  );

  const duplicateMilestone = {
    ...stored,
    milestones: [{ id: "m", title: "一", done: false }, { id: "m", title: "二", done: false }],
  };
  await assert.rejects(repository.update(() => ({ items: [duplicateMilestone], result: undefined })), /Invalid goals document/);

  assert.equal(totalChanges(managed), before, "rejected writes must not reach the database");
  assert.deepEqual(await repository.read(), [stored]);
});

test("data survives a restart of the database", async (t) => {
  const { file, managed } = await openFixture(t, "pi-muse-goals-sqlite-restart");
  const stored = goal("g1");
  await createGoalRepository(managed).update(() => ({ items: [stored], result: undefined }));
  await managed.close();

  const reopened = await openSqliteDatabase(file);
  t.after(() => reopened.close());
  assert.deepEqual(await createGoalRepository(reopened).read(), [stored]);
});

test("the goal service keeps its CRUD, status transition and milestone semantics on SQLite", async (t) => {
  const { managed } = await openFixture(t, "pi-muse-goals-sqlite-service");
  const goals = createGoalService(createGoalRepository(managed));

  const created = await goals.create({
    title: "完成半程马拉松",
    description: "年底前完成 21km",
    category: "fitness",
    milestones: ["跑量达 30km/周", "完成 15km 长距离"],
  });
  assert.equal(created.status, "active");
  assert.equal(created.milestones.length, 2);
  assert.equal((await goals.list()).length, 1);

  const toggled = await goals.toggleMilestone(created.id, created.milestones[0]!.id);
  assert.equal(toggled.milestone?.done, true);
  assert.equal((await goals.get(created.id))!.milestones[0]!.done, true);
  assert.ok((await goals.get(created.id))!.milestones[0]!.doneAt, "checking a milestone records its completion time");

  const completed = await goals.setStatus(created.id, "completed");
  assert.equal(completed!.status, "completed");
  assert.ok(completed!.milestones.every((milestone) => milestone.done), "completing a goal checks every milestone");

  const edited = await goals.edit(created.id, { title: "完成半程马拉松 2026", description: "改过的描述" });
  assert.equal(edited!.title, "完成半程马拉松 2026");
  assert.equal(edited!.description, "改过的描述");

  assert.equal(await goals.remove(created.id), true);
  assert.deepEqual(await goals.list(), []);
  assert.equal(
    (managed.database.prepare("SELECT COUNT(*) AS count FROM goal_milestones").get() as { count: number }).count,
    0,
  );
});

test("a repository opened on a database without the goals module fails explicitly", async (t) => {
  const { managed } = await openFixture(t, "pi-muse-goals-sqlite-missing");
  // 账本里已有别的模块却没有 goals：属于结构未安装，必须明确失败而不是接管。
  ensureSqliteModules(managed, [
    { id: "unrelated", version: 1, tables: ["unrelated"], ddl: ["CREATE TABLE unrelated (id TEXT PRIMARY KEY)"] },
  ]);
  assert.throws(() => createGoalRepository(managed), /goals module is not installed/);
});
