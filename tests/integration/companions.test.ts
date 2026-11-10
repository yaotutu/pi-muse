import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { COMPANION_STATES, MAX_COMPANION_PNG_BYTES } from "../../src/features/companions/types.js";
import { companionPackDir } from "../../src/adapters/storage/data-layout.js";
import { companionResponse, companionsResponse, saveCompanionResponse, saveCompanionAssetResponse } from "../../src/http/contracts/companions.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC1lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const start = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-companion-http-"));
  const service = await createService(createConfig({ schemaVersion: 1, server: {}, model: { baseUrl: "http://127.0.0.1:1", id: "test-model", apiKey: "k" }, runtime: { dataDir: root, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 } }));
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${service.auth.login()}`, "Content-Type": "application/json" };
  const request = (path: string, method = "GET", body?: unknown) => service.app.request(`/api/companions${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { root, service, request };
};

test("companions HTTP: all six operations require Bearer auth, invalid paths and states are 400", async (t) => {
  const { service, request } = await start(t);
  for (const [method, path] of [["GET", ""], ["GET", "/test"], ["GET", "/test/assets/idle"], ["PUT", "/test"], ["PUT", "/test/assets/idle"], ["DELETE", "/test"]])
    assert.equal((await service.app.request(`/api/companions${path}`, { method })).status, 401, `${method} ${path}`);
  for (const id of ["UPPER", "..%2Fescape", "foo%5Cbar", "a".repeat(65)]) {
    const response = await request(`/${id}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_COMPANION_ID");
  }
  for (const method of ["GET", "PUT"]) {
    const response = await request("/test/assets/not-a-state", method, method === "PUT" ? { dataBase64: png.toString("base64") } : undefined);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_COMPANION_STATE");
  }
});

test("companions HTTP: staged uploads become complete, serve exact PNG and invalidate etag/version", async (t) => {
  const { request } = await start(t);
  const metadata = await request("/custom", "PUT", { name: "  Custom  ", description: "A custom pack" });
  assert.equal(metadata.status, 200);
  const staged = saveCompanionResponse.parse(await metadata.json());
  assert.equal(staged.name, "Custom");
  assert.equal(staged.complete, false);
  assert.deepEqual(staged.missingStates, COMPANION_STATES);
  assert.equal((await request("/custom")).status, 404);
  assert.equal((await request("/custom/assets/idle")).status, 404);
  let etag = "";
  for (const state of COMPANION_STATES) {
    const response = await request(`/custom/assets/${state}`, "PUT", { dataBase64: png.toString("base64") });
    assert.equal(response.status, 200);
    const result = saveCompanionAssetResponse.parse(await response.json());
    assert.equal(result.state, state);
    etag = result.etag;
  }
  const completion = saveCompanionResponse.parse(await (await request("/custom", "PUT", { name: "Custom", description: "A custom pack" })).json());
  assert.equal(completion.complete, true);
  assert.deepEqual(completion.missingStates, []);
  const first = companionResponse.parse(await (await request("/custom")).json()).companion;
  const list = companionsResponse.parse(await (await request("")).json());
  assert.deepEqual(list.companions, [first]);
  assert.deepEqual(list.diagnostics, []);
  const asset = await request("/custom/assets/idle");
  assert.equal(asset.headers.get("content-type"), "image/png");
  assert.equal(asset.headers.get("etag"), `"${etag}"`);
  assert.equal(asset.headers.get("cache-control"), "private, max-age=300");
  assert.deepEqual(Buffer.from(await asset.arrayBuffer()), png);
  const replacement = Buffer.concat([png, Buffer.from([1])]);
  const updated = saveCompanionAssetResponse.parse(await (await request("/custom/assets/idle", "PUT", { dataBase64: replacement.toString("base64") })).json());
  assert.notEqual(updated.etag, etag);
  assert.notEqual(companionResponse.parse(await (await request("/custom")).json()).companion.version, first.version);
  assert.equal((await request("/custom/assets/idle")).headers.get("etag"), `"${updated.etag}"`);
  assert.deepEqual(await (await request("/custom", "DELETE")).json(), { ok: true, id: "custom" });
  for (const path of ["/custom", "/custom/assets/idle"]) assert.equal((await request(path)).status, 404);
  assert.equal((await request("/custom", "DELETE")).status, 404);
  assert.deepEqual(companionsResponse.parse(await (await request("")).json()).companions, []);
});

test("companions HTTP: invalid PNG, strict base64, 768 KiB boundary and dedicated 2 MiB limit", async (t) => {
  const { request } = await start(t);
  for (const dataBase64 of ["data:image/png;base64,AAAA", "@@@@", "", "AAAA\n", Buffer.from("not-png").toString("base64")]) {
    const response = await request("/custom/assets/idle", "PUT", { dataBase64 });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_PNG");
  }
  const max = Buffer.alloc(MAX_COMPANION_PNG_BYTES);
  png.copy(max);
  // 768 KiB 的 base64 加上 JSON 已大于默认 1 MiB，必须能够成功。
  const allowed = await request("/custom/assets/idle", "PUT", { dataBase64: max.toString("base64") });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).size, MAX_COMPANION_PNG_BYTES);
  for (const bytes of [Buffer.concat([max, Buffer.from([0])]), Buffer.alloc(1_600_000)]) {
    const response = await request("/custom/assets/idle", "PUT", { dataBase64: bytes.toString("base64") });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, "REQUEST_TOO_LARGE");
  }
  assert.equal((await request("/custom", "PUT", { name: "a".repeat(1_048_577) })).status, 413);
});

test("companions HTTP: corrupt manifest and incomplete files are diagnosed without modifying originals", async (t) => {
  const { request, service } = await start(t);
  const dir = companionPackDir(service.layout, "damaged");
  await mkdir(dir);
  const manifest = "{broken-json";
  await writeFile(join(dir, "manifest.json"), manifest);
  await request("/incomplete/assets/idle", "PUT", { dataBase64: png.toString("base64") });
  const list = companionsResponse.parse(await (await request("")).json());
  assert.deepEqual(list.companions, []);
  assert.deepEqual(list.diagnostics.map((item) => item.id), ["damaged", "incomplete"]);
  assert.equal((await request("/damaged", "PUT", { name: "Overwrite" })).status, 409);
  assert.equal((await request("/damaged/assets/idle", "PUT", { dataBase64: png.toString("base64") })).status, 409);
  assert.equal(await readFile(join(dir, "manifest.json"), "utf8"), manifest);
  assert.equal((await request("/damaged")).status, 404);
  assert.equal((await request("/damaged/assets/idle")).status, 404);
  assert.equal((await request("/incomplete")).status, 404);
  assert.equal((await request("/damaged", "DELETE")).status, 200);
  assert.equal((await request("/incomplete", "DELETE")).status, 200);
});

test("companions HTTP: symlink pack, manifest, asset and container cannot escape storage", async (t) => {
  const { root, request, service } = await start(t);
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep"), "untouched");
  await symlink(outside, companionPackDir(service.layout, "linked"));
  for (const [id, file] of [["manifest-link", "manifest.json"], ["asset-link", "idle.png"]]) {
    const dir = companionPackDir(service.layout, id!);
    await mkdir(dir);
    await symlink(join(outside, "keep"), join(dir, file!));
  }
  for (const id of ["linked", "manifest-link", "asset-link"]) {
    assert.equal((await request(`/${id}`)).status, 409);
    assert.equal((await request(`/${id}/assets/idle`, "PUT", { dataBase64: png.toString("base64") })).status, 409);
    assert.equal((await request(`/${id}`, "DELETE")).status, 409);
  }
  assert.equal(companionsResponse.parse(await (await request("")).json()).diagnostics.length, 3);
  await rm(service.layout.companionsDir, { recursive: true });
  await symlink(outside, service.layout.companionsDir);
  assert.equal((await request("/new", "PUT", { name: "New" })).status, 409);
  assert.equal(companionsResponse.parse(await (await request("")).json()).diagnostics.length, 1);
  assert.equal(await readFile(join(outside, "keep"), "utf8"), "untouched");
});
