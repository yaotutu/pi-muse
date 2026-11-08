import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, unlink, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import type { ModelTraceKind } from "./context.js";

/**
 * 模型调用 trace 的落盘快照。
 *
 * meta 只放业务标识与非敏感诊断：上游仅记 origin，不记 path/query，
 * 请求头与 Authorization 永不进入任何字段。request 是发送给供应商的
 * 可见载荷投影；response 在失败时保留上游错误正文，供排查。
 */
export type ModelTraceRequest = {
  system: string;
  messages: unknown[];
  tools: unknown[];
  sampling: Record<string, unknown>;
  parseError?: string;
};

export type ModelTraceResponse = {
  outputText: string;
  toolCalls: Array<{ name: string; arguments: string }>;
  finishReason?: string;
  usage?: unknown;
  streamDone?: boolean;
  errorBody?: string;
  truncated: boolean;
  disconnected?: boolean;
  failure?: string;
};

export type ModelTraceRecord = {
  meta: {
    startedAt: string;
    endedAt: string;
    durationMs: number;
    agentId: string;
    kind: ModelTraceKind;
    extra?: Record<string, string>;
    upstreamOrigin: string;
    httpStatus?: number;
  };
  request?: ModelTraceRequest;
  response?: ModelTraceResponse;
};

/** 已知密钥字符串在所有落盘文本中原样替换；短于 8 位的值不参与替换，避免误伤普通子串。 */
export const redactTraceText = (text: string, secrets: readonly string[]): string => {
  let redacted = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
};

const pad = (value: number, length: number) => String(value).padStart(length, "0");
/** 文件名与目录名只允许 ASCII 字母/数字/`-`/`_`；kind 里的 `:` 等字符折叠为 `-`。 */
const fileNamePart = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "x";

const traceLogFailure = (action: string, error: unknown) => {
  // 只输出动作与错误码/名称，不透出可能含路径或上游详情的 message。
  const code = (error as NodeJS.ErrnoException | null)?.code ?? (error as Error | null)?.name ?? "unknown";
  console.error(`[pi-muse/model-trace] ${action} failed: ${code}`);
};

/**
 * trace 文件存储：DATA_DIR/traces/<yyyy-mm-dd>/<HHmmss-sss>-<agentId>-<kind>-<seq>.json。
 *
 * 写入经进程内串行队列原子完成（同目录临时文件 + rename）；任何失败只打印
 * 一行脱敏摘要，绝不向上抛出——记录是旁路，不能影响模型调用本身。
 * 保留策略默认一直保留；总大小超过上限时按最旧文件先删。为控制成本，
 * 按日目录聚合缓存大小：首次执行时全量扫描一次，之后只随本进程写入增量维护。
 */
export const createModelTraceStore = (deps: {
  dir: string;
  maxTotalBytes: number;
  /** 运行时注册的模型 Key 等需要全局脱敏的字符串；来自受保护配置，不落盘原值。 */
  secrets?: readonly string[];
}) => {
  const secrets = deps.secrets ?? [];
  const queue = createSerializedWriter();
  const daySizes = new Map<string, number>();
  let scanned = false;
  let sequence = 0;

  const scanDaySizes = async () => {
    daySizes.clear();
    let dayEntries;
    try {
      dayEntries = await readdir(deps.dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        scanned = true;
        return;
      }
      throw error;
    }
    for (const entry of dayEntries) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
      const dayPath = join(deps.dir, entry.name);
      let bytes = 0;
      for (const name of await readdir(dayPath).catch(() => [])) {
        const info = await stat(join(dayPath, name)).catch(() => undefined);
        if (info?.isFile()) bytes += info.size;
      }
      daySizes.set(entry.name, bytes);
    }
    scanned = true;
  };

  /** 超出上限时从最旧日期目录开始逐文件删除；删除本身失败也只记一行摘要。 */
  const enforceRetention = async () => {
    if (!scanned) await scanDaySizes();
    let total = [...daySizes.values()].reduce((sum, bytes) => sum + bytes, 0);
    if (total <= deps.maxTotalBytes) return;
    for (const day of [...daySizes.keys()].sort()) {
      if (total <= deps.maxTotalBytes) break;
      const dayPath = join(deps.dir, day);
      const names = (await readdir(dayPath).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
      for (const name of names) {
        if (total <= deps.maxTotalBytes) break;
        const file = join(dayPath, name);
        const info = await stat(file).catch(() => undefined);
        await unlink(file).catch(() => undefined);
        const bytes = info?.isFile() ? info.size : 0;
        total -= bytes;
        daySizes.set(day, (daySizes.get(day) ?? 0) - bytes);
      }
      if ((daySizes.get(day) ?? 0) <= 0) {
        await rm(dayPath, { recursive: true, force: true }).catch(() => undefined);
        daySizes.delete(day);
      }
    }
  };

  const writeOnce = async (record: ModelTraceRecord) => {
    sequence += 1;
    const now = new Date();
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}`;
    const prefix = `${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}-${pad(now.getMilliseconds(), 3)}`;
    const name = `${prefix}-${fileNamePart(record.meta.agentId)}-${fileNamePart(record.meta.kind)}-${pad(sequence, 6)}.json`;
    const dayPath = join(deps.dir, day);
    await mkdir(dayPath, { recursive: true, mode: 0o700 });
    const text = redactTraceText(`${JSON.stringify(record, null, 2)}\n`, secrets);
    const temporary = join(dayPath, `.${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      await rename(temporary, join(dayPath, name));
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    daySizes.set(day, (daySizes.get(day) ?? 0) + Buffer.byteLength(text));
    await enforceRetention();
  };

  return {
    /** 旁路写入：立即返回，任何失败吞掉并打印一行脱敏摘要。 */
    write: (record: ModelTraceRecord): void => {
      void queue(async () => {
        try {
          await writeOnce(record);
        } catch (error) {
          traceLogFailure("trace write", error);
        }
      });
    },
    /** 等待队列中已排入的写入全部收尾；关闭路径使用，不在请求热路径调用。 */
    close: (): Promise<void> => queue(async () => {}),
  };
};
