export const newsSourceFailureCategories = [
  "NETWORK", "SSRF_BLOCKED", "TIMEOUT", "HTTP_ERROR", "PARSE_INVALID", "UNKNOWN",
] as const;

export type NewsSourceFailure = {
  category: typeof newsSourceFailureCategories[number];
  httpStatus?: number;
};

export class NewsError extends Error {
  constructor(
    public code: "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "REFRESHING" | "SHUTDOWN",
    message: string,
  ) {
    super(message);
  }
}

/** 只投影受控分类和状态码；上游 message/cause/stack 不进入客户端或持久化。 */
export class NewsSourceError extends NewsError {
  readonly failure: NewsSourceFailure;

  constructor(failure: NewsSourceFailure) {
    const safeFailure: NewsSourceFailure = {
      category: newsSourceFailureCategories.includes(failure.category) ? failure.category : "UNKNOWN",
      ...(failure.category === "HTTP_ERROR" && Number.isInteger(failure.httpStatus) &&
        failure.httpStatus! >= 100 && failure.httpStatus! <= 599
        ? { httpStatus: failure.httpStatus } : {}),
    };
    super("INVALID_INPUT", `RSS source failed: ${safeFailure.category}${safeFailure.httpStatus ? ` (HTTP ${safeFailure.httpStatus})` : ""}`);
    this.failure = safeFailure;
  }
}

export const asNewsSourceError = (error: unknown): NewsSourceError =>
  error instanceof NewsSourceError ? new NewsSourceError(error.failure)
    : new NewsSourceError({ category: "UNKNOWN" });
