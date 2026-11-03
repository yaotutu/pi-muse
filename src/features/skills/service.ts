import type { SkillRepository } from "./port.js";

export class UnknownSkillError extends Error {}

/** 智能体只保存覆盖；目录扫描与文件写入由注入的 repository 承担。 */
export const createSkillsService = (repository: SkillRepository) => {
  const describeAgent = async (agentId: string) => {
    const { skills, diagnostics } = await repository.listSkills();
    const overrides = await repository.getAgentOverrides(agentId);
    return {
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        defaultEnabled: skill.defaultEnabled,
        enabled: overrides[skill.name] ?? skill.defaultEnabled,
      })),
      diagnostics,
    };
  };
  /** Agent 技能维护视图：保留来源但不暴露物理路径；HTTP 技能开关继续使用 describeAgent。 */
  const describeAuthoring = async (agentId: string) => {
    const { skills, diagnostics } = await repository.listSkills();
    const overrides = await repository.getAgentOverrides(agentId);
    return {
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: skill.isBuiltin ? ("builtin" as const) : ("user" as const),
        defaultEnabled: skill.defaultEnabled,
        enabled: overrides[skill.name] ?? skill.defaultEnabled,
      })),
      diagnostics,
    };
  };
  return {
    describeAgent,
    describeAuthoring,
    findSkill: async (name: string) => (await repository.listSkills()).skills.find((skill) => skill.name === name),
    getEffectiveSkills: async (agentId: string) => (await describeAgent(agentId)).skills,
    /** 整份替换覆盖表自然移除旧引用；拒绝本次请求中的未知名称，不静默吞掉用户输入。 */
    updateAgentOverrides: async (agentId: string, overrides: Record<string, boolean>) => {
      const { skills } = await repository.listSkills();
      const validNames = new Set(skills.map((skill) => skill.name));
      const unknown = Object.keys(overrides).find((name) => !validNames.has(name));
      if (unknown) throw new UnknownSkillError(`Unknown skill name: ${unknown}`);
      await repository.setAgentOverrides(agentId, overrides);
    },
  };
};

export type SkillsService = ReturnType<typeof createSkillsService>;
