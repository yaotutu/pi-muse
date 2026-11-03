/**
 * 浏览器契约与服务端会话域共享的纯 agentId 规则。
 * 不要在此文件引入 Node API 或附件字节校验，避免 Web 构建 pulled in 服务端运行时。
 */
const AGENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export const isAgentId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 64 &&
  AGENT_ID_PATTERN.test(value);
