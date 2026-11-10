import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompanionService } from "../../src/features/companions/service.js";
import { COMPANION_STATES, CompanionError, MAX_COMPANION_PNG_BYTES } from "../../src/features/companions/types.js";
import { createCompanionStore } from "../../src/adapters/storage/companions-store.js";
import { companionPackDir, createDataLayout, ensureLayout, isCompanionPackId } from "../../src/adapters/storage/data-layout.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const fixture = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-companion-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = createDataLayout(root);
  return { root, layout, service: createCompanionService(createCompanionStore(layout)) };
};
const code = (expected: string, status?: number) => (error: unknown) => error instanceof CompanionError && error.code === expected && (status === undefined || error.status === status);

test("companions: ID and state boundaries are fixed and reject traversal", async (t) => {
  const { layout, service } = await fixture(t);
  assert.deepEqual(COMPANION_STATES, ["idle", "thinking", "responding", "working", "waiting-approval", "success", "error", "stopped"]);
  for (const id of ["", "../x", "x/y", "x\\y", ".", "A", "-a", "a".repeat(65), "你好"]) {
    assert.equal(isCompanionPackId(id), false);
    assert.throws(() => companionPackDir(layout, id));
    await assert.rejects(service.get(id), code("INVALID_COMPANION_ID", 400));
  }
  assert.ok(isCompanionPackId("a_0-test"));
  assert.ok(isCompanionPackId("a".repeat(64)));
  await assert.rejects(service.asset("valid", "../idle"), code("INVALID_COMPANION_STATE", 400));
  await assert.rejects(service.saveAsset("valid", "IDLE", png.toString("base64")), code("INVALID_COMPANION_STATE", 400));
});

test("companions: listing is read-only, layout initialization rejects linked container", async (t) => {
  const { root, layout, service } = await fixture(t);
  assert.equal(layout.companionsDir, join(root, "companions"));
  assert.deepEqual(await service.list(), { companions: [], diagnostics: [] });
  await assert.rejects(lstat(layout.companionsDir), { code: "ENOENT" });
  const outside = join(root, "outside");
  await mkdir(outside);
  await symlink(outside, layout.companionsDir);
  await assert.rejects(ensureLayout(layout), /Unsafe data directory/);
  assert.equal((await service.list()).diagnostics.length, 1);
  await assert.rejects(service.saveMetadata("test", { name: "Test" }), code("UNSAFE_COMPANION_PATH", 409));
});

test("companions: staged writes and reads share one queue and update content version", async (t) => {
  const { service } = await fixture(t);
  const metadata = await service.saveMetadata("test", { name: "  Test  " });
  assert.deepEqual(metadata, { id: "test", name: "Test", description: "", complete: false, missingStates: [...COMPANION_STATES] });
  const writes = COMPANION_STATES.map((state) => service.saveAsset("test", state, png.toString("base64")));
  const read = service.get("test");
  await Promise.all(writes);
  const first = (await read).companion;
  assert.deepEqual(first.states, COMPANION_STATES);
  assert.match(first.version, /^[a-f0-9]{64}$/);
  const bytes = Buffer.concat([png, Buffer.from([1])]);
  await service.saveAsset("test", "idle", bytes.toString("base64"));
  const second = (await service.get("test")).companion;
  assert.notEqual(first.version, second.version);
  assert.deepEqual(Buffer.from((await service.asset("test", "idle")).bytes), bytes);
  await service.saveMetadata("test", { name: "Renamed", description: "Description" });
  assert.notEqual((await service.get("test")).companion.version, second.version);
  assert.equal((await service.saveMetadata("test", { name: "Latest" })).complete, true);
  assert.deepEqual((await service.list()).companions.map((item) => item.id), ["test"]);
  await service.remove("test");
  await assert.rejects(service.get("test"), code("COMPANION_NOT_FOUND", 404));
  await assert.rejects(service.remove("test"), code("COMPANION_NOT_FOUND", 404));
});

test("companions: version binds each individual asset, not only concatenated bytes", async (t) => {
  const { service } = await fixture(t);
  for (const state of COMPANION_STATES) await service.saveAsset("test", state, png.toString("base64"));
  await service.saveAsset("test", "idle", Buffer.concat([png, png]).toString("base64"));
  const first = (await service.get("test")).companion.version;
  // 两份文件拼接的总字节不变，但每份内容改变，包版本仍必须改变。
  await service.saveAsset("test", "idle", png.toString("base64"));
  await service.saveAsset("test", "thinking", Buffer.concat([png, png]).toString("base64"));
  assert.notEqual((await service.get("test")).companion.version, first);
});

test("companions: strict metadata, base64, PNG signature and byte limits", async (t) => {
  const { service } = await fixture(t);
  for (const metadata of [null, {}, { name: " " }, { name: "a".repeat(81) }, { name: "a", description: "a".repeat(201) }, { name: "a", extra: true }])
    await assert.rejects(service.saveMetadata("test", metadata), code("INVALID_COMPANION_METADATA", 400));
  for (const base64 of [null, "", "data:image/png;base64,AAAA", "!!!!", "AAAA\n", "AAAA=", "Zh==", Buffer.from("not a PNG").toString("base64"), "iVBORw=="])
    await assert.rejects(service.saveAsset("test", "idle", base64), code("INVALID_PNG", 400));
  const maxPng = Buffer.alloc(MAX_COMPANION_PNG_BYTES);
  png.copy(maxPng);
  assert.equal((await service.saveAsset("test", "idle", maxPng.toString("base64"))).size, MAX_COMPANION_PNG_BYTES);
  await assert.rejects(service.saveAsset("test", "idle", Buffer.concat([maxPng, Buffer.from([0])]).toString("base64")), code("REQUEST_TOO_LARGE", 413));
  assert.equal((await service.asset("test", "idle").catch((error) => error)).status, 404);
});

