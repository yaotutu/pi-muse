import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { resolvePublicHost, type ResolvedAddress } from "../../shared/public-host.js";

/** 底层公网 HTTP 通道配置，不感知具体搜索供应商或页面正文提取策略。 */
export type WebHttpClientConfig = {
  timeoutMs: number;
  maxResponseBytes: number;
  userAgent?: string;
  /** 本机联调/测试用：允许回环与私网目标（默认拒绝，见 config tools.web）。 */
  allowPrivateTargets?: boolean;
  proxy?: string;
};

export type HttpRequestOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};

export type HttpRequestFn = (
  url: URL,
  config: WebHttpClientConfig,
  pinned: ResolvedAddress,
  timeoutMs: number,
  signal?: AbortSignal,
  options?: HttpRequestOptions,
) => Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  url: URL;
}>;

export type SafeHttpResponse = {
  status: number;
  contentType: string;
  body: string;
  finalUrl: string;
};

export type SafePublicRequestFn = (
  rawUrl: string,
  config: WebHttpClientConfig,
  signal?: AbortSignal,
  options?: HttpRequestOptions,
) => Promise<SafeHttpResponse>;

const defaultUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36";

const readBody = async (
  stream: NodeJS.ReadableStream,
  maxBytes: number,
  abort: () => void,
) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      abort();
      throw new Error("Response too large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const proxyAuthHeader = (proxyUrl: URL): string | undefined => {
  if (!proxyUrl.username && !proxyUrl.password) return undefined;
  const decodedUser = decodeURIComponent(proxyUrl.username);
  const decodedPass = decodeURIComponent(proxyUrl.password);
  const encoded = Buffer.from(`${decodedUser}:${decodedPass}`).toString("base64");
  return `Basic ${encoded}`;
};

const openConnectTunnel = (
  proxyUrl: URL,
  targetHost: string,
  targetPort: number,
  signal: AbortSignal,
) => new Promise<ReturnType<typeof tlsConnect>>((resolve, reject) => {
  signal.throwIfAborted();
  const authority = `${targetHost}:${targetPort}`;
  const auth = proxyAuthHeader(proxyUrl);
  const transport = proxyUrl.protocol === "https:" ? httpsRequest : httpRequest;
  const connectReq = transport({
    hostname: proxyUrl.hostname,
    port: proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80),
    method: "CONNECT",
    path: authority,
    headers: {
      Host: authority,
      ...(auth ? { "Proxy-Authorization": auth } : {}),
    },
  });
  let settled = false;
  const finish = (err?: unknown, socket?: ReturnType<typeof tlsConnect>) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
    if (err) {
      socket?.destroy();
      connectReq.destroy();
      reject(err);
    } else if (socket) {
      resolve(socket);
    }
  };
  const onAbort = () => finish(signal.reason ?? new Error("Aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  connectReq.on("connect", (res, rawSocket, head) => {
    if (res.statusCode !== 200) {
      rawSocket.destroy();
      finish(new Error(`Proxy CONNECT HTTP ${res.statusCode ?? 0}`));
      return;
    }
    if (head.length > 0) rawSocket.unshift(head);
    const tlsSocket = tlsConnect({ socket: rawSocket, servername: targetHost });
    tlsSocket.once("error", (err) => finish(err, tlsSocket));
    tlsSocket.once("secureConnect", () => finish(undefined, tlsSocket));
  });
  connectReq.on("error", (err) => finish(err));
  connectReq.end();
});

