export const FEATURE_IDS = ["news", "sms"] as const;
export type FeatureId = typeof FEATURE_IDS[number];
export const FEATURE_SPACES: Record<FeatureId, string> = { news: "news-internal", sms: "sms-internal" };
export const FEATURE_NAMES: Record<FeatureId, string> = { news: "新闻", sms: "短信" };
export const isFeatureId = (value: unknown): value is FeatureId => value === "news" || value === "sms";
export const isFeatureSpace = (value: unknown) => Object.values(FEATURE_SPACES).includes(value as string);
export const featureForSpace = (spaceId: string): FeatureId | undefined => FEATURE_IDS.find((id) => FEATURE_SPACES[id] === spaceId);

/** 来源由服务端写入 PI 通知，不从正文或客户端参数推断跨空间权限。 */
export type FeatureSource = { featureId: FeatureId; itemIds: string[] };
export type FeatureLink = FeatureSource & { spaceId: string; sessionId: string; messageId: string };
/** 只读展示投影；正文仍只保存在实际承接会话的 PI 历史。 */
export type FeatureNotification = {
  id: string; featureId: FeatureId; targetSpaceId: string; sessionId: string;
  messageId: string; createdAt: string; content: string;
};
export type FeatureState = { schemaVersion: 1; bindings: Record<FeatureId, string>; links: FeatureLink[] };
export const defaultFeatureState = (): FeatureState => ({ schemaVersion: 1, bindings: { news: "local-main", sms: "local-main" }, links: [] });
export type FeatureRepository = {
  read: () => Promise<FeatureState>;
  update: <T>(change: (state: FeatureState) => { state: FeatureState; result: T }) => Promise<T>;
};
export class FeatureError extends Error {
  constructor(public code: "INVALID_INPUT" | "NOT_FOUND" | "FEATURE_BOUND", message: string) { super(message); }
}
