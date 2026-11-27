import { resolvePublicHost } from "../../shared/public-host.js";
import type { FetchedWebPage } from "../../features/web/types.js";
import type { SafePublicRequestFn, WebHttpClientConfig } from "./http-client.js";

export type WebFetchConfig = {
  useJinaReader: boolean;
  jinaApiKey?: string;
};

const jinaReaderBase = "https://r.jina.ai/";

const sensitiveQueryParamNames = new Set([
  "token",
  "access_token",
  "auth",
  "key",
  "api_key",
  "apikey",
  "signature",
  "sig",
  "x-amz-signature",
  "x-amz-credential",
  "session",
  "secret",
  "password",
  "passwd",
  "jwt",
  "code",
]);

const rawDataExtensions = [
  ".json",
  ".xml",
  ".rss",
  ".atom",
  ".txt",
  ".md",
  ".csv",
  ".yaml",
  ".yml",
];

/** 遵循 nanobot 防泄漏策略：私网、带凭据/鉴权参数的 URL 及纯数据后缀不经过第三方 Reader。 */
export const shouldBypassExternalReader = (
  url: URL,
  options?: { useJinaReader?: boolean; allowPrivateTargets?: boolean },
): boolean => {
  if (options?.useJinaReader === false) return true;
  if (options?.allowPrivateTargets === true) return true;
  if (url.username || url.password) return true;
  for (const key of url.searchParams.keys()) {
    if (sensitiveQueryParamNames.has(key.toLowerCase())) return true;
  }
  const pathLower = url.pathname.toLowerCase();
  return rawDataExtensions.some((ext) => pathLower.endsWith(ext));
};

/** 网页抓取器：默认经 Jina Reader 转为干净 Markdown，命中防泄漏条件或异常时无缝回退本地抓取。 */
export const createWebFetcher = (options: {
  http: WebHttpClientConfig;
  fetch?: WebFetchConfig;
  request: SafePublicRequestFn;
}) => async (url: string, signal?: AbortSignal): Promise<FetchedWebPage> => {
  signal?.throwIfAborted();
  const parsed = new URL(url);
  const useJina = options.fetch?.useJinaReader !== false;
  if (!shouldBypassExternalReader(parsed, {
    useJinaReader: useJina,
    allowPrivateTargets: options.http.allowPrivateTargets,
  })) {
    // 私网或非法目标在提交给 r.jina.ai 前即刻拦截，绝不泄露内网域名。
    await resolvePublicHost(parsed.hostname, false, signal);
    signal?.throwIfAborted();
    try {
      const readerUrl = `${jinaReaderBase}${parsed.toString()}`;
      const jinaPage = await options.request(
        readerUrl,
        options.http,
        signal,
        {
          headers: {
            accept: "text/markdown, text/plain;q=0.9",
            "x-return-format": "markdown",
            ...(options.fetch?.jinaApiKey
              ? { authorization: `Bearer ${options.fetch.jinaApiKey}` }
              : {}),
          },
        },
      );
      if (jinaPage.body.trim().length > 0) {
        return {
          finalUrl: parsed.toString(),
          status: jinaPage.status,
          contentType: "text/markdown; charset=utf-8",
          body: jinaPage.body,
          extractorHint: "jina",
        };
      }
    } catch {
      signal?.throwIfAborted();
      // Jina Reader 不可用时无缝回退本地直接抓取与抽取。
    }
  }
  return options.request(url, options.http, signal);
};
