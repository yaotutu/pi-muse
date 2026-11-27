import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createConfig } from "../../src/config/load-config.js";
import { createFakeModel, type ModelRequest } from "../support/fake-model.js";
import { createService } from "../support/test-service.js";

const requestText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
          .join("")
      : "";

const systemPromptOf = (request: ModelRequest): string =>
  requestText(request.messages.find((message) => message.role === "system")?.content);

const userPromptOf = (request: ModelRequest): string =>
  requestText(request.messages.findLast((message) => message.role === "user")?.content);

const fixture = async (t: TestContext) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-include-int-"));
  const model = await createFakeModel();
  const service = await createService(createConfig({
    schemaVersion: 1,
    server: { host: "127.0.0.1" },
    model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "fake-include-key" },
    runtime: { dataDir, runTimeoutMs: 10_000, schedulerIntervalMs: 60_000, monitorScanIntervalMs: 60_000 },
  }));
  t.after(async () => {
    try { await service.close(); } finally {
      try { await model.close(); } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  });
  const token = service.auth.login()!;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const api = async (path: string, method = "GET", body?: unknown) => {
    const res = await service.app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => undefined) as unknown };
  };
  const runChat = async (content: string, runId = randomUUID()) => {
    const conv = (await api("/api/conversation?sessionId=main")).body as { revision: string };
    const res = await service.app.request("/api/conversation/run", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: "main",
        runId,
        expectedRevision: conv.revision,
        message: { id: randomUUID(), content },
      }),
    });
    assert.equal(res.status, 200);
    await res.text();
  };
  return { api, dataDir, model, runChat, service };
};

test("main chat expands frontmatter includes across SOUL, USER, and INSTRUCTIONS while GET returns raw text and Dream write-back preserves frontmatter", async (t) => {
  const h = await fixture(t);
  const { workspaceDir } = h.service.layout;

  await writeFile(join(workspaceDir, "assistant", "soul-tone.md"), "SOUL-EXTRA-TONE-DIRECT", "utf8");
  await writeFile(join(workspaceDir, "assistant", "user-ctx.md"), "USER-EXTRA-TIMEZONE-UTC8", "utf8");
  await writeFile(join(workspaceDir, "assistant", "sub-rule.md"), "ASSISTANT-SUB-RULE-CITATION", "utf8");
  await writeFile(join(workspaceDir, "files", "shared-policy.md"), "SHARED-FILE-POLICY-CHECK", "utf8");

  const rawSoul = "---\ninclude:\n  - ./soul-tone.md\n  - ./missing-soul.md\n---\n\nPrimary SOUL.";
  const rawUser = "---\ninclude:\n  - ./user-ctx.md\n---\n\nPrimary USER.";
  const rawInstructions = "---\ninclude:\n  - ./sub-rule.md\n  - ../files/shared-policy.md\n  - ./missing-inst.md\n---\n\nPrimary ASSISTANT rule.";

  assert.equal((await h.api("/api/profile", "PUT", { soul: rawSoul, user: rawUser })).status, 200);
  assert.equal((await h.api("/api/assistant/instructions", "PUT", { instructions: rawInstructions })).status, 200);

  // Read APIs MUST preserve raw YAML frontmatter untouched.
  assert.deepEqual((await h.api("/api/profile")).body, { soul: rawSoul, user: rawUser });
  const assistantBody = (await h.api("/api/assistant/instructions")).body as { instructions: string; includes: Array<{ path: string; status: string }> };
  assert.equal(assistantBody.instructions, rawInstructions);
  assert.ok(assistantBody.includes.some((entry) => entry.status === "loaded"));

  const reqStart = h.model.requests.length;
  await h.runChat("hello\n会话规则:回复前先核对时间");

  const chatReq = h.model.requests.slice(reqStart).find((req) =>
    systemPromptOf(req).includes("## Your identity (SOUL)"));
  assert.ok(chatReq, "expected main chat model request");
  const chatSystem = systemPromptOf(chatReq);
  assert.ok(chatSystem.includes("Primary SOUL."));
  assert.ok(chatSystem.includes("SOUL-EXTRA-TONE-DIRECT"));
  assert.ok(chatSystem.includes("Primary USER."));
  assert.ok(chatSystem.includes("USER-EXTRA-TIMEZONE-UTC8"));
  assert.ok(chatSystem.includes("Primary ASSISTANT rule."));
  assert.ok(chatSystem.includes("<!-- begin include: assistant/sub-rule.md -->\nASSISTANT-SUB-RULE-CITATION\n<!-- end include: assistant/sub-rule.md -->"));
  assert.ok(chatSystem.includes("SHARED-FILE-POLICY-CHECK"));
  assert.ok(!chatSystem.includes("missing-soul.md") && !chatSystem.includes("missing-inst.md"));

  // Dream consolidation prompt receives expanded documents, while applying the pending suggestion keeps top frontmatter intact.
  const dreamReqStart = h.model.requests.length;
  const dreamRes = await h.api("/api/dream/run", "POST", {});
  assert.equal(dreamRes.status, 200);
  const overview = dreamRes.body as { pending: Array<{ id: string; suggestedTarget: string }> };
  assert.equal(overview.pending.length, 1);

  const dreamReq = h.model.requests.slice(dreamReqStart)[0]!;
  const dreamUser = userPromptOf(dreamReq);
  assert.ok(dreamUser.includes("SOUL-EXTRA-TONE-DIRECT"));
  assert.ok(dreamUser.includes("USER-EXTRA-TIMEZONE-UTC8"));
  assert.ok(dreamUser.includes("ASSISTANT-SUB-RULE-CITATION"));

  const applied = await h.api(`/api/dream/pending/${overview.pending[0]!.id}`, "POST", { action: "apply" });
  assert.equal(applied.status, 200);

  const afterApply = (await h.api("/api/assistant/instructions")).body as { instructions: string };
  assert.ok(afterApply.instructions.startsWith("---\ninclude:\n  - ./sub-rule.md"), "Dream apply must preserve top frontmatter");
  assert.ok(afterApply.instructions.includes("回复前先核对时间"));
});

