import { join, dirname } from "node:path";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import type { SkillsService } from "../../features/skills/service.js";
import type { SkillSource } from "../../features/skills/port.js";
import { safeWorkspacePath } from "./tools/workspace-path.js";

export type EnabledProductSkill = Skill & { catalogId: string; catalogSource: SkillSource };

/** 目录优先级与开关只由技能服务决定；运行装配不再独立重扫另一套来源。 */
export async function loadEnabledProductSkills(
  service: SkillsService | undefined,
  sessionId: string,
  inheritedIds?: readonly string[],
): Promise<EnabledProductSkill[]> {
  if (!service) return [];
  const definitions = await service.getEnabledSkillDefinitions(sessionId);
  const inherited = inheritedIds ? new Set(inheritedIds) : undefined;
  const result: EnabledProductSkill[] = [];
  for (const definition of definitions) {
    if (inherited && !inherited.has(definition.id)) continue;
    const target = join(definition.path, "SKILL.md");
    try {
      // 共享目录的入口链接已规范化为真实根；内部文件仍必须经过无链接边界检查。
      await safeWorkspacePath(definition.path, target, { boundaryDir: dirname(definition.path) });
      const loaded = loadSkillsFromDir({ dir: definition.path, source: "project" });
      const skill = loaded.skills.find((candidate) => candidate.name === definition.name && candidate.filePath === target);
      if (!skill) throw new Error("Unavailable skill");
      await safeWorkspacePath(definition.path, target, { boundaryDir: dirname(definition.path) });
      result.push({ ...skill, catalogId: definition.id, catalogSource: definition.source });
    } catch {
      // 源码路径与解析器的底层错误不得进入模型或历史。
      throw new Error(`Enabled skill unavailable: ${definition.name}`);
    }
  }
  return result;
}
