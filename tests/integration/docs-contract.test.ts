import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../support/test-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createFakeModel } from "../support/fake-model.js";
import { buildOpenApiDocument } from "../../src/http/openapi.js";
import { endpoints } from "../../src/http/contracts/endpoints.js";
import { serviceVersion } from "../../src/bootstrap/service-version.js";
import { healthResponse } from "../../src/http/contracts/responses.js";

/**
 * 文档防漂移契约测试：
 * 1) 生成的 OpenAPI 文档结构完整（每端点有 summary/200 响应 schema）。
 * 2) 免鉴权文档端点（/openapi.json、/docs）真实可达。
 * 3) 无副作用的 GET 端点真实响应能被注册表响应 schema safeParse——
 *    实现改了 schema 没跟（或反之），这里立刻红。
 */

const RUN_STEP_KINDS = ["tool", "subagent", "approval", "file_commit"];
const RUN_STEP_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "denied",
  "expired",
  "cancelled",
];
const RUN_STEP_FIELDS = [
  "id",
  "parentId",
  "kind",
  "title",
  "detail",
  "status",
  "result",
  "toolName",
  "approvalId",
  "startedAt",
  "endedAt",
];

type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
};

type OpenApiOperation = {
  summary?: string;
  description?: string;
  tags?: string[];
  security?: unknown[];
  parameters?: { name: string; in: string; required: boolean; description?: string; schema: JsonSchema }[];
  responses: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: JsonSchema }>;
      headers?: Record<string, { description?: string; schema?: JsonSchema }>;
      "x-sse-events"?: Record<string, unknown>;
    }
  >;
};

const runOperations = () => {
  const doc = buildOpenApiDocument();
  const paths = doc.paths as unknown as Record<string, Record<string, OpenApiOperation>>;
  const list = paths["/api/runs"]?.get;
  const status = paths["/api/runs/status"]?.get;
  assert.ok(list, "generated OpenAPI must include GET /api/runs");
  assert.ok(status, "generated OpenAPI must include GET /api/runs/status");
  return { doc, paths, list, status };
};

const responseSchema = (operation: OpenApiOperation): JsonSchema => {
  const schema = operation.responses["200"]?.content?.["application/json"]?.schema;
  assert.ok(schema, "200 response must expose an application/json schema");
  return schema;
};

const queryParameter = (operation: OpenApiOperation, name: string) => {
  const parameter = operation.parameters?.find((item) => item.name === name);
  assert.ok(parameter, `missing query parameter ${name}`);
  return parameter;
};

/**
 * 可空字段在 JSON Schema 中有两种等价写法：`type: ["string","null"]`（zod nullable）
 * 或 `anyOf: [{type:"string"}, {type:"null"}]`（zod optional+nullable 等组合）。
 * 统一归一成排序后的类型集合，测试只关心“确实允许 null”，不锁定生成器的具体写法。
 */
const nullableTypes = (schema: JsonSchema | undefined): string[] => {
  assert.ok(schema, "nullable schema must exist");
  const collect = (item: JsonSchema): string[] =>
    Array.isArray(item.type) ? [...item.type] : item.type ? [item.type] : (item.anyOf ?? []).flatMap(collect);
  return collect(schema).sort();
};

test("docs: generated OpenAPI document is structurally complete", () => {
  const doc = buildOpenApiDocument();
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.title, "pi-muse API");
  for (const endpoint of endpoints) {
    const path = endpoint.path.replace(/:([a-zA-Z]+)/g, "{$1}");
    const operation = (doc.paths as Record<string, Record<string, {
      summary?: string;
      operationId?: string;
      description?: string;
      parameters?: { name: string; in: string; description?: string }[];
      responses?: Record<string, unknown>;
    }>>)[path]?.[endpoint.method];
    assert.ok(operation, `${endpoint.method} ${path} missing in generated doc`);
    assert.ok(operation.summary, `${path} has no summary`);
    assert.ok(operation.operationId, `${path} has no operationId`);
    assert.ok(
      typeof operation.description === "string" && operation.description.trim().length > 0,
      `${endpoint.method} ${path} has no description (hint is required for frontend clarity)`,
    );
    if (operation.parameters) {
      for (const param of operation.parameters as { name: string; in: string; description?: string }[]) {
        assert.ok(
          typeof param.description === "string" && param.description.trim().length > 0,
          `${endpoint.method} ${path} parameter "${param.name}" (in: ${param.in}) has no description`,
        );
      }
    }
    const expectedStatus = String(endpoint.successStatus ?? 200);
    const successResp = operation.responses?.[expectedStatus];
    assert.ok(successResp, `${path} has no ${expectedStatus} response`);
    if (endpoint.successStatus === 303) {
      const respObj = successResp as { content?: unknown; headers?: Record<string, unknown> };
      assert.equal(respObj.content, undefined, `${path} 303 response must have no content body`);
      assert.ok(respObj.headers?.location, `${path} 303 response must declare Location header`);
      assert.ok(respObj.headers?.["set-cookie"], `${path} 303 response must declare set-cookie header`);
    } else if (!endpoint.sse) {
      const contentType = endpoint.responseContentType ?? "application/json";
      const schema = (successResp as { content?: Record<string, { schema?: unknown }> }).content?.[contentType]?.schema;
      assert.ok(schema, `${path} ${expectedStatus} response has no JSON schema`);
    } else {
      assert.ok((successResp as Record<string, unknown>)["x-sse-events"], `${path} SSE response has no event contract`);
    }
  }
});

test("docs: companions expose authenticated tagged JSON and PNG contracts", () => {
  const doc = buildOpenApiDocument();
  const paths = doc.paths as unknown as Record<string, Record<string, OpenApiOperation>>;
  const registrations = endpoints.filter((endpoint) => endpoint.path.startsWith("/api/companions"));
  assert.equal(registrations.length, 6);
  for (const endpoint of registrations) {
    const path = endpoint.path.replace(/:([a-zA-Z]+)/g, "{$1}");
    const operation = paths[path]![endpoint.method]!;
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
    assert.deepEqual(operation.tags, ["助手形象"]);
    assert.ok(operation.responses["400"]);
    assert.ok(operation.responses["404"]);
    assert.ok(operation.responses["409"]);
    assert.ok(operation.responses["413"]);
  }
  const list = paths["/api/companions"]!.get!;
  const listSchema = responseSchema(list);
  assert.deepEqual(listSchema.required, ["companions", "diagnostics"]);
  assert.deepEqual(Object.keys(listSchema.properties!.companions!.items!.properties!), ["id", "name", "description", "states", "version", "updatedAt"]);
  assert.match(list.description ?? "", /不创建目录/);
  assert.match(list.description ?? "", /diagnostics/);
  assert.match(list.description ?? "", /不新增 SSE/);
  const asset = paths["/api/companions/{packId}/assets/{state}"]!.get!;
  assert.deepEqual(Object.keys(asset.responses["200"]!.content!), ["image/png"]);
  assert.equal(asset.responses["200"]!.content!["image/png"]!.schema!.type, "string");
  // 响应头由端点声明，不是生成器按媒体类型猜测。
  assert.equal(asset.responses["200"]!.headers!.ETag!.description, "带双引号的 PNG 字节 SHA-256");
  assert.equal(asset.responses["200"]!.headers!["Cache-Control"]!.description, "private, max-age=300");
  assert.match(asset.description ?? "", /ETag/);
  assert.match(asset.description ?? "", /private, max-age=300/);
  assert.equal(asset.parameters!.find((parameter) => parameter.name === "packId")!.schema.pattern, "^[a-z0-9][a-z0-9_-]{0,63}$");
  assert.deepEqual(asset.parameters!.find((parameter) => parameter.name === "state")!.schema.enum, ["idle", "thinking", "responding", "working", "waiting-approval", "success", "error", "stopped"]);
  const upload = paths["/api/companions/{packId}/assets/{state}"]!.put!;
  for (const pattern of [/786432/, /2 MiB/, /INVALID_PNG/, /REQUEST_TOO_LARGE/, /符号链接/, /原件保留/]) assert.match(upload.description ?? "", pattern);
});

