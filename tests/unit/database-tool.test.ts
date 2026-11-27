import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { createDatabaseService } from "../../src/features/database/database-service.js";
import { DatabaseToolError } from "../../src/features/database/errors.js";
import type { DatabaseExecutionResult, DatabaseName, DatabaseRequest } from "../../src/features/database/types.js";
import { createDatabaseToolStore, type DatabaseToolConnection } from "../../src/adapters/storage/database-tool-store.js";
import { databaseTool } from "../../src/adapters/pi/tools/database.js";

/** Real SQLite; only the shared connection scheduling contract is supplied by this fixture. */
function managed(database = new DatabaseSync(":memory:")): DatabaseToolConnection {
  let pending = Promise.resolve();
  return {
    database,
    serialize(work) {
      const next = pending.then(work);
      pending = next.then(() => undefined, () => undefined);
      return next;
    },
    transaction(work) {
      database.exec("BEGIN");
      try {
        const result = work();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function fixture(t: TestContext) {
  const connections = { main: managed() };
  const requested: DatabaseName[] = [];
  const store = createDatabaseToolStore(async (name) => { requested.push(name); return connections[name]; });
  const service = createDatabaseService(store);
  t.after(async () => {
    for (const connection of Object.values(connections)) await connection.serialize(() => connection.database.close());
  });
  const execute = async (sql: string, extra: Partial<DatabaseRequest> = {}) =>
    await service.execute({ action: "execute", sql, ...extra }) as DatabaseExecutionResult;
  return { connections, requested, store, service, execute };
}
const integer = (value: number | string) => ({ type: "bigint", value: String(value) });
function errorCode(code: string, outcome?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof DatabaseToolError);
    assert.equal(error.code, code);
    if (outcome) assert.equal(error.outcome, outcome);
    return true;
  };
}

test("database lists only the logical managed main name", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.service.execute({ action: "list" }), {
    databases: [{ name: "main", default: true }],
  });
  assert.deepEqual(f.requested, []);
  await f.execute("CREATE TABLE own_table (id INTEGER)");
  const schema = await f.service.execute({ action: "schema" }) as DatabaseExecutionResult;
  assert.ok(schema.results[0]!.rows.some((row) => row[2] === "own_table"));
  await assert.rejects(f.execute("SELECT 1", { database: "other" as DatabaseName }), errorCode("invalid_request", "not_started"));
});

test("database permits SELECT bindings, unrestricted DDL/DML/ALTER/DROP and exact columns", async (t) => {
  const f = fixture(t);
  await f.execute("CREATE TABLE sample_preferences (id INTEGER PRIMARY KEY, secret TEXT)");
  await f.execute("ALTER TABLE sample_preferences ADD COLUMN custom INTEGER");
  const insert = await f.execute("INSERT INTO sample_preferences(secret,custom) VALUES (?, ?)", { params: ["safe ' quote ; SELECT", 4] });
  assert.equal(insert.results[0]!.changes, "1");
  await f.execute("UPDATE sample_preferences SET custom=:value WHERE secret=:secret", { params: { ":value": 7, ":secret": "safe ' quote ; SELECT" } });
  const rows = await f.execute("SELECT custom AS duplicate, custom AS duplicate, secret FROM sample_preferences");
  assert.deepEqual(rows.results[0]!.columns, ["duplicate", "duplicate", "secret"]);
  assert.deepEqual(rows.results[0]!.rows, [[integer(7), integer(7), "safe ' quote ; SELECT"]]);
  assert.equal(rows.results[0]!.changes, "0");
  assert.equal((await f.execute("DELETE FROM sample_preferences")).results[0]!.changes, "1");
  assert.equal((await f.execute("DROP TABLE sample_preferences")).results[0]!.changes, "0");
  assert.equal(f.connections.main.database.isTransaction, false);
});

