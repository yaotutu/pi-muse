import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";

/** tsc 保持 adapters/storage 的层级；资产位置相对模块决定，不依赖启动 cwd 或源码目录存在性。 */
export const getBuiltinSkillsDir = (): string => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const outputRoot = resolve(directory, "../..");
  return basename(outputRoot) === "dist"
    ? resolve(outputRoot, "assets/skills")
    : resolve(directory, "../../../assets/skills");
};

/** 随服务端发布的内置默认开关清单；损坏即加载失败，不静默忽略自家资产。 */
export const getBuiltinSkillsDefaultsFile = (): string => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const outputRoot = resolve(directory, "../..");
  return basename(outputRoot) === "dist"
    ? resolve(outputRoot, "assets/skills-defaults.json")
    : resolve(directory, "../../../assets/skills-defaults.json");
};
