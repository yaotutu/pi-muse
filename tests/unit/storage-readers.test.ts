import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { jobsModule } from "../../src/adapters/storage/jobs-schema.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import { openSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { createMemoryRepository } from "../../src/adapters/storage/memory-repository.js";
import { createIdentityRepository } from "../../src/adapters/storage/identity-repository.js";
import { createJobRepository } from "../../src/adapters/storage/job-repository.js";
import { InvalidDocumentError } from "../../src/adapters/storage/document-schemas.js";
import { defaultIdentity } from "../../src/features/identity/types.js";

const memorySetup = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "personal-bot-storage-readers-memory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, "document.md"), identityFile: join(directory, "identity.json") };
};

// 定时任务事实已迁入 main.sqlite：同样的错误策略在关系表上继续成立。
const openJobs = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "personal-bot-storage-readers-jobs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const managed = await openSqliteDatabase(join(directory, "main.sqlite"));
  t.after(() => managed.close());
  await managed.serialize(() => ensureSqliteModules(managed, [jobsModule]));
  return { managed, repository: createJobRepository(managed) };
};

const jobRows = (managed: Awaited<ReturnType<typeof openJobs>>["managed"]): number =>
  Number((managed.database.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n);

test("jobs reads an empty table without creating any row", async (t) => {
  const { managed, repository } = await openJobs(t);
  assert.deepEqual(await repository.read(), []);
  assert.equal(jobRows(managed), 0);
});

test("jobs rejects corrupted rows without deleting or filtering them", async (t) => {
  const { managed, repository } = await openJobs(t);
  managed.database.exec("PRAGMA ignore_check_constraints = ON");
  managed.database.prepare(
    "INSERT INTO jobs (id, position, prompt, daily, at, enabled, created_at, next_run_at) VALUES ('broken', 0, 'p', 1, '99:99', 1, ?, ?)",
  ).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  managed.database.exec("PRAGMA ignore_check_constraints = OFF");

  await assert.rejects(repository.read(), InvalidDocumentError);
  let called = false;
  await assert.rejects(repository.update(() => {
    called = true;
    return { result: undefined };
  }), (error: unknown) => {
    assert.ok(error instanceof InvalidDocumentError);
    assert.equal(error.message.includes("broken"), false);
    return true;
  });
  assert.equal(called, false);
  // 坏记录保留在库里，等待人工修复，不被静默清空。
  assert.equal(jobRows(managed), 1);
});

test("jobs writer recovers after the damaged row is explicitly repaired", async (t) => {
  const { managed, repository } = await openJobs(t);
  managed.database.exec("PRAGMA ignore_check_constraints = ON");
  managed.database.prepare(
    "INSERT INTO jobs (id, position, prompt, daily, at, enabled, created_at, next_run_at) VALUES ('broken', 0, 'p', 1, '99:99', 1, ?, ?)",
  ).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  managed.database.exec("PRAGMA ignore_check_constraints = OFF");
  await assert.rejects(repository.update(() => ({ result: undefined })), InvalidDocumentError);
  // 修复是调用者明确的外部动作：把坏时刻改回合法值后写入恢复。
  managed.database.prepare("UPDATE jobs SET at = ? WHERE id = ?").run("10:30", "broken");
  await repository.update(() => ({ items: [], result: undefined }));
  assert.deepEqual(await repository.read(), []);
  assert.equal(jobRows(managed), 0);
});


test("memory markdown defaults only a missing file and does not create it on read", async (t) => {
  const { directory, file } = await memorySetup(t);
  const repository = createMemoryRepository(file);
  assert.deepEqual(await repository.read(), { memories: [] });
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.deepEqual(await readdir(directory), []);
});

test("memory markdown rejects corrupted documents without changing original bytes", async (t) => {
  const { directory, file } = await memorySetup(t);
  const malformed = [
    "- 不是列表项\n",
    "- [bad id] 文本\n",
    "- [ok] 文本 <!-- source=chat -->\n",
    "# 长期记忆\n\n- [ok] 文本 <!-- source=chat created=2026-10-10T00:00:00.000Z updated=2026-10-10T00:00:00.000Z -->\n坏行\n",
  ];
  const repository = createMemoryRepository(file);
  for (const source of malformed) {
    await writeFile(file, source);
    await assert.rejects(repository.read(), InvalidDocumentError);
    let called = false;
    await assert.rejects(repository.update(() => {
      called = true;
      return { result: undefined };
    }), (error: unknown) => {
      assert.ok(error instanceof InvalidDocumentError);
      assert.equal(error.message.includes(file), false);
      assert.equal(error.message.includes("secret"), false);
      return true;
    });
    assert.equal(called, false);
    assert.equal(await readFile(file, "utf8"), source);
    assert.deepEqual(await readdir(directory), ["document.md"]);
  }
});

test("memory markdown propagates filesystem read errors instead of defaulting to empty", async (t) => {
  const { directory } = await memorySetup(t);
  const repository = createMemoryRepository(directory);
  await assert.rejects(repository.read(), { code: "EISDIR" });
  await assert.rejects(repository.update(() => ({ result: undefined })), { code: "EISDIR" });
});

test("memory markdown writer recovers after the damaged file is explicitly repaired", async (t) => {
  const { file } = await memorySetup(t);
  const repository = createMemoryRepository(file);
  await writeFile(file, "- 坏行\n");
  await assert.rejects(repository.update(() => ({ result: undefined })), InvalidDocumentError);
  // 修复必须是调用者明确的外部动作，repository 不自动清空、不重试。
  await writeFile(file, "# 长期记忆\n");
  await repository.update(() => ({
    state: { memories: [{ id: "ok", text: "修复后", source: "test", createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z" }] },
    result: undefined,
  }));
  assert.match(await readFile(file, "utf8"), /- \[ok\] 修复后/);
});

test("identity json defaults only a missing file and never creates it on read", async (t) => {
  const { directory, identityFile } = await memorySetup(t);
  const repository = createIdentityRepository(identityFile);
  assert.deepEqual(await repository.read(), defaultIdentity);
  await assert.rejects(stat(identityFile), { code: "ENOENT" });
  assert.deepEqual(await readdir(directory), []);
});