test("database binds null and numeric parameters without interpolation and rejects unused bindings", async (t) => {
  const f = fixture(t);
  const result = await f.execute("SELECT :n, @text, $empty", { params: { ":n": 2.5, "@text": "' DROP TABLE x; --", "$empty": null } });
  assert.deepEqual(result.results[0]!.rows, [[2.5, "' DROP TABLE x; --", null]]);
  await assert.rejects(f.execute("SELECT :v", { params: { v: "must use prefix" } }), errorCode("sql_error"));
  await assert.rejects(f.execute("SELECT 1", { params: { ":unused": "anything" } }), errorCode("sql_error"));
});

test("database batches commit atomically and failures roll back DDL and DML", async (t) => {
  const f = fixture(t);
  const success = await f.service.execute({ action: "execute", statements: [
    { sql: "CREATE TABLE batch (n INTEGER UNIQUE)" },
    { sql: "INSERT INTO batch VALUES (?)", params: [1] },
    { sql: "SELECT * FROM batch" },
  ] }) as DatabaseExecutionResult;
  assert.equal(success.atomic, true);
  assert.deepEqual(success.results[2]!.rows, [[integer(1)]]);
  await assert.rejects(f.service.execute({ action: "execute", statements: [
    { sql: "CREATE TABLE should_rollback (n INTEGER)" },
    { sql: "INSERT INTO batch VALUES (2)" },
    { sql: "INSERT INTO batch VALUES (1)" },
  ] }), (error: unknown) => {
    errorCode("sql_error", "rolled_back")(error);
    assert.equal((error as DatabaseToolError).statementIndex, 2);
    return true;
  });
  assert.equal(f.connections.main.database.isTransaction, false);
  assert.deepEqual((await f.execute("SELECT * FROM batch")).results[0]!.rows, [[integer(1)]]);
  await assert.rejects(f.execute("SELECT * FROM should_rollback"), errorCode("sql_error"));
});

test("database rejects multistatement tails without executing the first write; handles trivia and triggers", async (t) => {
  const f = fixture(t);
  await f.execute("CREATE TABLE t (n TEXT)");
  await assert.rejects(f.execute("INSERT INTO t VALUES ('one'); INSERT INTO t VALUES ('two')"), errorCode("invalid_request", "not_started"));
  await assert.rejects(f.execute("INSERT INTO t VALUES ('one'); invalid tail"), errorCode("invalid_request"));
  await assert.rejects(f.execute("INSERT INTO t VALUES ('one'); -- hidden\nDROP TABLE t"), errorCode("invalid_request"));
  assert.deepEqual((await f.execute("SELECT * FROM t")).results[0]!.rows, []);
  await f.execute("CREATE TRIGGER duplicate AFTER INSERT ON t WHEN new.n='first' BEGIN INSERT INTO t VALUES ('second'); END;");
  const inserted = await f.execute("INSERT INTO t VALUES ('first'); ; -- trailing ;\n /* trivia */");
  assert.equal(inserted.results[0]!.changes, "2");
  assert.equal((await f.execute("SELECT ';text;'; -- comment")).results[0]!.rows[0]![0], ";text;");
});

test("database never leaves explicit transactions or savepoints across calls", async (t) => {
  const f = fixture(t);
  for (const sql of ["BEGIN", "BEGIN IMMEDIATE", "SAVEPOINT hold", "COMMIT", "ROLLBACK", "RELEASE hold", "END"]) {
    await assert.rejects(f.execute(sql), errorCode("host_boundary", "not_started"));
    assert.equal(f.connections.main.database.isTransaction, false);
  }
  await f.execute("CREATE TABLE next_call (n)");
  await assert.rejects(f.service.execute({ action: "execute", statements: [
    { sql: "INSERT INTO next_call VALUES (1)" }, { sql: "BEGIN" },
  ] }), errorCode("host_boundary", "rolled_back"));
  assert.deepEqual((await f.execute("SELECT * FROM next_call")).results[0]!.rows, []);
  assert.equal(f.connections.main.database.isTransaction, false);
});

