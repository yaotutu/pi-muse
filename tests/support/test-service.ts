import { join } from "node:path";
import { createService as createProductionService } from "../../src/bootstrap/create-service.js";

/** 每个测试实例只扫描自己的空共享目录，绝不读取用户 ~/.agents/skills。 */
export const createService = (
  config: Parameters<typeof createProductionService>[0],
  options: Parameters<typeof createProductionService>[1] = {},
) => createProductionService(config, {
  sharedSkillsDir: join(config.dataDir, "test-shared-skills"),
  ...options,
});

/** 显式保存测试所需的整份内置技能开关；不改变生产默认。 */
export const enableBuiltinSkills = async (
  service: Awaited<ReturnType<typeof createProductionService>>,
  names: readonly string[],
) => service.skills.updateOverrides(
  Object.fromEntries(names.map((name) => [`builtin/${name}`, true])),
);