test("docs: browser file endpoints document chooser, limits, persistence and error semantics", () => {
  const doc = buildOpenApiDocument();
  const paths = doc.paths as unknown as Record<string, Record<string, OpenApiOperation>>;
  const list = paths["/api/browser/files"]?.get;
  const upload = paths["/api/browser/uploads/{uploadId}"]?.post;
  const cancelUpload = paths["/api/browser/uploads/{uploadId}"]?.delete;
  const content = paths["/api/browser/downloads/{downloadId}/content"]?.get;
  const remove = paths["/api/browser/downloads/{downloadId}"]?.delete;
  for (const operation of [list, upload, cancelUpload, content, remove]) {
    assert.ok(operation);
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
  }
  assert.match(list?.description ?? "", /filechooser/);
  assert.match(list?.description ?? "", /损坏[\s\S]*不能当作空列表/);
  assert.match(upload?.description ?? "", /内存 Base64/);
  assert.match(upload?.description ?? "", /8MiB/);
  assert.match(upload?.description ?? "", /12MiB/);
  assert.match(upload?.description ?? "", /413/);
  assert.match(upload?.description ?? "", /404/);
  assert.match(upload?.description ?? "", /400/);
  assert.match(cancelUpload?.description ?? "", /setFiles\(\[\]\)/);
  assert.match(content?.description ?? "", /409/);
  assert.match(remove?.description ?? "", /异步完成不能复活已删除记录/);
});

test("docs: run execution endpoints are read-only JSON operations and legacy /api/activities* are removed", () => {
  const { paths, list, status } = runOperations();

  for (const [path, operation] of [
    ["/api/runs", list],
    ["/api/runs/status", status],
  ] as const) {
    assert.deepEqual(operation.security, [{ bearerAuth: [] }], `${path} must require bearer auth in generated docs`);
    assert.deepEqual(operation.tags, ["执行记录"], `${path} must stay in the execution records tag`);
    assert.ok(operation.summary, `${path} must have a summary`);
    assert.deepEqual(Object.keys(operation.responses["200"]?.content ?? {}), ["application/json"], `${path} must be JSON-only`);
    assert.equal(Object.hasOwn(operation.responses["200"] ?? {}, "x-sse-events"), false, `${path} must not expose x-sse-events`);
    assert.match(operation.description ?? "", /只读/, `${path} must be documented as read-only`);
  }

  const activityPaths = Object.entries(paths).filter(
    ([path]) => path === "/api/activities" || path.startsWith("/api/activities/"),
  );
  assert.deepEqual(activityPaths, [], "legacy /api/activities endpoints must be removed");

  const workspaceEvents = paths["/api/events"]?.get?.responses["200"]?.["x-sse-events"];
  assert.deepEqual(Object.keys(workspaceEvents ?? {}).sort(), [
    "browser_updated",
    "session_presence_updated",
    "session_status_updated",
    "approval_pending",
    "approval_updated",
    "conversation_updated",
    "session_directory_updated",
    "subagent_updated",
    "ready",
  ].sort());
});

test("docs: workspace file endpoints pin explicit selectors, manual confirmation and safety limits", () => {
  const doc = buildOpenApiDocument();
  const paths = doc.paths as unknown as Record<string, Record<string, OpenApiOperation>>;
  const fileOperations = {
    list: paths["/api/workspace/files"]?.get,
    content: paths["/api/workspace/files/content"]?.get,
    create: paths["/api/workspace/files/text"]?.post,
    update: paths["/api/workspace/files/text"]?.put,
    delete: paths["/api/workspace/files"]?.delete,
  };
  for (const [name, operation] of Object.entries(fileOperations)) {
    assert.ok(operation, `missing workspace file operation ${name}`);
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
    assert.equal(operation.tags?.[0], "工作区文件");
  }

  assert.deepEqual(
    Object.entries(paths).filter(([path]) => path.startsWith("/api/workspace/files")).map(([path, operations]) => [
      path,
      Object.keys(operations).sort(),
    ]),
    [
      ["/api/workspace/files", ["delete", "get"]],
      ["/api/workspace/files/content", ["get"]],
      ["/api/workspace/files/text", ["post", "put"]],
    ],
  );

  for (const rule of [/唯一 DATA_DIR\/workspace/, /1000 项/, /413/])
    assert.match(fileOperations.list!.description ?? "", rule);
  for (const rule of [/8388608 字节/, /严格 UTF-8/, /无 NUL/, /PNG\/JPEG\/GIF\/WebP/, /dataBase64/, /不透出绝对路径/])
    assert.match(fileOperations.content!.description ?? "", rule);
  for (const operation of [fileOperations.create!, fileOperations.update!]) {
    for (const rule of [/完整 before\/after|完整新内容/, /confirmed:true/, /100000 UTF-8 字节/, /ASCII 字母/])
      assert.match(operation.description ?? "", rule);
  }
  assert.match(fileOperations.create!.description ?? "", /目标存在返回 409/);
  assert.match(fileOperations.update!.description ?? "", /缺失返回 404/);
  assert.match(fileOperations.update!.description ?? "", /旧 pending 模型审批/);
  assert.match(fileOperations.delete!.description ?? "", /仅删除现存普通文件/);
});

test("docs: /api/runs pins required sessionId, limit range, cursor binding, and RunStep schema", () => {
  const { list, status } = runOperations();
  const parameters = list.parameters ?? [];
  assert.deepEqual(parameters.map((parameter) => parameter.name).sort(), ["sessionId", "cursor", "limit"].sort());
  const sessionIdParam = queryParameter(list, "sessionId");
  assert.equal(sessionIdParam.in, "query");
  assert.equal(sessionIdParam.required, true);
  const limitParam = queryParameter(list, "limit");
  assert.equal(limitParam.required, false);
  assert.equal(limitParam.schema.type, "integer");
  assert.equal(limitParam.schema.default, 20);
  assert.equal(limitParam.schema.minimum, 1);
  assert.equal(limitParam.schema.maximum, 100);
  const cursorParam = queryParameter(list, "cursor");
  assert.equal(cursorParam.required, false);
  assert.match(cursorParam.schema.description ?? "", /绑定 sessionId/);

  const page = responseSchema(list);
  assert.deepEqual(Object.keys(page.properties ?? {}).sort(), ["instanceId", "runs", "hasMore", "nextCursor"].sort());
  assert.equal(page.additionalProperties, false);
  const runItem = page.properties?.runs?.items;
  assert.ok(runItem);
  const statusResponse = responseSchema(status);
  assert.deepEqual(runItem, statusResponse.properties?.status, "/api/runs items and /api/runs/status.status must share schema");
  const step = runItem.properties?.steps?.items;
  assert.ok(step, "sessionStatus must expose steps array schema");
  assert.deepEqual(Object.keys(step.properties ?? {}).sort(), [...RUN_STEP_FIELDS].sort());
  assert.deepEqual([...(step.required ?? [])].sort(), [...RUN_STEP_FIELDS].sort());
  assert.equal(step.additionalProperties, false);
  assert.deepEqual(step.properties?.kind?.enum, RUN_STEP_KINDS);
  assert.deepEqual(step.properties?.status?.enum, RUN_STEP_STATUSES);
});

