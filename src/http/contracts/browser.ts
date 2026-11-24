import { z } from "zod";

export const browserTab = z.strictObject({
  id: z.string().describe("服务端生成的标签页 ID"),
  title: z.string().describe("当前页面标题；外部标题是不可信数据"),
  url: z.string().describe("当前页面 URL"),
  active: z.boolean().describe("是否为当前激活标签；只有激活标签会推帧"),
  loading: z.boolean().describe("是否处于导航加载中"),
});

export const browserTabsResponse = z.strictObject({
  tabs: z.array(browserTab).describe("全局标签列表"),
});

export const browserTicketResponse = z.strictObject({
  ticket: z.string().describe("一次性 WS ticket；10 分钟过期且使用后立即失效"),
  expiresAt: z.string().describe("ticket 过期时间（ISO 8601）"),
});

export const browserViewportPresetSchema = z.enum(["desktop", "mobile", "custom"]);

export const browserViewportSchema = z.strictObject({
  preset: browserViewportPresetSchema.describe("视口预设：desktop、mobile 或 custom"),
  width: z.number().int().min(320).max(2560).describe("当前浏览器 CSS 视口宽度（px）"),
  height: z.number().int().min(320).max(2560).describe("当前浏览器 CSS 视口高度（px）"),
  mobile: z.boolean().describe("是否开启移动端触控模拟（Emulation.setTouchEmulationEnabled）"),
});

export const browserViewportUpdateSchema = z.strictObject({
  preset: browserViewportPresetSchema.describe("目标视口预设：desktop（默认 1280×800）、mobile（默认 390×720）或 custom"),
  width: z.number().int().min(320).max(2560).optional().describe("可选视口宽度（custom 必填，320–2560）"),
  height: z.number().int().min(320).max(2560).optional().describe("可选视口高度（custom 必填，320–2560）"),
  mobile: z.boolean().optional().describe("可选触控模拟开关；desktop 默认 false，mobile 默认 true"),
});

export const browserViewportResponse = z.strictObject({
  viewport: browserViewportSchema,
});

export const browserHandoffSchema = z.strictObject({
  id: z.string().describe("人工接管请求唯一 ID"),
  tabId: z.string().describe("请求接管的标签页 ID"),
  reason: z.string().describe("模型说明需要用户人工操作的原因（如登录、扫码或验证码）"),
  url: z.string().describe("发起接管时该标签页当前 URL"),
  createdAt: z.iso.datetime().describe("接管请求创建时间（ISO 8601）"),
});

export const browserStatusResponse = z.strictObject({
  enabled: z.boolean().describe("tools.browser.enabled；false 时 viewerPath 为 null"),
  running: z.boolean().describe("真实 GUI Chrome 当前是否已启动；查询状态不会触发懒启动"),
  viewerPath: z.string().nullable().describe("同源浏览器操控页路径；enabled 时固定 /browser"),
  tabsCount: z.number().int().min(0).describe("当前已知标签数；未启动时为 0"),
  activeTabId: z.string().nullable().describe("当前激活标签 ID；未启动或无标签时为 null"),
  viewport: browserViewportSchema.describe("当前共享真实浏览器的视口与触控状态"),
  pendingUploadsCount: z.number().int().min(0).describe("当前待上传 filechooser 数量"),
  downloadsCount: z.number().int().min(0).describe("持久下载记录总数"),
  handoff: browserHandoffSchema.nullable().describe("当前进行中的人工接管请求；无则为 null"),
});

export const browserViewerTicketResponse = z.strictObject({
  launchPath: z.string().describe("同源一次性操控页启动路径，10 分钟有效；直接以同源地址 GET 打开"),
  expiresAt: z.string().describe("ticket 过期时间（ISO 8601）"),
});

export const browserLaunchQuerySchema = z.strictObject({
  ticket: z.string().min(1).describe("一次性浏览器 viewer ticket"),
});

export const browserLaunchResponse = z.null()
  .describe("无响应体：303 重定向到 /browser，同时签发 HttpOnly 浏览器域会话 cookie");

export const createBrowserTabSchema = z.strictObject({
  url: z.url().max(2048).regex(/^https?:\/\//, "http(s) only").optional()
    .describe("可选初始地址；省略时打开 about:blank"),
});

export const browserNavigationSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("navigate").describe("跳转到 url"),
    url: z.url().max(2048).regex(/^https?:\/\//, "http(s) only").describe("目标 HTTP(S) 地址"),
  }),
  z.strictObject({ action: z.literal("back").describe("后退一步") }),
  z.strictObject({ action: z.literal("forward").describe("前进一步") }),
  z.strictObject({ action: z.literal("reload").describe("重新加载") }),
]);