test("companions: optional manifest defaults and incomplete packs are diagnostic only", async (t) => {
  const { service, layout } = await fixture(t);
  for (const state of COMPANION_STATES.slice(0, -1)) await service.saveAsset("defaults", state, png.toString("base64"));
  const incomplete = await service.list();
  assert.deepEqual(incomplete.companions, []);
  assert.match(incomplete.diagnostics[0]!.message, /stopped/);
  await assert.rejects(service.get("defaults"), code("COMPANION_NOT_FOUND", 404));
  await service.saveAsset("defaults", "stopped", png.toString("base64"));
  const pack = (await service.get("defaults")).companion;
  assert.equal(pack.name, "defaults");
  assert.equal(pack.description, "");
  await assert.rejects(lstat(join(companionPackDir(layout, "defaults"), "manifest.json")), { code: "ENOENT" });
});

test("companions: malformed manifest or PNG is retained and never overwritten", async (t) => {
  const { service, layout } = await fixture(t);
  await mkdir(layout.companionsDir);
  const invalid = ["{", JSON.stringify({ schemaVersion: 2, name: "x" }), JSON.stringify({ schemaVersion: 1, name: " " }), JSON.stringify({ schemaVersion: 1, name: "x", extra: true }), JSON.stringify({ schemaVersion: 1, name: "x", description: 1 })];
  for (const [index, content] of invalid.entries()) {
    const id = `bad-${index}`;
    const dir = companionPackDir(layout, id);
    await mkdir(dir);
    await writeFile(join(dir, "manifest.json"), content);
    assert.equal((await service.list()).diagnostics.some((item) => item.id === id), true);
    await assert.rejects(service.saveMetadata(id, { name: "Overwrite" }), code("INVALID_COMPANION_PACK", 409));
    await assert.rejects(service.saveAsset(id, "idle", png.toString("base64")), code("INVALID_COMPANION_PACK", 409));
    assert.equal(await readFile(join(dir, "manifest.json"), "utf8"), content);
  }
  const dir = companionPackDir(layout, "bad-png");
  await mkdir(dir);
  await writeFile(join(dir, "idle.png"), "broken");
  assert.equal((await service.list()).diagnostics.some((item) => item.id === "bad-png"), true);
  await assert.rejects(service.saveAsset("bad-png", "idle", png.toString("base64")), code("INVALID_COMPANION_PACK", 409));
  assert.equal(await readFile(join(dir, "idle.png"), "utf8"), "broken");
});

test("companions: invalid UTF-8, oversized PNG and non-regular files stay diagnostic and intact", async (t) => {
  const { service, layout } = await fixture(t);
  await mkdir(layout.companionsDir);
  for (const [id, filename] of [["directory-manifest", "manifest.json"], ["directory-asset", "idle.png"]]) {
    const dir = companionPackDir(layout, id!);
    await mkdir(dir);
    await mkdir(join(dir, filename!));
    await assert.rejects(service.saveMetadata(id!, { name: "Replace" }), code("UNSAFE_COMPANION_PATH", 409));
    assert.equal((await lstat(join(dir, filename!))).isDirectory(), true);
  }
  const invalid = companionPackDir(layout, "invalid-encoding");
  await mkdir(invalid);
  const content = Buffer.concat([Buffer.from('{"schemaVersion":1,"name":"'), Buffer.from([255]), Buffer.from('"}')]);
  await writeFile(join(invalid, "manifest.json"), content);
  await assert.rejects(service.saveMetadata("invalid-encoding", { name: "Replace" }), code("INVALID_COMPANION_PACK", 409));
  assert.deepEqual(await readFile(join(invalid, "manifest.json")), content);
  const oversized = companionPackDir(layout, "oversized");
  await mkdir(oversized);
  await writeFile(join(oversized, "idle.png"), Buffer.alloc(MAX_COMPANION_PNG_BYTES + 1));
  await assert.rejects(service.get("oversized"), code("COMPANION_NOT_FOUND", 404));
  assert.equal((await lstat(join(oversized, "idle.png"))).size, MAX_COMPANION_PNG_BYTES + 1);
  const list = await service.list();
  assert.deepEqual(list.companions, []);
  assert.equal(list.diagnostics.length, 4);
});

test("companions: rejects linked pack, manifest, PNG, and nested links on deletion", async (t) => {
  const { root, service, layout } = await fixture(t);
  await mkdir(layout.companionsDir);
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep"), "untouched");
  await symlink(outside, companionPackDir(layout, "linked-pack"));
  for (const [id, filename] of [["linked-manifest", "manifest.json"], ["linked-png", "idle.png"], ["nested-link", "other"]]) {
    const dir = companionPackDir(layout, id!);
    await mkdir(dir);
    await symlink(join(outside, "keep"), join(dir, filename!));
    await assert.rejects(service.remove(id!), code("UNSAFE_COMPANION_PATH", 409));
    if (filename !== "other") await assert.rejects(service.saveMetadata(id!, { name: "Unsafe" }), code("UNSAFE_COMPANION_PATH", 409));
  }
  await assert.rejects(service.get("linked-pack"), code("UNSAFE_COMPANION_PATH", 409));
  await assert.rejects(service.remove("linked-pack"), code("UNSAFE_COMPANION_PATH", 409));
  assert.equal((await service.list()).diagnostics.length, 4);
  assert.equal(await readFile(join(outside, "keep"), "utf8"), "untouched");
});