test("database blocks file escapes and extension/host callbacks before filesystem effects", async (t) => {
  const f = fixture(t);
  const dir = await mkdtemp(join(tmpdir(), "database-tool-boundary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let hostCalls = 0;
  f.connections.main.database.function("writefile", (_path, _value) => { hostCalls++; return 1; });
  f.connections.main.database.function("arbitrary_host_process", () => { hostCalls++; return 1; });
  for (const sql of [
    `ATTACH '${join(dir, "escape.sqlite")}' AS external`,
    "ATTACH ':memory:' AS external", "ATTACH '' AS external", "DETACH external",
    `VACUUM INTO '${join(dir, "copy.sqlite")}'`,
    "SELECT load_extension('private-extension')",
    `SELECT writefile('${join(dir, "file.txt")}', 'not allowed')`,
    "SELECT arbitrary_host_process()",
    `PRAGMA temp_store_directory='${dir}'`, `PRAGMA data_store_directory='${dir}'`,
    "PRAGMA writable_schema=ON",
  ]) {
    await assert.rejects(f.execute(sql), (error: unknown) => {
      assert.ok(error instanceof DatabaseToolError);
      assert.equal(error.code, "host_boundary", sql);
      return true;
    });
    assert.equal(f.connections.main.database.isTransaction, false);
  }
  await assert.rejects(f.execute("VACUUM INTO ?", { params: [join(dir, "bound.sqlite")] }), errorCode("host_boundary"));
  assert.equal(hostCalls, 0);
  assert.deepEqual(await readdir(dir), []);
  assert.equal(f.connections.main.database.prepare("PRAGMA database_list").all().length, 1);
});

test("database permits normal VACUUM/PRAGMA and explicitly errors on incompatible batch maintenance", async (t) => {
  const f = fixture(t);
  await f.execute("CREATE TABLE test (n)");
  await f.execute("INSERT INTO test VALUES (1)");
  await f.execute("VACUUM");
  assert.equal(f.connections.main.database.isTransaction, false);
  assert.equal((await f.execute("PRAGMA integrity_check")).results[0]!.rows[0]![0], "ok");
  assert.equal((await f.execute("PRAGMA table_info(test)")).results[0]!.rows.length, 1);
  await f.execute("PRAGMA cache_size=100");
  await assert.rejects(f.service.execute({ action: "execute", statements: [
    { sql: "INSERT INTO test VALUES (2)" }, { sql: "VACUUM" },
  ] }), errorCode("sql_error", "rolled_back"));
  assert.deepEqual((await f.execute("SELECT * FROM test")).results[0]!.rows, [[integer(1)]]);
});

test("database rejects lock-retaining maintenance and nontransactional PRAGMAs in atomic batches", async (t) => {
  const f = fixture(t);
  await f.execute("CREATE TABLE pragma_test (n)");
  await assert.rejects(f.execute("PRAGMA locking_mode=EXCLUSIVE"), errorCode("unsupported_sql", "not_started"));
  await assert.rejects(f.execute("PRAGMA locking_mode=1"), errorCode("unsupported_sql", "not_started"));
  const cacheBefore = f.connections.main.database.prepare("PRAGMA cache_size").get()!.cache_size;
  await assert.rejects(f.service.execute({ action: "execute", statements: [
    { sql: "INSERT INTO pragma_test VALUES (1)" }, { sql: "PRAGMA cache_size=500" },
  ] }), errorCode("unsupported_sql", "rolled_back"));
  assert.equal(f.connections.main.database.prepare("PRAGMA cache_size").get()!.cache_size, cacheBefore);
  assert.deepEqual((await f.execute("SELECT * FROM pragma_test")).results[0]!.rows, []);
  const schemaQuery = await f.service.execute({ action: "execute", statements: [{ sql: "PRAGMA table_info(pragma_test)" }] }) as DatabaseExecutionResult;
  assert.equal(schemaQuery.results[0]!.rows.length, 1);
  await assert.rejects(f.service.execute({ action: "execute", statements: [
    { sql: "PRAGMA user_version=7" }, { sql: "SELECT * FROM missing_table" },
  ] }), errorCode("sql_error", "rolled_back"));
  assert.deepEqual((await f.execute("PRAGMA user_version")).results[0]!.rows, [[integer(0)]]);
  // SQLite can apply connection settings during prepare(). A rejected trailing statement does not
  // promise zero effects or invite automatic retries, even though no SQL step was executed.
  await assert.rejects(f.execute("PRAGMA cache_size=123; SELECT 1"), errorCode("invalid_request", "unknown"));
});

test("database releases file-backed read/write locks after truncated queries and batches", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "database-tool-locks-"));
  const path = join(dir, "synthetic.sqlite");
  const connection = managed(new DatabaseSync(path));
  const observer = new DatabaseSync(path);
  t.after(async () => {
    observer.close();
    await connection.serialize(() => connection.database.close());
    await rm(dir, { recursive: true, force: true });
  });
  const service = createDatabaseService(createDatabaseToolStore(async () => connection));
  await service.execute({ action: "execute", statements: [
    { sql: "CREATE TABLE locks (n)" }, { sql: "INSERT INTO locks VALUES(1),(2),(3)" },
  ] });
  const result = await service.execute({ action: "execute", sql: "SELECT * FROM locks", maxRows: 1 }) as DatabaseExecutionResult;
  assert.equal(result.results[0]!.rowsTruncated, "max_rows");
  observer.exec("INSERT INTO locks VALUES(4)");
  await assert.rejects(service.execute({ action: "execute", sql: "PRAGMA locking_mode=EXCLUSIVE" }), errorCode("unsupported_sql"));
  observer.exec("INSERT INTO locks VALUES(5)");
  await service.execute({ action: "execute", sql: "VACUUM" });
  assert.equal(connection.database.isTransaction, false);
  observer.exec("INSERT INTO locks VALUES(6)");
  assert.equal(observer.prepare("SELECT count(*) n FROM locks").get()!.n, 6);
});