test("docs: /api/runs enforces auth, strict query validation, and session-bound cursors", async (t) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-runs-docs-"));
  t.after(async () => {
    await service?.close();
    await model.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  service = await createService(
    createConfig({
      schemaVersion: 1,
      server: {},
      model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "k" },
      runtime: { dataDir, runTimeoutMs: 3000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    }),
  );

  assert.equal((await service.app.request("/api/runs?sessionId=main")).status, 401);
  assert.equal((await service.app.request("/api/activities", { headers: { Authorization: `Bearer ${service.auth.login()}` } })).status, 404);

  const headers = { Authorization: `Bearer ${service.auth.login()}` };
  const listEndpoint = endpoints.find((endpoint) => endpoint.method === "get" && endpoint.path === "/api/runs")!;

  const ok = await service.app.request("/api/runs?sessionId=main", { headers });
  assert.equal(ok.status, 200);
  assert.ok(listEndpoint.response.safeParse(await ok.json()).success, "empty runs list must match response schema");

  for (const query of ["", "limit=0", "limit=101", "limit=abc", "sessionId=-bad", "sessionId=main&unknown=1", "sessionId=main&limit=1&limit=2"]) {
    const response = await service.app.request(`/api/runs${query ? `?${query}` : ""}`, { headers });
    assert.equal(response.status, 400, `/api/runs?${query} should be rejected`);
  }

  const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const bound = encode({ startedAt: "2026-10-18T10:00:00.000Z", runId: "run-x", sessionId: "main" });
  assert.equal((await service.app.request(`/api/runs?sessionId=main&cursor=${bound}`, { headers })).status, 200);
  const otherSession = "00000000-0000-4000-8000-000000000001";
  for (const query of [
    `sessionId=${otherSession}&cursor=${bound}`,
    `sessionId=main&cursor=not-a-cursor`,
    `sessionId=main&cursor=${encode({ startedAt: "not-a-date", runId: "run-x", sessionId: "main" })}`,
  ]) {
    assert.equal((await service.app.request(`/api/runs?${query}`, { headers })).status, 400);
  }
});

test("docs: source routing, deletion, safe errors and deployed code identity are explicit", async () => {
  const doc = buildOpenApiDocument();
  const version = await serviceVersion;
  assert.deepEqual(doc["x-service-version"], version);
  assert.equal(doc.info.version, `${version.version}+${version.sourceHash.slice(0, 12)}`);
  assert.match(doc.info.description, new RegExp(version.sourceHash));
  assert.match(doc.info.description, /dirty=true[\s\S]*sourceHash/);
  type Operation = { description: string };
  const description = (path: string, method: string) => (doc.paths[path][method] as Operation).description;
  // 后台任务创建 API 已下线，注册表中只剩监控：仅断言监控的来源/删除约定。
  for (const path of ["/api/monitors"]) {
    const text = description(path, "post");
    assert.match(text, /仅省略/);
    assert.match(text, /已有会话/);
    assert.match(text, /(409 SESSION_DELETING|409 THREAD_DELETING)/);
    assert.match(text, /不自动重试/);
    assert.match(text, /选择保留时才迁移到主会话/);
    assert.doesNotMatch(text, /通知进主聊天流|结果以 📡 进主聊天流/);
  }
  const controlText = description("/api/jobs/{id}/control", "post");
  assert.match(controlText, /pause/);
  assert.match(controlText, /不中止正在执行的一轮/);
  assert.match(description("/api/conversation", "get"), /已删除[\s\S]*不创建[\s\S]*列表/);
  assert.match(description("/api/conversation", "get"), /模型上下文与历史前脱敏/);
  assert.match(description("/api/conversation/stop", "post"), /不建立/);
  assert.match(description("/api/sessions/{sessionId}", "delete"), /不能删除|不可删除/);
  assert.match(description("/api/health", "get"), /commit[\s\S]*dirty[\s\S]*sourceHash/);
});

test("docs: database tool declares shared storage, autonomous SQL and honest cancellation", () => {
  const doc = buildOpenApiDocument();
  const chat = doc.paths["/api/conversation/run"].post as { description: string };
  for (const rule of [/database/, /main\/news/, /无逐次 SQL 审批或表级权限/, /共用同一数据库/,
    /不接受任意文件路径/, /工具帧隐藏 SQL 参数和原始行/, /已提交修改不会因稍后取消而撤销/,
    /不自动重放/]) assert.match(chat.description, rule);
  assert.equal(Object.hasOwn(doc.paths, "/api/database"), false, "SQL stays a model tool, not a new unaudited REST endpoint");
});

test("docs: subagent stays inside the parent run and no background task creation remains", () => {
  const doc = buildOpenApiDocument();
  type Operation = { description: string; responses: Record<string, { content: Record<string, { schema: { properties: Record<string, unknown> } }> }> };
  const chat = doc.paths["/api/conversation/run"].post as Operation;
  for (const rule of [/subagent/, /最多 8 项/, /最多 4 个/, /结果后主模型继续/, /版本绑定人工审批/, /绑定父运行/, /取消并等待子会话清理/])
    assert.match(chat.description, rule);
  assert.ok(doc.paths["/api/subagents"]?.get, "generated doc must include GET /api/subagents");
  assert.ok(doc.paths["/api/subagents/{id}"]?.get, "generated doc must include GET /api/subagents/{id}");
  const snapshot = doc.paths["/api/identity"].get as Operation;
  assert.match(snapshot.description, /jobs/i);
  assert.match(snapshot.description, /不提供 POST \/api\/agent\/tasks/);
  assert.equal(Object.hasOwn(snapshot.responses["200"].content["application/json"].schema.properties, "worker"), false);
  assert.equal(Object.hasOwn(doc.paths, "/api/agent/tasks"), false);
  assert.equal(Object.hasOwn(doc.paths, "/api/agent/tasks/{id}"), false);
  assert.equal(Object.hasOwn(doc.paths, "/api/agent/tasks/{id}/control"), false);
  assert.ok(doc.paths["/api/jobs"]?.get, "generated doc must include GET /api/jobs");
  assert.ok(doc.paths["/api/jobs/{id}"]?.get, "generated doc must include GET /api/jobs/{id}");
  assert.ok(doc.paths["/api/jobs/{id}/control"]?.post, "generated doc must include POST /api/jobs/{id}/control");
  assert.ok(doc.paths["/api/jobs/{id}"]?.patch, "generated doc must include PATCH /api/jobs/{id}");
  const updateJobOp = doc.paths["/api/jobs/{id}"]?.patch as {
    description?: string;
    requestBody?: { content: Record<string, { schema: JsonSchema }> };
  } | undefined;
  const updateJobDesc = updateJobOp?.description ?? "";
  assert.match(updateJobDesc, /修改任务不改变归属/);
  assert.match(updateJobDesc, /409 SESSION_DELETING/);
  const patchBody = updateJobOp?.requestBody?.content?.["application/json"]?.schema;
  assert.equal(patchBody?.properties?.originSessionId, undefined);
  const deleteOp = doc.paths["/api/sessions/{sessionId}"]?.delete as {
    requestBody?: { content: Record<string, { schema: JsonSchema }> };
  } | undefined;
  const deleteBody = deleteOp?.requestBody?.content?.["application/json"]?.schema;
  assert.deepEqual(deleteBody?.required, ["scheduleDisposition", "scheduleRevision"]);
  assert.ok(doc.paths["/api/sessions/{sessionId}/schedules"]?.get);

  // A03: updateJob description 与 at 字段必须说明严格两位 HH:mm、00:00 至 23:59、
  // 非法日程 400 INVALID_SCHEDULE_FORMAT 且不自动进位、不写入；合法日程按服务器时区。
  assert.match(updateJobDesc, /严格两位 HH:mm/);
  assert.match(updateJobDesc, /00:00 至 23:59/);
  assert.match(updateJobDesc, /400 INVALID_SCHEDULE_FORMAT/);
  assert.match(updateJobDesc, /非法日程返回 400 INVALID_SCHEDULE_FORMAT，不自动进位、不写入/);
  assert.match(updateJobDesc, /合法日程按服务端本地时区计算并保存/);

  const atFieldDesc = patchBody?.properties?.at?.description ?? "";
  assert.match(atFieldDesc, /严格两位/);
  assert.match(atFieldDesc, /00:00 至 23:59/);
  assert.match(atFieldDesc, /400 INVALID_SCHEDULE_FORMAT/);
  assert.match(atFieldDesc, /非法日程返回 400 INVALID_SCHEDULE_FORMAT，不自动进位、不写入/);
  assert.ok(doc.paths["/api/jobs/{id}"]?.delete, "generated doc must include DELETE /api/jobs/{id}");
});

test("docs: conversation attachments keep one-shot submission and per-attachment history previews explicit", () => {
  const doc = buildOpenApiDocument();
  type Operation = {
    description: string;
    requestBody?: { content: Record<string, { schema: JsonSchema }> };
    responses: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
  };
  const run = doc.paths["/api/conversation/run"].post as Operation;
  assert.match(run.description, /最多 4 项/);
  assert.match(run.description, /单图最大 8MiB/);
  assert.match(run.description, /413 REQUEST_TOO_LARGE/);
  assert.match(run.description, /不自动换模型/);
  assert.ok(run.responses["413"]?.content?.["application/json"]?.schema);

  const attachment = run.requestBody?.content?.["application/json"]?.schema
    .properties?.message?.properties?.attachments?.items as JsonSchema | undefined;
  assert.deepEqual(attachment?.required, ["id", "name", "mimeType", "dataBase64"]);
  const properties = attachment?.properties as Record<string, JsonSchema>;
  assert.equal(properties.image, undefined);

  const history = doc.paths["/api/conversation"].get as Operation;
  const message = history.responses["200"]?.content?.["application/json"]?.schema
    ?.properties?.messages?.items as JsonSchema | undefined;
  const historyAttachment = message?.properties?.attachments?.items as JsonSchema | undefined;
  const historyFields = historyAttachment?.properties as Record<string, JsonSchema>;
  assert.deepEqual(Object.keys(historyFields).sort(), ["id", "image", "kind", "mimeType", "name", "sha256", "size"].sort());
  assert.ok(historyFields.image);
  assert.equal(message?.properties?.image, undefined);
});

test("docs: notification stream documents the client sync protocol and keeps event namespaces separate", () => {
  const document = buildOpenApiDocument();
  type StreamResponse = { description: string; "x-sse-events": Record<string, { schema: unknown }> };
  type Operation = { description: string; security?: unknown[]; responses: Record<string, StreamResponse> };
  const operation = document.paths["/api/events"].get as Operation;
  // 只检查标准描述，不借助 x-sse-events，防止关键接入规则只在机器扩展里存在。
  const description = operation.description;
  for (const rule of [
    /Authorization: Bearer/, /event:[\s\S]*data:/, /UTF-8/, /空行/,
    /ready[\s\S]*sessionStatuses[\s\S]*pendingApprovals/,
    /session_status_updated/, /approval_pending/, /approval_updated/, /conversation_updated/,
    /GET \/api\/conversation/, /不得伪造状态事件/, /同 ID 幂等 noop/,
    /GET \/api\/runs\?sessionId=/, /GET \/api\/runs\/status\?sessionId=/,
    /instanceId[\s\S]*revision/, /\(id, revision\)/,
    /30 秒[\s\S]*keep-alive/,
    /不发送事件 id/, /不支持历史重放/, /忽略 Last-Event-ID/,
    /不会取消聊天/, /服务关闭[\s\S]*结束活跃流/,
    /HTTP 401[\s\S]*重新登录/, /HTTP 503/, /HTTP 429/, /不是聊天增量/, /不负责锁屏系统推送/,
    /8MiB/, /12MiB/, /断流/,
    /本轮不发送记忆（memory）变化通知/, /不新增 jobs\/goals/,
  ]) assert.match(description, rule, `Missing client protocol rule in generated docs: ${rule}`);
  // 旧失效通知协议已下线：不能再出现空 data 或旧事件名。
  assert.doesNotMatch(description, /data: \{\}/);
  assert.doesNotMatch(description, /workspace_updated|actions_updated|activity_updated/);
  assert.ok(operation.security?.length);
  assert.deepEqual(Object.keys(operation.responses["200"]["x-sse-events"]).sort(), [
    "browser_updated",
    "session_presence_updated",
    "session_status_updated",
    "approval_pending",
    "approval_updated",
    "conversation_updated",
    "session_directory_updated",
    "subagent_updated",
    "ready",
  ].sort());
  const chat = document.paths["/api/conversation/run"].post as Operation;
  assert.match(chat.description, /不会取消服务端运行/);
  assert.match(chat.description, /GET \/api\/conversation\/stream/);
  assert.ok(Object.hasOwn(chat.responses["200"]["x-sse-events"], "RUN_FINISHED"));
  for (const name of ["ready", "session_status_updated", "approval_pending", "approval_updated"])
    assert.ok(!Object.hasOwn(chat.responses["200"]["x-sse-events"], name), `聊天 SSE 不应混入通知事件 ${name}`);
  const stream = document.paths["/api/conversation/stream"]?.get as Operation | undefined;
  assert.ok(stream, "generated doc must include GET /api/conversation/stream");
  assert.ok(Object.hasOwn(stream.responses["200"]["x-sse-events"], "RUN_FINISHED"));
  const conv = document.paths["/api/conversation"]?.get as {
    responses: { 200: { content: { "application/json": { schema: { properties: Record<string, unknown> } } } } };
  };
  assert.ok(Object.hasOwn(conv.responses["200"].content["application/json"].schema.properties, "lastRun"));
});

test("docs: /api/events SSE schema carries bounded runtime, presence and invalidation events", () => {
  const doc = buildOpenApiDocument();
  const op = (doc.paths as Record<string, Record<string, Record<string, unknown>>>)["/api/events"]?.get;
  assert.ok(op);
  const ok = (op.responses as Record<string, Record<string, unknown>>)["200"];
  // 200 必须声明 text/event-stream 媒体类型
  const content = (ok.content as Record<string, Record<string, unknown>>)["text/event-stream"];
  assert.ok(content, "200 必须声明 text/event-stream content");
  // 状态类事件直接可展示；conversation_updated 只带身份，客户端重读权威历史。
  const table = ok["x-sse-events"] as Record<string, { description: string; schema: Record<string, unknown> }>;
  assert.ok(table, "必须声明 x-sse-events 事件契约");
  assert.deepEqual(Object.keys(table).sort(), [
    "browser_updated",
    "session_presence_updated",
    "session_status_updated",
    "approval_pending",
    "approval_updated",
    "conversation_updated",
    "session_directory_updated",
    "subagent_updated",
    "ready",
  ].sort());
  for (const [name, entry] of Object.entries(table)) {
    assert.equal(entry.schema.type, "object", `${name} schema.type 必须是 object`);
    assert.notDeepEqual((entry.schema.properties ?? {}) as Record<string, unknown>, {}, `${name} 必须携带真实状态字段`);
    assert.ok(entry.description.length > 0, `${name} 必须有可读描述`);
  }
  // ready 是完整替换集合；增量事件顶层都带 instanceId。
  const ready = table.ready.schema;
  assert.deepEqual(Object.keys(ready.properties as object).sort(), ["sessionPresences", "sessionStatuses", "instanceId", "pendingApprovals", "serverTime"].sort());
  for (const name of ["session_presence_updated", "session_status_updated", "approval_pending", "approval_updated", "conversation_updated"])
    assert.ok(Object.hasOwn(table[name].schema.properties as object, "instanceId"), `${name} 顶层必须带 instanceId`);
  const conversationProps = table.conversation_updated.schema.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(conversationProps).sort(), ["sessionId", "instanceId", "piSessionId"].sort());
  assert.equal(table.conversation_updated.schema.additionalProperties, false);
  // 审批新增推完整预览；审批终态推轻量投影（不含 title/kind/preview）。
  const pendingProps = Object.keys(table.approval_pending.schema.properties as object);
  assert.ok(pendingProps.includes("preview"));
  const updatedProps = Object.keys(table.approval_updated.schema.properties as object);
  for (const omitted of ["title", "kind", "preview"])
    assert.ok(!updatedProps.includes(omitted), `approval_updated 不应包含 ${omitted}`);
  // 聊天 SSE 仍走独立事件表，不混入通知事件
  const runOp = (doc.paths as Record<string, Record<string, Record<string, unknown>>>)["/api/conversation/run"]?.post;
  const runTable = (runOp?.responses as Record<string, Record<string, Record<string, unknown>>>)["200"]?.["x-sse-events"];
  assert.ok(runTable, "聊天 SSE 必须有自己独立的事件表");
  const runNames = Object.keys(runTable as object);
  for (const name of ["ready", "session_status_updated", "approval_pending", "approval_updated"]) {
    assert.ok(!runNames.includes(name), `聊天 SSE 事件表不应混入通知事件 ${name}`);
  }
});