export const browserViewerPageResponse = z.string().describe("服务端自带的响应式真实浏览器操控页 HTML");

const browserFileName = z.string()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/,
    "file names may contain only ASCII letters, digits, dot, underscore and hyphen, and cannot start with a dot",
  );
const isStrictBase64 = (value: string) => {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let index = 0; index < value.length - padding; index++) {
    const code = value.charCodeAt(index);
    if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    ) return false;
  }
  return true;
};
const browserFileBase64 = z.string()
  .refine(isStrictBase64, "strict base64 without data prefix");

export const browserUploadSchema = z.strictObject({
  id: z.string().describe("服务端为当前 filechooser 生成的一次性 ID"),
  tabId: z.string().describe("触发 filechooser 的标签页 ID"),
  multiple: z.boolean().describe("页面 input 是否允许选择多个文件"),
  accept: z.string().describe("页面 input 的 accept 属性；空字符串表示未限制类型"),
  createdAt: z.iso.datetime().describe("filechooser 事件发生时间（ISO 8601）"),
});

export const browserDownloadSchema = z.strictObject({
  id: z.string().describe("服务端生成的下载 UUID"),
  tabId: z.string().describe("触发下载的标签页 ID"),
  name: z.string().describe("清理为单层 ASCII 文件名后的建议下载名"),
  status: z.enum(["downloading", "completed", "failed"]).describe("下载状态"),
  bytes: z.number().int().min(0).max(33_554_432).nullable()
    .describe("完成后的字节数；下载中或失败时为 null"),
  createdAt: z.iso.datetime().describe("Playwright download 事件发生时间（ISO 8601）"),
  error: z.string().nullable().describe("失败时返回稳定错误文案；其他状态为 null"),
});

export const browserFilesResponse = z.strictObject({
  uploads: z.array(browserUploadSchema)
    .describe("当前页面 filechooser；每页最多一个，导航、关闭或新 chooser 会替换/移除"),
  downloads: z.array(browserDownloadSchema)
    .describe("持久下载记录；完成记录在重启后仍可读取，中断记录标记 failed"),
});

export const browserUploadRequest = z.strictObject({
  files: z.array(z.strictObject({
    name: browserFileName.describe("单层文件名；只允许 ASCII 字母、数字、点、下划线和连字符，且不能以点开头"),
    mimeType: z.string().max(255).describe("MIME 类型；空字符串按 application/octet-stream 处理"),
    contentBase64: browserFileBase64.describe("严格 Base64 内存内容；不得带 data: 前缀"),
  })).min(1).max(4).describe("真实 chooser 对应的本地文件内容；单选必须 1 项，多选 1 到 4 项，原始字节合计不超过 8MiB"),
});

export const browserDownloadContentResponse = z.strictObject({
  name: z.string().describe("持久化的安全单层文件名"),
  mimeType: z.string().describe("下载内容 MIME 类型；当前为 application/octet-stream"),
  contentBase64: z.string().describe("已完成下载的严格 Base64 内容，不含 data: 前缀"),
});

export const browserOkResponse = z.strictObject({
  ok: z.literal(true),
});

const pointerButton = z.enum(["left", "middle", "right"]).optional();
const coordinate = z.number().finite().min(0).max(20000);
const scrollDelta = z.number().finite().min(-100000).max(100000);
const keySchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9]+([+][a-zA-Z0-9]+)*$/);

export const browserInputMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("pointer_move"), x: coordinate, y: coordinate }),
  z.strictObject({ type: z.literal("pointer_down"), x: coordinate, y: coordinate, button: pointerButton }),
  z.strictObject({ type: z.literal("pointer_up"), x: coordinate, y: coordinate, button: pointerButton }),
  z.strictObject({
    type: z.literal("click"),
    x: coordinate,
    y: coordinate,
    button: pointerButton,
    clickCount: z.number().int().min(1).max(3).optional(),
  }),
  z.strictObject({
    type: z.literal("wheel"),
    x: coordinate.optional(),
    y: coordinate.optional(),
    deltaX: scrollDelta,
    deltaY: scrollDelta,
  }),
  z.strictObject({ type: z.literal("key_down"), key: keySchema }),
  z.strictObject({ type: z.literal("key_up"), key: keySchema }),
  z.strictObject({ type: z.literal("insert_text"), text: z.string().min(1).max(2000) }),
]);

