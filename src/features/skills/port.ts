/** 技能目录事实与助手开关存储；物理路径仅供内部资源装配。 */
export type SkillSource = "builtin" | "user" | "shared";

export type SkillMeta = {
  name: string;
  description: string;
  id: string;
  source: SkillSource;
  /** 未手动选择时的默认开关：只有随服务端发布的内置清单可声明 true。 */
  defaultEnabled: boolean;
  path: string;
};

export type SkillDiagnostic = { path: string; message: string };
export type SkillCatalog = { skills: SkillMeta[]; diagnostics: SkillDiagnostic[] };

export type SkillRepository = {
  listSkills(): Promise<SkillCatalog>;
  readSkill(name: string): Promise<{ skill: SkillMeta; content: string } | undefined>;
  getOverrides(): Promise<Record<string, boolean>>;
  setOverrides(overrides: Record<string, boolean>): Promise<void>;
};