test("docs: approvals replace legacy actions endpoints and pin strict list/detail/decision semantics", () => {
  const doc = buildOpenApiDocument();
  type Operation = {
    description?: string;
    security?: unknown[];
    parameters?: { name: string; in: string; required: boolean; schema: JsonSchema }[];
    requestBody?: { required: boolean; content: Record<string, { schema: JsonSchema }> };
    responses: Record<string, { description?: string; content?: Record<string, { schema?: JsonSchema }> }>;
  };
  const paths = doc.paths as unknown as Record<string, Record<string, Operation>>;

  // 旧审批入口必须从注册表与文档中彻底消失，不保留兼容 reader。
  for (const legacy of ["/api/actions/pending", "/api/actions", "/api/actions/{id}", "/api/actions/{id}/decide"])
    assert.equal(Object.hasOwn(paths, legacy), false, `legacy approval path must be gone: ${legacy}`);
  assert.deepEqual(
    Object.keys(paths).filter((path) => path === "/api/approvals" || path.startsWith("/api/approvals/")).sort(),
    ["/api/approvals", "/api/approvals/pending", "/api/approvals/{id}", "/api/approvals/{id}/decision"].sort(),
    "approval domain exposes history, supplementary pending, detail and decision",
  );

  const list = paths["/api/approvals"]!.get!;
  assert.deepEqual(list.security, [{ bearerAuth: [] }]);
  assert.deepEqual(list.parameters?.map((parameter) => parameter.name).sort(), ["sessionId", "cursor", "limit", "status"].sort());
  for (const parameter of list.parameters ?? []) {
    assert.equal(parameter.in, "query");
    assert.equal(parameter.required, false);
  }
  const limit = queryParameter(list as never, "limit").schema;
  assert.equal(limit.type, "integer");
  assert.equal(limit.default, 20);
  assert.equal(limit.minimum, 1);
  assert.equal(limit.maximum, 100);
  assert.match(limit.description ?? "", /默认 20/);
  assert.match(limit.description ?? "", /1–100/);
  assert.match(queryParameter(list as never, "cursor").schema.description ?? "", /不透明/);
  for (const rule of [/只返回已处理\/失效审批的摘要/, /不含 preview/, /当前 pending 不在此列表/, /resolvedAt/, /分页不冻结/, /长期保留/])
    assert.match(list.description ?? "", rule, `missing approval list rule: ${rule}`);

  // 历史列表摘要省略 preview，但保留身份、revision、终态与时间。
  const page = responseSchema(list as never);
  assert.deepEqual(Object.keys(page.properties ?? {}).sort(), ["approvals", "hasMore", "nextCursor"].sort());
  assert.deepEqual([...(page.required ?? [])].sort(), ["approvals", "hasMore", "nextCursor"].sort());
  assert.equal(page.additionalProperties, false);
  assert.deepEqual(nullableTypes(page.properties?.nextCursor), ["null", "string"]);
  const summary = page.properties?.approvals?.items;
  assert.ok(summary);
  assert.equal(Object.hasOwn(summary.properties ?? {}, "preview"), false, "summary must omit preview");
  assert.equal(Object.hasOwn(summary.properties ?? {}, "revision"), true, "summary must keep revision");

  // 详情返回完整视图，字段与必填项精确；preview 全文不截断。
  const detail = paths["/api/approvals/{id}"]!.get!;
  const view = responseSchema(detail as never);
  const viewFields = ["sessionId", "createdAt", "decidedAt", "execution", "expiresAt", "id", "kind", "preview", "resolvedAt", "revision", "runId", "status", "subagentId", "title", "toolCallId"].sort();
  assert.deepEqual(Object.keys(view.properties ?? {}).sort(), viewFields);
  assert.deepEqual([...(view.required ?? [])].sort(), viewFields);
  assert.equal(view.additionalProperties, false);
  assert.deepEqual(view.properties?.status?.enum, ["pending", "approved", "denied", "expired", "cancelled"]);
  assert.match(view.properties?.status?.description ?? "", /expired=超过 expiresAt 自动失效/);
  assert.match(view.properties?.status?.description ?? "", /expired\/cancelled 不是人的决定，decidedAt 保持 null/);
  assert.deepEqual(nullableTypes(view.properties?.decidedAt), ["null", "string"]);
  assert.deepEqual(nullableTypes(view.properties?.resolvedAt), ["null", "string"]);
  const preview = view.properties?.preview as (JsonSchema & { oneOf?: JsonSchema[] }) | undefined;
  const fileVariant = preview?.oneOf?.find((variant) => variant.properties?.type?.enum?.includes("file_diff") || (variant.properties?.type as { const?: string } | undefined)?.const === "file_diff");
  const proposalVariant = preview?.oneOf?.find((variant) => variant.properties?.type?.enum?.includes("proposal") || (variant.properties?.type as { const?: string } | undefined)?.const === "proposal");
  assert.ok(fileVariant && proposalVariant, "approval preview schema must expose both file_diff and proposal variants");
  assert.deepEqual(Object.keys(fileVariant.properties ?? {}).sort(), ["after", "before", "beforeExists", "path", "scope", "type"].sort());
  assert.deepEqual(Object.keys(proposalVariant.properties ?? {}).sort(), ["category", "confirmLabel", "denyLabel", "items", "summary", "target", "type"].sort());
  assert.equal(fileVariant.additionalProperties, false);
  assert.equal(proposalVariant.additionalProperties, false);
  assert.match(fileVariant.properties?.before?.description ?? "", /不截断/);
  assert.match(view.description ?? "", /1\.5MB/);
  assert.match(view.description ?? "", /6MB/);
  assert.match(view.description ?? "", /最多 32 项/);
  assert.match(detail.description ?? "", /不存在返回 404/);

  // 决定请求严格只接受 approve/deny；409 携带当前完整审批视图。
  const decision = paths["/api/approvals/{id}/decision"]!.post!;
  assert.equal(decision.requestBody?.required, true);
  const request = decision.requestBody?.content["application/json"]?.schema;
  assert.deepEqual(Object.keys(request?.properties ?? {}), ["decision"]);
  assert.deepEqual(request?.properties?.decision?.enum, ["approve", "deny"]);
  assert.equal(request?.additionalProperties, false);
  const conflict = decision.responses["409"]?.content?.["application/json"]?.schema;
  assert.deepEqual(Object.keys(conflict?.properties ?? {}).sort(), ["approval", "error"].sort());
  assert.deepEqual([...(conflict?.required ?? [])].sort(), ["approval", "error"].sort());
  assert.deepEqual(Object.keys(conflict?.properties?.approval?.properties ?? {}).sort(), viewFields);
  assert.ok(Object.hasOwn(conflict?.properties?.approval?.properties ?? {}, "preview"));
  for (const rule of [/幂等返回 200/, /revision 不变/, /不再次执行/, /相反决定[\s\S]*409/, /未知 id 返回 404/, /请求体非法返回 400/, /401/])
    assert.match(decision.description ?? "", rule, `missing decision rule: ${rule}`);
});

