import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isWorkspaceText } from "../../shared/workspace-text.js";
import { safeWorkspacePath } from "../pi/tools/workspace-path.js";
import { readProfileFile } from "./profile-files.js";

export const MAX_WORKSPACE_INCLUDE_DEPTH = 5;
export const RESOLVED_WORKSPACE_TEXT_LIMIT = 60_000;

const MAX_INCLUDE_FILE_BYTES = 256 * 1024;
const TRUNCATION_MARKER = "\n<!-- include truncated: resolved character limit reached -->";

type ParsedIncludeFrontmatter = {
  entries: string[];
  body: string;
};

const parseIncludeFrontmatter = (raw: string): ParsedIncludeFrontmatter | undefined => {
  try {
    const parsed = parseFrontmatter<Record<string, unknown>>(raw);
    if (
      typeof parsed.frontmatter !== "object" ||
      parsed.frontmatter === null ||
      Array.isArray(parsed.frontmatter) ||
      !Object.prototype.hasOwnProperty.call(parsed.frontmatter, "include")
    ) {
      return undefined;
    }
    const rawInclude = parsed.frontmatter.include;
    const rawEntries =
      typeof rawInclude === "string"
        ? [rawInclude]
        : Array.isArray(rawInclude)
          ? rawInclude.filter((item): item is string => typeof item === "string")
          : [];
    return {
      entries: rawEntries.map((item) => item.trim()).filter(Boolean),
      body: parsed.body,
    };
  } catch {
    return undefined;
  }
};

const readSafeIncludeText = async (canonicalFile: string): Promise<string | undefined> => {
  try {
    const handle = await open(canonicalFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_INCLUDE_FILE_BYTES) return undefined;
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await handle.readFile());
      return isWorkspaceText(text) ? text : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
};

const sliceWithMarker = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_MARKER.length) return text.slice(0, maxChars);
  return text.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
};

const assembleWithBudget = (bodyText: string, blocks: readonly string[], maxChars: number): string => {
  let out = bodyText;
  if (out.length > maxChars) return sliceWithMarker(out, maxChars);
  for (const block of blocks) {
    const prefix = out.length > 0 ? "\n\n" : "";
    if (out.length + prefix.length + block.length <= maxChars) {
      out += prefix + block;
      continue;
    }
    const room = maxChars - out.length - TRUNCATION_MARKER.length;
    if (room > 0) {
      return out + (prefix + block).slice(0, room) + TRUNCATION_MARKER;
    }
    if (maxChars > TRUNCATION_MARKER.length) {
      return out.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
    }
    return out.slice(0, maxChars);
  }
  return out;
};

/**
 * 读取工作区托管文档并在模型注入前展开顶部 YAML frontmatter `include:` 引用。
 * 原文读取与编辑接口必须继续使用 readProfileFile；缺失、越界、符号链接、环路或非纯文本引用静默跳过，不阻止运行。
 */
export const readResolvedProfileFile = async (
  file: string,
  workspaceBoundary: string,
  options: { maxDepth?: number; maxChars?: number } = {},
): Promise<string> => {
  const maxDepth = Math.max(0, options.maxDepth ?? MAX_WORKSPACE_INCLUDE_DEPTH);
  const maxChars = Math.max(0, options.maxChars ?? RESOLVED_WORKSPACE_TEXT_LIMIT);

  const canonicalRoot = await safeWorkspacePath(workspaceBoundary, file, { allowMissing: true });
  const rawRoot = await readProfileFile(file, workspaceBoundary);
  if (!rawRoot) return rawRoot;

  const rootParsed = parseIncludeFrontmatter(rawRoot);
  if (!rootParsed) return sliceWithMarker(rawRoot, maxChars);

  const physicalRoot = await realpath(resolve(workspaceBoundary));
  const seen = new Set<string>([canonicalRoot]);
  const rootBody = rootParsed.body.trim();
  const context = { consumedChars: rootBody.length };

  const expandEntries = async (
    currentFile: string,
    entries: readonly string[],
    depth: number,
  ): Promise<string[]> => {
    if (depth >= maxDepth || context.consumedChars >= maxChars) return [];
    const blocks: string[] = [];
    for (const entry of entries) {
      if (context.consumedChars >= maxChars) break;
      if (!entry || entry.includes("\0") || entry.includes("\\") || isAbsolute(entry)) continue;
      let resolvedPath: string;
      try {
        resolvedPath = await safeWorkspacePath(physicalRoot, resolve(dirname(currentFile), entry));
      } catch {
        continue;
      }
      if (seen.has(resolvedPath)) continue;
      const childRaw = await readSafeIncludeText(resolvedPath);
      if (childRaw === undefined) continue;
      seen.add(resolvedPath);

      const childParsed = parseIncludeFrontmatter(childRaw);
      let childText: string;
      if (!childParsed) {
        childText = childRaw.trim();
      } else if (depth + 1 >= maxDepth) {
        childText = childParsed.body.trim();
      } else {
        const nestedBlocks = await expandEntries(resolvedPath, childParsed.entries, depth + 1);
        childText = [childParsed.body.trim(), ...nestedBlocks].filter(Boolean).join("\n\n");
      }
      if (!childText) continue;

      const relPath = relative(physicalRoot, resolvedPath).split(sep).join("/");
      const wrapped = `<!-- begin include: ${relPath} -->\n${childText}\n<!-- end include: ${relPath} -->`;
      blocks.push(wrapped);
      context.consumedChars += wrapped.length;
    }
    return blocks;
  };

  const rootBlocks = await expandEntries(canonicalRoot, rootParsed.entries, 0);
  return assembleWithBudget(rootBody, rootBlocks, maxChars);
};
