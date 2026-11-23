import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 仓库统一系统提示词加载器：
 * - 源码运行读取 `<repo>/prompts/`，构建运行读取 `dist/prompts/`；
 * - 每次按需直接从磁盘读取，修改后下一轮生效，不做数据目录覆盖层。
 */
export const getPromptsDir = (): string => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const outputRoot = resolve(directory, "../..");
  return basename(outputRoot) === "dist"
    ? resolve(outputRoot, "prompts")
    : resolve(directory, "../../../prompts");
};

const safePromptPath = (relativePath: string): string => {
  if (!relativePath || isAbsolute(relativePath)) {
    throw new Error(`Invalid prompt path: ${relativePath}`);
  }
  const root = getPromptsDir();
  const full = resolve(root, relativePath);
  const rel = relative(root, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Prompt path escapes prompts directory: ${relativePath}`);
  }
  return full;
};

/** 从统一提示词目录读取单份系统提示词模板，拒绝空文件与越界路径。 */
export const loadPrompt = (relativePath: string): string => {
  const text = readFileSync(safePromptPath(relativePath), "utf8").trimEnd();
  if (!text.trim()) {
    throw new Error(`Prompt file is empty: ${relativePath}`);
  }
  return text;
};

/** 加载模板并替换 `{{VAR}}` 占位符，使用函数替换避免 `$` 转义问题。 */
export const renderPrompt = (
  relativePath: string,
  vars: Record<string, string>,
): string => {
  let content = loadPrompt(relativePath);
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, () => value);
  }
  return content;
};
