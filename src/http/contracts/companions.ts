import { z } from "zod";
import { COMPANION_STATES, COMPANION_PACK_ID_PATTERN, MAX_COMPANION_PNG_BYTES } from "../../features/companions/types.js";

export const companionState = z.enum(COMPANION_STATES).describe("形象状态，按 idle、thinking、responding、working、waiting-approval、success、error、stopped 的固定顺序");
export const companionId = z.string().regex(COMPANION_PACK_ID_PATTERN).describe("1–64 字符，小写字母或数字开头，后续仅允许小写字母、数字、下划线和连字符；拒绝路径和符号链接");
export const companionMetadataRequest = z.strictObject({
  name: z.string().trim().min(1).max(80).describe("trim 后的显示名称，1–80 字符"),
  description: z.string().max(200).optional().describe("可选说明，最多 200 字符，省略保存为空串"),
});
export const companionAssetRequest = z.strictObject({
  dataBase64: z.string().min(1).describe("严格、规范的 base64 PNG，不含 data: 前缀或空白；解码后 1–786432 字节，必须匹配 PNG 魔数。JSON body 上限 2 MiB，超限返回 413 REQUEST_TOO_LARGE"),
});
const digest = z.string().regex(/^[a-f0-9]{64}$/).describe("64 位小写 SHA-256 hex");
export const companionSummary = z.strictObject({
  id: companionId,
  name: z.string().min(1).max(80),
  description: z.string().max(200),
  states: z.array(companionState).length(8).describe("完整包的全部八个状态，使用固定顺序"),
  version: digest.describe("规范化 manifest 内容与八个状态文件字节的 SHA-256；内容变化后重新计算"),
  updatedAt: z.iso.datetime().describe("目录、manifest 与状态图片最近修改时间的最大值（UTC）"),
});
export const companionsResponse = z.strictObject({
  companions: z.array(companionSummary).describe("按 ID 排序，仅包含八状态均完整有效的形象包"),
  diagnostics: z.array(z.strictObject({ id: z.string(), message: z.string() })).describe("损坏、不完整或不安全包的诊断；不会删除、覆盖或修复原文件"),
});
export const companionResponse = z.strictObject({ companion: companionSummary });
export const saveCompanionResponse = z.strictObject({
  id: companionId, name: z.string(), description: z.string(), complete: z.boolean(), missingStates: z.array(companionState),
});
export const saveCompanionAssetResponse = z.strictObject({ id: companionId, state: companionState, size: z.number().int().min(1).max(MAX_COMPANION_PNG_BYTES), etag: digest.describe("图片原始字节 SHA-256，不含引号；GET 的 ETag 头为带双引号值") });
export const deleteCompanionResponse = z.strictObject({ ok: z.literal(true), id: companionId });
export const companionPngResponse = z.string().describe("原始 PNG 二进制字节，不是 JSON 或 base64；Content-Type: image/png；ETag: 带双引号的图片 SHA-256；Cache-Control: private, max-age=300");
export const companionErrorResponse = z.object({ error: z.string(), code: z.string() });
export const companionErrors = {
  400: { description: "非法 ID/state 分别返回 INVALID_COMPANION_ID / INVALID_COMPANION_STATE；非法元数据返回 INVALID_COMPANION_METADATA，非法 base64 或 PNG 魔数返回 INVALID_PNG", schema: companionErrorResponse },
  404: { description: "COMPANION_NOT_FOUND：包不存在；读取时包损坏或未凑齐全部八个状态", schema: companionErrorResponse },
  409: { description: "UNSAFE_COMPANION_PATH / INVALID_COMPANION_PACK：拒绝符号链接、非常规文件或损坏的已有内容，保留原件，不静默修复", schema: companionErrorResponse },
  413: { description: "REQUEST_TOO_LARGE：PNG 超过 768 KiB（786432 字节）或图片 PUT JSON 超过 2 MiB", schema: companionErrorResponse },
};