test("docs: agent status query is read-only, requires both ids and shares the run status contract", () => {
  const doc = buildOpenApiDocument();
  type Operation = {
    description?: string;
    security?: unknown[];
    parameters?: { name: string; in: string; required: boolean; schema: JsonSchema }[];
    responses: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
  };
  const paths = doc.paths as unknown as Record<string, Record<string, Operation>>;
  const operation = paths["/api/runs/status"]!.get!;
  assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
  assert.deepEqual(
    operation.parameters?.map(({ name, in: location, required }) => ({ name, in: location, required })),
    [
      { name: "sessionId", in: "query", required: true },
      { name: "runId", in: "query", required: true },
    ],
    "both ids are required query parameters; no undeclared parameters",
  );
  assert.match(operation.description ?? "", /只读/);
  assert.match(operation.description ?? "", /运行结束后的最终终态/);
  assert.match(operation.description ?? "", /步骤时间线 steps/);
  assert.match(operation.description ?? "", /不(调用模型、不)?建立(会话|会话)、不创建目录/);
  assert.match(operation.description ?? "", /instanceId/);
  assert.match(operation.description ?? "", /revision/);
  assert.match(operation.description ?? "", /运行不存在或已被清理返回 404/);

  const response = responseSchema(operation as never);
  assert.deepEqual(Object.keys(response.properties ?? {}).sort(), ["instanceId", "status"].sort());
  assert.deepEqual([...(response.required ?? [])].sort(), ["instanceId", "status"].sort());
  assert.equal(response.additionalProperties, false);
  assert.equal(response.properties?.instanceId?.format, "uuid");
  const status = response.properties?.status;
  assert.equal(status?.additionalProperties, false);
  assert.deepEqual(status?.properties?.status?.enum, ["running", "succeeded", "failed", "cancelled"]);
  assert.ok(status?.properties?.steps?.items, "status schema must include steps");
  // 运行状态只携带审批 ID 引用，不内嵌审批完整视图（完整内容走 approval_pending / 详情接口）。
  assert.equal(status?.properties?.pendingApprovalIds?.items?.type, "string");
  assert.match(status?.properties?.pendingApprovalIds?.description ?? "", /approval_pending/);
  assert.doesNotMatch(JSON.stringify(status), /"preview"/, "run status must not embed approval preview");
  // 运行状态与 ready/session_status_updated 共用同一 schema，避免三处字段漂移。
  const events = paths["/api/events"]!.get!.responses["200"] as unknown as {
    "x-sse-events": Record<string, { schema: JsonSchema }>;
  };
  assert.deepEqual(events["x-sse-events"]?.ready?.schema.properties?.sessionStatuses?.items, status);
  // 增量事件 = 同一运行状态 + 顶层 instanceId；只比较业务字段，避免锁死 $ref/内联写法。
  const updated = events["x-sse-events"]?.session_status_updated?.schema;
  assert.equal(updated?.additionalProperties, false);
  assert.deepEqual(
    Object.keys(updated?.properties ?? {}).filter((key) => key !== "instanceId").sort(),
    Object.keys(status?.properties ?? {}).sort(),
  );
  assert.equal(updated?.properties?.instanceId?.format, "uuid");
});

