import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { BrowserService } from "../features/browser/browser-service.js";

const writeUnauthorized = (socket: Duplex) => {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  socket.destroy();
};

/**
 * Hono 的 fetch 抽象不承载 HTTP upgrade；这里在 Node server 上处理 /ws/browser。
 * 长期 Bearer token 不进入 URL，只消费一次性的短时 ticket。
 */
export const createBrowserUpgradeHandler = (
  browser: BrowserService | undefined,
) => {
  const sockets = new WebSocketServer({ noServer: true });
  const handle = (request: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      return false;
    }
    if (url.pathname !== "/ws/browser") return false;
    if (!browser?.consumeTicket(url.searchParams.get("ticket") ?? undefined)) {
      writeUnauthorized(socket);
      return true;
    }
    sockets.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
      const attached = browser!.attachClient({
        sendText: (message) => websocket.send(message),
        sendBinary: (data) => websocket.send(data, { binary: true }),
        close: () => websocket.close(),
        bufferedAmount: () => websocket.bufferedAmount,
      });
      websocket.on("message", (data, isBinary) => {
        if (!isBinary) attached.handleMessage(data.toString());
      });
      websocket.on("close", attached.detach);
      websocket.on("error", () => attached.detach());
    });
    return true;
  };
  return {
    handle,
    close: () => {
      sockets.clients.forEach((client) => client.terminate());
      sockets.close();
    },
  };
};

/** 挂载单通道 upgrade 处理：不匹配的路径返回 404 并关闭 socket。 */
export const attachUpgradeHandler = (
  server: Server,
  handle: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean,
) => {
  const listener = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      if (handle(request, socket, head)) return;
    } catch {
      socket.destroy();
      return;
    }
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  };
  server.on("upgrade", listener);
  return () => {
    server.off("upgrade", listener);
  };
};
