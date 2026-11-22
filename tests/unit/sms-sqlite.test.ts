import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createInformationRepository,
  parseInformationState,
} from "../../src/adapters/storage/information-repository.js";
import { SMS_SCHEMA_VERSION, smsModule } from "../../src/adapters/storage/sms-schema.js";
import { openSqliteDatabase, type ManagedSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import { defaultInformationState, type InformationState } from "../../src/features/information/types.js";

const TIMESTAMP = "2026-11-01T08:00:00.000Z";

const tempDirectory = async (prefix: string) => mkdtemp(join(tmpdir(), `${prefix}-`));

const openSmsDatabase = async (directory: string): Promise<ManagedSqliteDatabase> => {
  const managed = await openSqliteDatabase(join(directory, "main.sqlite"));
  await managed.serialize(() => ensureSqliteModules(managed, [smsModule]));
  return managed;
};

const item = (id: string, overrides: Partial<InformationState["items"][number]> = {}) => {
  const merged: InformationState["items"][number] = {
    id,
    queue: "realtime",
    source: "sms_inbox",
    externalId: `ext-${id}`,
    title: `Title ${id}`,
    content: `Content ${id}`,
    receivedAt: TIMESTAMP,
    acceptedAt: TIMESTAMP,
    status: "pending" as const,
    ...overrides,
  };
  if (merged.title === undefined) delete (merged as { title?: string }).title;
  return merged;
};

const fullState = (): InformationState => ({
  schemaVersion: 2,
  settings: { enabled: true, batchWindowSeconds: 30 },
  preferences: { learnedNotes: "用户偏好中文" },
  items: [
    item("info_1", { queue: "realtime", status: "processed", runId: "inforun_1" }),
    item("info_2", { queue: "archive", status: "failed", runId: "inforun_1" }),
    item("info_3", { queue: "realtime", status: "processing", runId: "inforun_2" }),
    item("info_4", { queue: "archive", title: undefined }),
  ],
  runs: [
    {
      id: "inforun_1",
      kind: "realtime",
      itemIds: ["info_1", "info_2"],
      status: "completed",
      createdAt: TIMESTAMP,
      startedAt: TIMESTAMP,
      finishedAt: TIMESTAMP,
      model: { status: "succeeded" },
      decisions: [
        { itemId: "info_1", decision: "notify", reason: "验证码" },
        { itemId: "info_2", decision: "silent", reason: "营销" },
      ],
      publications: [
        {
          notificationId: "notify_1",
          itemIds: ["info_1"],
          text: "验证码 1234",
          status: "published",
          receipt: { notificationId: "notify_1", piSessionId: "pi_1", messageId: "msg_1" },
        },
        {
          notificationId: "notify_2",
          itemIds: ["info_2"],
          text: "投递失败样例",
          status: "failed",
          error: "delivery failed",
        },
      ],
    },
    {
      id: "inforun_2",
      kind: "archive",
      itemIds: ["info_3"],
      status: "running",
      createdAt: TIMESTAMP,
      startedAt: TIMESTAMP,
      publications: [],
    },
  ],
});

test("sms v2 state round-trips queues, runs, decisions and publication payloads", async (t) => {
  const directory = await tempDirectory("pi-muse-sms-sqlite-roundtrip");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const managed = await openSmsDatabase(directory);
  t.after(() => managed.close());

  const repository = createInformationRepository(managed);
  assert.deepEqual(await repository.read(), defaultInformationState());

  const expected = parseInformationState(fullState());
  await repository.update(() => ({ state: expected, result: undefined }));
  const read = await repository.read();
  assert.deepEqual(read, expected);

  assert.deepEqual(read.items.map((entry) => entry.id), ["info_1", "info_2", "info_3", "info_4"]);
  assert.deepEqual(read.items.map((entry) => entry.queue), ["realtime", "archive", "realtime", "archive"]);
  assert.deepEqual(read.runs.map((run) => run.id), ["inforun_1", "inforun_2"]);
  assert.deepEqual(read.runs.map((run) => run.kind), ["realtime", "archive"]);
  assert.deepEqual(read.runs[0]?.itemIds, ["info_1", "info_2"]);
  assert.deepEqual(read.runs[0]?.decisions?.map((decision) => decision.itemId), ["info_1", "info_2"]);

  assert.deepEqual(read.runs[0]?.publications[0]?.receipt, {
    notificationId: "notify_1",
    piSessionId: "pi_1",
    messageId: "msg_1",
  });
  assert.equal(read.runs[0]?.publications[1]?.error, "delivery failed");
  assert.equal(read.runs[0]?.publications[1]?.status, "failed");

  assert.equal("decisions" in (read.runs[1]!), false);
  assert.equal("title" in read.items[3]!, false);
});

test("an update that returns no state never writes to the database", async (t) => {
  const directory = await tempDirectory("pi-muse-sms-sqlite-nowrite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const managed = await openSmsDatabase(directory);
  t.after(() => managed.close());
  const repository = createInformationRepository(managed);
  await repository.update(() => ({ state: parseInformationState(fullState()), result: undefined }));

  managed.database.exec("CREATE TABLE write_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT)");
  managed.database.exec(
    "CREATE TRIGGER audit_items AFTER INSERT ON sms_items BEGIN INSERT INTO write_audit (tag) VALUES ('item'); END",
  );
  managed.database.exec(
    "CREATE TRIGGER audit_runs AFTER UPDATE ON sms_runs BEGIN INSERT INTO write_audit (tag) VALUES ('run'); END",
  );

  const result = await repository.update((state) => ({ result: state.items.length }));
  assert.equal(result, 4);
  assert.deepEqual(managed.database.prepare("SELECT tag FROM write_audit").all(), []);
});

test("startup reconcile fails interrupted model runs and reverts processing items to pending", async (t) => {
  const directory = await tempDirectory("pi-muse-sms-sqlite-reconcile");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const managed = await openSmsDatabase(directory);
  t.after(() => managed.close());
  const repository = createInformationRepository(managed);

  const state = parseInformationState(fullState());
  await repository.update(() => ({ state, result: undefined }));
  const before = await repository.read();

  await repository.reconcileOnStart();
  const reconciled = await repository.read();

  assert.equal(reconciled.runs.length, before.runs.length);
  assert.equal(reconciled.runs[1]?.status, "failed");
  assert.equal(reconciled.runs[1]?.model?.status, "failed");
  assert.match(reconciled.runs[1]?.model?.error ?? "", /Interrupted by service restart/);
  assert.ok(reconciled.runs[1]?.finishedAt);
  assert.equal(reconciled.items[2]?.status, "pending");
  assert.equal(reconciled.items[2]?.runId, undefined);
  assert.equal(reconciled.items[3]?.status, "pending");
  assert.equal(reconciled.runs[0]?.publications[0]?.status, "published");
  assert.equal(reconciled.runs[0]?.model?.status, "succeeded");

  const snapshot = await repository.read();
  await repository.reconcileOnStart();
  assert.deepEqual(await repository.read(), snapshot);
});

test("pending publications of completed or mid-delivery running runs fail cleanly on startup", async (t) => {
  const directory = await tempDirectory("pi-muse-sms-sqlite-pending-publication");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const managed = await openSmsDatabase(directory);
  t.after(() => managed.close());
  const repository = createInformationRepository(managed);

  const state = parseInformationState(fullState());
  const pending: InformationState = {
    ...state,
    items: state.items.map((it) => (it.id === "info_3" ? { ...it, status: "processed" as const } : it)),
    runs: [
      {
        ...state.runs[0]!,
        status: "running",
        finishedAt: undefined,
        publications: [{ notificationId: "notify_1", itemIds: ["info_1"], text: "待投递", status: "pending" }],
      },
      {
        ...state.runs[1]!,
        status: "completed",
        model: { status: "succeeded" },
        decisions: [{ itemId: "info_3", decision: "notify", reason: "重要" }],
        publications: [{ notificationId: "notify_3", itemIds: ["info_3"], text: "待投递2", status: "pending" }],
      },
    ],
  };
  await repository.update(() => ({ state: pending, result: undefined }));
  await repository.reconcileOnStart();
  const reconciled = await repository.read();
  assert.equal(reconciled.runs[0]?.status, "completed");
  assert.equal(reconciled.runs[0]?.publications[0]?.status, "failed");
  assert.match(reconciled.runs[0]?.publications[0]?.error ?? "", /Interrupted by service restart/);
  assert.equal(reconciled.runs[1]?.status, "completed");
  assert.equal(reconciled.runs[1]?.publications[0]?.status, "failed");
});

test("sms state survives closing and reopening the database", async (t) => {
  const directory = await tempDirectory("pi-muse-sms-sqlite-restart");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await openSmsDatabase(directory);
  const expected = parseInformationState(fullState());
  await createInformationRepository(first).update(() => ({ state: expected, result: undefined }));
  await first.close();

  const second = await openSmsDatabase(directory);
  t.after(() => second.close());
  assert.deepEqual(await createInformationRepository(second).read(), expected);
});

test("invalid structures are rejected instead of being filtered or reset", async (t) => {
  const directory = await tempDirectory("pi-muse-sms-sqlite-invalid");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const managed = await openSmsDatabase(directory);
  t.after(() => managed.close());
  const repository = createInformationRepository(managed);
  await repository.update(() => ({ state: parseInformationState(fullState()), result: undefined }));

  await assert.rejects(
    repository.update(() => ({
      state: { ...defaultInformationState(), items: [{ id: "info_1", source: "sms", externalId: "1" }] } as never,
      result: undefined,
    })),
    /Invalid information state/,
  );
  await assert.rejects(
    repository.update((state) => ({
      state: {
        ...state,
        runs: [{ id: "run_x", kind: "realtime", itemIds: ["missing"], status: "running", createdAt: TIMESTAMP, startedAt: TIMESTAMP, publications: [] }],
      },
      result: undefined,
    })),
    /Invalid information state/,
  );
  assert.deepEqual((await repository.read()).items.map((entry) => entry.id), ["info_1", "info_2", "info_3", "info_4"]);

  managed.database.prepare("UPDATE sms_items SET content = '' WHERE id = 'info_1'").run();
  await assert.rejects(repository.read(), /Invalid information state/);
});

test("the sms v2 module owns only 5 sms tables and index without dead sms_feedback or news tables", async (t) => {
  const directory = await tempDirectory("pi-muse-sms-sqlite-ownership");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const managed = await openSmsDatabase(directory);
  t.after(() => managed.close());

  assert.equal(smsModule.id, "sms");
  assert.equal(SMS_SCHEMA_VERSION, 2);
  assert.equal(smsModule.version, 2);
  assert.deepEqual([...smsModule.tables], ["sms_state", "sms_items", "sms_runs", "sms_run_items", "sms_decisions"]);

  const tables = (managed.database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((row) => row.name);
  assert.ok(tables.includes("sms_state"));
  assert.equal(tables.includes("sms_feedback"), false);
  assert.equal(tables.includes("sms_feedback_comments"), false);
  assert.equal(tables.some((name) => name.startsWith("news_")), false);

  const indexes = (managed.database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all() as Array<{ name: string }>)
    .map((row) => row.name);
  assert.ok(indexes.includes("idx_sms_items_queue_status"));
});

test("a missing module registration is reported instead of silently creating tables", async (t) => {
  const directory = await tempDirectory("pi-muse-sms-sqlite-unregistered");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const managed = await openSqliteDatabase(join(directory, "main.sqlite"));
  t.after(() => managed.close());
  const repository = createInformationRepository(managed);
  await assert.rejects(repository.read(), /module sms is not registered|missing schema ledger/);
});