test("docs: snapshot points approvals at the SSE stream and keeps the existing read aggregation", () => {
  const doc = buildOpenApiDocument();
  const snapshot = doc.paths["/api/identity"].get as unknown as { description: string };
  assert.match(snapshot.description, /GET \/api\/events/);
  assert.match(snapshot.description, /ready\.pendingApprovals/);
  assert.doesNotMatch(snapshot.description, /GET \/api\/actions\/pending/);
  // 快照仅保留 identity，goals/memories/jobs/monitors 已迁移为独立端点。
  const schema = responseSchema(snapshot as never);
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["identity"].sort());
});

test("docs: goals endpoints declare list, get, create, patch, toggle and delete operations", () => {
  const doc = buildOpenApiDocument();
  type Operation = {
    summary?: string;
    description?: string;
    security?: unknown[];
    requestBody?: { required: boolean; content: Record<string, { schema: JsonSchema }> };
    responses: Record<string, { description?: string; content?: Record<string, { schema?: JsonSchema }> }>;
  };
  const paths = doc.paths as unknown as Record<string, Record<string, Operation>>;

  const list = paths["/api/goals"]?.get;
  assert.ok(list);
  assert.deepEqual(list.security, [{ bearerAuth: [] }]);
  assert.match(list.description ?? "", /长期目标[\s\S]*全量返回目标列表，不分页/);
  assert.doesNotMatch(list.description ?? "", /goals\.json/);

  const get = paths["/api/goals/{id}"]?.get;
  assert.ok(get);

  const create = paths["/api/goals"]?.post;
  assert.ok(create);
  assert.match(create.description ?? "", /active/);

  const patch = paths["/api/goals/{id}"]?.patch;
  assert.ok(patch);
  assert.match(patch.description ?? "", /completed/);

  const toggle = paths["/api/goals/{id}/milestones/{mid}/toggle"]?.post;
  assert.ok(toggle);

  const del = paths["/api/goals/{id}"]?.delete;
  assert.ok(del);
});

