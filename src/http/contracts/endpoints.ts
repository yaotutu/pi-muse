import { androidReleaseManifest } from "../../shared/android-release.js";
import { z } from "zod";
import * as req from "./rest.js";
import * as resp from "./responses.js";
import * as trace from "./traces.js";
import * as activity from "./activities.js";
import * as approval from "./approvals.js";
import * as status from "./session-status.js";
import * as files from "./workspace-files.js";
import * as browser from "./browser.js";
import * as message from "./messages.js";
import * as habits from "./habits.js";
import * as information from "./information.js";
import * as companion from "./companions.js";
import * as news from "./news.js";
import * as subagent from "./subagents.js";
import { sseEvents, SSE_EVENT_ORDER } from "./sse-events.js";
import { workspaceEvents, WORKSPACE_SSE_DESCRIPTION } from "./workspace-events.js";

/**
 * 端点注册表：所有对外 HTTP 接口的唯一清单。新增/修改端点必须在这里登记，
 * OpenAPI 文档（/openapi.json）与 Scalar 页面（/docs）由此自动生成——
 * 禁止手写 OpenAPI 文件。契约测试遍历此表做防漂移校验。
 */
export type SseSpec = {
  /** 流描述（写入 OpenAPI 200 描述） */
  description: string;
  /**
   * 事件名 → 数据 schema。每端点显式绑定，不复用全表。
   * 与聊天 SSE 不同的命名空间必须各自一份 events map，避免事件契约混入。
   */
  events: Readonly<Record<string, z.ZodType>>;
};

export type EndpointSpec = {
  operationId?: string;
  method: "get" | "post" | "put" | "patch" | "delete";
  /** 路径模板，路径参数用 :name（生成时转 {name}） */
  path: string;
  tag: string;
  summary: string;
  /** 客户端正确接入所需的行为说明，同时生成 operation.description 与 x-agent-hint。 */
  hint?: string;
  auth: boolean;
  /** 请求体 schema（生成 io=input 的 JSON Schema） */
  request?: z.ZodType;
  /** 查询参数 schema（单对象，字段即参数） */
  query?: z.ZodType;
  /** 200 响应 schema（生成 io=output；契约测试对真实响应 safeParse） */
  response: z.ZodType;
  /** 非 JSON 响应；默认 application/json */
  responseContentType?: "application/json" | "text/html" | "image/png" | "application/vnd.android.package-archive";
  /**
   * 200 响应头声明（名称 → 说明）。缓存策略、摘要等响应头语义由端点自己声明，
   * 生成器不按媒体类型猜测；schema 一律为 string。
   */
  responseHeaders?: Readonly<Record<string, string>>;
  /**
   * 成功响应为非 200 状态码（如 303 重定向）：生成器用该状态码替代默认 200，
   * response schema 仍描述响应形态（重定向目标说明）。
   */
  successStatus?: number;
  /**
   * 业务错误响应（如 409 冲突携带当前审批视图）。
   * 键为 HTTP 状态码；未登记的 4xx 仍由生成器补通用 {error} 形状。
   */
  errorResponses?: Readonly<Record<number, { description: string; schema: z.ZodType }>>;
  /**
   * 响应为 SSE 流时不生成 JSON schema，改挂 x-sse-events 事件契约。
   * 每端点显式提供 events map：聊天 SSE 绑定 sseEvents；工作区通知流绑定 workspaceEvents；
   * 互不复用，确保 OpenAPI 文档与生成器按各自事件命名空间渲染。
   */
  sse?: SseSpec;
};

