import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { androidApkNamePattern as apkName, androidReleaseTagPattern as tagPattern, androidReleaseManifest as manifestSchema, type AndroidRelease as Release } from "../../shared/android-release.js";

const repository = "yaotutu/pi-muse-mobile";
export const githubAndroidReleaseUrl = `https://api.github.com/repos/${repository}/releases/latest`;
const allowedHosts = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
type Asset = Release["assets"][number];

const isLater = (tag: string, current: string) => {
  const parts = (value: string) => value.slice(1).split(".").reduce((n, part) => n * 10_000_000n + BigInt(part), 0n);
  return parts(tag) > parts(current);
};
const pathFor = (tag: string, name: string) => `/updates/android/apk/${tag}/${name}`;
const safeAssets = (release: Release) =>
  new Set(release.assets.map((asset) => asset.name)).size === release.assets.length &&
  new Set(release.assets.map((asset) => asset.id)).size === release.assets.length &&
  release.assets.some((asset) => asset.name === "app-release.apk");

async function downloadAsset(transport: typeof fetch, asset: Asset, path: string, signal: AbortSignal) {
  let url = new URL(asset.browser_download_url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (url.protocol !== "https:" || url.port || url.username || url.password || !allowedHosts.has(url.hostname)) {
      throw new Error("Unexpected APK download host");
    }
    const response = await transport(url.href, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("APK download redirect has no location");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("APK download failed");
    }
    const hash = createHash("sha256");
    let size = 0;
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > asset.size) { callback(new Error("APK exceeds declared size")); return; }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream), verify, createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal });
    if (size !== asset.size || `sha256:${hash.digest("hex")}` !== asset.digest) throw new Error("APK checksum mismatch");
    return;
  }
  throw new Error("Too many APK redirects");
}

