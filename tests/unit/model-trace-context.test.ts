import assert from "node:assert/strict";
import { test } from "node:test";
import {
  currentModelTraceContext,
  runWithModelTrace,
  withModelTraceExecution,
} from "../../src/adapters/model-trace/context.js";
import type { ConversationExecution } from "../../src/features/conversation/ports.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("model trace context is visible inside run and absent outside", async () => {
  assert.equal(currentModelTraceContext(), undefined);
  await runWithModelTrace({ agentId: "local-main", kind: "chat", extra: { runId: "run-1" } }, async () => {
    assert.deepEqual(currentModelTraceContext(), {
      agentId: "local-main",
      kind: "chat",
      extra: { runId: "run-1" },
    });
    await sleep(5);
    assert.equal(currentModelTraceContext()?.agentId, "local-main");
  });
  assert.equal(currentModelTraceContext(), undefined);
});

test("nested runs override for inner work (subagent inside chat) without leaking outward", async () => {
  await runWithModelTrace({ agentId: "local-main", kind: "chat" }, async () => {
    assert.equal(currentModelTraceContext()?.kind, "chat");
    await runWithModelTrace({ agentId: "subagent-1", kind: "subagent" }, async () => {
      assert.deepEqual(
        [currentModelTraceContext()?.agentId, currentModelTraceContext()?.kind],
        ["subagent-1", "subagent"],
      );
    });
    assert.deepEqual(
      [currentModelTraceContext()?.agentId, currentModelTraceContext()?.kind],
      ["local-main", "chat"],
    );
  });
});

test("concurrent rounds keep their own agentId across awaited interleavings", async () => {
  const seen: string[] = [];
  const round = async (agentId: string) => {
    await runWithModelTrace({ agentId, kind: "chat" }, async () => {
      await sleep(agentId === "agent-a" ? 10 : 1);
      // 在对方已进入各自上下文后再读，验证 AsyncLocalStorage 不串号。
      seen.push(`${agentId}:${currentModelTraceContext()?.agentId}`);
      await sleep(agentId === "agent-a" ? 1 : 10);
      seen.push(`${agentId}:${currentModelTraceContext()?.agentId}`);
    });
  };
  await Promise.all([round("agent-a"), round("agent-b")]);
  assert.deepEqual(seen.sort(), [
    "agent-a:agent-a",
    "agent-a:agent-a",
    "agent-b:agent-b",
    "agent-b:agent-b",
  ]);
});

test("withModelTraceExecution labels model-driving methods and preserves the rest", async () => {
  const calls: string[] = [];
  const execution: ConversationExecution = {
    prompt: async () => {
      calls.push(`prompt:${currentModelTraceContext()?.agentId}:${currentModelTraceContext()?.kind}`);
    },
    waitForIdle: async () => {
      calls.push(`idle:${currentModelTraceContext()?.agentId}`);
    },
    abort: async () => {
      calls.push("abort");
    },
    dispose: () => {
      calls.push("dispose");
    },
    syncContext: () => {
      calls.push("sync");
    },
    compactIfNeeded: async () => {
      calls.push(`compact:${currentModelTraceContext()?.kind}`);
      return false;
    },
    subscribe: () => () => {
      calls.push("unsubscribe");
    },
  };
  const wrapped = withModelTraceExecution(execution, { agentId: "news-internal", kind: "chat" });
  await wrapped.prompt("hello");
  await wrapped.waitForIdle();
  await wrapped.compactIfNeeded?.();
  await wrapped.abort();
  wrapped.syncContext();
  wrapped.dispose();
  assert.deepEqual(calls, [
    "prompt:news-internal:chat",
    "idle:news-internal",
    "compact:chat",
    "abort",
    "sync",
    "dispose",
  ]);
  // 包装对象仍是普通执行适配：订阅与非模型方法原样可用。
  const unsubscribe = wrapped.subscribe(() => undefined);
  assert.equal(typeof unsubscribe, "function");
});