export const endpoints: EndpointSpec[] = [
  { operationId: "listCompanions", method: "get", path: "/api/companions", tag: "助手形象", summary: "列出自定义助手形象包", auth: true, response: companion.companionsResponse, errorResponses: companion.companionErrors,
    hint: "只读、不创建目录。仅列出八状态 PNG 全部有效的包；不完整、损坏 manifest/PNG、非法 ID 或符号链接记入 diagnostics 并跳过，绝不删除或覆盖原件。manifest.json 可选，缺失时 name=id、description 为空。形象只影响展示，不新增助手身份或模型工具；不新增 SSE 事件。" },
  { operationId: "getCompanion", method: "get", path: "/api/companions/:packId", tag: "助手形象", summary: "读取助手形象包", auth: true, response: companion.companionResponse, errorResponses: companion.companionErrors,
    hint: "只读。packId 必须匹配 ^[a-z0-9][a-z0-9_-]{0,63}$，非法返回 400 INVALID_COMPANION_ID；不存在、损坏或未凑齐八状态返回 404 COMPANION_NOT_FOUND。version 是规范化 manifest 与全部状态字节的 SHA-256，重新读取以发现修改。" },
  { operationId: "getCompanionAsset", method: "get", path: "/api/companions/:packId/assets/:state", tag: "助手形象", summary: "读取助手形象 PNG", auth: true, response: companion.companionPngResponse, responseContentType: "image/png",
    responseHeaders: { ETag: "带双引号的 PNG 字节 SHA-256", "Cache-Control": "private, max-age=300" }, errorResponses: companion.companionErrors,
    hint: "仅完整包可读取；缺失、损坏或不完整返回 404 COMPANION_NOT_FOUND。非法 ID/state 返回 400 INVALID_COMPANION_ID / INVALID_COMPANION_STATE。state 仅允许 idle、thinking、responding、working、waiting-approval、success、error、stopped。返回原始 image/png 字节，ETag 为带双引号的图片 SHA-256，Cache-Control: private, max-age=300；必须携带 Bearer 鉴权，不能把 token 放 URL。" },
  { operationId: "saveCompanion", method: "put", path: "/api/companions/:packId", tag: "助手形象", summary: "保存助手形象元数据", auth: true, request: companion.companionMetadataRequest, response: companion.saveCompanionResponse, errorResponses: companion.companionErrors,
    hint: "创建或整份替换 manifest.json（schemaVersion=1），最后成功保存生效。name trim 后 1–80 字符，description 最多 200 字符，省略为空。允许分步保存，complete/missingStates 反映缺失 PNG；八状态全部有效后才进入可用列表。已有坏 manifest/PNG 或符号链接拒绝写入且保留原件；先修复原文件。不调用模型；写入结果未明先读取状态，不自动重发。" },
  { operationId: "saveCompanionAsset", method: "put", path: "/api/companions/:packId/assets/:state", tag: "助手形象", summary: "保存助手形象状态 PNG", auth: true, request: companion.companionAssetRequest, response: companion.saveCompanionAssetResponse, errorResponses: companion.companionErrors,
    hint: "允许分步上传八个状态；缺省 manifest 的名称为 packId，说明为空。只接受严格规范 base64，不含 data: 前缀或非法字符；解码后 1–786432 字节且匹配 PNG 魔数。非 PNG 返回 400 INVALID_PNG，图片超过 768 KiB 或 JSON body 超过 2 MiB 返回 413 REQUEST_TOO_LARGE；其他路由仍为 1 MiB。拒绝目录穿越、非法 ID/state 与符号链接。已有损坏文件拒绝覆盖，原件保留。成功返回未带引号的图片 SHA-256 etag；完成后重读列表/详情取得 version。写入结果未明先读取，不自动重发。" },
  { operationId: "deleteCompanion", method: "delete", path: "/api/companions/:packId", tag: "助手形象", summary: "删除助手形象包", auth: true, response: companion.deleteCompanionResponse, errorResponses: companion.companionErrors,
    hint: "显式删除整个 pack 目录，包括未完成包；不可恢复，需用户主动操作。不存在返回 404 COMPANION_NOT_FOUND，非法 ID 返回 400 INVALID_COMPANION_ID；遇到任意符号链接拒绝，不跟随链接。删除结果未明先读取列表核对，不自动重发。不调用模型。" },
  { operationId: "listSessions", method: "get", path: "/api/sessions", tag: "会话", summary: "列出会话", auth: true, response: resp.sessionsResponse,
    hint: "main 永远存在且排第一；专题会话按 updatedAt 倒序。元数据与 pi 会话 id 独立；GET 不创建会话。" },
  { operationId: "createConversationSession", method: "post", path: "/api/sessions", tag: "会话", summary: "创建专题会话", auth: true, request: req.createSessionSchema, response: resp.sessionRecordResponse,
    hint: "服务端生成 UUID；title 缺省为新会话。只创建元数据和会话目录，不调用模型。写入结果未明先读取列表核对，不自动重发。" },
  { operationId: "getSession", method: "get", path: "/api/sessions/:sessionId", tag: "会话", summary: "读取会话", auth: true, response: resp.sessionRecordResponse, hint: "sessionId 只接受 main 或 UUID。不存在返回 404，不隐式创建。" },
  { operationId: "renameSession", method: "patch", path: "/api/sessions/:sessionId", tag: "会话", summary: "修改会话标题", auth: true, request: req.renameSessionSchema, response: resp.sessionRecordResponse, hint: "title trim 后 1–200 字符。main 的标题固定为默认会话。最后成功保存生效。" },
  { operationId: "resetSession", method: "post", path: "/api/sessions/:sessionId/reset", tag: "会话", summary: "重置会话历史", auth: true, request: req.resetSessionSchema, response: resp.resetSessionResponse,
    hint: "取消运行和待审批，清空 pi JSONL 与消息反馈；公开 sessionId 不变，piSessionId 换新。保留标题、任务、监控和全局资料。历史不可恢复；调用前用户须明确确认。结果未明先回读，不自动重发。" },
  { operationId: "getSessionSchedules", method: "get", path: "/api/sessions/:sessionId/schedules", tag: "会话", summary: "列出删除会话时受影响的任务", auth: true, response: resp.sessionSchedulesResponse,
    hint: "列出会话所属的定时任务和网页监控，包括暂停和已完成项。scheduleRevision 用于绑定删除确认时的任务清单。GET 不创建会话。" },
  { operationId: "deleteSession", method: "delete", path: "/api/sessions/:sessionId", tag: "会话", summary: "删除专题会话", auth: true, request: req.deleteSessionSchema, response: resp.deleteSessionResponse,
    hint: "显式选择删除任务/监控，或保留并转归 main。主会话不可删除。任务列表有变化时返回 409 SESSION_SCHEDULES_CHANGED，保留任务而原会话任务正在执行时返回 409 SESSION_JOB_RUNNING。删除会话历史、反馈并关闭在途聊天。保留任务时待投递监控通知随任务转移。", errorResponses: { 409: { description: "确认清单有变化、原会话的任务仍在执行，或会话不可删除", schema: resp.errorResponse } } },
  { operationId: "getAssistantInstructions", method: "get", path: "/api/assistant/instructions", tag: "助手设置", summary: "读取助手指令", auth: true, response: resp.instructionsResponse, hint: "所有聊天会话共用 workspace/assistant/INSTRUCTIONS.md 原文（缺失为空串）及顶部 YAML frontmatter `include:` 引用诊断 `includes`。支持引用同工作区内相对路径纯文本文件（模型注入前实时展开，问题引用不阻止保存或运行）。独立于短信与新闻领域偏好。" },
  { operationId: "saveAssistantInstructions", method: "put", path: "/api/assistant/instructions", tag: "助手设置", summary: "保存助手指令", auth: true, request: req.saveInstructionsSchema, response: resp.instructionsResponse, hint: "整份替换并保留原文（含顶部 YAML frontmatter `include:`），返回原文与最新 `includes` 诊断；最后成功保存生效。所有聊天会话从下一轮重读并展开可用引用，不能扩大工具/路径/审批权限。" },
  { operationId: "getAssistantSkills", method: "get", path: "/api/assistant/skills", tag: "助手设置", summary: "读取全部可选技能及来源", auth: true, response: resp.skillsResponse,
    hint: "列出当前可选技能，不限于已启用项。来源 user=DATA_DIR/assets/skills 实例自有、builtin=内置自有、shared=服务端用户 ~/.agents/skills 通用目录。按名称合并，优先级 user > builtin > shared；关闭优先项不会回退同名低优先来源。默认开关：内置技能按随服务端发布的 skills-defaults 清单（当前 9 项默认开启），通用与实例自建技能一律默认关闭；手动保存的选择始终优先并绑定来源。返回 id/name/description/source/defaultEnabled/enabled，不返回物理路径。GET 不创建目录或私有 config.json。开关和资产由所有聊天会话共用。" },
  { operationId: "getAssistantSkill", method: "get", path: "/api/assistant/skills/:name", tag: "助手设置", summary: "读取技能正文及来源", auth: true, response: resp.skillDetailResponse,
    hint: "读取当前优先来源的完整 SKILL.md 及来源、助手启用状态，最多 100 KiB；合法名称为 1–64 位小写字母/数字与单连字符。共享目录与内置技能只读，读取正文不启用技能，不加载脚本或扩展。不存在的技能返回 404；非法技能名返回 400。" },
  { operationId: "saveAssistantSkills", method: "put", path: "/api/assistant/skills", tag: "助手设置", summary: "保存助手技能选择", auth: true, request: req.updateSkillsSchema, response: resp.skillsResponse,
    hint: "overrides 整份替换，最后成功保存生效；键必须使用来源 id。保存绑定来源，同名来源新增/替换不继承旧授权；未知或被覆盖的来源身份返回 400。不会修改共享技能文件，也不会自动启用其他技能；下一轮按保存的选择装配，技能不扩大工具、路径或审批权限。" },
  { operationId: "runDream", method: "post", path: "/api/dream/run", tag: "记忆", summary: "立即执行全局记忆整理", auth: true, response: resp.dreamOverviewResponse, hint: "全局单执行槽，逐会话整理；忙时 409，不自动重试。" },
  { operationId: "resolveDreamPending", method: "post", path: "/api/dream/pending/:pendingId", tag: "记忆", summary: "处理全局待决建议", auth: true, request: req.resolveDreamPendingSchema, response: resp.dreamOverviewResponse, hint: "明确应用或忽略；instructions 写入共享助手指令；来源会话仅用于溯源。" },

  {
    operationId: "listTraces",
    method: "get", path: "/api/traces", tag: "模型追踪", summary: "分页读取模型调用摘要",
    auth: true, query: trace.tracesQuerySchema, response: trace.tracesResponse,
    hint: "需 Bearer 鉴权。仅开发者诊断，不进入模型上下文；GET 无副作用，不提供删除/清理 API。" +
      "sessionId/kind 精确匹配；since/until 接受 ISO 日期、带时区 ISO 时间或 Unix 毫秒时间戳，按 startedAt 包含边界过滤。" +
      "按 startedAt 倒序，同时间按 fileName 倒序。默认 20 条，上限 100。游标以最后一条文件名为锚点并绑定过滤条件；" +
      "改变过滤条件或锚点已被保留策略清理时从第一页重读。非法/重复/未知参数、since>until 和非法游标均 400。" +
      "关闭记录或缺少 traces 目录返回空集。单个损坏/不可读文件跳过并计入 badCount（全目录扫描数量，不按过滤缩减）；目录级故障为 500。摘要不含 request/response 正文。",
  },
  {
    operationId: "getTrace",
    method: "get", path: "/api/traces/:fileName", tag: "模型追踪", summary: "读取完整模型调用记录",
    auth: true, response: trace.traceDetailResponse,
    hint: "需 Bearer 鉴权。使用列表 fileName 原样作为单段路径参数：yyyy-mm-dd.HHmmss-sss-sessionId-kind-seq.json；" +
      "严格匹配一期文件格式，只允许 ASCII 字母、数字、点、连字符和下划线；斜杠、反斜杠、路径穿越与格式非法返回 400。" +
      "只读 traces 根内日目录中的普通文件，拒绝符号链接。不存在、损坏或不可读返回 404。返回完整 meta/request/response（原始记录已脱敏）；仅供诊断，不进入模型上下文。",
  },
  {
    operationId: "getTraceByDay",
    method: "get", path: "/api/traces/:day/:fileName", tag: "模型追踪", summary: "按日目录和文件名读取完整调用记录",
    auth: true, response: trace.traceDetailResponse,
    hint: "需 Bearer 鉴权。两段式只读详情：day 为 yyyy-mm-dd，fileName 为 HHmmss-sss-sessionId-kind-seq.json；" +
      "返回的 fileName 仍为列表使用的日目录加点的单段标识。每段严格校验，拒绝路径穿越、斜杠编码、反斜杠和符号链接；" +
      "格式非法 400，不存在、损坏或不可读 404。完整请求与响应仅供开发者诊断，不进入模型上下文。",
  },
  // ---- Android 更新镜像 ----
  {
    operationId: "getLatestAndroidUpdate", method: "get", path: "/updates/android/latest", tag: "应用更新", summary: "读取已同步的 Android 正式版",
    auth: false, response: androidReleaseManifest,
    hint: "无需登录。返回镜像上的已校验安装包和同源下载路径。没有已同步版本返回 503，并在后台尝试同步。",
  },
  {
    operationId: "refreshAndroidUpdate", method: "post", path: "/updates/android/refresh", tag: "应用更新", summary: "通知服务端同步 Android 正式版",
    auth: false, successStatus: 202, response: z.object({ accepted: z.literal(true) }),
    hint: "只接受发布提醒。同步来源固定为官方 GitHub 仓库，服务端不使用请求中的地址、内容或凭据；重复通知会合并。",
  },
  {
    operationId: "downloadAndroidUpdate", method: "get", path: "/updates/android/apk/:tag/:name", tag: "应用更新", summary: "下载指定版本的 Android 安装包",
    auth: false, response: z.string(), responseContentType: "application/vnd.android.package-archive",
    hint: "下载已同步版本的完整 APK。包名和版本只接受发布清单中的值，不存在返回 404。",
  },
  // ---- 基础 ----
  {
    operationId: "getHealth",
    method: "get", path: "/api/health", tag: "基础", summary: "健康检查",
    hint: "无需鉴权；探测服务存活状态、模型配置及权威本地时区（timeZone，如 Asia/Shanghai）。每日定时任务（daily at: HH:mm）以此时区为基准解释，客户端在同地区个人使用场景下无需做 UTC 转换。serviceVersion 为启动/构建时固定快照：version、commit、dirty、sourceHash、mode、builtAt；与 /openapi.json 的 x-service-version 及 /docs 一致。dirty=true 时不能只比较 commit，须核对 sourceHash；commit/dirty 无法核验时为 null。",
    auth: false, request: undefined, response: resp.healthResponse,
  },
  {
    operationId: "createSession",
    method: "post", path: "/api/session", tag: "基础", summary: "登录换取 Bearer token",
    hint: "一切 /api/* 调用的第一步；回环部署无密钥时空 body 即可。",
    auth: false, request: req.sessionRequestSchema, response: resp.sessionResponse,
  },
  {
    operationId: "getConversation",
    method: "get", path: "/api/conversation", tag: "会话", summary: "读取会话权威历史",
    hint: "刷新/恢复时同步历史用；历史只读，客户端不要回写。合法但不存在、已删除或正在删除的 ID 返回 200 {piSessionId:null, messages:[], revision:'empty'}，不创建会话或工作区，不使其出现在列表；非法 ID 返回 400。空历史不代表会话存在，存在性以 GET /api/sessions 为准。消息含工具投影（toolCalls 与 role=tool 消息按 toolCallId 关联）；user/assistant 消息必带 metadata（PI entry 时间、chat/job/notification 可靠来源、run/job/notification 关联与 feedbackAvailable）和当前 feedback。role=user 还可有 attachments；每项为 id/name/kind/mimeType/size/sha256，kind=image 还可带 image:{mimeType,dataBase64} 并按本条 SDK user 的 image blocks 顺序关联，文本正文不自动展开。文件/模型原始错误在进入模型上下文与历史前脱敏，文件缺失使用受控提示，不返回服务端绝对路径。",
    auth: true, query: req.conversationQuerySchema, response: resp.conversationResponse,
  },
  // ---- 消息反馈（独立业务层，持久化于 main.sqlite；不触发模型，不修改 PI 历史）----
  {
    operationId: "listMessageFeedback",
    method: "get", path: "/api/sessions/:sessionId/messages/feedback", tag: "消息反馈",
    summary: "按条件查询会话内有反馈的消息列表",
    hint:
      "按 sessionId+piSessionId 列出仍存在历史中的有反馈消息，可用 saved=true|false 与 reaction=like|dislike 过滤；省略条件返回所有产生过反馈（reaction/saved/comments 非空）的消息。" +
      "按最后反馈时间倒序排列；reset 后旧 piSessionId 返回 409。",
    auth: true, query: message.messageFeedbackListQuerySchema, response: message.messageFeedbackListResponse,
    errorResponses: {
      400: { description: "非法 sessionId、piSessionId 或过滤参数", schema: resp.errorResponse },
      404: { description: "会话不存在", schema: resp.errorResponse },
      409: { description: "piSessionId 不是该会话当前会话，或会话正在删除", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "getMessageFeedback",
    method: "get", path: "/api/sessions/:sessionId/messages/:messageId/feedback", tag: "消息反馈",
    summary: "读取消息当前反馈",
    hint:
      "按 sessionId+piSessionId+messageId 读取用户/助手消息的当前喜欢/不喜欢、收藏（saved）与全部评论。piSessionId 必填；" +
      "reset 后旧 piSessionId 返回 409。会话不存在返回 404，非法参数返回 400。工具结果和未落盘/当前生成中的消息不可反馈，按目标不存在返回 404。本接口不触发模型、不追加聊天消息，也不改变对话 revision。",
    auth: true, query: message.messageTargetSchema, response: message.messageFeedbackResponse,
    errorResponses: {
      400: { description: "非法 sessionId、messageId 或 piSessionId", schema: resp.errorResponse },
      404: { description: "会话或可反馈消息不存在", schema: resp.errorResponse },
      409: { description: "piSessionId 不是该会话当前会话，或会话正在删除", schema: resp.errorResponse },
      503: { description: "服务正在关闭；本次反馈未保存", schema: resp.errorResponse },
    },
  },
  {
    operationId: "listMessageFeedbackEvents",
    method: "get", path: "/api/sessions/:sessionId/messages/:messageId/feedback/events", tag: "消息反馈",
    summary: "读取消息原始反馈事件",
    hint:
      "返回该消息的完整操作历史：reaction 变更/撤销、saved 收藏变更、评论新增、编辑（旧新文本）与删除（删除前文本），均带服务端时间与 ID。事件只追加到 main.sqlite 消息反馈表，不进入 PI branch 或模型上下文；会话 reset/delete 级联删除。",
    auth: true, query: message.messageTargetSchema, response: message.messageFeedbackEventsResponse,
    errorResponses: {
      400: { description: "非法 sessionId、messageId 或 piSessionId", schema: resp.errorResponse },
      404: { description: "会话或可反馈消息不存在", schema: resp.errorResponse },
      409: { description: "piSessionId 不是该会话当前会话，或会话正在删除", schema: resp.errorResponse },
      503: { description: "服务正在关闭；本次反馈未保存", schema: resp.errorResponse },
    },
  },
  {
    operationId: "setMessageReaction",
    method: "put", path: "/api/sessions/:sessionId/messages/:messageId/feedback/reaction", tag: "消息反馈",
    summary: "设置或撤销喜欢/不喜欢",
    hint:
      "reaction 为 like/dislike/null；like 与 dislike 互斥，null 撤销当前反应；不影响 saved 收藏与评论。重复设置当前值不追加事件。成功返回完整当前反馈。反馈不触发模型、不追加聊天消息，也不改变 expectedRevision；同一会话内以前已落盘消息可在流式运行期间反馈。",
    auth: true, request: message.reactionRequestSchema, response: message.messageFeedbackResponse,
    errorResponses: {
      400: { description: "非法请求、reaction 或目标 ID", schema: resp.errorResponse },
      404: { description: "会话、消息或评论不存在；工具/未落盘/当前生成中目标不可反馈", schema: resp.errorResponse },
      409: { description: "piSessionId 不是该会话当前会话，或会话正在删除", schema: resp.errorResponse },
      503: { description: "服务正在关闭；本次反馈未保存", schema: resp.errorResponse },
    },
  },
  {
    operationId: "setMessageSaved",
    method: "put", path: "/api/sessions/:sessionId/messages/:messageId/feedback/saved", tag: "消息反馈",
    summary: "设置或取消消息收藏",
    hint:
      "saved 为布尔值，与 like/dislike 独立并存；重复设置当前值不追加事件。成功返回完整当前反馈。不触发模型、不追加聊天消息，也不改变 expectedRevision；同一会话内以前已落盘消息可在流式运行期间操作。",
    auth: true, request: message.savedRequestSchema, response: message.messageFeedbackResponse,
    errorResponses: {
      400: { description: "非法请求、saved 或目标 ID", schema: resp.errorResponse },
      404: { description: "会话或可反馈消息不存在；工具/未落盘/当前生成中目标不可操作", schema: resp.errorResponse },
      409: { description: "piSessionId 不是该会话当前会话，或会话正在删除", schema: resp.errorResponse },
      503: { description: "服务正在关闭；本次反馈未保存", schema: resp.errorResponse },
    },
  },
  {
    operationId: "addMessageComment",
    method: "post", path: "/api/sessions/:sessionId/messages/:messageId/feedback/comments", tag: "消息反馈",
    summary: "新增消息评论",
    hint:
      "text 先 trim，必须非空且最多 4000 字符。支持多条评论；ID 与 createdAt/updatedAt 由服务端生成。成功返回完整当前反馈。",
    auth: true, request: message.createCommentRequestSchema, response: message.messageFeedbackResponse,
    errorResponses: {
      400: { description: "非法请求、piSessionId、messageId 或空/超长评论", schema: resp.errorResponse },
      404: { description: "会话或可反馈消息不存在", schema: resp.errorResponse },
      409: { description: "piSessionId 不是该会话当前会话，或会话正在删除", schema: resp.errorResponse },
      503: { description: "服务正在关闭；本次反馈未保存", schema: resp.errorResponse },
    },
  },
  {
    operationId: "editMessageComment",
    method: "patch", path: "/api/sessions/:sessionId/messages/:messageId/feedback/comments/:commentId", tag: "消息反馈",
    summary: "编辑消息评论",
    hint:
      "text 先 trim，必须非空且最多 4000 字符。成功返回完整当前反馈；原始事件保留编辑前后文本。相同文本不追加事件；评论不存在返回 404。",
    auth: true, request: message.updateCommentRequestSchema, response: message.messageFeedbackResponse,
    errorResponses: {
      400: { description: "非法请求或空/超长评论", schema: resp.errorResponse },
      404: { description: "会话、消息或评论不存在", schema: resp.errorResponse },
      409: { description: "piSessionId 不是该会话当前会话，或会话正在删除", schema: resp.errorResponse },
      503: { description: "服务正在关闭；本次反馈未保存", schema: resp.errorResponse },
    },
  },
  {
    operationId: "deleteMessageComment",
    method: "delete", path: "/api/sessions/:sessionId/messages/:messageId/feedback/comments/:commentId", tag: "消息反馈",
    summary: "删除消息评论",
    hint:
      "删除当前评论并保留删除前文本的原始事件；重复删除返回 404，不冒充成功。piSessionId 为查询参数。成功返回完整当前反馈。",
    auth: true, query: message.messageTargetSchema, response: message.messageFeedbackResponse,
    errorResponses: {
      400: { description: "非法目标 ID 或 piSessionId", schema: resp.errorResponse },
      404: { description: "会话、消息或评论不存在", schema: resp.errorResponse },
      409: { description: "piSessionId 不是该会话当前会话，或会话正在删除", schema: resp.errorResponse },
      503: { description: "服务正在关闭；本次反馈未保存", schema: resp.errorResponse },
    },
  },
  // ---- 通用用户行为习惯归纳与管理（Habits）----
  {
    operationId: "listHabitSubagents",
    method: "get", path: "/api/habits", tag: "习惯", summary: "列出所有已注册的行为习惯 Subagent",
    hint: "返回全部受通用习惯引擎管理的专职 Subagent 清单（如 sms、news）及各自习惯条数、未消化反馈计数与最近一次归纳状态，无需客户端硬编码列表。",
    auth: true, response: habits.habitSubagentsListResponse,
    errorResponses: {
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "getHabitSubagentOverview",
    method: "get", path: "/api/habits/:subagentId", tag: "习惯", summary: "读取指定 Subagent 的行为习惯列表、待归纳样本与归纳状态",
    hint: "返回该 Subagent（如 sms、news）的名称与说明、已持久化生效的长短期行为习惯条目（habits，最多 50 条）、未消化反馈计数（unconsolidatedCount）与近期去重待归纳样本明细（pendingSignals，按最新倒序最多 20 条）、自动归纳阈值（autoThreshold=5）、定期归纳周期（intervalMs=7200000）、当前已提交游标 cursorSeq 及最近一次归纳统计。未注册 Subagent 返回 404，非法 subagentId 返回 400。",
    auth: true, response: habits.habitSubagentOverviewResponse,
    errorResponses: {
      400: { description: "非法 subagentId 标识", schema: resp.errorResponse },
      404: { description: "未注册该 Subagent", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "createHabit",
    method: "post", path: "/api/habits/:subagentId", tag: "习惯", summary: "手动新增一条 Subagent 行为习惯",
    hint: "向指定 Subagent 手动新增一条行为习惯规范（source=manual，text 为 1–300 字符有效文本），立即在下一次筛选/分析时作为 Consolidated User Habits 生效，不修改工作区 INSTRUCTIONS.md。每个 Subagent 上限 50 条，超限返回 409 LIMIT_EXCEEDED。",
    auth: true, request: habits.createHabitRequestSchema, response: habits.habitItemResponse,
    errorResponses: {
      400: { description: "非法 subagentId 或空/超长/含控制字符的习惯文本", schema: resp.errorResponse },
      404: { description: "未注册该 Subagent", schema: resp.errorResponse },
      409: { description: "已达到每个 Subagent 50 条上限（LIMIT_EXCEEDED）", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "updateHabit",
    method: "patch", path: "/api/habits/:subagentId/:habitId", tag: "习惯", summary: "修改单条行为习惯文本",
    hint: "修改指定 ID 习惯条目的正文并保留其手工编辑版本，立即在下次模型调用时生效。Subagent 或条目不存在返回 404。",
    auth: true, request: habits.updateHabitRequestSchema, response: habits.habitItemResponse,
    errorResponses: {
      400: { description: "非法 subagentId、habitId 或文本", schema: resp.errorResponse },
      404: { description: "Subagent 或习惯条目不存在", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "deleteHabit",
    method: "delete", path: "/api/habits/:subagentId/:habitId", tag: "习惯", summary: "删除单条行为习惯",
    hint: "按 habitId 精确删除指定行为习惯，立即从后续模型提示词移除。Subagent 或条目不存在返回 404。",
    auth: true, response: habits.deleteHabitResponse,
    errorResponses: {
      400: { description: "非法 subagentId 或 habitId", schema: resp.errorResponse },
      404: { description: "Subagent 或习惯条目不存在", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "consolidateHabits",
    method: "post", path: "/api/habits/:subagentId/consolidate", tag: "习惯", summary: "立即触发指定 Subagent 的反馈习惯归纳",
    hint: "请求须为有效 JSON 空对象 {}。按消费游标顺序批量消费该 Subagent 尚未消化的用户反馈热缓冲，调用受限子代理提炼或微调习惯条文（add/edit/delete）；每批仅在模型成功并完成检验后才原子推进 cursorSeq 与清理已消化信号，模型失败/取消绝不丢失原始反馈。同 Subagent 正在归纳返回 409 BUSY。",
    auth: true, request: habits.consolidateHabitsRequestSchema, response: habits.habitSubagentOverviewResponse,
    errorResponses: {
      400: { description: "非法 JSON 或非空对象，或非法 subagentId", schema: resp.errorResponse },
      404: { description: "未注册该 Subagent", schema: resp.errorResponse },
      409: { description: "同 Subagent 已有归纳正在运行（BUSY）", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  // ---- 信息后台（SMS）----
  {
    operationId: "getInformationSettings",
    method: "get", path: "/api/information/settings", tag: "信息后台", summary: "读取信息后台设置",
    hint: "只读查询全局短信/信息后台设置；默认 enabled=false、batchWindowSeconds=15。",
    auth: true, response: information.informationSettingsResponse,
    errorResponses: {
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "updateInformationSettings",
    method: "put", path: "/api/information/settings", tag: "信息后台", summary: "保存信息后台设置",
    hint: "整份替换 enabled 与 batchWindowSeconds（0–3600；0 表示下一调度周期立即处理）。短信子 Agent 使用独立指令 instructions（subagents/sms/INSTRUCTIONS.md）与通用习惯模块 /api/habits/sms，不写入主会话 assistant/INSTRUCTIONS.md。禁用时拒绝实时接入与 runNow 并取消在途轮，未处理队列保留；最后保存生效。",
    auth: true, request: information.informationSettingsRequestSchema, response: information.informationSettingsResponse,
    errorResponses: {
      400: { description: "非法请求或窗口范围", schema: resp.errorResponse },
      409: { description: "会话正在重置或后台忙", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "getInformationPreferences",
    method: "get", path: "/api/information/preferences", tag: "信息后台", summary: "读取信息指令、include 诊断与已归纳习惯",
    hint: "返回用户主动编写的领域指令 instructions 原文（subagents/sms/INSTRUCTIONS.md）、顶部 YAML frontmatter `include:` 引用诊断 includes（loaded/missing/invalid/cycle/depth_exceeded/truncated/empty）、通用习惯引擎沉淀的行为习惯清单 habits 及未消化反馈计数 unconsolidatedFeedbackCount；待归纳反馈样本明细统一通过 GET /api/habits/sms 查看。",
    auth: true, response: information.informationPreferencesResponse,
    errorResponses: {
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "updateInformationPreferences",
    method: "put", path: "/api/information/preferences", tag: "信息后台", summary: "保存信息领域指令",
    hint: "保存用户指令 instructions 原文（最多 20000 字符；空串清空；保留顶部 YAML frontmatter `include:` 引用并返回最新 includes 诊断）到 subagents/sms/INSTRUCTIONS.md，最后保存生效，不写主会话 assistant/INSTRUCTIONS.md；也可通过主对话路由至 sms subagent 修改。",
    auth: true, request: information.informationPreferencesRequestSchema, response: information.informationPreferencesResponse,
    errorResponses: {
      400: { description: "非法请求或超长 instructions", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "createInformationItems",
    method: "post", path: "/api/information/items", tag: "信息后台", summary: "接入日常实时信息（单周期队列）",
    hint: "提交 1–100 条日常实时信息到 queue=realtime；source+externalId 同内容幂等回读，不同内容返回 409 CONFLICT 且不覆盖原文；后台禁用时返回 409 DISABLED。",
    auth: true, request: information.informationIngestRequestSchema, response: information.informationIngestResponse,
    errorResponses: {
      400: { description: "整批或任一条目非法；不会提交任何条目", schema: resp.errorResponse },
      409: { description: "信息后台禁用、同 key 不同内容冲突或已暂停", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "ingestArchiveInformationItems",
    method: "post", path: "/api/information/archive/items", tag: "信息后台", summary: "导入历史归档信息（专用归档队列）",
    hint: "提交 1–500 条历史信息到 queue=archive。归档队列与实时调度完全隔离，仅存储与去重（同内容跳过并计入 skippedCount，同 key 不同内容返回 409），不会触发日常调度器。",
    auth: true, request: information.informationArchiveIngestRequestSchema, response: information.informationArchiveIngestResponse,
    errorResponses: {
      400: { description: "整批或任一条目非法；不会提交任何条目", schema: resp.errorResponse },
      409: { description: "同 key 不同内容冲突", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "runArchiveInformation",
    method: "post", path: "/api/information/archive/run", tag: "信息后台", summary: "触发历史归档队列批量提炼习惯与总览简报",
    hint: "逐批消化 queue=archive 待处理条目并向通用习惯库（/api/habits/sms）增量提交习惯更新（中间批次不推送通知）；当归档队列 pending=0 且不再存在非内容审核的失败时，最多生成 1 条 <=1200 字简报发往主对话。多条目批次若被上游内容安全审核（MODEL_CONTENT_REJECTED）拒绝会自动二分隔离：仅真正触发审核的条目失败，同批其余条目正常处理；此时响应 status 可能为 partial 且 briefingPublished=true，仅被审核跳过的条目数会在简报中自然告知。瞬时/全局故障（网络、5xx、无效结果）仍整批失败并阻断简报，可传 retryFailed=true 重试失败条目；队列为空返回 409 NO_PENDING，忙返回 409 BUSY。",
    auth: true, request: information.informationArchiveRunRequestSchema, response: information.informationArchiveRunResponse,
    errorResponses: {
      400: { description: "非法请求", schema: resp.errorResponse },
      409: { description: "NO_PENDING、BUSY 或后台已暂停", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "listInformationItems",
    method: "get", path: "/api/information/items", tag: "信息后台", summary: "分页读取原始信息条目与判定结果",
    hint: "按接纳时间倒序 SQL 分页读取，支持按 queue（realtime/archive）与 status 过滤；已产生判定结果时直接投影 decision（silent/notify）与 reason 理由；limit 默认 20、范围 1–100。",
    auth: true, query: information.informationItemsQuerySchema, response: information.informationItemsResponse,
    errorResponses: {
      400: { description: "非法查询或游标", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "getInformationItem",
    method: "get", path: "/api/information/items/:itemId", tag: "信息后台", summary: "读取单条信息与关联 run",
    hint: "返回原始条目（已判定时含 decision 与 reason）及关联执行记录；不存在返回 404。",
    auth: true, response: information.informationItemDetailResponse,
    errorResponses: {
      400: { description: "非法 itemId", schema: resp.errorResponse },
      404: { description: "条目不存在", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "getInformationStatus",
    method: "get", path: "/api/information/status", tag: "信息后台", summary: "读取信息后台实时与归档队列进度统计",
    hint: "分别返回日常实时队列 pendingCount/failedCount 与历史归档队列 archive.{running, pendingCount, processedCount, failedCount}。",
    auth: true, response: information.informationStatusResponse,
    errorResponses: {
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "runInformationNow",
    method: "post", path: "/api/information/runs", tag: "信息后台", summary: "立即触发一次日常实时单周期分析",
    hint: "忽略批等待窗口，取最早的一批 queue=realtime pending 条目（最多 20 条，受 60000 字符保护）完成单周期模型判定与通知发布；可传 retryFailed=true 先把失败的实时条目重置为 pending 后重跑。多条目批次若被上游内容安全审核（MODEL_CONTENT_REJECTED）拒绝会自动二分隔离，仅真正触发审核的条目失败、其余条目正常通知。无待处理条目返回 409 NO_PENDING，禁用返回 409 DISABLED，忙返回 409 BUSY。",
    auth: true, request: information.informationRunRequestSchema, response: information.informationRunDetailResponse,
    errorResponses: {
      400: { description: "非法请求", schema: resp.errorResponse },
      409: { description: "DISABLED、NO_PENDING、BUSY 或已暂停", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "listInformationRuns",
    method: "get", path: "/api/information/runs", tag: "信息后台", summary: "分页读取信息处理 run",
    hint: "按开始时间倒序读取执行记录，支持按 kind（realtime/archive）与 status 过滤；包含逐 item 决策与通知投递回执。",
    auth: true, query: information.informationRunsQuerySchema, response: information.informationRunsResponse,
    errorResponses: {
      400: { description: "非法查询或游标", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "getInformationRun",
    method: "get", path: "/api/information/runs/:runId", tag: "信息后台", summary: "读取单个信息处理 run 与原始条目",
    hint: "返回 run 决策、发布状态与本批原始条目；不存在返回 404。",
    auth: true, response: information.informationRunDetailResponse,
    errorResponses: {
      400: { description: "非法 runId", schema: resp.errorResponse },
      404: { description: "run 不存在", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  // ---- 新闻 V1：独立阅读视图，内部复用 information/pi，无专属聊天入口 ----
  {
    operationId: "getNewsStatus",
    method: "get", path: "/api/news/status", tag: "新闻", summary: "读取新闻采集与分析状态",
    hint: "只读状态查询。processing=true 时客户端可仅在新闻页前台短时回读本接口和列表；refreshing/processing 均为 false 或达到终态后停止轮询。后台分析失败时文章仍可读，推荐只包含已确认成功筛选结果。",
    auth: true, response: news.newsStatusResponseSchema,
    errorResponses: { 503: { description: "服务正在关闭", schema: resp.errorResponse } },
  },
  {
    operationId: "listNewsSources",
    method: "get", path: "/api/news/sources", tag: "新闻", summary: "列出 RSS 源",
    hint: "只读列出源配置与健康状态。lastError 为受控文案；lastErrorDetails 与添加源失败的 failure 共用分类字段，不含外部响应体、外部内容或内部堆栈。旧源尚无分类时可省略 lastErrorDetails，不推断旧错误。",
    auth: true, response: news.newsSourceListResponseSchema,
    errorResponses: { 503: { description: "服务正在关闭", schema: resp.errorResponse } },
  },
  {
    operationId: "createNewsSource",
    method: "post", path: "/api/news/sources", tag: "新闻", summary: "添加 RSS 源",
    hint: "仅接受无凭据公网 HTTP(S) URL；最终 HTTP 响应必须 2xx，服务端验证 RSS2 后保存源，不接纳文章。URL 去 fragment、scheme/host 小写、去默认端口后查重，409 文案包含已存在源 ID；不按重定向最终地址归一。条目缺稳定 guid/有效 link 或标题时跳过并返回 skipped；超过一半条目无效则整源 PARSE_INVALID。正文薄或为空但有 ID/标题的条目保留。拒绝带凭据 URL；抓取/解析失败 400 的 failure 为受控分类，不透传上游内容。",
    auth: true, request: news.newsCreateSourceRequestSchema, response: news.newsCreateSourceResponseSchema,
    errorResponses: {
      400: { description: "字段/JSON 非法，或源抓取/解析失败；仅后者携带 failure 分类", schema: news.newsCreateSourceErrorSchema },
      409: { description: "归一 URL 相同的 RSS 源已存在；文案包含已存在的源 ID", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "deleteNewsSource",
    method: "delete", path: "/api/news/sources/:sourceId", tag: "新闻", summary: "停止采集 RSS 源",
    hint: "删除只停止后续采集；已接纳文章及其反馈、收藏和评论继续保留。sourceId 不存在返回 404。",
    auth: true, response: news.newsDeleteSourceResponseSchema,
    errorResponses: {
      400: { description: "非法 sourceId", schema: resp.errorResponse },
      404: { description: "源不存在", schema: resp.errorResponse },
      409: { description: "该源正在本次抓取中", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "listNewsArticles",
    method: "get", path: "/api/news/articles", tag: "新闻", summary: "分页读取新闻文章",
    hint: "按 publishedAt+稳定 ID 倒序分页。view=recommended 只返回成功结构化筛选选中的文章并带 reason；savedOnly 只过滤不改变排序。模型失败不产生假推荐，全部时间线仍可读。",
    auth: true, query: news.newsArticlesQuerySchema, response: news.newsArticleListResponseSchema,
    errorResponses: {
      400: { description: "非法查询或游标", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "getNewsArticle",
    method: "get", path: "/api/news/articles/:articleId", tag: "新闻", summary: "读取新闻文章",
    hint: "返回文章元数据、安全文本、推荐理由和逐篇反馈；不创建或修改任何状态。",
    auth: true, response: news.newsArticleDetailResponseSchema,
    errorResponses: {
      400: { description: "非法 articleId", schema: resp.errorResponse },
      404: { description: "文章不存在", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "setNewsReaction",
    method: "put", path: "/api/news/articles/:articleId/reaction", tag: "新闻", summary: "设置文章喜欢或不喜欢",
    hint: "like/dislike 互斥；null 撤销。反馈按 articleId 会话局部持久化，不绑定聊天消息或 session，也不随主会话 reset 清空。",
    auth: true, request: news.newsReactionRequestSchema, response: news.newsFeedbackResponseSchema,
    errorResponses: {
      400: { description: "非法请求或 articleId", schema: resp.errorResponse },
      404: { description: "文章不存在", schema: resp.errorResponse },
      503: { description: "服务正在关闭；反馈未保存", schema: resp.errorResponse },
    },
  },
  {
    operationId: "setNewsSaved",
    method: "put", path: "/api/news/articles/:articleId/saved", tag: "新闻", summary: "设置文章收藏",
    hint: "saved 独立于 like/dislike；重复设置当前值幂等。收藏作为下一轮分析的弱信号，不立即触发模型。",
    auth: true, request: news.newsSavedRequestSchema, response: news.newsFeedbackResponseSchema,
    errorResponses: {
      400: { description: "非法请求或 articleId", schema: resp.errorResponse },
      404: { description: "文章不存在", schema: resp.errorResponse },
      503: { description: "服务正在关闭；反馈未保存", schema: resp.errorResponse },
    },
  },
  {
    operationId: "addNewsComment",
    method: "post", path: "/api/news/articles/:articleId/comments", tag: "新闻", summary: "新增文章评论",
    hint: "text 先 trim，必须非空且最多 4000 字符。服务端生成 id/createdAt/updatedAt；反馈不写入聊天历史。",
    auth: true, request: news.newsCommentCreateRequestSchema, response: news.newsFeedbackResponseSchema,
    errorResponses: {
      400: { description: "非法请求、articleId 或空/超长评论", schema: resp.errorResponse },
      404: { description: "文章不存在", schema: resp.errorResponse },
      503: { description: "服务正在关闭；评论未保存", schema: resp.errorResponse },
    },
  },
  {
    operationId: "deleteNewsComment",
    method: "delete", path: "/api/news/articles/:articleId/comments/:commentId", tag: "新闻", summary: "删除文章评论",
    hint: "删除指定评论并返回文章当前完整反馈；重复删除返回 404。",
    auth: true, response: news.newsFeedbackResponseSchema,
    errorResponses: {
      400: { description: "非法 articleId 或 commentId", schema: resp.errorResponse },
      404: { description: "文章或评论不存在", schema: resp.errorResponse },
      503: { description: "服务正在关闭；删除未保存", schema: resp.errorResponse },
    },
  },
  {
    operationId: "refreshNews",
    method: "post", path: "/api/news/refresh", tag: "新闻", summary: "手动抓取 RSS 源",
    hint: "请求须为有效 JSON 空对象 {}，非法 JSON 或空请求体返回 400 且无抓取/重置副作用。同步完成逐源抓取并返回 added、skipped，不等待模型分析；已有 information 调度处理 pending。缺标题/稳定 ID 的条目跳过，超过一半无效则该源失败；空正文条目保留并以标题作最小正文。并发 refresh 返回 409。单源或全部源抓取失败仍返回 200，受控文案/分类从 sources 的 lastError/lastErrorDetails 查看，status 提供汇总错误。抓取后尝试重置 failed；新闻模型轮运行时 resetDeferred=true，failed 保持原样，不自动补重试。resetDeferred=false 不保证模型分析完成。不自动重发写入。",
    auth: true, request: news.newsRefreshRequestSchema, response: news.newsRefreshResponseSchema,
    errorResponses: {
      400: { description: "非法 JSON、空请求体或非空对象；不执行抓取/failed 重置", schema: resp.errorResponse },
      409: { description: "已有 refresh 正在运行", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "getNewsPreferences",
    method: "get", path: "/api/news/preferences", tag: "新闻", summary: "读取新闻指令、include 诊断与行为习惯",
    hint: "instructions 是保存在 workspace/subagents/news/INSTRUCTIONS.md 的明确新闻指令原文，includes 报告顶部 YAML frontmatter `include:` 引用展开诊断；habits 与 unconsolidatedFeedbackCount 由通用习惯引擎从逐篇反馈中定期沉淀并提供（样本明细与手动管理统一走 /api/habits/news），不覆盖明确 instructions、会话指令或全局 USER。",
    auth: true, response: news.newsPreferencesResponseSchema,
    errorResponses: { 503: { description: "服务正在关闭", schema: resp.errorResponse } },
  },
  {
    operationId: "updateNewsPreferences",
    method: "put", path: "/api/news/preferences", tag: "新闻", summary: "保存新闻领域指令",
    hint: "instructions 最多 20000 字符，空串清空；最后成功保存生效，原样保留顶部 YAML frontmatter `include:` 引用并返回最新 includes 诊断。本接口和工作区文件页编辑同一份 workspace/subagents/news/INSTRUCTIONS.md，也不触发模型；也可在主聊天路由至 news subagent 调整。",
    auth: true, request: news.newsPreferencesUpdateRequestSchema, response: news.newsPreferencesResponseSchema,
    errorResponses: {
      400: { description: "非法请求或超长 instructions", schema: resp.errorResponse },
      503: { description: "服务正在关闭；指令未保存", schema: resp.errorResponse },
    },
  },
  // ---- 专职 Subagent 检视（只读）----
  {
    operationId: "listSubagents",
    method: "get", path: "/api/subagents", tag: "Subagents", summary: "列出服务端已注册的全部专职 Subagent 及其能力绑定",
    hint: "返回全仓统一注册中心内的所有专职 Subagent（如 sms、news、browser、habits、dream），包含各 Subagent 的触发入口（chat/background）、启用状态、纯函数执行策略、静态绑定的工具/技能/MCP 槽位以及各维度可编辑性元信息。",
    auth: true, response: subagent.subagentsListResponseSchema,
    errorResponses: {
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  {
    operationId: "getSubagent",
    method: "get", path: "/api/subagents/:id", tag: "Subagents", summary: "查看单个专职 Subagent 的完整配置、提示词与能力详情",
    hint: "只读返回目标 Subagent 的完整详情，包括全部内置系统提示词原文与来源路径、静态绑定的工具/技能/MCP 列表，以及（若关联）工作区用户指令原文、include 诊断与已归纳习惯快照。当前仅开放只读检视，不在此接口提供修改。",
    auth: true, response: subagent.subagentDetailResponseSchema,
    errorResponses: {
      400: { description: "非法 Subagent ID 格式", schema: resp.errorResponse },
      404: { description: "Subagent 不存在", schema: resp.errorResponse },
      503: { description: "服务正在关闭", schema: resp.errorResponse },
    },
  },
  // ---- 增量聊天（AG-UI SSE 输出）----
  {
    operationId: "runConversation",
    method: "post", path: "/api/conversation/run", tag: "会话", summary: "提交一条用户消息（SSE 流）",
    hint: `提交 message 和 expectedRevision；版本冲突 409 后重新读取历史。仅接受已存在的会话；删除进行中返回 409 SESSION_DELETING，客户端不自动重试旧 ID。事件顺序：${SSE_EVENT_ORDER}。` +
      "message.attachments 最多 4 项，随本条消息一次性提交：PNG/JPEG/GIF/WebP 单图最大 8MiB，全部原始字节合计最大 8MiB，严格 UTF-8 文本合计最大 100000 字节；请求体上限 12MiB，超限在 SSE/历史/模型开始前返回 413 REQUEST_TOO_LARGE。图片需要当前单业务模型支持视觉，服务端不自动换模型、不静默丢图；PDF/Office/压缩包及其他二进制拒绝，SVG/HTML 只按不可信文本处理。completed 重放或失败显式重试必须保持附件顺序与字节 SHA-256 身份一致。" +
      "主模型可调用 database 工具自主操作 main/news 托管 SQLite：可查询、写入、建表、改列和删表，无逐次 SQL 审批或表级权限。news 与新闻 API 共用同一数据库；main 是默认库，不表示其他业务已全部迁入。该工具不接受任意文件路径、不附加外部数据库或加载扩展；文件 write/edit 的审批边界不变。" +
      "database 的调用/结果按现有 tools.presentation 的 hidden/summary 投影，工具帧隐藏 SQL 参数和原始行；模型仍可能在最终回答中引用结果。Stop 不保证中断已开始的同步 SQL，已提交修改不会因稍后取消而撤销。结果未明先查询核对，不自动重放。" +
      "主模型可在本轮调用 subagent 工具将专职任务路由至服务端已注册且开放 chat 触发的专职 Subagent（如 sms、news、browser），子会话返回结果后主模型继续；这不是独立后台任务队列，不提供创建子任务的 HTTP 接口（可通过 GET /api/subagents 检视全部 Subagent 配置）。" +
      "工具参数统一为 {mode: 'single'|'parallel'|'chain', tasks: [{agent, task}]}；最多 8 项，最多 4 个子会话并发，链式用 {previous} 引用上一步结果，失败即停止；独占资源类 Subagent（如 browser）在 parallel 模式下会被拒绝。" +
      "subagent 的客户端卡片按 tools.presentation 的 hidden/summary 策略显示，参数正文不透出；父 SSE 不直接嵌套子会话聊天流或暴露原始工具详情。" +
      "所有 Subagent 均遵循纯函数语义（无跨次聊天上下文），仅在单次执行周期内拥有独立内存会话记录，所有会话共用同一个扁平工作区，不创建任何子目录；写工作区规则仍走版本绑定人工审批，审批 sessionId/runId 绑定父运行。Stop、父超时、删除会话和聊天流断开会同时取消并等待子会话清理；不会在服务重启后自动续跑。",
    auth: true, request: req.runRequestSchema, response: z.object({}).describe("SSE 流"),
    errorResponses: {
      400: { description: "非法消息、附件或会话 ID；未创建可见用户轮", schema: resp.errorResponse },
      409: { description: "历史版本、运行或消息身份冲突，会话正删除或会话正忙；重新核对，不自动重发", schema: resp.errorResponse },
      413: { description: "run JSON 请求体超过 12MiB；SSE、历史与模型均未开始", schema: resp.errorResponse },
      503: { description: "模型未配置或服务正关闭；本次消息未接纳", schema: resp.errorResponse },
    },
    sse: {
      description: "AG-UI 事件流（text/event-stream，每帧 data: <JSON>）",
      events: sseEvents,
    },
  },
  {
    operationId: "stopConversation",
    method: "post", path: "/api/conversation/stop", tag: "会话", summary: "停止指定运行",
    hint: "sessionId/runId 必须同时匹配当前轮；迟到 Stop 返回 false，不影响下一轮。不存在或正在删除的会话返回 {stopped:false}，不建立会话或工作区。",
    auth: true, request: req.stopRequestSchema, response: z.object({ stopped: z.boolean() }),
  },
  // ---- 工作区文件（手动管理；模型写入仍走审批工具）----
  {
    operationId: "listWorkspaceFiles",
    method: "get", path: "/api/workspace/files", tag: "工作区文件", summary: "列出工作区文件目录",
    hint: "没有 scope/sessionId 选择器，所有请求指向唯一 DATA_DIR/workspace/。path 相对所选根，默认 `.`。返回目录优先、名称升序；目录超过 1000 项返回 413，不截断。符号链接与特殊文件不返回。",
    auth: true, query: files.workspaceListQuerySchema, response: files.workspaceListResponse,
    errorResponses: {
      400: { description: "非法选择器/路径或目录不是普通目录", schema: resp.errorResponse },
      404: { description: "会话或目录不存在", schema: resp.errorResponse },
      413: { description: "目录超过 1000 项", schema: resp.errorResponse },
    },
  },
  {
    operationId: "readWorkspaceFile",
    method: "get", path: "/api/workspace/files/content", tag: "工作区文件", summary: "完整打开或下载工作区文件",
    hint: "读取现存普通文件，最大 8388608 字节，超过返回 413。kind=text 要求严格 UTF-8 且无 NUL，返回完整 content；PNG/JPEG/GIF/WebP 仅在魔数确认后返回 image，其余为 binary；image/binary 返回 dataBase64 与 mimeType。SVG/HTML 按文本原样返回，客户端必须按不可信文本展示而非执行。路径逐段拒绝符号链接，不透出绝对路径。",
    auth: true, query: files.workspaceContentQuerySchema, response: files.workspaceContentResponse,
    errorResponses: {
      400: { description: "非法路径、目标是目录/符号链接或非普通文件", schema: resp.errorResponse },
      404: { description: "会话或文件不存在", schema: resp.errorResponse },
      413: { description: "文件超过下载上限", schema: resp.errorResponse },
    },
  },
  {
    operationId: "createWorkspaceTextFile",
    method: "post", path: "/api/workspace/files/text", tag: "工作区文件", summary: "手动新建文本文件",
    hint: "调用前客户端必须向用户展示完整新内容并获得明确确认，confirmed:true 只表达这个已完成的确认，不创建 preview token、版本协议或服务端审批记录。仅新建；目标存在返回 409。content 最大 100000 UTF-8 字节、必须无 NUL 且是有效 Unicode；路径每段仅允许 ASCII 字母/数字/./-/_。成功返回实际写入后的完整文本详情。",
    auth: true, request: files.workspaceCreateTextSchema, response: files.workspaceTextWriteResponse,
    errorResponses: {
      400: { description: "未显式确认、非法路径/文本或路径不安全", schema: resp.errorResponse },
      404: { description: "会话不存在", schema: resp.errorResponse },
      409: { description: "目标文件已存在", schema: resp.errorResponse },
      413: { description: "文本超过 100000 字节", schema: resp.errorResponse },
    },
  },
  {
    operationId: "updateWorkspaceTextFile",
    method: "put", path: "/api/workspace/files/text", tag: "工作区文件", summary: "手动保存文本文件",
    hint: "调用前客户端必须向用户展示完整 before/after 并获得明确确认；confirmed:true 表达该确认。仅更新已存在普通文本文件，缺失返回 404。content 最大 100000 UTF-8 字节、必须无 NUL 且是有效 Unicode；路径每段仅允许 ASCII 字母/数字/./-/_。服务端用同目录临时文件提交，不截断旧文件；最后一次成功保存生效，不提供版本冲突协议或自动重试。成功返回实际写入后的完整文本详情。手动保存后，旧 pending 模型审批因基准版本变化不能覆盖。",
    auth: true, request: files.workspaceUpdateTextSchema, response: files.workspaceTextWriteResponse,
    errorResponses: {
      400: { description: "未显式确认、非法路径/文本或路径不安全", schema: resp.errorResponse },
      404: { description: "会话或文件不存在", schema: resp.errorResponse },
      409: { description: "提交后无法读回结果", schema: resp.errorResponse },
      413: { description: "文本超过 100000 字节", schema: resp.errorResponse },
    },
  },
  {
    operationId: "deleteWorkspaceFile",
    method: "delete", path: "/api/workspace/files", tag: "工作区文件", summary: "删除工作区普通文件",
    hint: "仅删除现存普通文件；目录、符号链接与特殊文件拒绝，不提供目录删除、重命名、回收站或版本树。成功返回 ok:true 与选择器/path。",
    auth: true, query: files.workspaceDeleteQuerySchema, response: files.workspaceDeleteResponse,
    errorResponses: {
      400: { description: "非法路径、目标是目录/符号链接或非普通文件", schema: resp.errorResponse },
      404: { description: "会话或文件不存在", schema: resp.errorResponse },
    },
  },
  // ---- 人设 ----
  {
    operationId: "getProfile",
    method: "get", path: "/api/profile", tag: "人设", summary: "读取 SOUL/USER 人设文本",
    hint: "读取全局 workspace/assistant/SOUL.md（助手灵魂与人设定位）与 workspace/assistant/USER.md（用户画像与背景偏好）的原始文本内容；未设置或文件不存在时对应字段返回空串，不创建任何文件。两者均支持在文件最顶部使用 YAML frontmatter `include:` 引用同工作区内相对路径纯文本文件（模型注入前实时展开，缺失文件静默跳过，本接口仍返回原始文本）。如需编辑人设，通过 PUT /api/profile 保存。",
    auth: true, response: resp.profileResponse,
  },
  {
    operationId: "updateProfile",
    method: "put", path: "/api/profile", tag: "人设", summary: "保存 SOUL/USER 人设",
    hint: "原样保存（含顶部 YAML frontmatter `include:` 引用），下一轮对话注入前自动展开可用引用（缺失引用不影响保存或运行）；传空串等于清空该段人设。",
    auth: true, request: req.saveProfileSchema, response: resp.profileResponse,
  },
  // ---- 工作区快照 ----
  {
    operationId: "getSessionSnapshot",
    method: "get", path: "/api/identity", tag: "快照", summary: "全量工作区快照",
    hint:
      "工作台首屏读取身份设置；定时任务已迁移至独立 /api/jobs 接口，网页监控已迁移至独立 /api/monitors 接口，长期记忆已迁移至独立 /api/memories 接口，长期目标已迁移至独立 /api/goals 接口，快照中不再包含 tasks、monitors、memories 与 goals 字段。不提供 POST /api/agent/tasks 创建入口；旧调用按未知 API 返回501。" +
      "subagent 是主模型的一次工具调用，不会产生任务记录，结果回到来源聊天；旧 tasks.json 不读取或执行。" +
      "审批横幅由 GET /api/events 的 ready.pendingApprovals 与 approval_pending 事件同步，不在此快照中；旧审批列表接口已下线。",
    auth: true, response: resp.identitySnapshot,
  },
  // ---- 执行活动（只读；登记与推进由对话工具完成）----
  {
    operationId: "listActivities",
    method: "get", path: "/api/activities", tag: "活动", summary: "列出执行活动（按创建时间倒序分页）",
    hint:
      "执行活动是主模型在决定开始推进用户交办的工作时通过对话工具显式登记的记录，不是每轮消息自动生成，" +
      "也不是后端解析回复或按关键词/工具次数机械分类；普通交流、解释、澄清和简单查询通常没有记录。" +
      "本接口只读：没有创建/更新/完成活动的 HTTP 写入口，活动的登记、进展、等待与完成只能由对话工具在真实执行中产生；" +
      "步骤是工具、模型、子代理、审批与文件提交等真实执行事件的安全投影，不含模型内部思维、凭据、原始工具参数或未脱敏日志。" +
      "排序为 createdAt 降序、同一时间按 id 降序；limit 默认 20、范围 1–100。" +
      "cursor 是上一页返回的不透明 base64url，原样回传即可；它绑定生成时的 sessionId/status 过滤条件，改变过滤后必须从第一页重新开始。" +
      "严格校验：未声明参数、重复参数、非法 limit、非法游标（结构/时间/过滤不匹配）一律 400。" +
      "分页不冻结：每次请求读取当前投影，执行中的状态与步骤会更新，期间新增活动只可能出现在第一页，已读页不保证与首次读取一致。" +
      "completed 表示主模型已明确声明完成且结果已交付；单次工具结束、子代理返回或一轮回复结束都不会自动完成。" +
      "awaiting_continuation 表示本轮结束但工作未完成，需用户明确要求继续；继续同一工作时更新原活动（runIds 追加新 run），不新建活动。" +
      "活动随来源会话删除而删除；本接口不新增 SSE 事件，状态变化由客户端重新读取本接口获取。",
    auth: true, query: activity.activitiesQuerySchema, response: activity.activitiesResponse,
  },
  {
    operationId: "getActivity",
    method: "get", path: "/api/activities/:id", tag: "活动", summary: "读取活动详情（概览＋逐步明细）",
    hint:
      "返回 activity 概览与 steps 逐步明细；steps 按真实执行顺序，失败、拒绝、取消、过期与中断如实保留，" +
      "是安全投影而非原始工具载荷或模型思维。只读，不提供修改/完成入口；活动不存在或来源会话已删除返回 404。" +
      "本接口不新增 SSE 事件，客户端在收到工作区通知或用户操作后重新读取。",
    auth: true, response: activity.activityDetailResponse,
  },
  // ---- 定时任务（Jobs）----
  {
    operationId: "listJobs",
    method: "get", path: "/api/jobs", tag: "任务", summary: "查询定时任务列表",
    hint:
      "按条件查询定时任务列表。支持按 sessionId 过滤与排序，全量返回不分页。时区规则：每日任务（daily=true）设定时刻 at 为 HH:mm，按服务端本地时区（GET /api/health.timeZone）解释；下一次运行时刻 nextRunAt 统一以带 Z 的 ISO 8601 UTC 字符串返回，前端通过 new Date(nextRunAt) 即可自动转为本地时间展示。",
    auth: true, query: req.jobsQuerySchema, response: resp.jobsResponse,
  },
  {
    operationId: "getJob",
    method: "get", path: "/api/jobs/:id", tag: "任务", summary: "定时任务详情（含时间线）",
    hint:
      "读取指定定时任务的详细信息及操作/运行时间线；任务不存在返回 404。",
    auth: true, response: resp.jobDetail,
  },
  {
    operationId: "controlJob",
    method: "post", path: "/api/jobs/:id/control", tag: "任务", summary: "控制定时任务（pause/resume/cancel/retry）",
    hint:
      "对定时任务执行生命周期操作：pause=暂停调度，resume=恢复调度，cancel=取消任务，retry=失败任务立即重试。pause 只影响后续调度，不中止正在执行的一轮。",
    auth: true, request: req.jobControlSchema, response: resp.jobItem,
  },
  {
    operationId: "updateJob",
    method: "patch", path: "/api/jobs/:id", tag: "任务", summary: "修改定时任务",
    hint:
      "修改定时任务的提示词（prompt）、执行周期与时刻（daily、at）。时刻设定规则：daily=true 时 at 必须为严格两位 HH:mm（00:00 至 23:59，前导零不可省略），按服务端本地时区解释，前端无需换算；daily=false 时 at 必须为带时区偏移的完整 ISO 8601 时间戳。非法日程返回 400 INVALID_SCHEDULE_FORMAT，不自动进位、不写入；合法日程按服务端本地时区计算并保存。修改时刻且任务处于调度中时，将自动重算下次触发时刻 nextRunAt（ISO 8601 UTC）。任务不存在返回 404。修改任务不改变归属。会话正在删除时返回 409 SESSION_DELETING。",
    auth: true, request: req.updateJobSchema, response: resp.jobItem,
  },
  {
    operationId: "deleteJob",
    method: "delete", path: "/api/jobs/:id", tag: "任务", summary: "删除定时任务",
    hint:
      "彻底删除指定的定时任务；任务不存在返回 404。",
    auth: true, response: resp.deleteJobResponse,
  },
  // ---- 长期记忆（Memories）----
  {
    operationId: "listMemories",
    method: "get", path: "/api/memories", tag: "记忆", summary: "查询或检索长期记忆列表",
    hint: "独立读取 memory.json 中的长期记忆，不依赖工作区大汇总且不广播 SSE。记忆现作为沉淀库按需检索，不再全量拼入每轮 system prompt；可选传入 q（按关键词忽略大小写子串匹配）、limit 及 sort/order（默认按 updatedAt 倒序），省略 q 时返回全部条目。未声明或重复查询参数返回 400。",
    auth: true, query: req.memoriesQuerySchema, response: resp.memoriesResponse,
  },
  {
    operationId: "getMemory",
    method: "get", path: "/api/memories/:id", tag: "记忆", summary: "读取单条记忆详情",
    hint: "读取指定 ID 的长期记忆条目；条目不存在返回 404。",
    auth: true, response: resp.memoryItem,
  },
  {
    operationId: "createMemory",
    method: "post", path: "/api/memories", tag: "记忆", summary: "新增记忆",
    hint: "显式新增一条长期记忆；上限 500 条，满额时返回 409 拒绝写入，绝不静默丢弃旧条目。",
    auth: true, request: req.createMemorySchema, response: resp.memoryItem,
  },
  {
    operationId: "updateMemory",
    method: "patch", path: "/api/memories/:id", tag: "记忆", summary: "修改记忆内容",
    hint: "修改指定 ID 记忆的文本内容，自动更新 updatedAt 时间戳；条目不存在返回 404。",
    auth: true, request: req.updateMemorySchema, response: resp.memoryItem,
  },
  {
    operationId: "deleteMemory",
    method: "delete", path: "/api/memories/:id", tag: "记忆", summary: "删除记忆",
    hint: "按条目 ID 精确删除；条目不存在返回 404。",
    auth: true, response: resp.deleteMemoryResponse,
  },
  {
    operationId: "getGlobalDream",
    method: "get", path: "/api/dream", tag: "记忆", summary: "读取 Dream 后台记忆整理全局概览",
    hint: "返回 Dream 启用开关、固定 2 小时周期、当前是否有整理轮在运行，以及所有已知会话的 Dream 状态与待决建议汇总；系统整理提示词统一托管在服务端仓库 prompts/dream/。",
    auth: true, response: resp.dreamOverviewResponse,
  },
  {
    operationId: "updateGlobalDream",
    method: "put", path: "/api/dream", tag: "记忆", summary: "更新 Dream 后台整理开关",
    hint: "保存全局 Dream 后台自动整理开关 enabled；系统整理提示词由服务端仓库 prompts/dream/ 统一维护，不再支持运行时覆盖。",
    auth: true, request: req.updateDreamSchema, response: resp.dreamOverviewResponse,
  },
  {
    operationId: "saveIdentity",
    method: "post", path: "/api/identity", tag: "人设", summary: "保存身份设置（名字/语气）",
    hint: "保存助手的全局展示身份设置，包括名字（name，注入每轮对话 prompt）、语气风格（tone: warm/concise/thoughtful）、头像标识（avatar）及是否在聊天中显示状态更新（showChatUpdates）。保存后立即生效并同步更新 GET /api/identity 快照。",
    auth: true, request: req.identitySchema, response: resp.identityView,
  },
  // ---- 目标 ----
  {
    operationId: "listGoals",
    method: "get", path: "/api/goals", tag: "目标", summary: "查询目标列表",
    hint: "查询全部长期目标，支持 status、category 过滤以及 sort/order 排序（默认按 updatedAt 倒序）。全量返回目标列表，不分页。未声明或重复查询参数返回 400。",
    auth: true, query: req.goalsQuerySchema, response: resp.goalsResponse,
  },
  {
    operationId: "getGoal",
    method: "get", path: "/api/goals/:id", tag: "目标", summary: "读取单项目标详情",
    hint: "按 ID 查询目标详情及里程碑列表；目标不存在返回 404。",
    auth: true, response: resp.goalView,
  },
  {
    operationId: "createGoal",
    method: "post", path: "/api/goals", tag: "目标", summary: "创建目标（可含里程碑）",
    hint: "新建目标，初始状态为 active；active 目标每轮注入对话（标题+进度+下一里程碑），助手规划类回答会引用。",
    auth: true, request: req.createGoalSchema, response: resp.goalView,
  },
  {
    operationId: "updateGoal",
    method: "patch", path: "/api/goals/:id", tag: "目标", summary: "修改目标属性或状态",
    hint: "修改目标标题、描述、分类或状态；若更新为 completed，自动勾掉名下全部未完成里程碑；目标不存在返回 404。",
    auth: true, request: req.updateGoalSchema, response: resp.goalView,
  },
  {
    operationId: "toggleGoalMilestone",
    method: "post", path: "/api/goals/:id/milestones/:mid/toggle", tag: "目标", summary: "勾选/取消里程碑",
    hint: "切换指定里程碑的完成状态（done/doneAt）；全部勾完不自动完成目标（完成是用户的显式决定）；目标或里程碑不存在返回 404。",
    auth: true, response: resp.goalView,
  },
  {
    operationId: "deleteGoal",
    method: "delete", path: "/api/goals/:id", tag: "目标", summary: "删除目标",
    hint: "按目标 ID 彻底删除；目标不存在返回 404。",
    auth: true, response: resp.deleteGoalResponse,
  },
  // ---- 网页监控（Monitors）----
  {
    operationId: "listMonitors",
    method: "get", path: "/api/monitors", tag: "监控", summary: "查询网页监控列表",
    hint: "按条件查询网页监控列表。支持按 sessionId 过滤，支持按 createdAt、lastCheckedAt、status 排序（默认按 createdAt 降序），全量返回，不分页。",
    auth: true, query: req.monitorsQuerySchema, response: resp.monitorsResponse,
  },
  {
    operationId: "getMonitor",
    method: "get", path: "/api/monitors/:id", tag: "监控", summary: "网页监控详情",
    hint: "读取指定网页监控的配置与检查状态；监控项不存在返回 404。修改监控不改变归属。",
    auth: true, response: resp.monitorItem,
  },
  {
    operationId: "createMonitor",
    method: "post", path: "/api/monitors", tag: "监控", summary: "创建网页监控",
    hint: "创建网页周期监控。change=页面变化通知（首检建基线不通知）；contains=关键词命中通知。📡 结果投递 originSessionId 指定来源，仅省略时投递 main。显式 ID 必须指向已有会话；不存在返回404；删除中返回 409 SESSION_DELETING，客户端刷新列表后由用户重新选择，不自动重试。只有用户删除会话并选择保留时才迁移到主会话。旧扫描不重建会话。",
    auth: true, request: req.createMonitorSchema, response: resp.monitorItem,
  },
  {
    operationId: "controlMonitor",
    method: "post", path: "/api/monitors/:id/control", tag: "监控", summary: "控制监控（pause/resume/stop）",
    hint: "对网页监控执行状态控制：pause=暂停检查，resume=恢复检查，stop=停止监控（终态）。",
    auth: true, request: req.monitorControlSchema, response: resp.monitorItem,
  },
  {
    operationId: "updateMonitor",
    method: "patch", path: "/api/monitors/:id", tag: "监控", summary: "修改网页监控",
    hint: "修改网页监控的标题（title）、URL、触发条件（condition）、关键词（value）、检查间隔（intervalMinutes）。若修改了 URL、触发条件或关键词，将自动重置内容指纹与命中基线。监控项不存在返回 404。修改监控不改变归属。",
    auth: true, request: req.updateMonitorSchema, response: resp.monitorItem,
  },
  {
    operationId: "deleteMonitor",
    method: "delete", path: "/api/monitors/:id", tag: "监控", summary: "删除网页监控",
    hint: "彻底删除指定的网页监控项；监控项不存在返回 404。修改监控不改变归属。",
    auth: true, response: resp.deleteMonitorResponse,
  },
  // ---- 审批 ----
  // 当前 pending 由 GET /api/events 的 ready/approval_pending 直接推送；HTTP 只负责历史读取与人的决定。
  {
    operationId: "listApprovals",
    method: "get", path: "/api/approvals", tag: "审批", summary: "读取已处理/失效审批摘要（分页，不含正文）",
    hint:
      "只返回已处理/失效审批的摘要，不含 preview 正文；当前 pending 不在此列表，由 GET /api/events 的 ready.pendingApprovals 与 approval_pending 事件同步。" +
      "按最近处理时间（resolvedAt）降序、同一时间按 id 降序；limit 默认 20、范围 1–100。" +
      "cursor 是上一页返回的不透明 base64url，原样回传即可；它绑定 status/sessionId/activityId 过滤，改变过滤后必须从第一页重新开始。结构非法、非规范编码或过滤不匹配返回 400。" +
      "严格校验：未声明参数、重复参数、非法 limit、非法游标一律 400。" +
      "分页不冻结：每次请求读取当前审批记录；历史与预览在登记后不可变，已处理/失效审批长期保留，不按时间或数量静默裁剪。" +
      "可按 status（approved/denied/expired/cancelled）、sessionId、activityId 过滤；pending 非法。execution=null 表示尚未观察到执行，不能当作成功。历史记录存在不代表授权仍有效；需要完整预览时读取 GET /api/approvals/:id。",
    auth: true, query: approval.approvalListQuery, response: approval.approvalPage,
    errorResponses: {
      400: { description: "查询参数或游标非法", schema: resp.errorResponse },
    },
  },
  {
    operationId: "listPendingApprovals",
    method: "get", path: "/api/approvals/pending", tag: "审批", summary: "补充读取当前待审批完整预览",
    hint: "只读返回未过期 pending；主要同步来源仍是 SSE ready.pendingApprovals 与 approval_pending，不要求客户端轮询。读取不写入决定、不执行文件操作。execution 为 null，不从授权推断成功。",
    auth: true, response: approval.pendingApprovalsResponse,
  },
  {
    operationId: "getApproval",
    method: "get", path: "/api/approvals/:id", tag: "审批", summary: "读取单个审批完整视图（含不可变预览）",
    hint:
      "返回完整审批视图，包含 title、kind 与 preview 全文；预览在登记时固定，不读取当前文件替换，也不截断。" +
      "pending 与历史审批都可用同一路径读取；不存在返回 404。execution 字段始终存在，null 表示尚未观察到执行，不代表成功；已回报的执行结果独立于人的决定。" +
      "scope=workspace 表示唯一工作区；scope=skill 表示技能文本，path 形如 <技能名>/<文件>。" +
      "单项按 UTF-8 JSON 最大 1.5MB；所有 pending 累计最大 6MB 且最多 32 项；超限时服务端拒绝登记，不截断预览。",
    auth: true, response: approval.approvalView,
    errorResponses: {
      404: { description: "审批不存在", schema: resp.errorResponse },
    },
  },
  {
    operationId: "decideApproval",
    method: "post", path: "/api/approvals/:id/decision", tag: "审批", summary: "审批写操作（approve/deny）",
    hint:
      "模型调用 write/edit 时工具挂起等此决定：approve 才落盘，deny 返回受控拒绝。" +
      "批准只代表授权执行预览中绑定的这一次操作，不代表执行成功；实际结果以 execution 与真实工具、Activity 步骤为准。execution=null 表示尚未观察到执行。" +
      "只有 pending 状态可决定。相同决定的重复提交幂等返回 200 与原审批，revision 不变，不再次执行；" +
      "相反决定、已 expired 或 cancelled 返回 409，响应为 {error, approval: 当前完整审批视图}。" +
      "未知 id 返回 404，请求体非法返回 400，未鉴权由中间件返回 401。" +
      "expired 不是人的决定：status=expired、decidedAt=null，resolvedAt 记录失效时间；有效期由 expiresAt 决定（默认5分钟），后台每秒对齐过期状态，不清理历史。" +
      "执行开始与回执各推进 revision 并推送 approval_updated，但不改 decidedAt/resolvedAt；running 遗留在重启后标记 unknown，不重跑。",
    auth: true, request: approval.approvalDecisionRequest, response: approval.approvalView,
    errorResponses: {
      400: { description: "决定请求体非法（只接受 approve/deny）", schema: resp.errorResponse },
      404: { description: "审批不存在", schema: resp.errorResponse },
      409: {
        description: "审批已处于其他终态或已过期；返回当前完整审批视图",
        schema: z.object({
          error: z.string().describe("受控冲突文案；不包含预览正文或服务端路径"),
          approval: approval.approvalView.describe("当前审批完整视图，供客户端按 (id, revision) 更新本地状态"),
        }),
      },
    },
  },
  // ---- 运行状态（只读单 run 查询）----
  {
    operationId: "getAgentStatus",
    method: "get", path: "/api/runs/status", tag: "活动", summary: "查询单个运行的最新状态",
    hint:
      "只读查询指定 (sessionId, runId) 的最新运行状态，包含运行结束后的最终终态；不调用模型、不建立会话、不创建目录、不写 Activity 历史。" +
      "普通 chat 可能没有登记 Activity，此时 status.activityId 为 null，不是错误。" +
      "活动列表与详情查询保持不变，仍使用 GET /api/activities 与 GET /api/activities/:id。" +
      "响应为 {instanceId, status}：instanceId 标识产生该状态的服务实例，运行 revision 只在该实例内存内有效；" +
      "该 revision 与 GET /api/events 的 ready.sessionStatuses / session_status_updated 共用同一运行状态版本，" +
      "客户端按 revision 合并同一运行的状态，instanceId 变化后清空运行版本缓存。" +
      "sessionId 与 runId 都必填；缺失、重复或未声明参数返回 400，运行不存在或已被清理返回 404。",
    auth: true, query: status.sessionStatusQuery, response: status.sessionStatusResponse,
    errorResponses: {
      400: { description: "查询参数非法", schema: resp.errorResponse },
      404: { description: "运行状态不存在或已被清理", schema: resp.errorResponse },
    },
  },
  // ---- 工作区实时状态推送（独立命名 SSE，不与聊天流共用事件）----
  {
    operationId: "subscribeEvents",
    method: "get", path: "/api/events", tag: "通知", summary: "工作区实时状态推送流（SSE）",
    hint: WORKSPACE_SSE_DESCRIPTION,
    auth: true, response: z.object({}).describe("SSE 流"),
    sse: {
      // 流描述直接复用契约模块的单一事实源；事件表由 workspaceEvents 生成，
      // 事件表由契约维护：状态类事件直接携带可展示投影，conversation_updated 只触发权威历史重读。
      description: WORKSPACE_SSE_DESCRIPTION,
      events: workspaceEvents,
    },
  },
  // ---- 真实浏览器 ----
  {
    operationId: "getBrowserStatus",
    method: "get", path: "/api/browser/status", tag: "浏览器", summary: "查询真实浏览器运行与状态概览",
    hint:
      "无论 tools.browser.enabled 是否开启都会注册；查询不会触发 Chrome 懒启动。" +
      "返回 enabled、running、viewerPath（enabled 时为 /browser）、当前视口 viewport、已知标签统计、待上传/下载计数及人工接管 handoff。",
    auth: true, response: browser.browserStatusResponse,
  },
  {
    operationId: "createBrowserViewerTicket",
    method: "post", path: "/api/browser/viewer-ticket", tag: "浏览器", summary: "换取一次性浏览器操控页启动 ticket",
    hint:
      "必须携带现有 Bearer token。返回的 launchPath 是同源一次性路径，10 分钟有效；用当前服务地址直接 GET 打开，" +
      "服务端签发 HttpOnly 会话 cookie 后 303 到 /browser。浏览器功能关闭返回 503 BROWSER_DISABLED。不要把长期 token 放进 URL。",
    auth: true, response: browser.browserViewerTicketResponse,
    errorResponses: {
      503: { description: "浏览器已关闭（BROWSER_DISABLED）", schema: resp.errorResponse },
    },
  },
  {
    operationId: "launchBrowserViewer",
    method: "get", path: "/browser/launch", tag: "浏览器", summary: "消费一次性 ticket 并进入浏览器操控页",
    hint:
      "URL query 携带 POST /api/browser/viewer-ticket 返回的 ticket；有效时签发 HttpOnly 会话 cookie" +
      "（SameSite=Strict，Path=/，Max-Age=3600，HTTPS 直连带 Secure，仅授权 /api/browser/* 路由不含 viewer-ticket）并 303 到 /browser。" +
      "ticket 无效、过期或重放返回 401；浏览器关闭返回 503。该端点不用 Bearer 鉴权，凭 ticket 自身把关。",
    auth: false, response: browser.browserLaunchResponse,
    successStatus: 303,
    query: browser.browserLaunchQuerySchema,
    errorResponses: {
      401: { description: "ticket 无效、已过期或已被使用", schema: resp.errorResponse },
      503: { description: "浏览器已关闭（BROWSER_DISABLED）", schema: resp.errorResponse },
    },
  },
  {
    operationId: "getBrowserViewerPage",
    method: "get", path: "/browser", tag: "浏览器", summary: "打开服务端响应式真实浏览器操控页",
    hint: "免鉴权 HTML 页面，同时适配手机竖屏与桌面端。支持通过 /browser/launch 会话 cookie、无 AccessKey 静默登录或手动输入 AccessKey 调用 POST /api/session 获取 Session Token（清空输入框并移除 URL 中的 accessKey/key）。连接 /ws/browser 实时接收 JPEG 帧流、动态切换手机/桌面视口、原生中文输入、双指缩放与单指滚屏、实时文件上传下载以及人工接管确认。",
    auth: false, response: browser.browserViewerPageResponse, responseContentType: "text/html",
  },
  {
    operationId: "updateBrowserViewport",
    method: "put", path: "/api/browser/viewport", tag: "浏览器", summary: "切换共享真实浏览器的视口尺寸与触控模式",
    hint: "支持 desktop（默认 1280×800）、mobile（默认 390×720，启用触控模拟）或 custom（指定 320–2560 宽高）。修改后会同步更新所有标签视口、重启活跃 screencast 推流并广播 viewport 与 browser_updated 事件。",
    auth: true, request: browser.browserViewportUpdateSchema, response: browser.browserViewportResponse,
    errorResponses: {
      400: { description: "视口预设、尺寸范围或参数非法", schema: resp.errorResponse },
    },
  },
  {
    operationId: "resolveBrowserHandoff",
    method: "delete", path: "/api/browser/handoff", tag: "浏览器", summary: "解除当前浏览器人工接管等待状态",
    hint: "用户在 /browser 手动完成登录、扫码或验证码后调用，幂等清除当前 handoff 状态并广播给 WS 与 /api/events 订阅者。",
    auth: true, response: browser.browserOkResponse,
  },
  {
    operationId: "listBrowserTabs",
    method: "get", path: "/api/browser/tabs", tag: "浏览器", summary: "列出真实浏览器标签",
    hint: "首次调用会懒启动系统 Chrome（或按 tools.browser.cdpUrl 附着外部 Chrome）并使用 DATA_DIR/runtime/browser/profile 持久 profile。返回全局标签列表；只有 active=true 的标签会推送帧。",
    auth: true, response: browser.browserTabsResponse,
  },
  {
    operationId: "createBrowserTab",
    method: "post", path: "/api/browser/tabs", tag: "浏览器", summary: "新建浏览器标签",
    hint: "可传初始 HTTP(S) URL；省略时打开 about:blank。私网目标默认被拒绝，需 tools.browser.allowPrivateTargets=true 才允许本机联调。",
    auth: true, request: browser.createBrowserTabSchema, response: browser.browserTab,
  },
  {
    operationId: "closeBrowserTab",
    method: "delete", path: "/api/browser/tabs/:tabId", tag: "浏览器", summary: "关闭浏览器标签",
    hint: "关闭指定标签；若关闭激活标签，剩余第一个标签会成为新的激活标签。若关闭的标签正在人工接管中，同时清除 handoff。标签不存在返回 404。",
    auth: true, response: browser.browserTabsResponse,
  },
  {
    operationId: "activateBrowserTab",
    method: "post", path: "/api/browser/tabs/:tabId/activate", tag: "浏览器", summary: "激活浏览器标签",
    hint: "全局只允许一个 active 标签。切换后旧标签停止 screencast，新标签在存在 WS 订阅者时重启 screencast。",
    auth: true, response: browser.browserTab,
  },
  {
    operationId: "navigateBrowserTab",
    method: "post", path: "/api/browser/tabs/:tabId/navigation", tag: "浏览器", summary: "导航、后退、前进或刷新",
    hint: "action=navigate 必须带 HTTP(S) url；back/forward/reload 不带 url。返回最新标签状态，页面标题和内容都是不可信外部数据。",
    auth: true, request: browser.browserNavigationSchema, response: browser.browserTab,
  },
  {
    operationId: "createBrowserWebSocketTicket",
    method: "post", path: "/api/browser/ws-ticket", tag: "浏览器", summary: "换取一次性浏览器 WS ticket",
    hint: "必须携带现有 Bearer token（或有效的 /browser/launch 浏览器会话 cookie）。返回的 ticket 10 分钟过期且只能使用一次；WS 地址为 /ws/browser?ticket=...。完整二进制帧、ready/tabs/viewport/files/handoff/error、输入与 ack 协议见 OpenAPI 顶层 x-websocket-contracts.browser，OpenAPI 不把 WebSocket 伪装成普通 HTTP operation。",
    auth: true, response: browser.browserTicketResponse,
  },
  {
    operationId: "listBrowserFiles",
    method: "get", path: "/api/browser/files", tag: "浏览器",
    summary: "列出待上传 filechooser 与持久下载记录",
    hint:
      "必须携带现有 Bearer token（或有效的浏览器会话 cookie）。uploads 只来自真实页面的 filechooser 事件，每页最多一个当前 chooser；页面主导航、关闭或出现新 chooser 后旧项失效。" +
      "downloads 来自 Playwright download 事件并持久化在 DATA_DIR/runtime/browser/downloads，普通模型文件工具无法读取。" +
      "完成下载在重启后可读；中断下载标记 failed，不自动重新下载。读取损坏持久数据返回受控 500，不能当作空列表。" +
      "该 GET 不会因为下载目录为空而启动 Chrome。",
    auth: true, response: browser.browserFilesResponse,
    errorResponses: {
      500: { description: "下载持久数据损坏或浏览器文件存储不可用；错误已脱敏", schema: resp.errorResponse },
    },
  },
  {
    operationId: "uploadBrowserFiles",
    method: "post", path: "/api/browser/uploads/:uploadId", tag: "浏览器",
    summary: "把用户明确选择的本地文件写入当前页面 filechooser",
    hint:
      "只接受 GET /api/browser/files 或 WS files 推送返回的有效 uploadId。客户端必须在 Files 面板让用户选择本地文件并点击 Upload 后才能调用；服务端只使用请求中的内存 Base64 字节调用 Playwright fileChooser.setFiles，不读取服务端路径或 workspace。" +
      "单选 chooser 必须恰好 1 个文件；多选允许 1 到 4 个；原始字节合计最多 8MiB。contentBase64 必须是严格 Base64 且无 data: 前缀；name 只允许 ASCII 字母、数字、点、下划线和连字符，不能以点开头或包含路径；空 mimeType 使用 application/octet-stream。" +
      "该精确 POST 路径的 JSON 请求体上限为 12MiB；请求体或原始总字节超限返回 413。缺失、已过期、页面关闭或主导航后的 chooser 返回 404；文件数量等非法输入返回 400。成功会消费该一次性 chooser，不新增聊天工具或文件审批旁路。",
    auth: true, request: browser.browserUploadRequest, response: browser.browserOkResponse,
    errorResponses: {
      400: { description: "文件名、Base64、MIME 或文件数量非法", schema: resp.errorResponse },
      404: { description: "chooser 不存在、已过期、页面已关闭或已主导航", schema: resp.errorResponse },
      413: { description: "文件原始字节合计超过 8MiB，或 JSON 请求体超过 12MiB", schema: resp.errorResponse },
      500: { description: "浏览器或文件存储操作失败；错误已脱敏", schema: resp.errorResponse },
    },
  },
  {
    operationId: "cancelBrowserUpload",
    method: "delete", path: "/api/browser/uploads/:uploadId", tag: "浏览器",
    summary: "取消待上传 filechooser",
    hint:
      "只删除当前 uploadId 的待处理记录，不使用 setFiles([]) 清空页面已有文件选择。" +
      "缺失或已失效返回 404；不会关闭页面、导航或影响其他标签。",
    auth: true, response: browser.browserOkResponse,
    errorResponses: {
      404: { description: "chooser 不存在或已失效", schema: resp.errorResponse },
    },
  },
  {
    operationId: "getBrowserDownloadContent",
    method: "get", path: "/api/browser/downloads/:downloadId/content", tag: "浏览器",
    summary: "读取已完成浏览器下载内容",
    hint:
      "返回持久化下载的 name、mimeType 与严格 Base64 contentBase64，不返回服务端路径。" +
      "仅 completed 可读；downloading 或 failed 返回 409，缺失返回 404。损坏持久数据返回受控 500，不能假装空内容。",
    auth: true, response: browser.browserDownloadContentResponse,
    errorResponses: {
      404: { description: "下载记录不存在", schema: resp.errorResponse },
      409: { description: "下载尚未完成或已失败", schema: resp.errorResponse },
      500: { description: "下载持久数据损坏或读取失败；错误已脱敏", schema: resp.errorResponse },
    },
  },
  {
    operationId: "deleteBrowserDownload",
    method: "delete", path: "/api/browser/downloads/:downloadId", tag: "浏览器",
    summary: "删除浏览器自有下载",
    hint:
      "只删除 DATA_DIR/runtime/browser/downloads 中该 UUID 目录。进行中的下载会先 cancel；异步完成不能复活已删除记录。" +
      "缺失返回 404；删除后 content 与列表记录均不可再读取。",
    auth: true, response: browser.browserOkResponse,
    errorResponses: {
      400: { description: "downloadId 不是合法 UUID", schema: resp.errorResponse },
      404: { description: "下载记录不存在", schema: resp.errorResponse },
      500: { description: "下载目录不是安全的浏览器自有存储；错误已脱敏", schema: resp.errorResponse },
    },
  },
];
