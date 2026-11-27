import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createService } from "../support/test-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { databaseTool } from "../../src/adapters/pi/tools/database.js";

const start = async (t: TestContext) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-database-integration-"));
  const service = await createService(createConfig({
    server: { host: "127.0.0.1", accessKey: "database-integration-access" },
    runtime: { dataDir, schedulerIntervalMs: 3_600_000, monitorScanIntervalMs: 3_600_000 },
    tools: { browser: { enabled: false }, web: { enabled: false } },
  }));
  t.after(async () => { try { await service.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const response = await service.app.request("/api/session", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessKey: "database-integration-access" }),
  });
  assert.equal(response.status, 200);
  const { token } = await response.json() as { token: string };
  return { service, headers: { authorization: `Bearer ${token}` } };
};

test("database accesses main database and service close rejects late SQL", async (t) => {
  const { service } = await start(t);
  assert.ok((await stat(service.layout.mainDatabaseFile)).isFile());
  const tool = databaseTool(service.database);
  const written = await tool.execute("main-schema", {
    action: "execute", statements: [{ sql: "CREATE TABLE main_probe (id TEXT PRIMARY KEY)" }, { sql: "INSERT INTO main_probe VALUES (?)", params: ["one"] }],
  }, undefined, undefined, {} as never);
  assert.notEqual(written.isError, true);
  assert.ok((await stat(service.layout.mainDatabaseFile)).isFile());
  const [first, second] = await Promise.all([
    service.database.execute({ action: "execute", sql: "SELECT id FROM main_probe" }),
    service.database.execute({ action: "schema" }),
  ]);
  assert.ok("results" in first && "results" in second);
  assert.equal(first.results[0]?.rows[0]?.[0], "one");
  await service.close();
  const late = await tool.execute("late", { action: "execute", sql: "INSERT INTO main_probe VALUES ('late')" }, undefined, undefined, {} as never);
  assert.equal(late.isError, true);
  await assert.rejects(stat(service.layout.mainDatabaseFile + "-wal"), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});