test("database preserves bigint/blob/nonfinite output without JSON serialization failures", async (t) => {
  const f = fixture(t);
  const response = await f.execute("SELECT 9223372036854775807 AS large, x'00ff10' AS bytes, NULL AS empty, 1e999 AS infinity");
  assert.deepEqual(response.results[0]!.rows, [[integer("9223372036854775807"), { type: "blob", base64: "AP8Q" }, null, { type: "number", value: "Infinity" }]]);
  assert.doesNotThrow(() => JSON.stringify(response));
});

test("database bounds rows honestly, resets cursors and does not truncate DML RETURNING mutations", async (t) => {
  const f = fixture(t);
  const result = await f.execute("WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<100) SELECT n FROM seq", { maxRows: 3 });
  assert.equal(result.results[0]!.rows.length, 3);
  assert.equal(result.results[0]!.rowsTruncated, "max_rows");
  assert.equal(result.truncated, true);
  const exact = await f.execute("SELECT 1 UNION ALL SELECT 2", { maxRows: 2 });
  assert.equal(exact.truncated, false);
  await f.execute("CREATE TABLE returning_test (n)");
  const inserted = await f.execute("INSERT INTO returning_test VALUES (1),(2),(3),(4) RETURNING n", { maxRows: 1 });
  assert.equal(inserted.results[0]!.changes, "4");
  assert.equal(inserted.results[0]!.rowsTruncated, "max_rows");
  assert.deepEqual((await f.execute("SELECT count(*) FROM returning_test")).results[0]!.rows, [[integer(4)]]);
  await f.execute("VACUUM");
  assert.equal(f.connections.main.database.isTransaction, false);
});

