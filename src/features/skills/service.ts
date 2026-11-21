import type { SkillMeta, SkillRepository } from "./port.js";

export class UnknownSkillError extends Error {}

/** 选择只绑定完整来源身份，目录同名项变化时不会继承旧授权。 */
const isEnabled = (skill: SkillMeta, overrides: Record<string, boolean>): boolean =>
  Object.hasOwn(overrides, skill.id) ? overrides[skill.id]! : skill.defaultEnabled;

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
    updateOverrides: async (overrides: Record<string, boolean>) => {
      const { skills } = await repository.listSkills();
      const available = new Set(skills.map((skill) => skill.id));
      for (const id of Object.keys(overrides)) {
        if (!available.has(id)) throw new UnknownSkillError("Unknown skill source ID");
      }
      await repository.setOverrides(overrides);
    },
  };
};

export type SkillsService = ReturnType<typeof createSkillsService>;
