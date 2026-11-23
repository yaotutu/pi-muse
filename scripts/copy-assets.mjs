import { cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const copyTree = async (sourceDir, destinationDir) => {
  // 只替换构建生成的资源子树，避免重复构建嵌套和已经移除的资产残留；不删除整个 dist。
  if (destinationDir === sourceDir || sourceDir.startsWith(destinationDir + "/")) {
    throw new Error(`Refusing to replace source directory: ${sourceDir}`);
  }
  await rm(destinationDir, { recursive: true, force: true });
  await cp(sourceDir, destinationDir, { recursive: true });
};

const assetsSource = resolve(projectRoot, "assets");
const assetsDest = process.argv[2] ? resolve(process.argv[2]) : resolve(projectRoot, "dist/assets");
await copyTree(assetsSource, assetsDest);

// 仅完整构建（未显式指定单目录目标）时同步统一系统提示词目录 dist/prompts/。
if (!process.argv[2]) {
  await copyTree(resolve(projectRoot, "prompts"), resolve(projectRoot, "dist/prompts"));
}
