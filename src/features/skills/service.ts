import type { SkillMeta, SkillRepository } from "./port.js";

export class UnknownSkillError extends Error {}

/** 来源 ID 优先；旧名称选择只兼容自有技能，绝不授权新发现的通用技能。默认值只来自随服务端发布的内置清单。 */
const isEnabled = (skill: SkillMeta, overrides: Record<string, boolean>): boolean => {
  if (Object.hasOwn(overrides, skill.id)) return overrides[skill.id]!;
  return skill.source !== "shared" && Object.hasOwn(overrides, skill.name) ? overrides[skill.name]! : skill.defaultEnabled;
};

const metadata = (skill: SkillMeta, overrides: Record<string, boolean>) => ({
  name: skill.name,
  description: skill.description,
  id: skill.id,
  source: skill.source,
  defaultEnabled: skill.defaultEnabled,
  enabled: isEnabled(skill, overrides),
});

/** 助手配置只保存覆盖；目录扫描与文件写入由注入的 repository 承担。 */
export const createSkillsService = (repository: SkillRepository) => {
  const describe = async () => {
    const { skills, diagnostics } = await repository.listSkills();
    const overrides = await repository.getOverrides();
    return { skills: skills.map((skill) => metadata(skill, overrides)), diagnostics };
  };
  return {
    describe,
    findSkill: async (name: string) => (await repository.listSkills()).skills.find((skill) => skill.name === name),
    getEnabledSkillDefinitions: async (): Promise<SkillMeta[]> => {
      const { skills } = await repository.listSkills();
      const overrides = await repository.getOverrides();
      return skills.filter((skill) => isEnabled(skill, overrides));
    },
    describeSkill: async (name: string) => {
      const result = await repository.readSkill(name);
      if (!result) throw new UnknownSkillError("Unknown skill");
      const overrides = await repository.getOverrides();
      return { ...metadata(result.skill, overrides), content: result.content };
    },
    /** 手动整份保存解析当前 winner，绑定来源；旧文件只在用户主动保存时规范化。 */
    updateOverrides: async (overrides: Record<string, boolean>) => {
      const { skills } = await repository.listSkills();
      const winners = new Map(skills.flatMap((skill) => [[skill.name, skill], [skill.id, skill]]));
      const normalized: Record<string, boolean> = {};
      for (const [key, enabled] of Object.entries(overrides)) {
        const skill = winners.get(key);
        if (!skill) throw new UnknownSkillError("Unknown skill name or source ID");
        normalized[skill.id] = enabled;
      }
      await repository.setOverrides(normalized);
    },
  };
};

export type SkillsService = ReturnType<typeof createSkillsService>;