test("database byte budget includes metadata and later batch writes still run", async (t) => {
  const f = fixture(t);
  const result = await f.service.execute({ action: "execute", maxBytes: 8192, statements: [
    { sql: "SELECT hex(zeroblob(6000)) AS oversized" },
    { sql: "CREATE TABLE after_truncation (n)" },
    { sql: "INSERT INTO after_truncation VALUES (1)" },
    { sql: "SELECT * FROM after_truncation" },
  ] }) as DatabaseExecutionResult;
  assert.equal(result.results[0]!.rowsTruncated, "max_bytes");
  assert.deepEqual(result.results[0]!.rows, []);
  assert.equal(result.results[2]!.changes, "1");
  assert.deepEqual(result.results[3]!.rows, [[integer(1)]]);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  const hugeColumn = await f.execute(`SELECT 1 AS "${"a".repeat(12_000)}"`, { maxBytes: 8192 });
  assert.equal(hugeColumn.results[0]!.columnsTruncated, true);
  assert.equal(hugeColumn.results[0]!.rowsTruncated, "max_bytes");
  assert.ok(Buffer.byteLength(JSON.stringify(hugeColumn)) <= 8192);
  const many = await f.service.execute({ action: "execute", maxBytes: 8192, statements: Array.from({ length: 16 }, () => ({
    sql: "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<100) SELECT '你好世界' AS label, n FROM seq",
  })) }) as DatabaseExecutionResult;
  assert.equal(many.results.length, 16);
  assert.equal(many.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(many), "utf8") <= 8192);
});

test("database rejects invalid request paths, inconsistent shapes and unsafe parameters", async (t) => {
  const f = fixture(t);
  const requests = [
    { action: "execute", sql: "SELECT 1", database: "../anything" },
    { action: "execute", sql: "SELECT 1", statements: [{ sql: "SELECT 2" }] },
    { action: "execute", statements: [] }, { action: "execute" },
    { action: "schema", sql: "DROP TABLE x" },
    { action: "execute", sql: "SELECT 1", maxRows: 0 },
    { action: "execute", sql: "SELECT 1", maxBytes: 20 },
    { action: "execute", sql: "SELECT 1\0; DROP TABLE x" },
    { action: "execute", sql: "SELECT ?", params: [Infinity] },
    { action: "execute", sql: "SELECT ?", params: [Number.MAX_SAFE_INTEGER + 1] },
    { action: "execute", sql: "SELECT ?", params: [true] },
  ];
  for (const request of requests) await assert.rejects(f.service.execute(request as DatabaseRequest), errorCode("invalid_request", "not_started"));
  assert.deepEqual(f.requested, []);
});

test("database cancellation before admission or while queued never writes", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort("secret cancellation reason");
  await assert.rejects(f.service.execute({ action: "execute", sql: "CREATE TABLE never_created (n)" }, controller.signal), errorCode("cancelled", "not_started"));
  assert.deepEqual(f.requested, []);
  let release!: () => void;
  const holding = f.connections.main.serialize(() => new Promise<void>((resolve) => { release = resolve; }));
  // Let the holding callback enter the actual shared queue.
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const queuedController = new AbortController();
  const queued = f.service.execute({ action: "execute", sql: "CREATE TABLE queued_never_created (n)" }, queuedController.signal);
  const rejected = assert.rejects(queued, errorCode("cancelled", "not_started"));
  // getDatabase has resolved and serialize has enqueued this call behind the held callback.
  await new Promise<void>((resolve) => setImmediate(resolve));
  queuedController.abort();
  release();
  await holding;
  await rejected;
  assert.deepEqual((await f.service.execute({ action: "schema" }) as DatabaseExecutionResult).results[0]!.rows, []);
  await f.execute("CREATE TABLE subsequent (n)");
});