test("SMS expands workspace instructions includes while keeping HTTP GET raw and never expanding habits", async (t) => {
  const h = await fixture(t);
  const { workspaceDir } = h.service.layout;

  await writeFile(join(workspaceDir, "subagents", "sms", "bank.md"), "SMS-SUB-BANK-ALERTS", "utf8");
  await writeFile(join(workspaceDir, "files", "vip.md"), "SHARED-VIP-CONTACT", "utf8");
  await writeFile(join(workspaceDir, "files", "forbidden-secret.md"), "FORBIDDEN-SECRET-MUST-NOT-EXPAND", "utf8");

  const smsRaw = "---\ninclude:\n  - ./bank.md\n  - ../../files/vip.md\n  - ./missing-sms.md\n---\n\nSMS root instructions.";

  assert.equal((await h.api("/api/information/preferences", "PUT", { instructions: smsRaw })).status, 200);

  const smsPrefsBody = (await h.api("/api/information/preferences")).body as { instructions: string; includes: Array<{ status: string }> };
  assert.equal(smsPrefsBody.instructions, smsRaw);
  assert.ok(smsPrefsBody.includes.some((entry) => entry.status === "loaded"));

  // Poison habits with YAML frontmatter include; MUST NEVER expand.
  assert.equal((await h.api("/api/habits/sms", "POST", {
    text: "---\ninclude:\n  - ../../files/forbidden-secret.md\n---\nlearned-sms-only",
  })).status, 200);

  assert.equal((await h.api("/api/information/settings", "PUT", { enabled: true, batchWindowSeconds: 3600 })).status, 200);
  assert.equal((await h.api("/api/information/items", "POST", {
    items: [{ source: "sms", externalId: "sms-inc-1", content: "NOTIFY Package arrived pickup code 1234" }],
  })).status, 200);

  const smsReqStart = h.model.requests.length;
  assert.equal((await h.api("/api/information/runs", "POST", {})).status, 200);
  const smsReq = h.model.requests.slice(smsReqStart).find((req) => systemPromptOf(req).includes("SMS/information decision worker"));
  assert.ok(smsReq, "expected SMS realtime model request");
  const smsSystem = systemPromptOf(smsReq);
  assert.ok(smsSystem.includes("SMS root instructions."));
  assert.ok(smsSystem.includes("<!-- begin include: subagents/sms/bank.md -->\nSMS-SUB-BANK-ALERTS\n<!-- end include: subagents/sms/bank.md -->"));
  assert.ok(smsSystem.includes("SHARED-VIP-CONTACT"));
  assert.ok(smsSystem.includes("learned-sms-only"));
  assert.ok(!smsSystem.includes("FORBIDDEN-SECRET-MUST-NOT-EXPAND"), "habits must never expand include directives");
});

test("instructions and domain preferences return accurate include diagnostics across all error statuses", async (t) => {
  const h = await fixture(t);
  const workspaceDir = join(h.dataDir, "workspace");
  await writeFile(join(workspaceDir, "assistant", "loaded.md"), "LOADED-SUB", "utf8");
  await writeFile(join(workspaceDir, "assistant", "empty.md"), "   \n", "utf8");
  await writeFile(join(workspaceDir, "assistant", "cycle-a.md"), "---\ninclude: ./cycle-b.md\n---\nCYCLE-A", "utf8");
  await writeFile(join(workspaceDir, "assistant", "cycle-b.md"), "---\ninclude: ./cycle-a.md\n---\nCYCLE-B", "utf8");

  const assistantDoc = [
    "---",
    "include:",
    "  - ./loaded.md",
    "  - ./missing.md",
    "  - ../../escape.md",
    "  - ./empty.md",
    "  - ./cycle-a.md",
    "---",
    "Root instructions.",
  ].join("\n");

  const savedAssistant = await h.api("/api/assistant/instructions", "PUT", { instructions: assistantDoc });
  assert.equal(savedAssistant.status, 200);
  const assistantBody = savedAssistant.body as {
    instructions: string;
    includes: Array<{ path: string; status: string }>;
  };
  assert.equal(assistantBody.instructions, assistantDoc);
  assert.deepEqual(
    assistantBody.includes.map((entry) => [entry.path, entry.status]),
    [
      ["./loaded.md", "loaded"],
      ["./missing.md", "missing"],
      ["../../escape.md", "invalid"],
      ["./empty.md", "empty"],
      ["./cycle-a.md", "cycle"],
      ["./cycle-b.md", "loaded"],
      ["./cycle-a.md", "loaded"],
    ],
  );

  await writeFile(join(workspaceDir, "subagents", "sms", "valid.md"), "SMS-VALID", "utf8");
  const smsDoc = "---\ninclude:\n  - ./valid.md\n  - ./missing.md\n---\nSMS-ROOT";
  const savedSms = await h.api("/api/information/preferences", "PUT", { instructions: smsDoc });
  assert.equal(savedSms.status, 200);
  const smsBody = savedSms.body as { includes: Array<{ path: string; status: string }> };
  assert.deepEqual(
    smsBody.includes.map((entry) => [entry.path, entry.status]),
    [["./valid.md", "loaded"], ["./missing.md", "missing"]],
  );
});
