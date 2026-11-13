import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { DataLayout } from "./data-layout.js";
import { sessionSkillsFile } from "./data-layout.js";
import { getBuiltinSkillsDefaultsFile, getBuiltinSkillsDir } from "./builtin-skills.js";
import { writeJsonDocument } from "./json-document.js";
import { InvalidDocumentError } from "./document-schemas.js";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import { isSessionId } from "../../features/conversation/session-id.js";
import type { SkillCatalog, SkillRepository, SkillSource } from "../../features/skills/port.js";

const overridesSchema = z.strictObject({ overrides: z.record(z.string(), z.boolean()) });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const maxContentBytes = 100 * 1024;
const validName = (name: string) => name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
const unsafe = () => new Error("Unsafe or unreadable skill");

/** 自有目录从实例边界逐段检查；允许 /tmp 等边界祖先的系统路径别名。 */
const ownDirectory = async (boundary: string, directory: string): Promise<string> => {
  const base = resolve(boundary);
  const target = resolve(directory);
  if (target !== base && !target.startsWith(base + sep)) throw unsafe();
  let current = base;
  for (const component of ["", ...relative(base, target).split(sep).filter(Boolean)]) {
    current = component ? join(current, component) : current;
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw unsafe();
  }
  const physical = await realpath(target);
  if (physical !== join(await realpath(base), relative(base, target))) throw unsafe();
  return physical;
};

/** 仅顶层 shared 入口可为链接；技能内部不跟随链接，也不授予整个 HOME 读取权限。 */
const checkSkillTree = async (root: string): Promise<void> => {
  const rootEntry = await lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink() || await realpath(root) !== root) throw unsafe();
  let count = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 16) throw unsafe();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 4096 || entry.isSymbolicLink()) throw unsafe();
      if (entry.isDirectory()) await visit(join(directory, entry.name), depth + 1);
      else if (!entry.isFile()) throw unsafe();
    }
  };
  await visit(root, 0);
};

/** no-follow + 固定大小缓冲区；扫描与详情均拒绝超限文件，不截断正文冒充完整内容。 */
const readSkillContent = async (directory: string): Promise<string> => {
  const handle = await open(join(directory, "SKILL.md"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.size > maxContentBytes) throw unsafe();
    const buffer = Buffer.alloc(maxContentBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxContentBytes) throw unsafe();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
};

/** 内置默认开关清单：仅随服务端发布的自有资产可声明默认开启；通用与实例自建一律默认关闭。 */
const defaultsSchema = z.strictObject({ schemaVersion: z.literal(1), defaultEnabled: z.array(z.string().max(64)) });
const readBuiltinDefaults = async (): Promise<Set<string>> => {
  const parsed = defaultsSchema.parse(JSON.parse(await readFile(getBuiltinSkillsDefaultsFile(), "utf8")));
  const names = new Set(parsed.defaultEnabled);
  if (names.size !== parsed.defaultEnabled.length) throw new Error("Duplicate built-in default skill");
  for (const name of names) if (!validName(name)) throw new Error("Invalid built-in default skill name");
  return names;
};

/** 元数据只走 SDK；诊断只使用受控逻辑位置/文案，不转发含物理路径的 SDK 或 I/O 错误。 */
const scanSkillsDir = async (dir: string, source: SkillSource, boundary = dir, builtinDefaults?: ReadonlySet<string>): Promise<SkillCatalog> => {
  const result: SkillCatalog = { skills: [], diagnostics: [] };
  const defaultEnabled = source === "builtin" ? (builtinDefaults ?? new Set<string>()) : new Set<string>();
  let physicalDir: string;
  let entries;
  try {
    physicalDir = source === "shared" ? await realpath(dir) : await ownDirectory(boundary, dir);
    entries = await readdir(physicalDir, { withFileTypes: true });
  } catch (error) {
    if (!missing(error)) result.diagnostics.push({ path: source, message: "Cannot read skills directory" });
    return result;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const logical = validName(entry.name) ? `${source}/${entry.name}` : source;
    if ((source !== "shared" && !validName(entry.name))
      || (!entry.isDirectory() && !(source === "shared" && entry.isSymbolicLink()))) {
      result.diagnostics.push({ path: logical, message: "Unsupported skill directory entry" });
      continue;
    }
    try {
      const candidate = join(physicalDir, entry.name);
      const path = source === "shared" ? await realpath(candidate) : await ownDirectory(physicalDir, candidate);
      if (!(await lstat(path)).isDirectory()) throw unsafe();
      // 必须先验证常规 SKILL.md，不能让 loader 对缺失入口递归发现其他文件或技能。
      const file = join(path, "SKILL.md");
      const fileEntry = await lstat(file);
      if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) throw unsafe();
      await checkSkillTree(path);
      await readSkillContent(path);
      const loaded = loadSkillsFromDir({ dir: path, source });
      if (loaded.diagnostics.length) result.diagnostics.push({ path: logical, message: "Skill metadata has validation warnings" });
      const skill = loaded.skills.find((item) => item.filePath === file && validName(item.name)
        && (source === "shared" || item.name === entry.name));
      if (!skill) throw unsafe();
      if (result.skills.some((item) => item.name === skill.name)) {
        result.diagnostics.push({ path: logical, message: "Duplicate skill name ignored" });
        continue;
      }
      result.skills.push({
        name: skill.name, description: skill.description, id: `${source}/${skill.name}`, source, defaultEnabled: defaultEnabled.has(skill.name),
        path: source === "shared" ? path : join(dir, entry.name),
      });
    } catch {
      result.diagnostics.push({ path: logical, message: "Invalid, unsafe, oversized or unreadable skill" });
    }
  }
  return result;
};