test("database reports committed writes truthfully if cancellation arrives after serialized work", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const connection = f.connections.main;
  const store = createDatabaseToolStore(async () => ({
    ...connection,
    async serialize(work) {
      return connection.serialize(async () => {
        const value = await work();
        controller.abort();
        return value;
      });
    },
  }));
  const service = createDatabaseService(store);
  const result = await service.execute({ action: "execute", sql: "CREATE TABLE committed (n)" }, controller.signal) as DatabaseExecutionResult;
  assert.equal(result.results.length, 1);
  assert.equal(controller.signal.aborted, true);
  assert.equal(connection.database.prepare("SELECT name FROM sqlite_schema WHERE name='committed'").get()!.name, "committed");
});

test("database serializes with repository work and releases its temporary guard", async (t) => {
  const f = fixture(t);
  const order: string[] = [];
  const connection = f.connections.main;
  const repositoryWrite = connection.serialize(() => {
    order.push("repository");
    connection.database.exec("CREATE TABLE shared (n); INSERT INTO shared VALUES(42)");
  });
  const query = f.execute("SELECT * FROM shared").then((result) => { order.push("tool"); return result; });
  await repositoryWrite;
  assert.deepEqual((await query).results[0]!.rows, [[integer(42)]]);
  assert.deepEqual(order, ["repository", "tool"]);
  // A repository transaction still works; the tool did not leave its deny-BEGIN guard installed.
  await connection.serialize(() => connection.transaction(() => connection.database.exec("INSERT INTO shared VALUES(43)")));
  assert.equal(connection.database.isTransaction, false);
});

test("database uncertain queue/commit acknowledgement errors are sanitized and never replayed", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  const store = createDatabaseToolStore(async () => ({
    ...f.connections.main,
    async serialize(work) {
      attempts++;
      return f.connections.main.serialize(async () => {
        await work();
        throw new Error("synthetic-secret-commit-acknowledgement");
      });
    },
  }));
  const service = createDatabaseService(store);
  await assert.rejects(service.execute({ action: "execute", sql: "CREATE TABLE persisted_despite_error (n)" }), (error: unknown) => {
    errorCode("unavailable", "unknown")(error);
    assert.ok(!String(error).includes("synthetic-secret"));
    return true;
  });
  assert.equal(attempts, 1);
  assert.equal(f.connections.main.database.prepare("SELECT name FROM sqlite_schema WHERE name='persisted_despite_error'").get()!.name, "persisted_despite_error");
  assert.equal(f.connections.main.database.isTransaction, false);
});

test("database pi tool uses SDK definition and sanitizes SQL/provider failures without retry", async (t) => {
  const f = fixture(t);
  const tool = databaseTool(f.service);
  assert.equal(tool.name, "database");
  const result = await tool.execute("select", { action: "execute", sql: "SELECT 1" }, undefined, undefined, {} as never);
  assert.equal(result.isError, undefined);
  const text = result.content[0]!;
  assert.equal(text.type, "text");
  if (text.type === "text") assert.deepEqual(JSON.parse(text.text).results[0].rows, [[integer(1)]]);
  const secret = "synthetic-api-key-do-not-leak";
  for (const sql of [`SELECT * FROM "${secret}"`, `SELECT '${secret}' AS x; SELECT 2`, `SELECT "${secret}"('x')`]) {
    const error = await tool.execute("error", { action: "execute", sql }, undefined, undefined, {} as never);
    assert.equal(error.isError, true);
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.ok(!JSON.stringify(error).includes("SELECT"));
  }
  let attempts = 0;
  const broken = databaseTool({ execute: async () => { attempts++; throw new Error(secret); } });
  const error = await broken.execute("unknown", { action: "list" }, undefined, undefined, {} as never);
  assert.equal(attempts, 1);
  assert.equal(error.isError, true);
  assert.ok(!JSON.stringify(error).includes(secret));
  assert.ok(JSON.stringify(error).includes("unknown"));
});