const requestOnce: HttpRequestFn = async (
  url,
  config,
  pinned,
  timeoutMs,
  signal,
  options,
) => {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 父取消与本请求超时共用底层 request 的销毁语义，等待 headers/body 时都能中断。
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const method = options?.method ?? "GET";
  const headers: Record<string, string> = {
    "user-agent": config.userAgent || defaultUserAgent,
    accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
    "accept-encoding": "identity",
    ...options?.headers,
  };
  if (options?.body !== undefined && headers["content-length"] === undefined) {
    headers["content-length"] = String(Buffer.byteLength(options.body, "utf8"));
  }

  const dispatchRequest = (makeReq: (onResponse: (res: IncomingMessage) => void) => ClientRequest) =>
    new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: string;
      url: URL;
    }>((resolve, reject) => {
      const request = makeReq((response) => {
        // 超限/取消可能在异步迭代退出后才使 response 发出 error，仍需接住并拒绝本次请求。
        response.on("error", reject);
        const statusCode = response.statusCode ?? 0;
        // 超限直接销毁响应，不向已完成并可能归还连接池的 socket 再广播 AbortSignal。
        readBody(response, config.maxResponseBytes, () => response.destroy())
          .then((body) =>
            resolve({
              status: statusCode,
              headers: response.headers,
              body,
              url,
            }),
          )
          .catch(reject);
      });
      request.setTimeout(timeoutMs, () => controller.abort());
      request.on("error", reject);
      if (options?.body !== undefined) request.write(options.body, "utf8");
      request.end();
    });

  try {
    if (config.proxy) {
      const proxyUrl = new URL(config.proxy);
      if (url.protocol === "http:") {
        const auth = proxyAuthHeader(proxyUrl);
        const proxyTransport = proxyUrl.protocol === "https:" ? httpsRequest : httpRequest;
        return await dispatchRequest((onResponse) =>
          proxyTransport(
            {
              hostname: proxyUrl.hostname,
              port: proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80),
              path: url.toString(),
              method,
              headers: {
                ...headers,
                host: url.host,
                ...(auth ? { "proxy-authorization": auth } : {}),
              },
              signal: requestSignal,
            },
            onResponse,
          ),
        );
      }
      const targetPort = Number(url.port || 443);
      const tunnelSocket = await openConnectTunnel(
        proxyUrl,
        url.hostname,
        targetPort,
        requestSignal,
      );
      return await dispatchRequest((onResponse) =>
        httpsRequest(
          {
            hostname: url.hostname,
            port: targetPort,
            path: `${url.pathname}${url.search}`,
            method,
            headers: {
              ...headers,
              host: url.host,
            },
            agent: false,
            createConnection: () => tunnelSocket,
            signal: requestSignal,
          },
          onResponse,
        ),
      );
    }

    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    return await dispatchRequest((onResponse) =>
      transport(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method,
          headers,
          signal: requestSignal,
          lookup: (_host, lookupOpts, callback) => {
            // DNS 已在上层校验并固定；这里不再让 Node 二次解析域名。
            // Node 的 Happy Eyeballs 路径会传 all=true 并要求数组；兼容两种 lookup 回调。
            if (lookupOpts?.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          },
        },
        onResponse,
      ),
    );
  } finally {
    clearTimeout(timer);
  }
};

/** 发起带公网域名/DNS 固定、逐跳重定向校验、总预算超时与可选 HTTP(S) 代理的请求。 */
export const safePublicRequest = async (
  rawUrl: string,
  config: WebHttpClientConfig,
  signal?: AbortSignal,
  options?: HttpRequestOptions,
  doRequest: HttpRequestFn = requestOnce,
): Promise<SafeHttpResponse> => {
  signal?.throwIfAborted();
  const deadline = Date.now() + config.timeoutMs;
  const timeoutController = new AbortController();
  const overallTimer = setTimeout(() => timeoutController.abort(), config.timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    combinedSignal.throwIfAborted();
    let url = new URL(rawUrl);
    let pinned = await resolvePublicHost(url.hostname, config.allowPrivateTargets, combinedSignal);
    for (let redirects = 0; redirects < 6; redirects++) {
      combinedSignal.throwIfAborted();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        timeoutController.abort();
        combinedSignal.throwIfAborted();
      }
      const response = await doRequest(
        url,
        config,
        pinned,
        remainingMs,
        combinedSignal,
        redirects === 0 ? options : undefined,
      );
      combinedSignal.throwIfAborted();
      const location = response.headers.location;
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        if (response.status < 200 || response.status >= 400)
          throw new Error(`HTTP ${response.status}`);
        const contentType = Array.isArray(response.headers["content-type"])
          ? response.headers["content-type"][0]!
          : response.headers["content-type"] ?? "";
        return {
          status: response.status,
          contentType,
          body: response.body,
          finalUrl: url.toString(),
        };
      }
      if (!location) throw new Error("Redirect without location");
      url = new URL(Array.isArray(location) ? location[0]! : location, url);
      pinned = await resolvePublicHost(url.hostname, config.allowPrivateTargets, combinedSignal);
    }
    throw new Error("Too many redirects");
  } finally {
    clearTimeout(overallTimer);
  }
};

/** 兼容直接 GET 调用（RSS、天气等直连场景复用同一底层安全通道）。 */
export const safePublicGet = async (
  rawUrl: string,
  config: WebHttpClientConfig,
  signal?: AbortSignal,
  doRequest: HttpRequestFn = requestOnce,
): Promise<SafeHttpResponse> => safePublicRequest(rawUrl, config, signal, undefined, doRequest);
