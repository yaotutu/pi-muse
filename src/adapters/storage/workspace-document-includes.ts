import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type {
  ResolvedWorkspaceDocument,
  WorkspaceIncludeDiagnostic,
} from "../../shared/workspace-includes.js";
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

type IncludeReadOutcome =
  | { ok: true; text: string }
  | { ok: false; status: "missing" | "invalid" };

type ResolvedBlock = {
  text: string;
  diagnostic: WorkspaceIncludeDiagnostic;
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

const readSafeIncludeText = async (canonicalFile: string): Promise<IncludeReadOutcome> => {
  try {
    const handle = await open(canonicalFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_INCLUDE_FILE_BYTES) {
        return { ok: false, status: "invalid" };
      }
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await handle.readFile());
      return isWorkspaceText(text) ? { ok: true, text } : { ok: false, status: "invalid" };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, status: "missing" };
    }
    return { ok: false, status: "invalid" };
  }
};

const sliceWithMarker = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_MARKER.length) return text.slice(0, maxChars);
  return text.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
};

const assembleWithBudget = (
  bodyText: string,
  blocks: readonly ResolvedBlock[],
  maxChars: number,
): { resolved: string; budgetTruncated: boolean } => {
  let out = bodyText;
  if (out.length > maxChars) {
    for (const block of blocks) block.diagnostic.status = "truncated";
    return { resolved: sliceWithMarker(out, maxChars), budgetTruncated: true };
  }
  let budgetTruncated = false;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (budgetTruncated) {
      block.diagnostic.status = "truncated";
      continue;
    }
    const prefix = out.length > 0 ? "\n\n" : "";
    if (out.length + prefix.length + block.text.length <= maxChars) {
      out += prefix + block.text;
      continue;
    }
    budgetTruncated = true;
    const room = maxChars - out.length - TRUNCATION_MARKER.length;
    if (room > 0) {
      out = out + (prefix + block.text).slice(0, room) + TRUNCATION_MARKER;
    } else if (maxChars > TRUNCATION_MARKER.length) {
      out = out.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
      block.diagnostic.status = "truncated";
    } else {
      out = out.slice(0, maxChars);
      block.diagnostic.status = "truncated";
    }
  }
  return { resolved: out, budgetTruncated };
};

/**
 * 检查并展开工作区托管文档顶部 YAML frontmatter `include:` 引用，同时收集每条引用的诊断状态。
 * 原文读取与编辑接口必须继续使用 readProfileFile；问题引用不阻止保存或运行。
 */
export const inspectProfileFile = async (
  file: string,
  workspaceBoundary: string,
  options: { maxDepth?: number; maxChars?: number } = {},
): Promise<ResolvedWorkspaceDocument> => {
  const maxDepth = Math.max(0, options.maxDepth ?? MAX_WORKSPACE_INCLUDE_DEPTH);
  const maxChars = Math.max(0, options.maxChars ?? RESOLVED_WORKSPACE_TEXT_LIMIT);

  const canonicalRoot = await safeWorkspacePath(workspaceBoundary, file, { allowMissing: true });
  const raw = await readProfileFile(file, workspaceBoundary);
  if (!raw) {
    return { raw, resolved: raw, includes: [], truncated: false };
  }

  const rootParsed = parseIncludeFrontmatter(raw);
  if (!rootParsed) {
    return {
      raw,
      resolved: sliceWithMarker(raw, maxChars),
      includes: [],
      truncated: raw.length > maxChars,
    };
  }

  const physicalRoot = await realpath(resolve(workspaceBoundary));
  const seen = new Set<string>([canonicalRoot]);
  const rootBody = rootParsed.body.trim();
  const context = { consumedChars: rootBody.length, truncated: rootBody.length > maxChars };
  const includes: WorkspaceIncludeDiagnostic[] = [];

  const expandEntries = async (
    currentFile: string,
    entries: readonly string[],
    depth: number,
  ): Promise<ResolvedBlock[]> => {
    const blocks: ResolvedBlock[] = [];
    for (const entry of entries) {
      if (!entry || entry.includes("\0") || entry.includes("\\") || isAbsolute(entry)) {
        includes.push({ path: entry || "(empty)", status: "invalid" });
        continue;
      }

      let candidatePath: string;
      try {
        candidatePath = await safeWorkspacePath(
          physicalRoot,
          resolve(dirname(currentFile), entry),
          { allowMissing: true },
        );
      } catch {
        includes.push({ path: entry, status: "invalid" });
        continue;
      }

      const relPath = relative(physicalRoot, candidatePath).split(sep).join("/");
      if (seen.has(candidatePath)) {
        includes.push({ path: entry, resolvedPath: relPath, status: "cycle" });
        continue;
      }
      if (depth >= maxDepth) {
        includes.push({ path: entry, resolvedPath: relPath, status: "depth_exceeded" });
        continue;
      }
      if (context.consumedChars >= maxChars) {
        context.truncated = true;
        includes.push({ path: entry, resolvedPath: relPath, status: "truncated" });
        continue;
      }

      const readOutcome = await readSafeIncludeText(candidatePath);
      if (!readOutcome.ok) {
        includes.push({ path: entry, resolvedPath: relPath, status: readOutcome.status });
        continue;
      }

      seen.add(candidatePath);
      const childParsed = parseIncludeFrontmatter(readOutcome.text);
      let childText: string;
      if (!childParsed) {
        childText = readOutcome.text.trim();
      } else {
        const nestedBlocks = childParsed.entries.length
          ? await expandEntries(candidatePath, childParsed.entries, depth + 1)
          : [];
        childText = [childParsed.body.trim(), ...nestedBlocks.map((b) => b.text)]
          .filter(Boolean)
          .join("\n\n");
      }

      if (!childText) {
        includes.push({ path: entry, resolvedPath: relPath, status: "empty" });
        continue;
      }

      const wrapped = `<!-- begin include: ${relPath} -->\n${childText}\n<!-- end include: ${relPath} -->`;
      const diagnostic: WorkspaceIncludeDiagnostic = {
        path: entry,
        resolvedPath: relPath,
        status: "loaded",
      };
      includes.push(diagnostic);
      blocks.push({ text: wrapped, diagnostic });
      context.consumedChars += wrapped.length;
    }
    return blocks;
  };

  const rootBlocks = await expandEntries(canonicalRoot, rootParsed.entries, 0);
  const assembled = assembleWithBudget(rootBody, rootBlocks, maxChars);
  return {
    raw,
    resolved: assembled.resolved,
    includes,
    truncated: context.truncated || assembled.budgetTruncated,
  };
};

/** 仅返回展开后的正文供模型注入；原文读取请使用 readProfileFile。 */
export const readResolvedProfileFile = async (
  file: string,
  workspaceBoundary: string,
  options: { maxDepth?: number; maxChars?: number } = {},
): Promise<string> => (await inspectProfileFile(file, workspaceBoundary, options)).resolved;
