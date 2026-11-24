import { useCallback, useEffect, useRef, useState } from "react";
import {
  createBrowserViewerTicket,
  getBrowserStatus,
  resolveBrowserHandoff,
  setBrowserViewport,
  type BrowserHandoffDto,
  type BrowserStatusDto,
} from "../lib/api";

/** 联调台浏览器视图：负责状态展示、视口预设切换、人工接管确认与同源嵌入真实操控页。 */
export const BrowserView = ({
  browserSyncVersion,
  handoffHint,
}: {
  browserSyncVersion: number;
  handoffHint: BrowserHandoffDto | null;
}) => {
  const [status, setStatus] = useState<BrowserStatusDto | null>(null);
  const [launchSrc, setLaunchSrc] = useState<string | null>(null);
  const [iframeRevision, setIframeRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const ticketRequestedRef = useRef(false);

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await getBrowserStatus(signal);
      if (signal?.aborted) return;
      setStatus(next);
      setError("");
      if (!next.enabled) {
        ticketRequestedRef.current = false;
        setLaunchSrc(null);
      }
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caught instanceof Error ? caught.message : "无法读取浏览器状态");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);
    return () => { controller.abort(); };
  }, [browserSyncVersion, loadStatus]);

  useEffect(() => {
    if (!status?.enabled || launchSrc || ticketRequestedRef.current) return;
    ticketRequestedRef.current = true;
    const controller = new AbortController();
    void createBrowserViewerTicket(controller.signal).then(
      (ticket) => {
        if (controller.signal.aborted) return;
        setLaunchSrc(ticket.launchPath);
        setIframeRevision((value) => value + 1);
      },
      (caught) => {
        if (controller.signal.aborted) {
          ticketRequestedRef.current = false;
          return;
        }
        ticketRequestedRef.current = false;
        setError(caught instanceof Error ? caught.message : "无法获取浏览器嵌入票据");
      },
    );
    return () => {
      controller.abort();
    };
  }, [launchSrc, status?.enabled]);

  const reloadEmbed = async () => {
    if (!status?.enabled || busyAction) return;
    setBusyAction("reload");
    setError("");
    try {
      const ticket = await createBrowserViewerTicket();
      ticketRequestedRef.current = true;
      setLaunchSrc(ticket.launchPath);
      setIframeRevision((value) => value + 1);
      await loadStatus();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法刷新浏览器视图");
    } finally {
      setBusyAction("");
    }
  };

  const openStandalone = async () => {
    if (!status?.enabled || busyAction) return;
    setBusyAction("open");
    setError("");
    const popup = window.open("", "_blank");
    if (popup) popup.opener = null;
    try {
      const ticket = await createBrowserViewerTicket();
      if (popup) popup.location.href = ticket.launchPath;
      else window.location.assign(ticket.launchPath);
    } catch (caught) {
      popup?.close();
      setError(caught instanceof Error ? caught.message : "无法打开独立浏览器窗口");
    } finally {
      setBusyAction("");
    }
  };

  const applyViewport = async (preset: "desktop" | "mobile") => {
    if (!status?.enabled || busyAction) return;
    setBusyAction(preset);
    setError("");
    try {
      const target = preset === "desktop"
        ? { preset: "desktop" as const, width: 1280, height: 800, mobile: false }
        : { preset: "mobile" as const, width: 390, height: 720, mobile: true };
      const updated = await setBrowserViewport(target);
      setStatus((current) => current ? { ...current, viewport: updated.viewport } : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "切换浏览器视口失败");
    } finally {
      setBusyAction("");
    }
  };

  const confirmHandoff = async () => {
    if (!status?.enabled || busyAction) return;
    setBusyAction("handoff");
    setError("");
    try {
      await resolveBrowserHandoff();
      await loadStatus();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "确认人工接管失败");
    } finally {
      setBusyAction("");
    }
  };

  const activeHandoff = status?.handoff ?? handoffHint;

  return (
    <div className="flex h-full flex-col bg-stone-100">
      <div className="flex flex-wrap items-center gap-2 border-b border-stone-200 bg-white px-4 py-2.5 text-xs">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              !status?.enabled
                ? "bg-stone-300"
                : status.running
                  ? "bg-emerald-500"
                  : "bg-amber-400"
            }`}
            aria-hidden
          />
          <span className="font-medium text-stone-700">
            {loading
              ? "正在检查浏览器状态…"
              : !status?.enabled
                ? "浏览器未启用"
                : status.running
                  ? `真实 Chrome 运行中 · ${status.tabsCount} 标签 · ${status.viewport.width}×${status.viewport.height}`
                  : `真实 Chrome 待命 · ${status.viewport.width}×${status.viewport.height}`}
          </span>
        </div>

        {status?.enabled && (
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() => void applyViewport("desktop")}
              className={`rounded-lg border px-2.5 py-1 font-medium transition ${
                status.viewport.preset === "desktop"
                  ? "border-stone-800 bg-stone-800 text-white"
                  : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
              } disabled:opacity-50`}
            >
              桌面 1280×800
            </button>
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() => void applyViewport("mobile")}
              className={`rounded-lg border px-2.5 py-1 font-medium transition ${
                status.viewport.preset === "mobile"
                  ? "border-stone-800 bg-stone-800 text-white"
                  : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
              } disabled:opacity-50`}
            >
              手机 390×720
            </button>
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() => void reloadEmbed()}
              className="rounded-lg border border-stone-300 bg-white px-2.5 py-1 text-stone-700 hover:bg-stone-50 disabled:opacity-50"
            >
              刷新视图
            </button>
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() => void openStandalone()}
              className="rounded-lg border border-stone-300 bg-white px-2.5 py-1 text-stone-700 hover:bg-stone-50 disabled:opacity-50"
            >
              新窗口打开 /browser
            </button>
          </div>
        )}
      </div>

      {activeHandoff && (
        <div className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          <div className="min-w-0 flex-1">
            <p className="font-medium">需要人工操作：{activeHandoff.reason}</p>
            <p className="truncate text-amber-700">{activeHandoff.url}</p>
          </div>
          <button
            type="button"
            disabled={Boolean(busyAction)}
            onClick={() => void confirmHandoff()}
            className="shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            我已完成，继续
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {!loading && status && !status.enabled ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <section className="max-w-md space-y-2 rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-600 shadow-sm">
            <h2 className="text-base font-semibold text-stone-800">浏览器模块未启用</h2>
            <p>请在服务端配置文件中开启 <code className="rounded bg-stone-100 px-1.5 py-0.5 text-xs">tools.browser.enabled = true</code> 后重启服务。</p>
            <p className="text-xs text-stone-500">启用后，本页可直接查看与操控服务端运行中的真实 GUI Chrome，也可通过独立页面 <code className="rounded bg-stone-100 px-1 py-0.5">/browser</code> 在手机和电脑浏览器上免跳转使用。</p>
          </section>
        </div>
      ) : launchSrc ? (
        <iframe
          key={`${iframeRevision}:${launchSrc}`}
          src={launchSrc}
          title="真实浏览器操控台"
          className="min-h-0 w-full flex-1 border-0 bg-stone-950"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-stone-400">
          {loading ? "正在加载真实浏览器视图…" : "正在准备同源浏览器连接…"}
        </div>
      )}
    </div>
  );
};
