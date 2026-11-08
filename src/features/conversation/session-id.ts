/** 公开 id 只接受永久默认会话或规范小写 UUID；路径与各协议复用同一规则。 */
export const SESSION_ID_PATTERN = /^(?:main|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
export const isSessionId = (value: unknown): value is string =>
  typeof value === "string" && SESSION_ID_PATTERN.test(value);
