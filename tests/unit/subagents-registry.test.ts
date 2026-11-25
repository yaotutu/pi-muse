import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentRegistry, SubagentError } from "../../src/features/subagents/registry.js";
import type { SubagentRegistration } from "../../src/features/subagents/types.js";

const sampleAgent = (overrides: Partial<SubagentRegistration> = {}): SubagentRegistration => ({
  id: "sms",
  name: "短信助手",
  description: "短信查询与规则管理",
  triggers: ["chat", "background"],
  executionPolicy: { stateless: true, parallelAllowed: true },
  prompts: () => [
    {
      key: "chat",
      label: "聊天路由提示词",
      trigger: "chat",
      source: "builtin",
      sourcePath: "prompts/subagents/sms-chat.md",
      editable: false,
      content: "sms chat prompt",
    },
  ],
  tools: [{ name: "sms_query", description: "查短信", triggers: ["chat"] }],
  skills: [],
  mcp: [],
  userInstructions: {
    path: "subagents/sms/AGENTS.md",
    read: async () => ({ instructions: "只提醒验证码", habits: [], unconsolidatedFeedbackCount: 0 }),
  },
  runChatTask: async (task) => ({ agent: "sms", task, output: `done:${task}` }),
  ...overrides,
});

test("subagent registry validates IDs, duplicates, and chat handler requirements", () => {
  assert.throws(
    () => createSubagentRegistry({ agents: [sampleAgent({ id: "INVALID" })] }),
    (error: unknown) => error instanceof SubagentError && error.code === "INVALID_INPUT",
  );
  assert.throws(
    () => createSubagentRegistry({ agents: [sampleAgent(), sampleAgent()] }),
    (error: unknown) => error instanceof SubagentError && error.code === "INVALID_INPUT",
  );
  assert.throws(
    () => createSubagentRegistry({ agents: [sampleAgent({ runChatTask: undefined })] }),
    (error: unknown) => error instanceof SubagentError && error.code === "INVALID_INPUT",
  );
});

test("subagent registry exposes list, detail, chat descriptors, and enforces availability", async () => {
  let browserEnabled = false;
  const registry = createSubagentRegistry({
    agents: [
      sampleAgent(),
      sampleAgent({
        id: "browser",
        name: "浏览器助手",
        triggers: ["chat"],
        isEnabled: () => browserEnabled,
        executionPolicy: { stateless: true, parallelAllowed: false },
        userInstructions: undefined,
        runChatTask: async (task) => ({ agent: "browser", task, output: "browsed" }),
      }),
      sampleAgent({
        id: "dream",
        name: "记忆整理助手",
        triggers: ["background"],
        userInstructions: undefined,
        runChatTask: undefined,
      }),
    ],
  });

  const listed = await registry.list();
  assert.deepEqual(listed.subagents.map((s) => s.id), ["sms", "browser", "dream"]);
  assert.equal(listed.subagents[0]?.editability.userInstructions, "editable");
  assert.equal(listed.subagents[1]?.enabled, false);
  assert.equal(listed.subagents[2]?.editability.userInstructions, "none");

  const smsDetail = await registry.getDetail("sms");
  assert.equal(smsDetail.prompts.length, 1);
  assert.equal(smsDetail.userInstructions?.path, "subagents/sms/AGENTS.md");
  assert.equal(smsDetail.userInstructions?.instructions, "只提醒验证码");

  const dreamDetail = await registry.getDetail("dream");
  assert.equal(dreamDetail.userInstructions, null);

  assert.deepEqual((await registry.listChatDescriptors()).map((d) => d.id), ["sms"]);
  await assert.rejects(
    () => registry.runChatTask("browser", "open", { sessionId: "main", subagentId: "s1" }),
    (error: unknown) => error instanceof SubagentError && error.code === "UNAVAILABLE",
  );
  await assert.rejects(
    () => registry.runChatTask("dream", "run", { sessionId: "main", subagentId: "s1" }),
    (error: unknown) => error instanceof SubagentError && error.code === "UNAVAILABLE",
  );

  browserEnabled = true;
  assert.deepEqual((await registry.listChatDescriptors()).map((d) => d.id), ["sms", "browser"]);
  const res = await registry.runChatTask("browser", "open", { sessionId: "main", subagentId: "s2" });
  assert.equal(res.output, "browsed");

  await assert.rejects(
    () => registry.getDetail("INVALID!"),
    (error: unknown) => error instanceof SubagentError && error.code === "INVALID_INPUT",
  );
  await assert.rejects(
    () => registry.getDetail("missing"),
    (error: unknown) => error instanceof SubagentError && error.code === "NOT_FOUND",
  );
});
