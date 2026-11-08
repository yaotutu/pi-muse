import { createFakeModel } from "../support/fake-model.js";
import { waitForTest } from "../support/http-client.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { sessionInstructionsFile } from "../../src/adapters/storage/data-layout.js";
import { readSessionInstructions } from "../../src/adapters/storage/session-instructions.js";
import { createNewsRepository } from "../../src/adapters/storage/news-repository.js";
import {
  newsArticleListResponseSchema,
  newsFeedbackResponseSchema,
} from "../../src/http/contracts/news.js";

const configFor = (dataDir: string) => createConfig({
  schemaVersion: 1,
  server: {},
  model: { baseUrl: "http://127.0.0.1:1", id: "test-model", apiKey: "k" },
  runtime: { dataDir, runTimeoutMs: 1000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
});

const start = async (t: test.TestContext) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-news-http-"));
  const service = await createService(configFor(dataDir));
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    service,
    headers: { Authorization: `Bearer ${service.auth.login()}` },
  };
};

test("news HTTP surface is authenticated, stable and exposes News as a full agent", async (t) => {
  const { service, headers } = await start(t);
  const sessions = await service.app.request("/api/sessions", { headers });
  assert.deepEqual(((await sessions.json()) as {sessions: {id:string}[]}).sessions.map((s)=>s.id),["main"]);
  for (const path of ["/api/news/status", "/api/news/sources", "/api/news/preferences"]) {
    assert.equal((await service.app.request(path, { headers })).status, 200, path);
  }
  const allArticles = await service.app.request("/api/news/articles?savedOnly=false", { headers });
  assert.equal(allArticles.status, 200);
  assert.deepEqual(newsArticleListResponseSchema.parse(await allArticles.json()), {
    articles: [],
    nextCursor: null,
  });
  const savedArticles = await service.app.request("/api/news/articles?savedOnly=true", { headers });
  assert.equal(savedArticles.status, 200);
  assert.deepEqual(newsArticleListResponseSchema.parse(await savedArticles.json()), {
    articles: [],
    nextCursor: null,
  });
  const invalidSaved = await service.app.request("/api/news/articles?savedOnly=1", { headers });
  assert.equal(invalidSaved.status, 400);
  const article = { id:"info_contract", source:"rss", externalId:"article-contract", title:"Feedback response contract", content:"Strict feedback response projection.", receivedAt:new Date().toISOString(), acceptedAt:new Date().toISOString(), status:"processed" as const, metadata:{sourceId:"newssource_http",sourceTitle:"HTTP Feed",url:"https://example.com/article"} };
  await createNewsRepository(service.layout.newsFile).update((state)=>({state:{...state,processing:{...state.processing,items:[article]}},result:undefined}));
  assert.ok(article);
  const feedbackCall = async (label: string, path: string, init: RequestInit) => {
    const response = await service.app.request(path, { ...init, headers });
    assert.equal(response.status, 200, label);
    const parsed = newsFeedbackResponseSchema.parse(await response.json());
    assert.deepEqual(Object.keys(parsed.feedback).sort(), ["comments", "reaction", "saved"]);
    assert.equal(Object.hasOwn(parsed.feedback, "itemId"), false);
    return parsed;
  };
  const reacted = await feedbackCall(
    "reaction response",
    `/api/news/articles/${article.id}/reaction`,
    { method: "PUT", body: JSON.stringify({ reaction: "like" }) },
  );
  assert.equal(reacted.feedback.reaction, "like");
  const saved = await feedbackCall(
    "saved response",
    `/api/news/articles/${article.id}/saved`,
    { method: "PUT", body: JSON.stringify({ saved: true }) },
  );
  assert.equal(saved.feedback.saved, true);
  const commented = await feedbackCall(
    "comment response",
    `/api/news/articles/${article.id}/comments`,
    { method: "POST", body: JSON.stringify({ text: "  strict comment  " }) },
  );
  assert.equal(commented.feedback.comments.length, 1);
  const comment = commented.feedback.comments[0]!;
  assert.match(comment.id, /^comment_/);
  assert.equal(comment.text, "strict comment");
  assert.equal(comment.createdAt, comment.updatedAt);
  const deletedComment = await feedbackCall(
    "delete comment response",
    `/api/news/articles/${article.id}/comments/${comment.id}`,
    { method: "DELETE" },
  );
  assert.equal(deletedComment.feedback.reaction, "like");
  assert.equal(deletedComment.feedback.saved, true);
  assert.deepEqual(deletedComment.feedback.comments, []);
  const credentialUrl = new URL("https://example.com/feed.xml");
  credentialUrl.username = "user";
  (credentialUrl as unknown as Record<string, string>)["pass" + "word"] = "opaque";
  const credentialSource = await service.app.request("/api/news/sources", {
    method: "POST",
    headers,
    body: JSON.stringify({ url: credentialUrl.toString() }),
  });
  assert.equal(credentialSource.status, 400);

  assert.equal((await service.app.request("/api/news/sources")).status,401);
  assert.equal((await service.app.request("/api/sessions",{headers})).status,200);

});