test("docs: memory and Dream endpoints pin layering, capacity, prompt inheritance and pending confirmation rules", () => {
  const doc = buildOpenApiDocument();
  type Operation = {
    description?: string;
    security?: unknown[];
    parameters?: { name: string; in: string; required: boolean; schema: JsonSchema }[];
    requestBody?: { required: boolean; content: Record<string, { schema: JsonSchema }> };
    responses: Record<string, { description?: string; content?: Record<string, { schema?: JsonSchema }> }>;
  };
  const paths = doc.paths as unknown as Record<string, Record<string, Operation>>;

  // 独立记忆列表读取：只读、鉴权、说明按需检索与 500 条硬上限。
  const memoriesList = paths["/api/memories"]?.get;
  assert.ok(memoriesList);
  assert.deepEqual(memoriesList.security, [{ bearerAuth: [] }]);
  assert.match(memoriesList.description ?? "", /按需检索[\s\S]*不再全量拼入/);
  const memoriesCreate = paths["/api/memories"]?.post;
  assert.ok(memoriesCreate?.responses["4xx"], "POST /api/memories must document client error schema");
  assert.match(memoriesCreate?.description ?? "", /500[\s\S]*409[\s\S]*绝不静默丢弃/);

  // 独立详情、PATCH 与 DELETE 端点
  const memoryDetail = paths["/api/memories/{id}"]?.get;
  const memoryPatch = paths["/api/memories/{id}"]?.patch;
  const memoryDelete = paths["/api/memories/{id}"]?.delete;
  assert.ok(memoryDetail && memoryPatch && memoryDelete);

  const globalGet = paths["/api/dream"]?.get;
  const globalPut = paths["/api/dream"]?.put;
  assert.ok(globalGet && globalPut);
  assert.deepEqual(Object.keys(responseSchema(globalGet as never).properties ?? {}).sort(), ["cursors","enabled","intervalHours","lastRun","pending","running"].sort());
  assert.deepEqual(Object.keys(globalPut.requestBody?.content["application/json"]?.schema.properties ?? {}).sort(),["enabled"]);
  const dreamRun = paths["/api/dream/run"]?.post;
  const pending = paths["/api/dream/pending/{pendingId}"]?.post;
  assert.ok(dreamRun && pending);
  assert.match(dreamRun.description ?? "",/409/);
  assert.deepEqual(pending.requestBody?.content["application/json"]?.schema.properties?.action?.enum,["apply","dismiss"]);
  assert.deepEqual(pending.requestBody?.content["application/json"]?.schema.properties?.target?.enum,["user","soul","instructions","memory"]);
  const instructionsPut = paths["/api/assistant/instructions"]?.put;
  assert.ok(instructionsPut);
  assert.deepEqual(Object.keys(instructionsPut.requestBody?.content["application/json"]?.schema.properties ?? {}),["instructions"]);
  assert.match(instructionsPut.description ?? "",/不能扩大/);

});
test("docs: /openapi.json and /docs are served without auth", async (t) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-docs-"));
  t.after(async () => {
    await serviceRef?.then((service) => service.close(), () => undefined);
    await model.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  let serviceRef!: Promise<Awaited<ReturnType<typeof createService>>>;
  serviceRef = createService(
    createConfig({
      schemaVersion: 1,
      server: {},
      model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "k" },
      runtime: { dataDir, runTimeoutMs: 3000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    }),
  );
  const service = await serviceRef;
  const spec = await service.app.request("/openapi.json");
  assert.equal(spec.status, 200);
  const body = (await spec.json()) as { info: { title: string }; paths: Record<string, unknown> };
  assert.equal(body.info.title, "pi-muse API");
  const health = await service.app.request("/api/health");
  const healthBody = healthResponse.parse(await health.json());
  assert.deepEqual(healthBody.serviceVersion, (body as unknown as { "x-service-version": unknown })["x-service-version"]);
  assert.deepEqual(healthBody.serviceVersion, await serviceVersion);
  assert.ok(Object.keys(body.paths).length >= 20, "spec should cover all endpoints");
  const docs = await service.app.request("/docs");
  assert.equal(docs.status, 200);
  const html = await docs.text();
  assert.match(html, /<title>pi-muse API 文档<\/title>/);
  assert.match(html, /scalar\.js|jsdelivr/);
  const scalar = await service.app.request("/scalar.js");
  assert.equal(scalar.status, 200);
  assert.match(await scalar.text(), /createApiReference/);
  // /api/events 标准 operation.description 在真实 /openapi.json 中也必须覆盖关键 SSE 接入规则（不能只验 200/字段存在）
  const liveOp = (body.paths as Record<string, Record<string, Record<string, unknown>>>)["/api/events"]?.get;
  assert.ok(liveOp, "/openapi.json 必须包含 /api/events GET");
  const liveDesc = String(liveOp.description ?? "");
  assert.match(liveDesc, /Authorization[\s\S]*Bearer/i, "live description 应说明 Authorization: Bearer");
  assert.match(liveDesc, /event:[\s\S]*?data:/i, "live description 应说明 event:/data: 帧格式");
  assert.match(liveDesc, /session_status_updated[\s\S]*approval_pending[\s\S]*approval_updated[\s\S]*conversation_updated/i, "live description 应说明通知事件");
  assert.match(liveDesc, /subagent_updated/i, "live description 应包含 subagent_updated");
  assert.match(liveDesc, /keep-alive/i, "live description 应说明 : keep-alive 心跳");
  assert.match(liveDesc, /Last-Event-ID/, "live description 应说明无 Last-Event-ID / 不重放");
  assert.doesNotMatch(liveDesc, /workspace_updated|actions_updated|activity_updated/, "旧失效通知事件不得保留");
});

test("docs: live GET responses parse against registry schemas (no drift)", async (t) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-drift-"));
  t.after(async () => {
    await service?.close();
    await model.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  service = await createService(
    createConfig({
      schemaVersion: 1,
      server: {},
      model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "k" },
      runtime: { dataDir, runTimeoutMs: 3000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    }),
  );
  const headers = { Authorization: `Bearer ${service.auth.login()}` };
  // 无路径参数、无必填查询参数的 GET 才可直接请求；/api/runs/status 需要 sessionId+runId，
  // 单独在下方验证其 400/404 语义，不能用一个缺参请求冒充成功响应。
  const cases: { path: string }[] = endpoints
    .filter((e) => e.method === "get" && !e.path.includes(":") || e.path === "/api/health")
    .filter((e) => !e.sse) // SSE 端点响应是流，不是 JSON schema；safeParse 不适用
    .filter((e) => e.path !== "/api/runs" && e.path !== "/api/runs/status")
    .filter((e) => e.path !== "/updates/android/latest") // 缓存可为空；镜像专项测试覆盖成功与 503。
    .filter((e) => e.path !== "/browser/launch") // 需票据，下方单独验证 401 契约。
    .filter((e) => e.responseContentType !== "text/html") // 调试页与桌面静态页是 HTML/二进制，不参与 JSON response safeParse。
    // 工作区文件 GET 需要显式 selector/path，且 content 需要先准备现存文件；下方单独覆盖。
    .filter((e) => !e.path.startsWith("/api/workspace/files"))
    .map((e) => ({ path: e.path }));
  // conversation 需要查询参数；单独加。
  for (const { path } of cases) {
    const response = await service.app.request(path, { headers });
    assert.equal(response.status, 200, `${path} should be 200`);
    const endpoint = endpoints.find((e) => e.path === path && e.method === "get")!;
    const parsed = endpoint.response.safeParse(await response.json());
    assert.ok(parsed.success, `${path} response drifted from schema: ${parsed.success ? "" : JSON.stringify(parsed.error.issues).slice(0, 200)}`);
  }
  // 浏览器 viewer launch：无有效 ticket 时返回 401 JSON { error }
  const launchNoTicket = await service.app.request("/browser/launch");
  assert.equal(launchNoTicket.status, 401);
  const launchNoTicketBody = (await launchNoTicket.json()) as { error?: unknown };
  assert.equal(typeof launchNoTicketBody.error, "string");

  // 运行状态查询：缺参 400、未声明参数 400、不存在的 run 404；均不得建立会话或目录。
  for (const query of ["", "?sessionId=main", "?runId=run-1", "?sessionId=main&runId=run-1&extra=1"]) {
    const response = await service.app.request(`/api/runs/status${query}`, { headers });
    assert.equal(response.status, 400, `/api/runs/status${query} should be 400`);
  }
  const missingStatus = await service.app.request("/api/runs/status?sessionId=main&runId=missing-run", { headers });
  assert.equal(missingStatus.status, 404);
  assert.equal(typeof ((await missingStatus.json()) as { error?: unknown }).error, "string");
  const approvalPage = await service.app.request("/api/approvals", { headers });
  assert.equal(approvalPage.status, 200);
  const approvalEndpoint = endpoints.find((e) => e.path === "/api/approvals" && e.method === "get")!;
  assert.ok(approvalEndpoint.response.safeParse(await approvalPage.json()).success, "empty approval page must match schema");
  const conv = await service.app.request("/api/conversation?sessionId=main", { headers });
  assert.equal(conv.status, 200);
  const convEndpoint = endpoints.find((e) => e.path === "/api/conversation")!;
  assert.ok(convEndpoint.response.safeParse(await conv.json()).success, "conversation response drifted");
  const profile = await service.app.request("/api/profile", { headers });
  const profileEndpoint = endpoints.find((e) => e.path === "/api/profile" && e.method === "get")!;
  assert.ok(profileEndpoint.response.safeParse(await profile.json()).success, "profile response drifted");
  await writeFile(join(dataDir, "workspace", "docs-file.txt"), "docs");
  const workspaceList = await service.app.request("/api/workspace/files", { headers });
  assert.equal(workspaceList.status, 200);
  const workspaceListEndpoint = endpoints.find((e) => e.path === "/api/workspace/files" && e.method === "get")!;
  assert.ok(workspaceListEndpoint.response.safeParse(await workspaceList.json()).success, "workspace list response drifted");
  const workspaceContent = await service.app.request(
    "/api/workspace/files/content?path=docs-file.txt",
    { headers },
  );
  assert.equal(workspaceContent.status, 200);
  const workspaceContentEndpoint = endpoints.find((e) => e.path === "/api/workspace/files/content")!;
  assert.ok(workspaceContentEndpoint.response.safeParse(await workspaceContent.json()).success, "workspace content response drifted");
});

test("docs: every served route is registered and every registration is served (no shadow API)", async (t) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-audit-"));
  t.after(async () => {
    await service?.close();
    await model.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  service = await createService(
    createConfig({
      schemaVersion: 1,
      server: {},
      model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "k" },
      runtime: { dataDir, runTimeoutMs: 3000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    }),
  );
  const allRoutes = (service.app as unknown as { routes: { method: string; path: string }[] }).routes;
  const served = allRoutes
    .filter((r) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(r.method))
    .map((r) => `${r.method.toLowerCase()} ${r.path}`);
  // 文档基础设施路由：自身即文档面，不进注册表（登记会造成自引用）。
  const docsInfra = new Set(["get /openapi.json", "get /docs", "get /scalar.js"]);
  const registry = new Set(endpoints.map((e) => `${e.method} ${e.path}`));

  for (const key of served) {
    if (docsInfra.has(key)) continue;
    assert.ok(
      registry.has(key),
      `路由已注册到 Hono 但未登记端点注册表（文档会漏掉它）：${key}`,
    );
  }
  for (const endpoint of endpoints) {
    const key = `${endpoint.method} ${endpoint.path}`;
    const servedDirectly = served.includes(key);
    assert.ok(
      servedDirectly,
      `注册表登记了 ${key}，但服务端没有对应路由（文档在撒谎）`,
    );
  }
});

test("docs: information endpoints expose a bounded authenticated agent-scoped API", () => {
  const doc = buildOpenApiDocument();
  const paths = doc.paths as unknown as Record<string, Record<string, OpenApiOperation>>;
  const informationPaths = Object.entries(paths)
    .filter(([path]) => path.startsWith("/api/information"))
    .map(([path, operations]) => [path, Object.keys(operations).sort()] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(informationPaths, [
    ["/api/information/archive/items", ["post"]],
    ["/api/information/archive/run", ["post"]],
    ["/api/information/items", ["get", "post"]],
    ["/api/information/items/{itemId}", ["get"]],
    ["/api/information/preferences", ["get", "put"]],
    ["/api/information/runs", ["get", "post"]],
    ["/api/information/runs/{runId}", ["get"]],
    ["/api/information/settings", ["get", "put"]],
    ["/api/information/status", ["get"]],
  ]);

  for (const operations of Object.values(paths)) {
    for (const operation of Object.values(operations)) {
      if (operation.tags?.[0] !== "信息后台") continue;
      assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
    }
  }

  assert.match(paths["/api/information/items"]!.post!.description ?? "", /最多|1–100/);
  assert.match(paths["/api/information/items"]!.post!.description ?? "", /同内容幂等回读/);
  assert.match(paths["/api/information/items"]!.post!.description ?? "", /不同内容返回 409/);
  assert.match(paths["/api/information/archive/items"]!.post!.description ?? "", /queue=archive/);
  assert.match(paths["/api/information/archive/run"]!.post!.description ?? "", /1200 字简报/);
  assert.match(paths["/api/information/runs"]!.post!.description ?? "", /409 BUSY|BUSY 返回 409/);
  assert.match(paths["/api/information/runs"]!.post!.description ?? "", /queue=realtime/);
  assert.match(paths["/api/information/runs"]!.get!.description ?? "", /通知投递回执/);
  assert.match(paths["/api/information/preferences"]!.get!.description ?? "", /habits/);
  assert.match(paths["/api/information/settings"]!.put!.description ?? "", /取消在途轮/);
  assert.ok(paths["/api/habits"]?.get);
  assert.ok(paths["/api/habits/{subagentId}"]?.get && paths["/api/habits/{subagentId}"]?.post);
  assert.ok(paths["/api/habits/{subagentId}/{habitId}"]?.patch && paths["/api/habits/{subagentId}/{habitId}"]?.delete);
  assert.ok(paths["/api/habits/{subagentId}/consolidate"]?.post);
});

test("docs: browser status, viewer ticket, launch cookie, viewport, handoff and WS contract", () => {
  const doc = buildOpenApiDocument();
  const paths = doc.paths as unknown as Record<string, Record<string, OpenApiOperation>>;

  // 1. GET /api/browser/status: 鉴权接口、无论 enabled 均注册、返回完整状态
  const statusOp = paths["/api/browser/status"]?.get;
  assert.ok(statusOp, "generated OpenAPI must include GET /api/browser/status");
  assert.deepEqual(statusOp.security, [{ bearerAuth: [] }]);
  assert.equal(statusOp.tags?.[0], "浏览器");
  assert.match(statusOp.description ?? "", /无论 tools.browser.enabled 是否开启都会注册/);
  assert.match(statusOp.description ?? "", /不会触发 Chrome 懒启动/);
  const statusSchema = responseSchema(statusOp);
  assert.deepEqual(Object.keys(statusSchema.properties ?? {}).sort(), [
    "activeTabId",
    "downloadsCount",
    "enabled",
    "handoff",
    "pendingUploadsCount",
    "running",
    "tabsCount",
    "viewerPath",
    "viewport",
  ].sort());
  assert.deepEqual(statusSchema.required?.sort(), [
    "activeTabId",
    "downloadsCount",
    "enabled",
    "handoff",
    "pendingUploadsCount",
    "running",
    "tabsCount",
    "viewerPath",
    "viewport",
  ].sort());

  // 2. POST /api/browser/viewer-ticket: 鉴权接口、503 错误定义、返回 launchPath/expiresAt
  const ticketOp = paths["/api/browser/viewer-ticket"]?.post;
  assert.ok(ticketOp, "generated OpenAPI must include POST /api/browser/viewer-ticket");
  assert.deepEqual(ticketOp.security, [{ bearerAuth: [] }]);
  assert.equal(ticketOp.tags?.[0], "浏览器");
  assert.match(ticketOp.description ?? "", /同源一次性路径/);
  const ticket200 = responseSchema(ticketOp);
  assert.deepEqual(Object.keys(ticket200.properties ?? {}).sort(), ["expiresAt", "launchPath"].sort());
  const ticket503 = ticketOp.responses["503"];
  assert.ok(ticket503, "POST /api/browser/viewer-ticket must declare 503 response");
  const ticket503Schema = ticket503.content?.["application/json"]?.schema;
  assert.deepEqual(Object.keys(ticket503Schema?.properties ?? {}).sort(), ["code", "error"].sort());
  assert.deepEqual(ticket503Schema?.required, ["error"]);

  // 3. GET /browser/launch: 免鉴权、303 状态码无 content 响应体、Location/set-cookie 头、401 错误
  const launchOp = paths["/browser/launch"]?.get;
  assert.ok(launchOp, "generated OpenAPI must include GET /browser/launch");
  assert.equal(launchOp.security, undefined);
  assert.equal(launchOp.tags?.[0], "浏览器");
  const launch303 = launchOp.responses["303"] as {
    description?: string;
    content?: unknown;
    headers?: Record<string, { description?: string; schema?: { type: string } }>;
  };
  assert.ok(launch303, "GET /browser/launch must declare 303 success response");
  assert.equal(launch303.content, undefined, "303 redirect response must have no content body");
  assert.ok(launch303.headers?.location, "303 response must declare Location header");
  assert.ok(launch303.headers?.["set-cookie"], "303 response must declare set-cookie header");
  const launch401 = launchOp.responses["401"];
  assert.ok(launch401, "GET /browser/launch must declare 401 error response");
  const launch401Schema = launch401.content?.["application/json"]?.schema;
  assert.deepEqual(Object.keys(launch401Schema?.properties ?? {}).sort(), ["code", "error"].sort());
  assert.deepEqual(launch401Schema?.required, ["error"]);

  // 4. PUT /api/browser/viewport 与 DELETE /api/browser/handoff
  const viewportOp = paths["/api/browser/viewport"]?.put;
  assert.ok(viewportOp, "generated OpenAPI must include PUT /api/browser/viewport");
  assert.deepEqual(viewportOp.security, [{ bearerAuth: [] }]);
  assert.equal(viewportOp.tags?.[0], "浏览器");
  const handoffOp = paths["/api/browser/handoff"]?.delete;
  assert.ok(handoffOp, "generated OpenAPI must include DELETE /api/browser/handoff");
  assert.deepEqual(handoffOp.security, [{ bearerAuth: [] }]);
  assert.equal(handoffOp.tags?.[0], "浏览器");

  // 5. WebSocket 契约登记：统一到 /ws/browser，不再包含旧 desktop 网关
  const wsContracts = (doc as unknown as { "x-websocket-contracts": Record<string, unknown> })["x-websocket-contracts"];
  assert.ok(wsContracts?.browser, "OpenAPI must include browser WebSocket contract");
  assert.equal(wsContracts?.browserDesktop, undefined);
});

test("docs: news endpoints freeze the client contract without exposing the internal agent", () => {
  const doc = buildOpenApiDocument();
  const paths = doc.paths as unknown as Record<string, Record<string, OpenApiOperation>>;
  const newsPaths = Object.entries(paths)
    .filter(([path]) => path.startsWith("/api/news"))
    .map(([path, operations]) => [path, Object.keys(operations).sort()] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(newsPaths, [
    ["/api/news/articles", ["get"]],
    ["/api/news/articles/{articleId}", ["get"]],
    ["/api/news/articles/{articleId}/comments", ["post"]],
    ["/api/news/articles/{articleId}/comments/{commentId}", ["delete"]],
    ["/api/news/articles/{articleId}/reaction", ["put"]],
    ["/api/news/articles/{articleId}/saved", ["put"]],
    ["/api/news/preferences", ["get", "put"]],
    ["/api/news/refresh", ["post"]],
    ["/api/news/sources", ["get", "post"]],
    ["/api/news/sources/{sourceId}", ["delete"]],
    ["/api/news/status", ["get"]],
  ]);

  for (const operations of Object.values(paths)) {
    for (const operation of Object.values(operations)) {
      if (operation.tags?.[0] !== "新闻") continue;
      assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
      assert.ok(!JSON.stringify(operation).includes("news-internal"));
      assert.ok(!JSON.stringify(operation).includes("sessionId"));
    }
  }

  const list = paths["/api/news/articles"]!.get!;
  const savedOnly = queryParameter(list, "savedOnly");
  assert.deepEqual(savedOnly.schema.enum, ["true", "false"]);
  assert.equal(savedOnly.schema.default, "false");
  assert.match(savedOnly.description ?? "", /收藏/);
  assert.match(list.description ?? "", /publishedAt/);
  assert.match(list.description ?? "", /模型失败/);
  const refresh = paths["/api/news/refresh"]!.post!;
  assert.match(refresh.description ?? "", /不等待模型分析/);
  assert.match(refresh.description ?? "", /非法 JSON.*400/);
  assert.match(refresh.description ?? "", /全部源.*200/);
  assert.match(refresh.description ?? "", /resetDeferred=true.*不自动补重试/);
  assert.ok(refresh.responses["400"]);
  const refreshSchema = refresh.responses["200"]!.content!["application/json"]!.schema!;
  assert.deepEqual(refreshSchema.required, ["added", "skipped", "resetDeferred"]);
  assert.match(refreshSchema.properties!.resetDeferred!.description ?? "", /不会自动补重试/);
  const create = paths["/api/news/sources"]!.post!;
  assert.match(create.description ?? "", /fragment.*scheme\/host.*默认端口/);
  assert.match(create.description ?? "", /不按重定向最终地址归一/);
  assert.match(create.description ?? "", /超过一半.*PARSE_INVALID/);
  const errorSchema = create.responses["400"]!.content!["application/json"]!.schema!;
  const failure = errorSchema.properties!.failure!;
  assert.deepEqual(failure.properties!.category!.enum, ["NETWORK", "SSRF_BLOCKED", "TIMEOUT", "HTTP_ERROR", "PARSE_INVALID", "UNKNOWN"]);
  assert.deepEqual(failure.required, ["category"]);
  assert.equal(failure.additionalProperties, false);
  assert.equal(failure.properties!.httpStatus!.minimum, 100);
  assert.equal(failure.properties!.httpStatus!.maximum, 599);
  const sourceSchema = paths["/api/news/sources"]!.get!.responses["200"]!.content!["application/json"]!.schema!.properties!.sources!.items!;
  const details = sourceSchema.properties!.lastErrorDetails!;
  const sourceFailure = details.anyOf?.find((schema) => schema.type === "object");
  assert.deepEqual(sourceFailure?.properties, failure.properties, "add error and persisted source details use the same classification fields");
  assert.deepEqual(sourceFailure?.required, failure.required);
  assert.equal(sourceFailure?.additionalProperties, false);
  assert.ok(!sourceSchema.required!.includes("lastErrorDetails"), "legacy source details remain optional");
  assert.ok(create.responses["200"]!.content!["application/json"]!.schema!.required!.includes("skipped"));
  assert.match(paths["/api/news/sources/{sourceId}"]!.delete!.description ?? "", /文章.*保留/);
});