async function readGithubRelease(transport: typeof fetch, signal: AbortSignal): Promise<Release> {
  const response = await transport(githubAndroidReleaseUrl, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-muse-release-mirror" },
    redirect: "error",
    signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("GitHub release metadata unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024 * 1024) throw new Error("GitHub release metadata too large");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!raw || typeof raw !== "object" || !("draft" in raw) || raw.draft !== false ||
      !("prerelease" in raw) || raw.prerelease !== false || !("assets" in raw) || !Array.isArray(raw.assets))
    throw new Error("Expected a stable GitHub release");
  const release = manifestSchema.parse({ ...raw, assets: raw.assets.filter((item) =>
    item && typeof item.name === "string" && apkName.test(item.name)) });
  if (!safeAssets(release) || release.assets.some((asset) =>
    asset.browser_download_url !== `https://github.com/${repository}/releases/download/${release.tag_name}/${asset.name}`))
    throw new Error("Unexpected GitHub release assets");
  return release;
}

/** 公网只触发同步。发布事实和校验值来自固定的 GitHub HTTPS 源。 */
export function createAndroidReleaseMirror(root: string, options: { transport?: typeof fetch; cooldownMs?: number } = {}) {
  const transport = options.transport ?? fetch;
  const shutdown = new AbortController();
  let inFlight: Promise<boolean> | undefined;
  let lastAttempt = -Infinity;
  let checkedAt = -Infinity;
  let queued = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const cooldown = options.cooldownMs ?? 30_000;
  const storedRelease = async (tag: string) => {
    if (!tagPattern.test(tag)) return null;
    try {
      const directory = join(root, tag);
      if (!(await lstat(directory)).isDirectory()) return null;
      const parsed = manifestSchema.parse(JSON.parse(await readFile(join(directory, "release.json"), "utf8")));
      if (parsed.tag_name !== tag || !safeAssets(parsed) || parsed.assets.some((asset) =>
        asset.browser_download_url !== pathFor(tag, asset.name))) return null;
      return parsed;
    } catch { return null; }
  };
  const latest = async (): Promise<Release | null> => {
    try { return await storedRelease(await readFile(join(root, "latest"), "utf8")); }
    catch { return null; }
  };
  const publish = async () => {
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(30 * 60_000)]);
    const previous = await latest();
    const release = await readGithubRelease(transport, signal);
    if (previous && !isLater(release.tag_name, previous.tag_name)) return true;
    await mkdir(root, { recursive: true, mode: 0o700 });
    // 单实例串行同步，应对进程退出后遗留的临时目录。
    const leftovers = (await readdir(root)).filter((entry) => /^\.sync-[A-Za-z0-9]+$/.test(entry));
    await Promise.allSettled(leftovers.map((entry) => rm(join(root, entry), { recursive: true, force: true })));
    // 同文件系统上先发布完整版本目录，再原子替换指针文件。
    const stage = await mkdtemp(join(root, ".sync-"));
    const versionDir = join(root, release.tag_name);
    try {
      const files = join(stage, "release");
      await mkdir(files, { mode: 0o700 });
      const download = new AbortController();
      const downloadSignal = AbortSignal.any([signal, download.signal]);
      const results = await Promise.allSettled(release.assets.map(async (item) => {
        try { await downloadAsset(transport, item, join(files, item.name), downloadSignal); }
        catch (error) { download.abort(); throw error; }
      }));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      const local = { ...release, assets: release.assets.map((asset) => ({
        ...asset, browser_download_url: pathFor(release.tag_name, asset.name),
      })) };
      await writeFile(join(files, "release.json"), JSON.stringify(local), { flag: "wx", mode: 0o600 });
      signal.throwIfAborted();
      // 同一 tag 的未发布目录只可能来自上次更新在替换指针前中断。
      await rm(versionDir, { recursive: true, force: true });
      await rename(files, versionDir);
      await writeFile(join(stage, "latest"), release.tag_name, { flag: "wx", mode: 0o600 });
      await rename(join(stage, "latest"), join(root, "latest"));
    } finally { await rm(stage, { recursive: true, force: true }).catch(() => {}); }
    const entries = await readdir(root).catch(() => []);
    await Promise.allSettled(entries.filter((entry) => tagPattern.test(entry) &&
      entry !== previous?.tag_name && entry !== release.tag_name).map((entry) => rm(join(root, entry), { recursive: true, force: true })));
    return true;
  };
  const refresh = () => {
    if (inFlight) return inFlight;
    if (shutdown.signal.aborted || performance.now() - lastAttempt < cooldown) return Promise.resolve(false);
    lastAttempt = performance.now();
    inFlight = publish().then((ok) => { checkedAt = performance.now(); return ok; })
      .catch(() => false).finally(() => { inFlight = undefined; if (queued) notify(); });
    return inFlight;
  };
  const notify = () => {
    if (shutdown.signal.aborted) return;
    if (inFlight) { queued = true; return; }
    if (retry) clearTimeout(retry);
    queued = false;
    const wait = cooldown - (performance.now() - lastAttempt);
    if (wait > 0) {
      retry = setTimeout(() => { retry = undefined; notify(); }, Math.ceil(wait));
      retry.unref();
    } else { void refresh(); }
  };
  return {
    latest,
    notify,
    refresh,
    checkIfDue: () => { if (performance.now() - checkedAt >= 60 * 60_000) void refresh(); },
    async asset(tag: string, name: string) {
      if (!apkName.test(name)) return undefined;
      const asset = (await storedRelease(tag))?.assets.find((item) => item.name === name);
      if (!asset) return undefined;
      const path = join(root, tag, name);
      try {
        const stats = await lstat(path);
        return stats.isFile() && stats.size === asset.size ? { path, size: asset.size, digest: asset.digest } : undefined;
      } catch { return undefined; }
    },
    async close() { shutdown.abort(); clearTimeout(retry); await inFlight; },
  };
}
export type AndroidReleaseMirror = ReturnType<typeof createAndroidReleaseMirror>;
