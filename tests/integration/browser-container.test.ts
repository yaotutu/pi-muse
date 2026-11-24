import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFile(join(root, path), "utf8");

test("browser container keeps Chrome headed and slimmed down without VNC/fluxbox/noVNC", async () => {
  const dockerfile = await read("Dockerfile");
  const compose = await read("compose.browser.yaml");
  const entrypoint = await read("scripts/container-browser-entrypoint.sh");

  assert.match(dockerfile, /FROM --platform=linux\/amd64 node:24-bookworm-slim/);
  assert.match(dockerfile, /\bxvfb\b/);
  assert.match(dockerfile, /google-chrome-stable/);
  assert.match(dockerfile, /EXPOSE 12330/);
  assert.match(dockerfile, /HEALTHCHECK .*http:\/\/127\.0\.0\.1:12330\/api\/health/s);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/tini", "--", "\/usr\/local\/bin\/container-browser-entrypoint"\]/);

  // Clean break: VNC/noVNC/fluxbox and assets/browser must be gone from Dockerfile.
  for (const legacy of ["x11vnc", "fluxbox", "novnc", "websockify", "assets/browser", "install-novnc-responsive-entry"]) {
    assert.ok(!dockerfile.includes(legacy), `Dockerfile must not include legacy ${legacy}`);
  }

  // Entrypoint runs Xvfb, drops privileges with setpriv, cleans runtime Singleton locks and wakes Chrome.
  await exec("sh", ["-n", join(root, "scripts/container-browser-entrypoint.sh")]);
  assert.match(entrypoint, /Xvfb "\$display"/);
  assert.match(entrypoint, /exec setpriv/);
  assert.match(entrypoint, /rm -f \/app\/\.pi-muse\/runtime\/browser\/profile\/SingletonCookie/);
  assert.match(entrypoint, /SingletonLock/);
  assert.match(entrypoint, /SingletonSocket/);
  assert.match(entrypoint, /fetch\("http:\/\/127\.0\.0\.1:12330\/api\/browser\/tabs"/);
  assert.ok(!entrypoint.includes("6080") && !entrypoint.includes("5900"));
  for (const legacy of ["x11vnc", "fluxbox", "websockify", "novnc"]) {
    assert.ok(!entrypoint.toLowerCase().includes(legacy), `entrypoint must not reference ${legacy}`);
  }

  // Single compose service exposes only 12330; legacy mobile sidecar/profile is gone.
  assert.match(compose, /pi-muse-browser:/);
  assert.match(compose, /shm_size:\s*1gb/);
  assert.match(compose, /12330\}?:12330/);
  assert.ok(!compose.includes("pi-muse-browser-mobile"));
  assert.ok(!compose.includes("6080"));
});

test("web Vite config proxies /api, /browser and /ws/browser for both dev and preview", async () => {
  const viteConfig = await read("web/vite.config.ts");
  assert.match(viteConfig, /"\/api":\s*apiTarget/);
  assert.match(viteConfig, /"\/browser":\s*apiTarget/);
  assert.match(viteConfig, /"\/ws\/browser":\s*\{\s*target:\s*apiTarget,\s*ws:\s*true\s*\}/);
});
