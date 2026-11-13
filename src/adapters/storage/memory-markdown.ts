import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { MemoryItem } from "../../features/memory/types.js";

import { InvalidDocumentError } from "./document-schemas.js";

/**
 * 长期记忆的纯文本格式（DATA_DIR/profile/memory.md）。
 *
 * 目标是让人可以直接阅读和手改，所以用 Markdown 而不是数据库或 JSON：
 *
 *   # 长期记忆
 *
 *   - [mem_xxxx] 用户偏好深色界面 <!-- source=chat created=2026-11-01T08:00:00.000Z updated=2026-11-01T08:00:00.000Z -->
 *
 * 解析规则（严格）：
 * - 以 "#" 开头的标题行与空行忽略；
 * - 其余每一行都必须是一条 "- [id] 文本"，id 字符集 [A-Za-z0-9_-]{1,64}，文本非空；
 * - 行尾可选的 HTML 注释承载 source/created/updated，三者齐全才算合法；
 * - 任何一行不符合格式都判定为损坏并抛 InvalidDocumentError("memory-markdown")，
 *   既不静默丢弃坏行，也不当作空记忆。
 */

/** 写回时固定使用的标题行；解析时任意 "#" 标题行都被忽略。 */
const TITLE = "# 长期记忆";

/** 条目 id 字符集：随机 UUID 与工具/HTTP 传入的 id 都在其中。 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 时间戳：ISO 8601 UTC；写回时用 toISOString() 的毫秒形式。 */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** 手写条目没有注释时的兜底来源与时间：明确可辨认，不冒充真实采集时间。 */
const DEFAULT_SOURCE = "manual";
const DEFAULT_TIMESTAMP = "1970-01-01T00:00:00.000Z";

const corrupt = (): never => {
  throw new InvalidDocumentError("memory-markdown");
};

/**
 * 文本转义：一条记忆必须占一行，所以换行、回车和注释起始符都要转义。
 * 反斜杠优先转义，未知转义序列按字面保留（人写的 Windows 路径不会被吃掉）。
 */
const escapeText = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/<!--/g, "\\<!--");

const unescapeText = (value: string): string => {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      output += character;
      continue;
    }
    const next = value[index + 1];
    if (next === undefined) corrupt();
    index += 1;
    if (next === "\\") output += "\\";
    else if (next === "n") output += "\n";
    else if (next === "r") output += "\r";
    else if (next === "<") output += "<";
    else output += `\\${next}`;
  }
  return output;
};

/** 找到未被转义的 "<!--"；注释起始符必须成对出现。 */
const findCommentStart = (value: string): number => {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "<" && value.startsWith("<!--", index)) return index;
  }
  return -1;
};

type Meta = { source: string; createdAt: string; updatedAt: string };

/**
 * 解析注释里的元数据：source=<来源> created=<ISO> updated=<ISO>。
 * 边界用最后一次出现的位置判定，来源文本里含 " created=" / " updated=" 也不会串味。
 */
const parseMeta = (raw: string): Meta => {
  const updatedIndex = raw.lastIndexOf(" updated=");
  if (updatedIndex < 0) corrupt();
  const updatedAt = raw.slice(updatedIndex + " updated=".length);
  const head = raw.slice(0, updatedIndex);
  const createdIndex = head.lastIndexOf(" created=");
  if (createdIndex < 0) corrupt();
  const createdAt = head.slice(createdIndex + " created=".length);
  const sourcePart = head.slice(0, createdIndex);
  if (!sourcePart.startsWith("source=")) corrupt();
  const source = sourcePart.slice("source=".length);
  if (!source) corrupt();
  if (!TIMESTAMP_PATTERN.test(createdAt) || !Number.isFinite(Date.parse(createdAt))) corrupt();
  if (!TIMESTAMP_PATTERN.test(updatedAt) || !Number.isFinite(Date.parse(updatedAt))) corrupt();
  return { source: unescapeText(source), createdAt, updatedAt };
};

/** 拆出正文与尾部注释；没有注释时使用手写条目的兜底元数据。 */
const splitComment = (value: string): { text: string; meta: Meta } => {
  const commentStart = findCommentStart(value);
  if (commentStart < 0) {
    return {
      text: value,
      meta: { source: DEFAULT_SOURCE, createdAt: DEFAULT_TIMESTAMP, updatedAt: DEFAULT_TIMESTAMP },
    };
  }
  if (!value.endsWith("-->")) corrupt();
  const raw = value.slice(commentStart + "<!--".length, value.length - "-->".length).trim();
  return { text: value.slice(0, commentStart), meta: parseMeta(raw) };
};

const parseLine = (line: string): MemoryItem => {
  const match = /^- \[([^\]]*)\]\s+(.*)$/.exec(line) ?? corrupt();
  const id = match[1];
  if (!ID_PATTERN.test(id)) corrupt();
  const { text: rawText, meta } = splitComment(match[2]);
  const text = unescapeText(rawText).trim();
  if (!text) corrupt();
  return { id, text, ...meta };
};

/** 解析整个文件；任何一行不合规都整体拒绝，不静默丢行。 */
export const parseMemoryMarkdown = (source: string): MemoryItem[] => {
  const items: MemoryItem[] = [];
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    items.push(parseLine(line));
  }
  return items;
};

/**
 * 写回文件内容：固定标题行，随后每条记忆一行，顺序即条目顺序。
 * 条目顺序稳定沿用写入顺序，与既有 list/search 行为一致（search 仍按 updatedAt 倒序）。
 */
export const renderMemoryMarkdown = (items: MemoryItem[]): string => {
  const lines = [TITLE, ""];
  for (const item of items) {
    lines.push(
      `- [${item.id}] ${escapeText(item.text)} <!-- source=${escapeText(item.source)} created=${item.createdAt} updated=${item.updatedAt} -->`,
    );
  }
  return `${lines.join("\n")}\n`;
};

/** 原子写回：同目录临时文件写完再替换目标，避免半截文件。 */
export const writeMemoryMarkdown = async (file: string, items: MemoryItem[]): Promise<void> => {
  const document = renderMemoryMarkdown(items);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  let written = false;
  try {
    await writeFile(temporary, document, { mode: 0o600, flag: "wx" });
    written = true;
    await rename(temporary, file);
  } catch (error) {
    if (written || (error as NodeJS.ErrnoException).code !== "EEXIST") {
      await unlink(temporary).catch(() => undefined);
    }
    throw error;
  }
};
