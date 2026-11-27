import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAndroidUpdateRoutes } from "../../src/http/routes/android-updates.js";
import { androidReleaseManifest } from "../../src/shared/android-release.js";
import { createAndroidReleaseMirror, githubAndroidReleaseUrl } from "../../src/adapters/releases/android-release-mirror.js";

test("mirror publishes versioned APKs only after verifying bytes and keeps the previous release on failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-apk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = "signed apk fixture";
  const digest = "sha256:" + createHash("sha256").update(content).digest("hex");
  let tag = "v1.0.1";
  let body = content;
  let downloads = 0;
  const transport: typeof fetch = async (input) => {
    if (input === githubAndroidReleaseUrl) return Response.json({
      id: 9, tag_name: tag, draft: false, prerelease: false,
      assets: [{ id: 1, name: "app-release.apk", size: Buffer.byteLength(content), digest,
        browser_download_url: `https://github.com/yaotutu/pi-muse-flutter/releases/download/${tag}/app-release.apk` }],
    });
    downloads++;
    return new Response(body);
  };
  const mirror = createAndroidReleaseMirror(root, { transport, cooldownMs: 0 });
  assert.equal(await mirror.latest(), null);
  const app = createAndroidUpdateRoutes(mirror);
  assert.equal((await app.request("/latest")).status, 503);
  const one = mirror.refresh();
  assert.equal(mirror.refresh(), one);
  assert.equal(await one, true);
  const latest = await mirror.latest();
  assert.deepEqual(androidReleaseManifest.parse(await (await app.request("/latest")).json()), latest);
  assert.equal(latest?.tag_name, "v1.0.1");
  assert.equal(latest?.assets[0]?.browser_download_url, "/updates/android/apk/v1.0.1/app-release.apk");
  const asset = await mirror.asset("v1.0.1", "app-release.apk");
  assert.equal(await readFile(asset!.path, "utf8"), content);
  assert.equal(await mirror.asset("v1.0.1", "../config.json"), undefined);
  assert.equal(downloads, 1);
  const response = await app.request("/apk/v1.0.1/app-release.apk");
  assert.equal(response.headers.get("etag"), `"${digest}"`);
  assert.equal(response.headers.get("content-type"), "application/vnd.android.package-archive");
  assert.equal(await response.text(), content);
  assert.equal((await app.request("/apk/v1.0.9/app-release.apk")).status, 404);

  tag = "v1.0.2";
  body = "incorrect content";
  assert.equal(await mirror.refresh(), false);
  assert.deepEqual(await mirror.latest(), latest);
  assert.equal(await mirror.asset("v1.0.2", "app-release.apk"), undefined);
  assert.deepEqual(await createAndroidReleaseMirror(root).latest(), latest);
  await mirror.close();
});

test("public notifications never choose an upstream URL or follow an out-of-policy APK redirect", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-apk-redirect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests: string[] = [];
  const source = "https://github.com/yaotutu/pi-muse-flutter/releases/download/v1.0.1/app-release.apk";
  const transport: typeof fetch = async (input) => {
    requests.push(String(input));
    if (input === githubAndroidReleaseUrl) return Response.json({
      id: 9, tag_name: "v1.0.1", draft: false, prerelease: false,
      assets: [{ id: 1, name: "app-release.apk", size: 1, digest: "sha256:" + "f".repeat(64), browser_download_url: source }],
    });
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
  };
  const mirror = createAndroidReleaseMirror(root, { transport });
  t.after(() => mirror.close());
  const app = createAndroidUpdateRoutes(mirror);
  const response = await app.request("/refresh", { method: "POST", body: JSON.stringify({ url: "https://example.test" }) });
  assert.equal(response.status, 202);
  assert.equal(await mirror.refresh(), false);
  assert.deepEqual(requests, [githubAndroidReleaseUrl, source]);
  assert.equal(await mirror.latest(), null);
});

test("legacy mirror cache from deprecated mobile repo is never served and gets purged when Flutter release syncs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-apk-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacyDir = join(root, "v1.0.75");
  await mkdir(legacyDir, { recursive: true });
  await writeFile(join(root, "latest"), "v1.0.75");
  await writeFile(join(legacyDir, "app-release.apk"), "legacy-apk");
  await writeFile(join(legacyDir, "release.json"), JSON.stringify({
    id: 1, draft: false, prerelease: false, tag_name: "v1.0.75",
    assets: [{
      id: 1, name: "app-release.apk", size: 10,
      digest: "sha256:" + createHash("sha256").update("legacy-apk").digest("hex"),
      browser_download_url: "/updates/android/apk/v1.0.75/app-release.apk",
    }],
  }));

  const flutterApk = "flutter-apk-bytes";
  const flutterDigest = "sha256:" + createHash("sha256").update(flutterApk).digest("hex");
  const transport: typeof fetch = async (input) => {
    if (input === githubAndroidReleaseUrl) {
      return Response.json({
        id: 20, tag_name: "v0.1.12", draft: false, prerelease: false,
        assets: [{
          id: 2, name: "app-release.apk", size: Buffer.byteLength(flutterApk), digest: flutterDigest,
          browser_download_url: "https://github.com/yaotutu/pi-muse-flutter/releases/download/v0.1.12/app-release.apk",
        }],
      });
    }
    return new Response(flutterApk);
  };
  const mirror = createAndroidReleaseMirror(root, { transport, cooldownMs: 0 });
  t.after(() => mirror.close());

  assert.equal(await mirror.latest(), null);
  assert.equal(await mirror.asset("v1.0.75", "app-release.apk"), undefined);
  assert.equal(await mirror.refresh(), true);
  assert.equal((await mirror.latest())?.tag_name, "v0.1.12");
  await assert.rejects(stat(legacyDir));
});