export const browserClientViewportMessageSchema = z.strictObject({
  type: z.literal("viewport"),
  preset: browserViewportPresetSchema,
  width: z.number().int().min(320).max(2560).optional(),
  height: z.number().int().min(320).max(2560).optional(),
  mobile: z.boolean().optional(),
});

export const browserServerTabsMessageSchema = z.strictObject({
  type: z.literal("tabs"),
  tabs: z.array(browserTab),
  activeTabId: z.string().nullable(),
});

export const browserServerViewportMessageSchema = z.strictObject({
  type: z.literal("viewport"),
  viewport: browserViewportSchema,
});

export const browserServerFilesMessageSchema = z.strictObject({
  type: z.literal("files"),
  uploads: z.array(browserUploadSchema),
  downloads: z.array(browserDownloadSchema),
});

export const browserServerHandoffMessageSchema = z.strictObject({
  type: z.literal("handoff"),
  handoff: browserHandoffSchema.nullable(),
});

export const browserServerReadyMessageSchema = z.strictObject({
  type: z.literal("ready"),
  tabs: z.array(browserTab),
  activeTabId: z.string().nullable(),
  viewport: browserViewportSchema,
  files: browserFilesResponse,
  handoff: browserHandoffSchema.nullable(),
  frameFormat: z.string(),
});

export const browserServerErrorMessageSchema = z.strictObject({
  type: z.literal("error"),
  error: z.string(),
});

export const browserAckMessageSchema = z.strictObject({
  type: z.literal("frame_ack"),
  frameId: z.number(),
  sessionId: z.string(),
});

/**
 * OpenAPI 不描述 WebSocket，这里用 x-websocket-contracts 明确机器可读协议；
 * 不把 /ws/browser 伪装成普通 HTTP operation。
 */
export const browserWebSocketContract = {
  path: "/ws/browser",
  summary: "真实浏览器帧流、动态视口、实时文件与输入协议",
  description:
    "先以 Bearer token（或同源浏览器会话 cookie）调用 POST /api/browser/ws-ticket 获取一次性 10 分钟 ticket，再用 " +
    "当前访问地址对应的 ws://<host>/ws/browser?ticket=<ticket> 或 wss://<host>/ws/browser?ticket=<ticket> 升级。页面不内置服务地址，本机地址、局域网地址、域名和反向代理地址均可；HTTPS 反向代理下应转发 wss。ticket 使用一次后立即删除，不把长期 token 放 URL。 " +
    "服务端先发送 ready（含 tabs、viewport、files、handoff），随后实时推送 tabs、viewport、files 与 handoff 变化。帧为二进制：4 字节大端 metadataLength + UTF-8 JSON metadata + JPEG 字节。 " +
    "客户端必须绘制帧后发送 {type:'frame_ack',frameId,sessionId}；慢客户端会被跳帧，缓冲超过 2MiB 会断开。 " +
    "仅当前激活标签推帧；切换标签或调整视口时会重启 screencast 并立即发送首帧。没有订阅者时不推流。",
  authentication: "POST /api/browser/ws-ticket 换取的一次性短时 ticket（10 分钟有效）；WS URL query 只携带该 ticket",
  frameFormat: "uint32be metadataLength + utf8-json metadata + jpeg bytes",
  serverMessages: {
    ready: browserServerReadyMessageSchema,
    tabs: browserServerTabsMessageSchema,
    viewport: browserServerViewportMessageSchema,
    files: browserServerFilesMessageSchema,
    handoff: browserServerHandoffMessageSchema,
    error: browserServerErrorMessageSchema,
  },
  clientMessages: {
    frame_ack: browserAckMessageSchema,
    viewport: browserClientViewportMessageSchema,
    input: browserInputMessageSchema,
  },
} as const;

export type BrowserStatusDto = z.infer<typeof browserStatusResponse>;
export type BrowserViewportDto = z.infer<typeof browserViewportSchema>;
export type BrowserViewportUpdateDto = z.infer<typeof browserViewportUpdateSchema>;
export type BrowserHandoffDto = z.infer<typeof browserHandoffSchema>;
export type BrowserViewerTicketDto = z.infer<typeof browserViewerTicketResponse>;
