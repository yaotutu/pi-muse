import { importLegacyNewsJson } from "../src/adapters/storage/news-import.js";

/**
 * 显式导入 CLI：把旧 news.json 一次性导入全新 news.sqlite。
 * 源文件只读；目标必须不存在；失败不留下可误当成功的目标库。
 * 用法：node --import tsx scripts/import-news-sqlite.ts --source <news.json> --target <news.sqlite>
 */
const parseArguments = (argv: readonly string[]): { source: string; target: string } => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag !== "--source" && flag !== "--target") {
      throw new Error("Unknown or misplaced argument; expected --source <news.json> --target <news.sqlite>");
    }
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    values.set(flag, value);
    index++;
  }
  const source = values.get("--source");
  const target = values.get("--target");
  if (!source || !target) throw new Error("Both --source <news.json> and --target <news.sqlite> are required");
  return { source, target };
};

const main = async (): Promise<void> => {
  const options = parseArguments(process.argv.slice(2));
  const report = await importLegacyNewsJson({ sourceFile: options.source, databaseFile: options.target });
  console.log(JSON.stringify({
    imported: true,
    sourceFile: report.sourceFile,
    databaseFile: report.databaseFile,
    counts: report.counts,
  }, null, 2));
};

main().catch((error: unknown) => {
  console.error(`news import failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
