import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGroupRouting, type RouteDecision, type RouteInput } from "../../src/features/group-chat/routing.js";
import { createGroupRoutingRepository } from "../../src/adapters/storage/group-routing-repository.js";
import { createGroupChat } from "../../src/features/group-chat/service.js";
import type { AgentCommunication } from "../../src/features/agent-communication/service.js";

test("group routing persists public capabilities and explicit membership, validates decisions and protects default deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-routing-")); const file = join(root, "routing.json");
  let directory = ["local-main", "sms-internal", "news-internal"];
  let decision: RouteDecision = { mode: "direct", targetAgentIds: ["sms-internal"], reason: "短信查询" };
  let observed: RouteInput | undefined;
  const routing = createGroupRouting({ repository: createGroupRoutingRepository(file), agents: async () => directory.map((id) => ({ id })),
    decide: async (input) => { observed = input; return decision; } });
  try {
    const settings = await routing.settings();
    assert.deepEqual(settings.memberIds, directory);
    await routing.saveCapability("sms-internal", "处理短信，不负责新闻");
    await routing.saveSettings({ ...settings, instructions: "简短回复", memberIds: ["sms-internal", "local-main"] });
    directory.push("new-agent");
    assert.equal((await routing.settings()).memberIds.includes("new-agent"), false);
    assert.deepEqual(await routing.route("原文不改写", new AbortController().signal), decision);
    assert.equal(observed?.content, "原文不改写");
    assert.deepEqual(observed?.members.map((item) => item.id), ["local-main", "sms-internal"]);
    assert.equal(observed?.members[1]?.capability, "处理短信，不负责新闻");
    assert.equal(observed?.settings.instructions, "简短回复");
    for (const targetAgentIds of [["missing"], ["news-internal"], ["local-main", "sms-internal"], []]) {
      decision = { mode: "direct", targetAgentIds, reason: "" };
      await assert.rejects(routing.route("test", new AbortController().signal), /Invalid routing decision/);
    }
    decision = { mode: "confirm", targetAgentIds: ["local-main", "sms-internal"], reason: "请选择" };
    assert.equal((await routing.route("不感兴趣", new AbortController().signal)).mode, "confirm");
    await assert.rejects(routing.saveSettings({ ...settings, defaultAgentId: "missing" }), /Default agent/);
    await assert.rejects(routing.assertCanDelete("local-main"), /Choose another/);
    await routing.saveSettings({ ...settings, defaultAgentId: "sms-internal" });
    await routing.assertCanDelete("local-main");
    await routing.removeAgent("news-internal"); directory = directory.filter((id) => id !== "news-internal");
    assert.equal((await routing.settings()).memberIds.includes("news-internal"), false);
    const reopened = await createGroupRoutingRepository(file).read();
    assert.equal(reopened.group?.defaultAgentId, "sms-internal");
    assert.deepEqual(reopened.capabilities, { "sms-internal": "处理短信，不负责新闻" });
    await assert.rejects(routing.saveCapability("missing", "do not create"), /not found/);
    await writeFile(file, "broken"); await assert.rejects(routing.validate(), /Invalid group routing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("planning is single-owner, stop and close cancel it; confirmation does not execute targets, explicit target bypasses classifier", async () => {
  let classify = 0; let calls = 0;
  const settings = { name: "全部", purpose: "", instructions: "", memberIds: ["local-main", "sms-internal"], defaultAgentId: "local-main" };
  const routing = createGroupRouting({ repository: { read: async () => ({ group: settings, capabilities: {} }), update: async () => {} },
    agents: async () => settings.memberIds.map((id) => ({ id })), decide: async (input, signal) => {
      classify++;
      if (input.content === "wait") await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      signal.throwIfAborted();
      return { mode: "confirm", targetAgentIds: settings.memberIds, reason: "请选择" };
    } });
  const group = createGroupChat({ routing, repository: { read: async () => [], update: async () => {} }, notifications: async () => [],
    resolveNotification: async () => ({ targetAgentId: "sms-internal", context: "verified" }), history: async () => ({ messages: [] }),
    communication: { request: async (input: { targetAgentId: string; message: string }) => { calls++; assert.equal(input.targetAgentId, "sms-internal"); assert.equal(input.message, "original"); } } as unknown as AgentCommunication });
  const events: unknown[] = []; const signal = new AbortController().signal;
  await group.send({ id: "ambiguous", content: "original" }, signal, (event) => events.push(event));
  assert.equal(calls, 0); assert.equal(classify, 1); assert.deepEqual((await group.snapshot()).turns, []);
  assert.deepEqual(events, [{ type: "suggestion", id: "ambiguous", content: "original", targetAgentIds: settings.memberIds, reason: "请选择" }, { type: "settled" }]);
  await group.send({ id: "confirmed", content: "original", targetAgentId: "sms-internal" }, signal, () => {});
  assert.equal(calls, 1); assert.equal(classify, 1);
  const pending = group.send({ id: "planning", content: "wait" }, signal, () => {});
  const rejected = assert.rejects(pending);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(group.send({ id: "concurrent", content: "original" }, signal, () => {}), /busy/);
  assert.equal(group.stop("other"), false); assert.equal(group.stop("planning"), true); await rejected;
  assert.equal(group.busy(), false); assert.equal(calls, 1);
  const closing = group.send({ id: "closing", content: "wait" }, signal, () => {}); const closed = assert.rejects(closing);
  await new Promise((resolve) => setTimeout(resolve, 10)); await group.close(); await closed;
  await assert.rejects(group.send({ id: "late", content: "original" }, signal, () => {}), /closing/);
});
