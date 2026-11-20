import assert from "node:assert/strict";
import test from "node:test";
import { createDomainAgentRegistry, DomainAgentError } from "../../src/features/domain-agents/registry.js";
import type { DomainRuleUpdateRequest } from "../../src/features/domain-agents/types.js";
import { createDomainAgentTool, DOMAIN_AGENT_TOOL_NAME } from "../../src/adapters/pi/tools/domain-agent.js";

test("domain agent registry lists domains, reads/updates rules, and validates inputs", async () => {
  let smsNotes = "快递取件码需要提醒";
  let newsEnabled = true;
  const registry = createDomainAgentRegistry({
    defaultRuleUpdateMode: "auto",
    domains: [
      {
        id: "sms",
        name: "短信助手",
        summary: "筛选短信通知",
        isEnabled: async () => false,
        rules: {
          read: async () => ({ notes: smsNotes, learnedNotes: "已学习招行账单", feedbackExamples: [] }),
          write: async (notes) => {
            smsNotes = notes;
            return { notes: smsNotes };
          },
        },
        query: async (input) => ({ queriedAction: input.action, status: input.status ?? null, limit: input.limit ?? null }),
      },
      {
        id: "news",
        name: "新闻助手",
        summary: "推荐 RSS 新闻",
        isEnabled: async () => newsEnabled,
        rules: {
          read: async () => ({ notes: "AI 工程", learnedNotes: "" }),
          write: async (notes) => ({ notes }),
        },
      },
    ],
  });

  assert.deepEqual(registry.describeForPrompt(), [
    { id: "sms", name: "短信助手", summary: "筛选短信通知" },
    { id: "news", name: "新闻助手", summary: "推荐 RSS 新闻" },
  ]);

  const listed = await registry.list();
  assert.deepEqual(listed.domains, [
    { id: "sms", name: "短信助手", summary: "筛选短信通知", enabled: false, ruleUpdateMode: "auto", capabilities: { rules: true, query: true } },
    { id: "news", name: "新闻助手", summary: "推荐 RSS 新闻", enabled: true, ruleUpdateMode: "auto", capabilities: { rules: true, query: false } },
  ]);

  const rules = await registry.getRules("sms");
  assert.deepEqual(rules, {
    domainId: "sms",
    name: "短信助手",
    notes: "快递取件码需要提醒",
    learnedNotes: "已学习招行账单",
    feedbackExamples: [],
  });

  const updated = await registry.updateRules({
    domainId: "sms",
    notes: "快递取件码需要提醒\n信用卡还款必须提醒",
    reason: "用户确认信用卡还款有用",
    sessionId: "main",
    runId: "run-1",
  });
  assert.deepEqual(updated, {
    domainId: "sms",
    name: "短信助手",
    beforeNotes: "快递取件码需要提醒",
    notes: "快递取件码需要提醒\n信用卡还款必须提醒",
    updated: true,
  });
  assert.equal(smsNotes, "快递取件码需要提醒\n信用卡还款必须提醒");

  const queried = await registry.query("sms", { action: "items", status: "processed", limit: 10.9 });
  assert.deepEqual(queried, {
    domainId: "sms",
    name: "短信助手",
    result: { queriedAction: "items", status: "processed", limit: 10 },
  });

  await assert.rejects(() => registry.query("news", { action: "overview" }), { code: "INVALID_INPUT" });
  await assert.rejects(() => registry.query("sms", { action: "items", limit: 101 }), { code: "INVALID_INPUT" });
  await assert.rejects(() => registry.getRules("unknown"), { code: "NOT_FOUND" });
  await assert.rejects(() => registry.getRules("INVALID!"), { code: "INVALID_INPUT" });
  await assert.rejects(() => registry.updateRules({ domainId: "sms", notes: "x".repeat(20_001) }), { code: "INVALID_INPUT" });

  assert.throws(() => createDomainAgentRegistry({
    domains: [
      { id: "BadId", name: "bad", summary: "bad", rules: { read: async () => ({ notes: "", learnedNotes: "" }), write: async (n) => ({ notes: n }) } },
    ],
  }), DomainAgentError);
  assert.throws(() => createDomainAgentRegistry({
    domains: [
      { id: "dup", name: "a", summary: "a", rules: { read: async () => ({ notes: "", learnedNotes: "" }), write: async (n) => ({ notes: n }) } },
      { id: "dup", name: "b", summary: "b", rules: { read: async () => ({ notes: "", learnedNotes: "" }), write: async (n) => ({ notes: n }) } },
    ],
  }), DomainAgentError);
  newsEnabled = false;
});