const readOverrides = async (file: string): Promise<Record<string, boolean>> => {
  let source: string;
  try { source = await readFile(file, "utf8"); }
  catch (error) { if (missing(error)) return {}; throw error; }
  try { return overridesSchema.parse(JSON.parse(source)).overrides; }
  catch { throw new InvalidDocumentError("skills-overrides"); }
};

/** 同一 repository 唯一队列覆盖读取/校验/写入；扫描不会创建目录、配置或改写历史文件。 */
export const createSkillRepository = (layout: DataLayout, sharedSkillsDir = join(homedir(), ".agents", "skills")): SkillRepository => {
  const builtinDir = getBuiltinSkillsDir();
  const serialized = createSerializedWriter();
  const fileFor = (sessionId: string) => {
    if (!isSessionId(sessionId)) throw new Error("Invalid sessionId");
    return sessionSkillsFile(layout, sessionId);
  };
  const listSkills = async (): Promise<SkillCatalog> => {
    // 清单损坏属于自有资产损坏，直接失败；不静默回退成“内置全关”。
    const builtinDefaults = await readBuiltinDefaults();
    const catalogs = [
      await scanSkillsDir(layout.skillsDir, "user", layout.root),
      await scanSkillsDir(builtinDir, "builtin", undefined, builtinDefaults),
      await scanSkillsDir(sharedSkillsDir, "shared"),
    ];
    const merged = new Map<string, SkillCatalog["skills"][number]>();
    const diagnostics = catalogs.flatMap((catalog) => catalog.diagnostics);
    for (const catalog of catalogs) for (const skill of catalog.skills) {
      if (merged.has(skill.name)) diagnostics.push({ path: skill.id, message: "Same-name skill shadowed by higher-priority source" });
      else merged.set(skill.name, skill);
    }
    return { skills: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
  };
  return {
    listSkills: () => serialized(listSkills),
    readSkill: (name) => serialized(async () => {
      const skill = (await listSkills()).skills.find((item) => item.name === name);
      if (!skill) return undefined;
      // 重查内部链接与有界正文；异常仅输出受控错误，不能暴露真实 HOME 或 SDK 路径。
      try {
        const path = skill.source === "shared" ? skill.path
          : await ownDirectory(skill.source === "user" ? layout.root : builtinDir, skill.path);
        await checkSkillTree(path);
        return { skill, content: await readSkillContent(path) };
      } catch { throw new Error("Cannot read skill content"); }
    }),
    getSessionOverrides: (sessionId) => serialized(() => readOverrides(fileFor(sessionId))),
    setSessionOverrides: (sessionId, overrides) => serialized(async () => {
      const file = fileFor(sessionId);
      await readOverrides(file);
      const document = overridesSchema.parse({ overrides });
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeJsonDocument(file, document);
    }),
  };
};
