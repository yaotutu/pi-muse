import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createConfig } from "../../src/config/load-config.js";
import { createDataLayout, ensureLayout } from "../../src/adapters/storage/data-layout.js";
import {
  isContentRejectedError,
  runStructuredSubagent,
  runSubagent,
  type SubagentRuntimeDeps,
} from "../../src/adapters/pi/subagent-runner.js";
import { createFakeModel } from "../support/fake-model.js";
import { createService, enableBuiltinSkills } from "../support/test-service.js";

const createRunnerDeps = async (t: TestContext, baseUrl: string): Promise<SubagentRuntimeDeps> => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-subagent-runner-"));
  const layout = createDataLayout(dir);
  await ensureLayout(layout);
  const config = createConfig({
    server: { host: "127.0.0.1" },
    model: { baseUrl, id: "test-model", apiKey: "test-key" },
    runtime: { dataDir: dir, runTimeoutMs: 5000 },
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: layout.piAuthFile,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("personal", {
    baseUrl,
    api: "openai-completions",
    models: [
      {
        id: config.modelId!,
        name: config.modelId!,
        reasoning: false,
        input: ["text", "image"],
        contextWindow: config.contextWindow,
        maxTokens: config.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
        },
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey("personal", "test-key");
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return { config, layout, modelRuntime };
};

const createScriptedSseServer = async (
  t: TestContext,
  handler: (input: {
    messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
    tools?: Array<{ function?: { name?: string } }>;
  }) =>
    | { type: "tool"; name: string; args: Record<string, unknown> }
    | { type: "text"; text: string },
) => {
  let callSeq = 0;
  const requests: Array<{
    messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
    tools?: Array<{ function?: { name?: string } }>;
  }> = [];
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body) as (typeof requests)[number];
    requests.push(input);
    const decision = handler(input);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: object, finish_reason: string | null = null) =>
      res.write(
        "data: " +
          JSON.stringify({
            id: "chatcmpl-local",
            object: "chat.completion.chunk",
            created: 1,
            model: "test-model",
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          "\n\n",
      );
    send({ role: "assistant" });
    if (decision.type === "tool") {
      send({
        tool_calls: [
          {
            index: 0,
            id: `call_local_${++callSeq}`,
            type: "function",
            function: { name: decision.name, arguments: JSON.stringify(decision.args) },
          },
        ],
      });
      send({}, "tool_calls");
    } else {
      send({ content: decision.text });
      send({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
  };
};

test("isContentRejectedError distinguishes upstream content moderation from transient failures", () => {
  const positives = [
    '{"error":{"message":"[422]: {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"unprocessable_entity_error\\",\\"message\\":\\"input new_sensitive (1026)\\",\\"http_code\\":\\"422\\"}}","type":"invalid_request_error"}}',
    "400 content_filter: The response was filtered due to the prompt triggering Azure OpenAI's content management policy",
    "DataInspectionFailed: Input text data may contain inappropriate content",
    "1301 content_exists_risk",
    "Provider stopped with: sensitive",
    "output new_sensitive (1027)",
    "request blocked by moderation_blocked policy",
    "The model refused to complete the request",
  ];
  for (const raw of positives) {
    assert.equal(isContentRejectedError(raw), true, `should classify as content rejection: ${raw}`);
  }
  const negatives = [
    "401 invalid_api_key",
    "429 rate_limit_exceeded, too many requests",
    "503 Service Unavailable",
    "maximum context length exceeded",
    "context_length_exceeded",
    "request timeout after 30000ms",
    "fetch failed: econnrefused",
    "insufficient_quota",
    undefined,
    "",
  ];
  for (const raw of negatives) {
    assert.equal(isContentRejectedError(raw), false, `should NOT classify as content rejection: ${String(raw)}`);
  }
});

test("runStructuredSubagent classifies upstream HTTP 422 content moderation as MODEL_CONTENT_REJECTED", async (t) => {
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    for await (const _chunk of req) { /* drain */ }
    res
      .writeHead(422, { "content-type": "application/json" })
      .end(
        JSON.stringify({
          error: {
            message:
              '[422]: {"type":"error","error":{"type":"unprocessable_entity_error","message":"input new_sensitive (1026)","http_code":"422"}}',
            type: "invalid_request_error",
            code: "",
          },
        }),
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  const deps = await createRunnerDeps(t, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
  const buildSubmitTool = (onSubmitted: (value: { answer: string }) => void) =>
    defineTool({
      name: "submit_structured",
      label: "Submit structured",
      description: "Submit structured result once",
      parameters: Type.Object({ answer: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      execute: async (_id, params) => {
        onSubmitted(params);
        return { content: [{ type: "text", text: "accepted" }], details: undefined };
      },
    });

  const outcome = await runStructuredSubagent<{ answer: string }>(deps, {
    systemPrompt: "sys",
    prompt: "poison input",
    buildSubmitTool,
    validateSubmitted: () => undefined,
    trace: { sessionId: "main", kind: "subagent" },
  });
  assert.deepEqual(outcome, { ok: false, error: "MODEL_CONTENT_REJECTED" });
});

test("runSubagent is deny-by-default and creates no session files", async (t) => {
  const model = await createFakeModel();
  t.after(() => model.close());
  const deps = await createRunnerDeps(t, model.baseUrl);

  const outcome = await runSubagent(deps, {
    systemPrompt: "Clean isolated helper.",
    prompt: "hello isolated",
    trace: { sessionId: "main", kind: "subagent" },
  });

  assert.equal(outcome.ok, true);
  assert.match(outcome.text, /reply: hello isolated/);
  assert.equal(model.requests.length, 1);
  assert.deepEqual(model.requests[0]?.tools ?? [], []);
  assert.deepEqual(await readdir(deps.layout.sessionsDir), []);
});

test("runSubagent hard-blocks bash and recursive subagent tools before contacting model", async (t) => {
  const model = await createFakeModel();
  t.after(() => model.close());
  const deps = await createRunnerDeps(t, model.baseUrl);

  const dummyTool = (name: string) =>
    defineTool({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
    });

  await assert.rejects(
    () =>
      runSubagent(deps, {
        systemPrompt: "sys",
        prompt: "p",
        tools: [dummyTool("bash")],
        trace: { sessionId: "main", kind: "subagent" },
      }),
    /forbidden tool: bash/,
  );

  await assert.rejects(
    () =>
      runSubagent(deps, {
        systemPrompt: "sys",
        prompt: "p",
        allowedToolNames: ["subagent"],
        trace: { sessionId: "main", kind: "subagent" },
      }),
    /forbidden tool: subagent/,
  );

  await assert.rejects(
    () =>
      runSubagent(deps, {
        systemPrompt: "sys",
        prompt: "p",
        extensions: {
          extensions: [
            {
              path: "/tmp/ext.ts",
              tools: new Map([["bash", {} as never]]),
            } as never,
          ],
          errors: [],
          runtime: {} as never,
        },
        trace: { sessionId: "main", kind: "subagent" },
      }),
    /forbidden tool: bash/,
  );

  assert.equal(model.requests.length, 0);
});

test("runSubagent isolates 5 concurrent invocations without prompt or output cross-talk", async (t) => {
  const model = await createFakeModel();
  t.after(() => model.close());
  const deps = await createRunnerDeps(t, model.baseUrl);

  const outcomes = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      runSubagent(deps, {
        systemPrompt: `SYSTEM-MARKER-${index}`,
        prompt: `task-payload-${index}`,
        trace: { sessionId: "main", kind: "subagent", extra: { worker: String(index) } },
      }),
    ),
  );

  assert.equal(outcomes.length, 5);
  outcomes.forEach((outcome, index) => {
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, new RegExp(`reply: task-payload-${index}`));
  });
  assert.equal(model.requests.length, 5);
  for (let index = 0; index < 5; index++) {
    const matched = model.requests.find((req) => {
      const serialized = JSON.stringify(req.messages);
      return serialized.includes(`SYSTEM-MARKER-${index}`) && serialized.includes(`task-payload-${index}`);
    });
    assert.ok(matched, `missing request for invocation ${index}`);
    const serialized = JSON.stringify(matched.messages);
    for (let other = 0; other < 5; other++) {
      if (other === index) continue;
      assert.equal(serialized.includes(`SYSTEM-MARKER-${other}`), false);
      assert.equal(serialized.includes(`task-payload-${other}`), false);
    }
  }
});

test("runStructuredSubagent composes read-only extraTools with single structured submission and enforces errors", async (t) => {
  let mode: "extra_then_submit" | "no_submit" | "duplicate_submit" = "extra_then_submit";
  const server = await createScriptedSseServer(t, (input) => {
    const toolResults = input.messages.filter((m) => m.role === "tool");
    if (mode === "extra_then_submit") {
      if (toolResults.length === 0) return { type: "tool", name: "lookup_fact", args: { key: "alpha" } };
      if (toolResults.length === 1) return { type: "tool", name: "submit_structured", args: { answer: "fact:alpha" } };
      return { type: "text", text: "done" };
    }
    if (mode === "no_submit") {
      return { type: "text", text: "plain text without tool call" };
    }
    if (toolResults.length < 2) {
      return { type: "tool", name: "submit_structured", args: { answer: `dup-${toolResults.length}` } };
    }
    return { type: "text", text: "done" };
  });

  const deps = await createRunnerDeps(t, server.baseUrl);
  let lookupCalls = 0;
  const lookupTool = defineTool({
    name: "lookup_fact",
    label: "Lookup fact",
    description: "Read-only lookup helper",
    parameters: Type.Object({ key: Type.String() }, { additionalProperties: false }),
    execute: async (_id, params) => {
      lookupCalls++;
      return { content: [{ type: "text", text: `fact:${params.key}` }], details: undefined };
    },
  });
  const buildSubmitTool = (onSubmitted: (value: { answer: string }) => void) =>
    defineTool({
      name: "submit_structured",
      label: "Submit structured",
      description: "Submit structured result once",
      parameters: Type.Object({ answer: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      execute: async (_id, params) => {
        onSubmitted(params);
        return { content: [{ type: "text", text: "accepted" }], details: undefined };
      },
    });

  // 1. 先查只读 extraTool，再一次性结构化提交
  const okOutcome = await runStructuredSubagent<{ answer: string }>(deps, {
    systemPrompt: "sys",
    prompt: "lookup and submit",
    extraTools: [lookupTool],
    buildSubmitTool,
    validateSubmitted: (value) => {
      if (!value.answer.startsWith("fact:")) throw new Error("bad answer");
    },
    trace: { sessionId: "main", kind: "subagent" },
  });
  assert.deepEqual(okOutcome, { ok: true, value: { answer: "fact:alpha" } });
  assert.equal(lookupCalls, 1);
  const declaredToolNames = (server.requests[0]?.tools ?? [])
    .map((tool) => tool.function?.name)
    .sort();
  assert.deepEqual(declaredToolNames, ["lookup_fact", "submit_structured"]);

  // 2. 未调用提交工具 -> MODEL_REQUEST_FAILED
  mode = "no_submit";
  const missingOutcome = await runStructuredSubagent<{ answer: string }>(deps, {
    systemPrompt: "sys",
    prompt: "no submit",
    buildSubmitTool,
    validateSubmitted: () => undefined,
    trace: { sessionId: "main", kind: "subagent" },
  });
  assert.deepEqual(missingOutcome, { ok: false, error: "MODEL_REQUEST_FAILED" });

  // 3. 重复提交 -> INVALID_MODEL_RESULT
  mode = "duplicate_submit";
  const duplicateOutcome = await runStructuredSubagent<{ answer: string }>(deps, {
    systemPrompt: "sys",
    prompt: "dup submit",
    buildSubmitTool,
    validateSubmitted: () => undefined,
    trace: { sessionId: "main", kind: "subagent" },
  });
  assert.deepEqual(duplicateOutcome, { ok: false, error: "INVALID_MODEL_RESULT" });

  // 4. 预取消 signal -> CANCELLED（不发模型请求）
  const beforeRequests = server.requests.length;
  const aborted = new AbortController();
  aborted.abort();
  const cancelledOutcome = await runStructuredSubagent<{ answer: string }>(deps, {
    systemPrompt: "sys",
    prompt: "cancelled",
    buildSubmitTool,
    validateSubmitted: () => undefined,
    signal: aborted.signal,
    trace: { sessionId: "main", kind: "subagent" },
  });
  assert.deepEqual(cancelledOutcome, { ok: false, error: "CANCELLED" });
  assert.equal(server.requests.length, beforeRequests);
});

test("chat subagent isolates exclusive browser agent from parallel mode while allowing single mode", async (t) => {
  const model = await createFakeModel();
  t.after(() => model.close());
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-subagent-browser-"));
  const config = createConfig({
    server: { host: "127.0.0.1" },
    model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "fake-key" },
    runtime: { dataDir, runTimeoutMs: 5000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
  });
  const service = await createService(config);
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const token = service.auth.login()!;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const runTurn = async (text: string) => {
    const conv = await service.app.request("/api/conversation?sessionId=main", { headers });
    const { revision } = (await conv.json()) as { revision: string };
    const res = await service.app.request("/api/conversation/run", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: "main",
        runId: randomUUID(),
        expectedRevision: revision,
        message: { id: randomUUID(), content: text },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /RUN_FINISHED/);
    return body;
  };

  await runTurn("E2E browser single");
  const singleChildReq = model.requests.find((req) =>
    JSON.stringify(req.messages).includes("Task: E2E clock single"),
  );
  assert.ok(singleChildReq, "single browser subagent child request must exist");
  const singleTools = new Set(
    (singleChildReq.tools ?? []).map((tool) => (tool as { function: { name: string } }).function.name),
  );
  assert.equal(singleTools.has("browser"), true, "browser subagent in single mode must have browser tool");
  assert.equal(singleTools.has("currentTime"), true);
  assert.equal(singleTools.has("read"), true);
  assert.equal(singleTools.has("grep"), true);
  assert.equal(singleTools.has("write"), false);

  const parallelBefore = model.requests.length;
  const parallelBody = await runTurn("E2E browser parallel");
  assert.match(parallelBody, /cannot run in parallel mode/);
  // 独占 browser 在 parallel 模式下被直接拒绝，不会启动 browser 子会话
  const browserParallelChild = model.requests.slice(parallelBefore).find((req) =>
    JSON.stringify(req.messages).includes("Task: E2E clock A"),
  );
  assert.equal(browserParallelChild, undefined);

  await runTurn("E2E parallel");
  const parallelChildA = model.requests.find((req) =>
    JSON.stringify(req.messages).includes("Task: E2E clock A"),
  );
  const parallelChildB = model.requests.find((req) =>
    JSON.stringify(req.messages).includes("Task: E2E clock B"),
  );
  assert.ok(parallelChildA && parallelChildB, "parallel sms/news subagent child requests must exist");
  const smsTools = new Set((parallelChildA.tools ?? []).map((tool) => (tool as { function: { name: string } }).function.name));
  const newsTools = new Set((parallelChildB.tools ?? []).map((tool) => (tool as { function: { name: string } }).function.name));
  assert.equal(smsTools.has("sms_query"), true);
  assert.equal(smsTools.has("browser"), false);
  assert.equal(newsTools.has("news_query"), true);
  assert.equal(newsTools.has("browser"), false);
});
