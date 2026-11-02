import { z } from "zod";
import * as info from "./information.js";
export const featureBindingRequest = z.strictObject({ spaceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).describe("已存在的普通工作空间；不是 sessionId，不接受内部功能空间") });
export const featureResponse = z.strictObject({ id: z.enum(["news", "sms"]), name: z.string(), targetSpaceId: z.string().describe("稳定交互承接空间，默认 local-main；不随当前页面、会话重置而改变") });
export const featuresResponse = z.strictObject({ features: z.array(featureResponse) });
export const newsDiscussionRequest = z.strictObject({ articleId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
export const featureDiscussionResponse = z.strictObject({ spaceId: z.string(), sessionId: z.string(), messageId: z.string(), notificationId: z.string() });

export const featureEndpoints = [
  { operationId: "listFeatures", method: "get" as const, path: "/api/features", summary: "列出独立功能与承接空间", response: featuresResponse,
    hint: "新闻与短信各自拥有独立内部 Space，内部数据不属于承接空间，也不允许经普通空间、聊天或文件 API 访问。绑定默认 local-main，配置持久化；GET 不创建绑定文件。新闻有独立阅读页，短信只有管理页与后台处理，没有独立聊天窗口。" },
  { operationId: "bindFeature", method: "put" as const, path: "/api/features/:featureId/binding", summary: "更换功能交互承接空间", request: featureBindingRequest, response: featureResponse,
    hint: "featureId 仅 news/sms。只接受已存在的普通工作空间，404 不创建目标。最后成功保存生效；只影响之后新接纳的处理轮/讨论，已接纳的在途交互保留旧目标。不会迁移功能数据、移动历史消息或复制配置；旧消息仍关联原功能。绑定的目标禁止删除（409 FEATURE_BOUND），须先显式改绑；不自动回退 main。重置目标保留绑定，但取消该旧会话的排队通知，不重发。" },
  { operationId: "discussNews", method: "post" as const, path: "/api/features/news/discussions", summary: "把新闻带到承接会话讨论", request: newsDiscussionRequest, response: featureDiscussionResponse,
    hint: "服务端读取文章并将来源与内容写入绑定空间当前会话；不会调用模型、自动发问或将全部新闻推送聊天。若该会话运行中则等待其通知队列；返回真实落盘 receipt。客户端成功后切到返回 spaceId 并回读权威聊天，用户继续发问。该写操作非幂等，不得因超时/断线自动重发；结果未明先检查目标历史。通知 metadata.featureSource 含已验证来源；聊天的 feature 工具只能沿本会话来源查询原始内容或保存明确反馈，不能跨空间读写文件。气泡反馈在功能下一轮中按消息关联读取，不写全局偏好；reset 清理聊天反馈与关联，不恢复旧消息。" },
  { operationId: "getSmsSettings", method: "get" as const, path: "/api/features/sms/settings", summary: "读取短信功能开关", response: info.informationSettingsResponse },
  { operationId: "saveSmsSettings", method: "put" as const, path: "/api/features/sms/settings", summary: "保存短信功能开关", request: info.informationSettingsRequestSchema, response: info.informationSettingsResponse,
    hint: "短信配置与数据属于独立功能，不跟随当前普通空间。首次默认关闭；保存先暂停并取消在途短信处理轮，禁用后不接纳、不自动处理。不会搬移、清除或接管历史普通空间 information 数据；原空间 API 继续管理那些既有通用信息。" },
  { operationId: "getSmsPreferences", method: "get" as const, path: "/api/features/sms/preferences", summary: "读取短信偏好与承接消息反馈", response: info.informationPreferencesResponse },
  { operationId: "saveSmsPreferences", method: "put" as const, path: "/api/features/sms/preferences", summary: "保存短信偏好", request: info.informationPreferencesRequestSchema, response: info.informationPreferencesResponse },
  { operationId: "listSmsItems", method: "get" as const, path: "/api/features/sms/items", summary: "读取短信处理条目", query: info.informationItemsQuerySchema, response: info.informationItemsResponse },
  { operationId: "ingestSmsItems", method: "post" as const, path: "/api/features/sms/items", summary: "向独立短信功能上报信息", request: info.informationIngestRequestSchema, response: info.informationIngestResponse,
    hint: "只接受 source=sms；source+externalId 为功能内幂等键，同 key 不同内容 409。自动采集需 Android 原生模块、用户短信权限和存活的应用进程，不保证应用被系统终止后接收；Expo Go 不支持自动采集，可手动提交文本。后台分析仍由真实模型决定静默或通知，只有通知进入绑定承接会话，带服务端结构化来源。" },
  { operationId: "runSmsProcessing", method: "post" as const, path: "/api/features/sms/runs", summary: "立即分析短信待处理批次", request: info.informationRunRequestSchema, response: info.informationRunResponse,
    hint: "同步等待一轮结果；沿用信息执行槽与结构化提交，未明不能自动重发。通知以轮次接纳时的承接空间为目标，不绑定永久 sessionId；会话重置、删除或停止导致旧投递失败，不重跑模型、不自动投递新会话。静默决策不产生聊天消息。" },
  { operationId: "listSmsRuns", method: "get" as const, path: "/api/features/sms/runs", summary: "读取短信处理记录", query: info.informationRunsQuerySchema, response: info.informationRunsResponse },
].map((endpoint) => ({ tag: "功能", auth: true, hint: "功能拥有自己的数据、偏好与处理记录，不随当前选中工作空间变化。", ...endpoint }));
