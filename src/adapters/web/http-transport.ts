import type { WebTransport } from "../../features/web/types.js";
import { createWebFetcher, type WebFetchConfig } from "./fetch.js";
import {
  safePublicGet,
  safePublicRequest,
  type HttpRequestFn,
  type SafePublicRequestFn,
  type WebHttpClientConfig,
} from "./http-client.js";
import {
  createWebSearchEngine,
  type SearchSourceRegistry,
  type WebSearchConfig,
} from "./search/index.js";

export type WebHttpConfig = WebHttpClientConfig & {
  search?: WebSearchConfig;
  fetch?: WebFetchConfig;
};

export { createWebFetcher, shouldBypassExternalReader, type WebFetchConfig } from "./fetch.js";
export {
  safePublicGet,
  safePublicRequest,
  type HttpRequestFn,
  type HttpRequestOptions,
  type SafeHttpResponse,
  type SafePublicRequestFn,
  type WebHttpClientConfig,
} from "./http-client.js";
export {
  braveSearchSource,
  createSearchSourceRegistry,
  createWebSearchEngine,
  duckDuckGoSearchSource,
  jinaSearchSource,
  parseBingRssResults,
  parseBraveResults,
  parseDuckDuckGoResults,
  parseJinaSearchResults,
  parseSearxngResults,
  parseTavilyResults,
  resolveSearchProvider,
  searxngSearchSource,
  tavilySearchSource,
  type SearchExecutionContext,
  type SearchSource,
  type SearchSourceRegistry,
  type WebSearchConfig,
  type WebSearchProvider,
  type WebSearchProviderId,
} from "./search/index.js";

/** 生产 transport 组合门面：把安全 HTTP 通道、可插拔搜索源引擎和 Jina/本地抓取器拼装为 WebTransport。 */
export const createHttpWebTransport = (
  config: WebHttpConfig,
  doRequest?: HttpRequestFn,
  registry?: SearchSourceRegistry,
): WebTransport => {
  const request: SafePublicRequestFn = (rawUrl, reqConfig, signal, options) =>
    safePublicRequest(rawUrl, reqConfig, signal, options, doRequest);
  const searchEngine = createWebSearchEngine({
    http: config,
    search: config.search,
    request,
    registry,
  });
  const fetchPage = createWebFetcher({
    http: config,
    fetch: config.fetch,
    request,
  });
  return {
    search: searchEngine.search,
    fetch: fetchPage,
  };
};