test("rule update authorization supports per-domain confirm mode and pluggable authorizer hook", async () => {
  const seenRequests: DomainRuleUpdateRequest[] = [];
  let saved = "initial";
  const confirmOnlyRegistry = createDomainAgentRegistry({
    domains: [
      {
        id: "sms",
        name: "短信助手",
        summary: "短信",
        ruleUpdateMode: "confirm",
        rules: {
          read: async () => ({ notes: saved, learnedNotes: "" }),
          write: async (notes) => { saved = notes; return { notes }; },
        },
      },
    ],
  });
  await assert.rejects(
    () => confirmOnlyRegistry.updateRules({ domainId: "sms", notes: "changed" }),
    { code: "CONFIRMATION_REQUIRED" },
  );
  assert.equal(saved, "initial");

  let mode: "allow" | "deny-auth" | "deny-confirm" = "deny-confirm";
  const pluggableRegistry = createDomainAgentRegistry({
    defaultRuleUpdateMode: "auto",
    authorizeRuleUpdate: async (request) => {
      seenRequests.push(request);
      if (mode === "allow") return { allowed: true };
      if (mode === "deny-auth") return { allowed: false, reason: "Policy forbids edit" };
      return { allowed: false, confirmationRequired: true, reason: "Needs approval UI" };
    },
    domains: [
      {
        id: "sms",
        name: "短信助手",
        summary: "短信",
        rules: {
          read: async () => ({ notes: saved, learnedNotes: "" }),
          write: async (notes) => { saved = notes; return { notes }; },
        },
      },
    ],
  });

  await assert.rejects(
    () => pluggableRegistry.updateRules({ domainId: "sms", notes: "next", reason: "user asked", sessionId: "main", runId: "r1" }),
    { code: "CONFIRMATION_REQUIRED", message: "Needs approval UI" },
  );
  mode = "deny-auth";
  await assert.rejects(
    () => pluggableRegistry.updateRules({ domainId: "sms", notes: "next" }),
    { code: "UNAUTHORIZED", message: "Policy forbids edit" },
  );
  assert.equal(saved, "initial");

  mode = "allow";
  const applied = await pluggableRegistry.updateRules({ domainId: "sms", notes: "next", reason: "approved", sessionId: "main", runId: "r2" });
  assert.equal(applied.notes, "next");
  assert.equal(saved, "next");
  assert.equal(seenRequests.length, 3);
  assert.deepEqual(seenRequests[0], {
    domainId: "sms",
    domainName: "短信助手",
    beforeNotes: "initial",
    afterNotes: "next",
    reason: "user asked",
    sessionId: "main",
    runId: "r1",
  });
});

test("domain_agent tool handles read/write actions and enforces read-only mode in child subagents", async () => {
  let smsNotes = "";
  const registry = createDomainAgentRegistry({
    domains: [
      {
        id: "sms",
        name: "短信助手",
        summary: "短信",
        rules: {
          read: async () => ({ notes: smsNotes, learnedNotes: "learned" }),
          write: async (notes) => { smsNotes = notes; return { notes }; },
        },
        query: async (input) => ({ action: input.action, count: 1 }),
      },
    ],
  });
  const mainTool = createDomainAgentTool(registry, { sessionId: "main", runId: "run-main", readOnly: false });
  assert.equal(mainTool.name, DOMAIN_AGENT_TOOL_NAME);

  const listResult = await mainTool.execute("1", { action: "list" }, undefined, undefined, {} as never);
  assert.equal(listResult.isError, undefined);
  assert.match((listResult.content[0] as { text: string }).text, /"sms"/);

  const updateResult = await mainTool.execute("2", {
    action: "update_rules",
    domain: "sms",
    notes: "信用卡还款提醒",
    reason: "用户指定",
  }, undefined, undefined, {} as never);
  assert.equal(updateResult.isError, undefined);
  assert.equal(smsNotes, "信用卡还款提醒");

  const queryResult = await mainTool.execute("3", {
    action: "query",
    domain: "sms",
    queryAction: "overview",
  }, undefined, undefined, {} as never);
  assert.equal(queryResult.isError, undefined);
  assert.match((queryResult.content[0] as { text: string }).text, /"count":1/);

  const childTool = createDomainAgentTool(registry, { sessionId: "main", runId: "run-main", readOnly: true });
  const deniedUpdate = await childTool.execute("4", {
    action: "update_rules",
    domain: "sms",
    notes: "forged",
  }, undefined, undefined, {} as never);
  assert.equal(deniedUpdate.isError, true);
  assert.equal(smsNotes, "信用卡还款提醒");

  const childRead = await childTool.execute("5", { action: "get_rules", domain: "sms" }, undefined, undefined, {} as never);
  assert.equal(childRead.isError, undefined);
});
