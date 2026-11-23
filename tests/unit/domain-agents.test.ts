import assert from "node:assert/strict";
import test from "node:test";
import { createDomainAgentRegistry, DomainAgentError } from "../../src/features/domain-agents/registry.js";
import { createDomainAgentTool, DOMAIN_AGENT_TOOL_NAME } from "../../src/adapters/pi/tools/domain-agent.js";

test("domain agent registry lists domains, reads instructions, and validates inputs", async () => {
  const smsInstructions = "快递取件码需要提醒";
  let newsEnabled = true;
  const registry = createDomainAgentRegistry({
    domains: [
      {
        id: "sms",
        name: "短信助手",
        summary: "筛选短信通知",
        isEnabled: async () => false,
        instructions: {
          read: async () => ({ instructions: smsInstructions, learnedNotes: "已学习招行账单", feedbackExamples: [] }),
        },
        query: async (input) => ({ queriedAction: input.action, status: input.status ?? null, limit: input.limit ?? null }),
      },
      {
        id: "news",
        name: "新闻助手",
        summary: "推荐 RSS 新闻",
        isEnabled: async () => newsEnabled,
        instructions: {
          read: async () => ({ instructions: "AI 工程", learnedNotes: "" }),
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
    { id: "sms", name: "短信助手", summary: "筛选短信通知", enabled: false, capabilities: { instructions: true, query: true } },
    { id: "news", name: "新闻助手", summary: "推荐 RSS 新闻", enabled: true, capabilities: { instructions: true, query: false } },
  ]);

  const rules = await registry.getInstructions("sms");
  assert.deepEqual(rules, {
    domainId: "sms",
    name: "短信助手",
    instructions: "快递取件码需要提醒",
    learnedNotes: "已学习招行账单",
    feedbackExamples: [],
  });

  const queried = await registry.query("sms", { action: "items", status: "processed", limit: 10.9 });
  assert.deepEqual(queried, {
    domainId: "sms",
    name: "短信助手",
    result: { queriedAction: "items", status: "processed", limit: 10 },
  });

  await assert.rejects(() => registry.query("news", { action: "overview" }), { code: "INVALID_INPUT" });
  await assert.rejects(() => registry.query("sms", { action: "items", limit: 101 }), { code: "INVALID_INPUT" });
  await assert.rejects(() => registry.getInstructions("unknown"), { code: "NOT_FOUND" });
  await assert.rejects(() => registry.getInstructions("INVALID!"), { code: "INVALID_INPUT" });

  assert.throws(() => createDomainAgentRegistry({
    domains: [
      { id: "BadId", name: "bad", summary: "bad", instructions: { read: async () => ({ instructions: "", learnedNotes: "" }) } },
    ],
  }), DomainAgentError);
  assert.throws(() => createDomainAgentRegistry({
    domains: [
      { id: "dup", name: "a", summary: "a", instructions: { read: async () => ({ instructions: "", learnedNotes: "" }) } },
      { id: "dup", name: "b", summary: "b", instructions: { read: async () => ({ instructions: "", learnedNotes: "" }) } },
    ],
  }), DomainAgentError);
  newsEnabled = false;
});

test("domain_agent tool handles read/write actions and enforces read-only mode in child subagents", async () => {
  let smsInstructions = "";
  const registry = createDomainAgentRegistry({
    domains: [
      {
        id: "sms",
        name: "短信助手",
        summary: "短信",
        instructions: {
          read: async () => ({ instructions: smsInstructions, learnedNotes: "learned" }),
        },
        query: async (input) => ({ action: input.action, count: 1 }),
      },
    ],
  });
  const deniedTool = createDomainAgentTool(registry);
  const denied = await deniedTool.execute("no-writer", { action: "update_instructions", domain: "sms", instructions: "blocked" }, undefined, undefined, {} as never);
  assert.equal(denied.isError, true);
  assert.equal(smsInstructions, "");
  const mainTool = createDomainAgentTool(registry, {
    writeInstructions: async (domainId, text, toolCallId) => {
      assert.equal(domainId, "sms");
      assert.equal(toolCallId, "2");
      smsInstructions = text;
      return {};
    },
  });
  assert.equal(mainTool.name, DOMAIN_AGENT_TOOL_NAME);

  const listResult = await mainTool.execute("1", { action: "list" }, undefined, undefined, {} as never);
  assert.equal(listResult.isError, undefined);
  assert.match((listResult.content[0] as { text: string }).text, /"sms"/);

  const updateResult = await mainTool.execute("2", {
    action: "update_instructions",
    domain: "sms",
    instructions: "信用卡还款提醒",
    reason: "用户指定",
  }, undefined, undefined, {} as never);
  assert.equal(updateResult.isError, undefined);
  assert.equal(smsInstructions, "信用卡还款提醒");

  const queryResult = await mainTool.execute("3", {
    action: "query",
    domain: "sms",
    queryAction: "overview",
  }, undefined, undefined, {} as never);
  assert.equal(queryResult.isError, undefined);
  assert.match((queryResult.content[0] as { text: string }).text, /"count":1/);

  const childTool = createDomainAgentTool(registry, { readOnly: true });
  const deniedUpdate = await childTool.execute("4", {
    action: "update_instructions",
    domain: "sms",
    instructions: "forged",
  }, undefined, undefined, {} as never);
  assert.equal(deniedUpdate.isError, true);
  assert.equal(smsInstructions, "信用卡还款提醒");

  const childRead = await childTool.execute("5", { action: "get_instructions", domain: "sms" }, undefined, undefined, {} as never);
  assert.equal(childRead.isError, undefined);
});

test("stopping a turn during instruction read prevents asking for approval", async () => {
  let finishRead!: () => void;
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { finishRead = resolve; });
  let writes = 0;
  const registry = createDomainAgentRegistry({
    domains: [{
      id: "news",
      name: "News",
      summary: "News preferences",
      instructions: {
        read: async () => {
          entered();
          await blocked;
          return { instructions: "", learnedNotes: "" };
        },
      },
    }],
  });
  const controller = new AbortController();
  const tool = createDomainAgentTool(registry, { writeInstructions: async () => { writes++; return {}; } });
  const change = tool.execute("cancelled-update", {
    action: "update_instructions",
    domain: "news",
    instructions: "Changed",
  }, controller.signal, undefined, {} as never);
  await reading;
  controller.abort();
  finishRead();
  await assert.rejects(change, { name: "AbortError" });
  assert.equal(writes, 0);
});
