import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { openSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";

const databaseFile = async (prefix: string): Promise<{ file: string; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  return { file: join(dir, "probe.sqlite"), cleanup: () => rm(dir, { recursive: true, force: true }) };
};

test("openSqliteDatabase creates a WAL database with enforced modes, foreign keys and busy timeout", async (t) => {
  const { file, cleanup } = await databaseFile("pi-muse-sqlite-open");
  t.after(cleanup);
  const managed = await openSqliteDatabase(file);
  t.after(() => managed.close());
  assert.equal((managed.database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  assert.equal((managed.database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
  assert.equal(managed.database.prepare("PRAGMA synchronous").get()?.synchronous, 2, "FULL durability is the default");
  const timeout = (managed.database.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
  assert.ok(typeof timeout === "number" && timeout > 0 && timeout <= 60_000, "busy timeout must be bounded");
  const entry = await stat(file);
  assert.equal(entry.mode & 0o777, 0o600);
  // 写入后 SQLite 创建的 WAL 边车也必须是 0600。
  managed.transaction(() => {
    managed.database.exec("CREATE TABLE probe (id TEXT PRIMARY KEY)");
    managed.database.prepare("INSERT INTO probe (id) VALUES (?)").run("a");
  });
  for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
    const sidecarEntry = await stat(sidecar);
    assert.equal(sidecarEntry.mode & 0o777, 0o600, sidecar);
  }
});

test("openSqliteDatabase rejects symlinked library files and symlinked parent directories", async (t) => {
  const { file, cleanup } = await databaseFile("pi-muse-sqlite-symlink");
  t.after(cleanup);
  await writeFile(file, "");
  const linked = join(dirname(file), "linked.sqlite");
  await symlink(file, linked);
  await assert.rejects(openSqliteDatabase(linked), /Unsafe database file/);
  const realDir = join(dirname(file), "real-dir");
  await mkdir(realDir, { mode: 0o700 });
  const linkedDir = join(dirname(file), "linked-dir");
  await symlink(realDir, linkedDir);
  await assert.rejects(openSqliteDatabase(join(linkedDir, "probe.sqlite")), /Unsafe database directory/);
});

test("openSqliteDatabase refuses when the target path is not a regular file", async (t) => {
  const { file, cleanup } = await databaseFile("pi-muse-sqlite-dir-target");
  t.after(cleanup);
  const directoryTarget = join(dirname(file), "as-directory");
  await mkdir(directoryTarget);
  await assert.rejects(openSqliteDatabase(directoryTarget), /Unsafe database file/);
});

test("openSqliteDatabase reports corrupt files as database errors without overwriting them", async (t) => {
  const { file, cleanup } = await databaseFile("pi-muse-sqlite-corrupt");
  t.after(cleanup);
  const corrupt = "this is not a sqlite database at all........";
  await writeFile(file, corrupt);
  await assert.rejects(openSqliteDatabase(file), /file is not a database|Unable to open/);
  assert.equal((await stat(file)).size, corrupt.length);
});

test("serialize executes queued work in submission order across async boundaries", async (t) => {
  const { file, cleanup } = await databaseFile("pi-muse-sqlite-serialize");
  t.after(cleanup);
  const managed = await openSqliteDatabase(file);
  t.after(() => managed.close());
  const order: number[] = [];
  const gate = new Promise<void>((resolve) => { setTimeout(resolve, 30); });
  const first = managed.serialize(async () => {
    await gate;
    order.push(1);
    return "first";
  });
  const second = managed.serialize(async () => {
    order.push(2);
    throw new Error("boom");
  });
  const third = managed.serialize(() => {
    order.push(3);
    return "third";
  });
  assert.equal(await first, "first");
  await assert.rejects(second, /boom/);
  assert.equal(await third, "third");
  assert.deepEqual(order, [1, 2, 3]);
});

test("transaction commits and rolls back synchronously and rejects promise results", async (t) => {
  const { file, cleanup } = await databaseFile("pi-muse-sqlite-tx");
  t.after(cleanup);
  const managed = await openSqliteDatabase(file);
  t.after(() => managed.close());
  managed.database.exec("CREATE TABLE probe (id TEXT PRIMARY KEY)");
  managed.transaction(() => {
    managed.database.prepare("INSERT INTO probe (id) VALUES (?)").run("keep");
  });
  assert.throws(() => managed.transaction(() => {
    managed.database.prepare("INSERT INTO probe (id) VALUES (?)").run("lost");
    throw new Error("rollback me");
  }), /rollback me/);
  assert.deepEqual(
    managed.database.prepare("SELECT id FROM probe ORDER BY id").all().map((row) => (row as { id: string }).id),
    ["keep"],
  );
  assert.throws(() => managed.transaction(async () => "async"), /synchronous/);
  assert.deepEqual(
    managed.database.prepare("SELECT id FROM probe ORDER BY id").all().map((row) => (row as { id: string }).id),
    ["keep"],
  );
  assert.throws(() => managed.transaction(() => managed.transaction(() => undefined)), /Nested/);
});

test("close waits for queued work, rejects new work and fails closed connections accurately", async (t) => {
  const { file, cleanup } = await databaseFile("pi-muse-sqlite-close");
  t.after(cleanup);
  const managed = await openSqliteDatabase(file);
  let released!: () => void;
  const gate = new Promise<void>((resolve) => { released = resolve; });
  let ran = false;
  const queued = managed.serialize(async () => {
    await gate;
    managed.transaction(() => managed.database.exec("CREATE TABLE accepted_before_close (id TEXT)"));
    ran = true;
  });
  const closing = managed.close();
  await assert.rejects(managed.serialize(() => undefined), /closed/);
  assert.equal(ran, false);
  released();
  await queued;
  await closing;
  assert.equal(ran, true);
  assert.equal(managed.database.isOpen, false);
  assert.equal(await managed.close(), undefined, "second close returns the same settled promise");
});

test("opening a database does not chmod an existing destination directory", async (t) => {
  const { file, cleanup } = await databaseFile("pi-muse-sqlite-existing-parent");
  t.after(cleanup);
  const parent = join(dirname(file), "existing-parent");
  await mkdir(parent);
  await chmod(parent, 0o755);
  const managed = await openSqliteDatabase(join(parent, "data.sqlite"));
  try {
    assert.equal((await stat(parent)).mode & 0o777, 0o755);
    assert.equal((await stat(join(parent, "data.sqlite"))).mode & 0o777, 0o600);
  } finally { await managed.close(); }
});

test("a driver close failure is retained and rejects new work without leaking the open connection", async (t) => {
  const { file, cleanup } = await databaseFile("pi-muse-sqlite-close-error");
  t.after(cleanup);
  const managed = await openSqliteDatabase(file);
  const actualClose = managed.database.close.bind(managed.database);
  t.mock.method(managed.database, "close", () => {
    actualClose();
    throw new Error("synthetic close failure");
  });
  const closing = managed.close();
  await assert.rejects(closing, /synthetic close failure/);
  assert.equal(managed.close(), closing);
  await assert.rejects(managed.serialize(() => undefined), /closed/);
  assert.equal(managed.database.isOpen, false);
});

test("database files persist rows across close and reopen", async (t) => {
  const { file, cleanup } = await databaseFile("pi-muse-sqlite-reopen");
  t.after(cleanup);
  const first = await openSqliteDatabase(file);
  first.transaction(() => {
    first.database.exec("CREATE TABLE probe (id TEXT PRIMARY KEY)");
    first.database.prepare("INSERT INTO probe (id) VALUES (?)").run("persisted");
  });
  await first.close();
  const second = await openSqliteDatabase(file);
  t.after(() => second.close());
  assert.equal(
    (second.database.prepare("SELECT id FROM probe").get() as { id: string } | undefined)?.id,
    "persisted",
  );
  const entry = await lstat(file);
  assert.equal(entry.mode & 0o777, 0o600, "mode is re-tightened on reopen");
});
