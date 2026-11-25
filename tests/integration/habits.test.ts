import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createConfig } from "../../src/config/load-config.js";
import { habitDomainOverviewResponse, habitItemResponse } from "../../src/http/contracts/habits.js";
import { informationPreferencesResponse } from "../../src/http/contracts/information.js";
import { newsPreferencesResponseSchema } from "../../src/http/contracts/news.js";
import { createFakeModel, type ModelRequest } from "../support/fake-model.js";
import { waitForTest } from "../support/http-client.js";
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
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-habits-int-"));
  const model = await createFakeModel();
  const service = await createService(
    createConfig({
      schemaVersion: 1,
      server: { host: "127.0.0.1" },
      model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "fake-habit-key" },
      runtime: { dataDir, runTimeoutMs: 10_000, schedulerIntervalMs: 60_000, monitorScanIntervalMs: 60_000 },
    }),
  );
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
  return { api, dataDir, model, service };
};

test("habits HTTP CRUD, validation, and model consolidation failure preservation across SMS & News", async (t) => {
  const h = await fixture(t);

  // Unknown & invalid domain errors
  assert.equal((await h.api("/api/habits/Invalid!")).status, 400);
  assert.equal((await h.api("/api/habits/unknown_domain")).status, 404);
  assert.equal((await h.api("/api/habits/sms/consolidate", "POST", { extra: 1 })).status, 400);
  assert.equal((await h.api("/api/habits/sms", "POST", { text: "   " })).status, 400);

  // Manual CRUD on sms
  const initialOverview = habitDomainOverviewResponse.parse((await h.api("/api/habits/sms")).body);
  assert.equal(initialOverview.habits.length, 0);
  assert.equal(initialOverview.unconsolidatedCount, 0);

  const createdRes = await h.api("/api/habits/sms", "POST", { text: "银行信用卡还款提醒不能静默" });
  assert.equal(createdRes.status, 200);
  const created = habitItemResponse.parse(createdRes.body).habit;
  assert.equal(created.source, "manual");

  const updatedRes = await h.api(`/api/habits/sms/${created.id}`, "PATCH", { text: "所有银行信用卡与房贷还款必须提醒" });
  assert.equal(updatedRes.status, 200);
  assert.equal(habitItemResponse.parse(updatedRes.body).habit.text, "所有银行信用卡与房贷还款必须提醒");

  // Missing habit returns 404
  assert.equal((await h.api("/api/habits/sms/hab_nonexistent", "DELETE")).status, 404);

  // SMS notification + dislike/comment -> hot buffer -> failure preserves -> consolidate moves to Consolidated User Habits
  await h.api("/api/information/settings", "PUT", { enabled: true, batchWindowSeconds: 3600 });
  await h.api("/api/information/items", "POST", {
    items: [{ source: "sms", externalId: "sms-fb-1", content: "NOTIFY 某品牌会员积分过期推广" }],
  });
  const firstRun = (await h.api("/api/information/runs", "POST", {})).body as {
    run: { publications: Array<{ receipt?: { piSessionId: string; messageId: string } }> };
  };
  const receipt = firstRun.run.publications[0]!.receipt!;

  await h.api(`/api/sessions/main/messages/${encodeURIComponent(receipt.messageId)}/feedback/reaction`, "PUT", {
    piSessionId: receipt.piSessionId,
    reaction: "dislike",
  });
  await h.api(`/api/sessions/main/messages/${encodeURIComponent(receipt.messageId)}/feedback/comments`, "POST", {
    piSessionId: receipt.piSessionId,
    text: "HABIT_FAIL 暂时测试失败",
  });

  // Hot buffer immediately reflects unconsolidated feedback in preferences and overview
  const smsPrefsBefore = informationPreferencesResponse.parse((await h.api("/api/information/preferences")).body);
  assert.equal(smsPrefsBefore.unconsolidatedFeedbackCount, 1);
  assert.equal(smsPrefsBefore.habits.length, 1);
  const domainsList = (await h.api("/api/habits")).body as { domains: Array<{ domain: string; name: string; unconsolidatedCount: number }> };
  assert.ok(domainsList.domains.some((entry) => entry.domain === "sms" && entry.unconsolidatedCount === 1));
  const smsHabitOverview = (await h.api("/api/habits/sms")).body as { name: string; summary: string; pendingSignals: Array<{ comments: string[]; reaction: string | null; saved: boolean }> };
  assert.equal(smsHabitOverview.name, "短信助手");
  assert.ok(smsHabitOverview.summary.length > 0);
  assert.equal(smsHabitOverview.pendingSignals.length, 1);

  // Failing model consolidation MUST preserve hot buffer (cursorSeq=0, unconsolidatedCount=1)
  const failedConsol = habitDomainOverviewResponse.parse(
    (await h.api("/api/habits/sms/consolidate", "POST", {})).body,
  );
  assert.equal(failedConsol.lastRunStatus, "failed");
  assert.equal(failedConsol.cursorSeq, 0);
  assert.equal(failedConsol.unconsolidatedCount, 1);

  // Replace failing comment with clean directive and consolidate
  const comments = (await h.api(`/api/sessions/main/messages/${encodeURIComponent(receipt.messageId)}/feedback?piSessionId=${encodeURIComponent(receipt.piSessionId)}`)).body as {
    comments: Array<{ id: string }>;
  };
  await h.api(
    `/api/sessions/main/messages/${encodeURIComponent(receipt.messageId)}/feedback/comments/${comments.comments[0]!.id}`,
    "PATCH",
    {
      piSessionId: receipt.piSessionId,
      text: "HABIT_ADD:会员积分与品牌商城营销短信一律静默",
    },
  );

  const succeededConsol = habitDomainOverviewResponse.parse(
    (await h.api("/api/habits/sms/consolidate", "POST", {})).body,
  );
  assert.equal(succeededConsol.lastRunStatus, "succeeded");
  assert.equal(succeededConsol.unconsolidatedCount, 0);
  assert.ok(succeededConsol.cursorSeq > 0);
  assert.deepEqual(
    succeededConsol.habits.map((x) => x.text),
    ["所有银行信用卡与房贷还款必须提醒", "会员积分与品牌商城营销短信一律静默"],
  );

  // Subsequent SMS realtime run receives Consolidated User Habits in system prompt & cleared hot buffer
  const smsTraceStart = h.model.requests.length;
  await h.api("/api/information/items", "POST", {
    items: [{ source: "sms", externalId: "sms-next-1", content: "silent ordinary promo" }],
  });
  await h.api("/api/information/runs", "POST", {});
  const smsReq = h.model.requests.slice(smsTraceStart).find((req) =>
    systemPromptOf(req).includes("SMS/information decision worker"),
  );
  assert.ok(smsReq);
  assert.ok(systemPromptOf(smsReq).includes("## Consolidated User Habits"));
  assert.ok(systemPromptOf(smsReq).includes("会员积分与品牌商城营销短信一律静默"));
  assert.ok(userPromptOf(smsReq).includes("## Recent Unconsolidated Feedback\n[]"));

  // Delete manual habit
  assert.equal((await h.api(`/api/habits/sms/${created.id}`, "DELETE")).status, 200);
  assert.equal(habitDomainOverviewResponse.parse((await h.api("/api/habits/sms")).body).habits.length, 1);

  // News domain feedback -> auto-threshold consolidation after 5 distinct articles
  const now = new Date().toISOString();
  await h.service.newsRepository.update((state) => ({
    state: {
      ...state,
      processing: {
        ...state.processing,
        items: Array.from({ length: 5 }, (_, idx) => ({
          id: `news_hab_${idx}`,
          source: "newssource_1",
          externalId: `ext-hab-${idx}`,
          title: `News Title ${idx}`,
          content: `News content ${idx}`,
          receivedAt: now,
          acceptedAt: now,
          status: "processed" as const,
          metadata: { sourceId: "newssource_1", sourceTitle: "Tech Feed", url: null },
        })),
      },
    },
    result: undefined,
  }));

  for (let idx = 0; idx < 5; idx++) {
    await h.api(`/api/news/articles/news_hab_${idx}/reaction`, "PUT", { reaction: idx === 0 ? "dislike" : "like" });
    if (idx === 0) {
      await h.api(`/api/news/articles/news_hab_${idx}/comments`, "POST", {
        text: "HABIT_ADD:新闻优先精选底层架构与工程实战，跳过融资八卦",
      });
    }
  }

  const newsConsolidated = await waitForTest(async () => {
    const ov = habitDomainOverviewResponse.parse((await h.api("/api/habits/news")).body);
    return !ov.running && ov.unconsolidatedCount === 0 && ov.habits.length > 0 ? ov : undefined;
  }, "auto threshold consolidation for news", 8000);
  assert.equal(newsConsolidated.habits[0]?.text, "新闻优先精选底层架构与工程实战，跳过融资八卦");
  const newsPrefs = newsPreferencesResponseSchema.parse((await h.api("/api/news/preferences")).body);
  assert.equal(newsPrefs.habits.length, 1);
  assert.equal(newsPrefs.unconsolidatedFeedbackCount, 0);

  // Also verify unified subagent registry detail sees `habits` snapshot directly!
  const smsDetail = await h.service.subagents.getDetail("sms");
  assert.equal(smsDetail.userInstructions?.habits.length, 1);
  assert.equal(randomUUID().length > 0, true);
});