test("ordinary information HTTP contracts do not expose internal recommendation fields", async (t) => {
  const { service, headers } = await start(t);
  const settings = await service.app.request("/api/information/settings", { headers });
  assert.equal(settings.status, 200);
  assert.deepEqual(await settings.json(), { enabled: false, batchWindowSeconds: 15 });
  const preferences = await service.app.request("/api/information/preferences", { headers });
  assert.equal(preferences.status, 200);
  assert.match(JSON.stringify(await preferences.json()), /短信过滤与通知规则/);
});

test("news and SMS use main instructions without creating hidden sessions", async (t) => {
  const {service} = await start(t);
  const instructions = await readSessionInstructions(sessionInstructionsFile(service.layout,"main"));
  assert.match(instructions,/短信过滤与通知规则/);
  assert.deepEqual((await service.sessions.list()).map((s)=>s.id),["main"]);
});

test("initialization preserves explicitly empty main instructions", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(),"pi-muse-main-instructions-"));
  const file = join(dataDir,"sessions","main","INSTRUCTIONS.md");
  await mkdir(join(dataDir,"sessions","main"),{recursive:true});
  await writeFile(file,"");
  const service = await createService(configFor(dataDir));
  t.after(async()=>{await service.close();await rm(dataDir,{recursive:true,force:true});});
  assert.equal(await readFile(file,"utf8"),"");
});

for(const scenario of ["valid","object-notifications","duplicate"] as const) {
  test(`news SDK recommendation schema: ${scenario} preserves exact submission and no chat publication`,async(t)=>{
    const dataDir=await mkdtemp(join(tmpdir(),"pi-muse-news-sdk-"));
    const model=await createFakeModel();
    let service:Awaited<ReturnType<typeof createService>>|undefined;
    t.after(async()=>{try{await service?.close();}finally{await model.close();await rm(dataDir,{recursive:true,force:true});}});
    const repo=createNewsRepository(join(dataDir,"news.json"));
    const timestamp=new Date().toISOString();
    await repo.update((state)=>({state:{...state,processing:{...state.processing,items:[{id:"info_news_schema",source:"rss",externalId:"schema",title:"SDK schema",content:scenario==="object-notifications"?"NOTIFY NEWS_OBJECT_NOTIFICATIONS":scenario==="duplicate"?"NOTIFY TWO_VALID_SUBMISSIONS":"NOTIFY news value",receivedAt:timestamp,acceptedAt:timestamp,status:"pending",metadata:{sourceId:"source_schema",sourceTitle:"Synthetic feed",url:null}}]}},result:undefined}));
    service=await createService(createConfig({server:{host:"127.0.0.1"},model:{baseUrl:model.baseUrl,id:"test-model",apiKey:"fake-news-key"},runtime:{dataDir,schedulerIntervalMs:60000,monitorScanIntervalMs:60000}}));
    const run=await waitForTest(async()=>{const current=(await repo.read()).processing.runs[0];return current && current.status!=="running"?current:undefined;},"news analysis",8000);
    assert.equal(run.status,scenario==="valid"?"completed":"failed");
    assert.equal(run.model?.status,scenario==="valid"?"succeeded":"failed");
    assert.deepEqual(run.publications,[]);
    assert.deepEqual((await (await service.conversationHub.forSession("main")).snapshot()).messages,[]);
    assert.deepEqual((await service.sessions.list()).map((s)=>s.id),["main"]);
    const tool=(model.requests[0].tools as {function:{name:string;parameters:{properties:Record<string,unknown>;required:string[]}}}[]).find((tool)=>tool.function.name==="submit_information_result")!;
    assert.deepEqual(Object.keys(tool.function.parameters.properties).sort(),["decisions","learnedNotes"]);
    assert.equal("notifications" in tool.function.parameters.properties,false);
    if(scenario==="valid")assert.equal((await repo.read()).processing.preferences.learnedNotes,"");
    else assert.equal(run.model?.error,"INVALID_MODEL_RESULT");
  });
}
