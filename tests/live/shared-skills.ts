import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLiveOptions, type LiveOptions } from "./options.js";

async function execute(options: LiveOptions) {
  const { serve } = await import("@hono/node-server");
  const { createConfig } = await import("../../src/config/load-config.js");
  const { createService } = await import("../../src/bootstrap/create-service.js");
  const { createLiveModel } = await import("../support/live-model.js");
  const { createTestClient } = await import("../support/http-client.js");
  const { skillsResponse, skillDetailResponse } = await import("../../src/http/contracts/responses.js");
  // 只读受保护配置的模型字段，不采用真实实例路径、会话、规则或其他设置。
  const input = JSON.parse(await readFile(options.configPath, "utf8"));
  const model = createConfig({ server: { host: "127.0.0.1" }, model: input.model });
  assert.ok(model.configured, "External model configuration required");
  const root = await mkdtemp(join(tmpdir(), "pi-muse-shared-skills-live-"));
  const dataDir = join(root, "data");
  const sharedDir = join(root, "home", ".agents", "skills");
  const skillDir = join(sharedDir, "live-shared");
  const referenceMarker = `LIVE_SHARED_REFERENCE_${randomUUID().replaceAll("-", "")}`;
  const ownMarker = `LIVE_OWN_REFERENCE_${randomUUID().replaceAll("-", "")}`;
  const extensionSentinel = join(root, "extension-must-not-run.txt");
  const checks: string[] = [];
  let stage = "initialization";
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let http: ReturnType<typeof serve> | undefined;
  let proxy: Awaited<ReturnType<typeof createLiveModel>> | undefined;
  let failure: unknown;
  const pass = (name: string) => { checks.push(name); console.log(`[PASS] ${name}`); };
  try {
    await mkdir(join(skillDir, "references"), { recursive: true, mode: 0o700 });
    const sharedContent = `---\nname: live-shared\ndescription: LIVE_SHARED_DISCOVERY_GUIDANCE for an explicitly requested isolated read-only check.\n---\n# Live shared skill\nRead ${JSON.stringify(join(skillDir, "references", "note.md"))} with the read tool, then return its verification marker. Do not write files or call other tools.\n`;
    await writeFile(join(skillDir, "SKILL.md"), sharedContent, { mode: 0o600 });
    await writeFile(join(skillDir, "references", "note.md"), `Verification marker: ${referenceMarker}\n`, { mode: 0o600 });
    await writeFile(join(skillDir, "extension.ts"), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(extensionSentinel)},'must not execute');export default function(){};`, { mode: 0o600 });
    proxy = await createLiveModel({ baseUrl: model.baseUrl!, apiKey: model.apiKey });
    service = await createService(createConfig({
      server: { host: "127.0.0.1", accessKey: "shared-skills-live-isolated-access" },
      model: { baseUrl: proxy.baseUrl, id: model.modelId, apiKey: "live-proxy-placeholder", contextWindow: model.contextWindow, maxTokens: model.maxTokens },
      runtime: { dataDir, runTimeoutMs: 180000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    }), { sharedSkillsDir: sharedDir });
    http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!http.listening) await once(http, "listening");
    const address = http.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(base + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: "shared-skills-live-isolated-access" }) });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    const client = createTestClient(() => base, token, 190000);
    const list = async (id = "main") => skillsResponse.parse(await client.json(`/api/sessions/${id}/skills`));
    const run = async (id: string, prompt: string) => {
      const first = proxy!.traces.length;
      const events = await client.run(prompt, id);
      assert.equal(events.at(-1)?.type, "RUN_FINISHED", "Real model run must finish successfully");
      const traces = proxy!.traces.slice(first);
      assert.ok(traces.length > 0 && traces.every((trace) => trace.upstreamStatus === 200), "Actual upstream model calls required");
      return traces;
    };

    stage = "default-off";
    const initial = await list();
    assert.ok(initial.skills.every((skill) => !skill.enabled && !skill.defaultEnabled));
    assert.equal(initial.skills.find((skill) => skill.name === "live-shared")?.source, "shared");
    const details = skillDetailResponse.parse(await client.json("/api/sessions/main/skills/live-shared"));
    assert.equal(details.content, sharedContent);
    const disabled = await run("main", "这是隔离真实验收。只实际调用 currentTime 一次，回复 LIVE_DEFAULT_OFF_OK 与得到的时间；不要读取文件或使用其他工具。");
    assert.ok(disabled.some((trace) => trace.calls.some((call) => call.name === "currentTime")));
    assert.ok(disabled.every((trace) => !trace.toolNames.includes("bash") && !trace.toolNames.includes("skills") && !trace.toolNames.includes("write")));
    await assert.rejects(stat(extensionSentinel), { code: "ENOENT" });
    pass(stage);

    stage = "shared-enabled-resource-read";
    await client.json("/api/sessions/main/skills", { overrides: { "shared/live-shared": true } }, "PUT");
    assert.equal((await list()).skills.filter((skill) => skill.enabled).length, 1);
    const shared = await run("main", "请明确使用 live-shared 技能完成隔离验收：先用 read 读取技能说明，再按说明读取参考资料，最终原样回复参考资料中的 verification marker。不要写文件，不要使用其他能力。");
    const sharedReads = shared.flatMap((trace) => trace.calls).filter((call) => call.name === "read");
    assert.ok(sharedReads.some((call) => call.arguments.includes("SKILL.md")), "The real model must read enabled skill instructions");
    assert.ok(sharedReads.some((call) => call.arguments.includes("references") && call.arguments.includes("note.md")), "The real model must read its exact allowed resource");
    assert.ok(shared.flatMap((trace) => trace.toolResults).join("\n").includes(referenceMarker));
    assert.ok(shared.some((trace) => trace.output.includes(referenceMarker)));
    await assert.rejects(stat(extensionSentinel), { code: "ENOENT" });
    assert.equal(await readFile(join(skillDir, "SKILL.md"), "utf8"), sharedContent);
    await assert.rejects(stat(join(skillDir, "config.json")), { code: "ENOENT" });
    pass(stage);

    stage = "own-priority-and-source-bound-selection";
    const ownDir = join(dataDir, "skills", "live-shared");
    await mkdir(ownDir, { recursive: true, mode: 0o700 });
    await writeFile(join(ownDir, "SKILL.md"), `---\nname: live-shared\ndescription: LIVE_OWN_DISCOVERY_GUIDANCE for the Pi Muse instance only.\n---\n# Own skill\nAfter reading this skill, reply exactly ${ownMarker}. Do not read shared resources or write files.\n`, { mode: 0o600 });
    const overridden = (await list()).skills.find((skill) => skill.name === "live-shared")!;
    assert.equal(overridden.source, "user");
    assert.equal(overridden.enabled, false, "New own source must not inherit the old shared selection");
    const refused = await client.request("/api/sessions/main/skills", { overrides: { "shared/live-shared": true } }, "PUT");
    assert.equal(refused.status, 400);
    // 新建独立上下文，避免把前一轮已读技能的历史内容误认为本轮自动加载。
    const fresh = (await client.json("/api/sessions", { title: "shared-skills-live-own" })).session.id as string;
    assert.ok((await list(fresh)).skills.every((skill) => !skill.enabled));
    await client.json(`/api/sessions/${fresh}/skills`, { overrides: { "user/live-shared": true } }, "PUT");
    const own = await run(fresh, "请使用 live-shared 技能：先实际读取技能正文，严格按正文回复其中的验收串。不要写文件，不要读取共享技能或其他资料。");
    assert.ok(own.flatMap((trace) => trace.calls).some((call) => call.name === "read" && call.arguments.includes("SKILL.md")));
    assert.ok(own.some((trace) => trace.output.includes(ownMarker)));
    assert.ok(own.flatMap((trace) => trace.toolResults).join("\n").includes(ownMarker));
    await client.json(`/api/sessions/${fresh}/skills`, { overrides: {} }, "PUT");
    assert.ok((await list(fresh)).skills.every((skill) => !skill.enabled));
    await assert.rejects(stat(extensionSentinel), { code: "ENOENT" });
    assert.equal(await readFile(join(skillDir, "SKILL.md"), "utf8"), sharedContent);
    pass(stage);
  } catch (error) {
    failure = error;
    console.error(`[FAIL] ${stage}: ${error instanceof assert.AssertionError ? error.message : "Live operation failed; sensitive details omitted"}`);
  } finally {
    const report = { checks, failedStage: failure ? stage : null, providerStatuses: proxy?.traces.map((trace) => trace.upstreamStatus), toolCalls: proxy?.traces.flatMap((trace) => trace.calls.map((call) => call.name)) };
    await writeFile(join(root, "summary.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    try { await service?.close(); }
    finally {
      if (http) {
        if ("closeAllConnections" in http) http.closeAllConnections();
        await new Promise<void>((resolve) => http!.close(() => resolve()));
      }
      await proxy?.close();
      if (!options.keepArtifacts) await rm(root, { recursive: true, force: true });
      else console.log(`ARTIFACTS ${root}`);
    }
  }
  if (failure) process.exitCode = 1;
}

const parsed = parseLiveOptions(process.argv.slice(2));
if (parsed.kind === "help") console.log(parsed.help);
else if (parsed.kind === "error") { console.error(parsed.message); process.exitCode = 1; }
else await execute(parsed.options);
