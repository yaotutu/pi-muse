import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDataLayout, sessionSkillsFile, sessionInstructionsFile } from "../../src/adapters/storage/data-layout.js";
import { createSkillRepository } from "../../src/adapters/storage/skill-repository.js";
import { createSkillsService, UnknownSkillError } from "../../src/features/skills/service.js";
import { readSessionInstructions, writeSessionInstructions } from "../../src/adapters/storage/session-instructions.js";
import { instructionsTool } from "../../src/adapters/pi/tools/instructions.js";

const fixture = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const root = await mkdtemp(join(tmpdir(), "skill-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = createDataLayout(root);
  const repository = createSkillRepository(layout);
  return { layout, repository, service: createSkillsService(repository) };
};

test("skill overrides only default on missing files and preserve damaged documents", async (t) => {
  const { layout, repository } = await fixture(t);
  assert.deepEqual(await repository.getSessionOverrides("00000000-0000-4000-8000-000000000001"), {});
  const file = sessionSkillsFile(layout, "00000000-0000-4000-8000-000000000001");
  await assert.rejects(stat(dirname(file)), { code: "ENOENT" });
  await mkdir(dirname(file), { recursive: true });
  for (const original of ["{broken", "[]", '{"overrides":{"cron":"yes"}}', '{"overrides":{},"schemaVersion":1}']) {
    await writeFile(file, original);
    await assert.rejects(repository.getSessionOverrides("00000000-0000-4000-8000-000000000001"), /Invalid skills-overrides document/);
    await assert.rejects(repository.setSessionOverrides("00000000-0000-4000-8000-000000000001", { cron: false }), /Invalid skills-overrides document/);
    assert.equal(await readFile(file, "utf8"), original);
  }
});

test("skill scanning uses pi metadata, fills only absent configs and reports invalid files", async (t) => {
  const { layout, repository } = await fixture(t);
  const directory = join(layout.skillsDir, "custom-meta");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), '---\nname: custom-meta\ndescription: >\n  Multiline skill description\n  parsed by pi.\n---\n# Body\n');
  const catalog = await repository.listSkills();
  assert.equal(catalog.skills.find((skill) => skill.name === "custom-meta")?.defaultEnabled, false);
  assert.match(catalog.skills.find((skill) => skill.name === "custom-meta")!.description, /Multiline skill description parsed by pi/);
  assert.ok(catalog.diagnostics.some((diagnostic) => diagnostic.path.endsWith("config.json")));
  const config = join(directory, "config.json");
  assert.equal((await stat(config)).mode & 0o777, 0o600);
  await writeFile(config, "invalid-json");
  const invalid = await repository.listSkills();
  assert.ok(invalid.diagnostics.some((diagnostic) => /original file preserved/.test(diagnostic.message)));
  assert.ok(!invalid.skills.some((skill) => skill.name === "custom-meta"));
  assert.equal(await readFile(config, "utf8"), "invalid-json");
});

test("skill diagnostics use logical builtin/ user paths while keeping the skill file path for internal use", async (t) => {
  // diagnostics 不能泄露 DATA_DIR 真实目录（绝对路径或运行时 cwd 路径），但 SkillMeta.path
  // 是内部使用的字段（资源加载/scan），仍然保留绝对路径，两者职责不同。
  const { layout, repository } = await fixture(t);
  const directory = join(layout.skillsDir, "logical-paths");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), '---\nname: logical-paths\ndescription: A skill used to verify diagnostic path normalization.\n---\n# Body\n');
  const catalog = await repository.listSkills();
  const skill = catalog.skills.find((candidate) => candidate.name === "logical-paths");
  assert.ok(skill, "skill should be loaded");
  // SkillMeta.path 仍为内部物理路径，供资源加载器使用，不被诊断路径信息变换影响。
  assert.equal(skill.path, directory);
  assert.ok(catalog.diagnostics.every((diagnostic) => !diagnostic.path.includes(layout.root)));
  assert.ok(catalog.diagnostics.some((diagnostic) => diagnostic.path === "user/logical-paths" || diagnostic.path === "user/logical-paths/config.json"));
  assert.ok(!catalog.diagnostics.some((diagnostic) => diagnostic.path.startsWith("/")));
});

test("overrides replace serially with private permissions and unknown names fail visibly", async (t) => {
  const { layout, repository, service } = await fixture(t);
  const writes = Array.from({ length: 12 }, (_, index) => repository.setSessionOverrides("00000000-0000-4000-8000-000000000001", { cron: index % 2 === 0 }));
  await Promise.all(writes);
  assert.deepEqual(await repository.getSessionOverrides("00000000-0000-4000-8000-000000000001"), { cron: false });
  assert.equal((await stat(sessionSkillsFile(layout, "00000000-0000-4000-8000-000000000001"))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dirname(sessionSkillsFile(layout, "00000000-0000-4000-8000-000000000001"))), ["skills.json"]);
  await assert.rejects(service.updateSessionOverrides("00000000-0000-4000-8000-000000000001", { "unknown-skill": true }), UnknownSkillError);
  await service.updateSessionOverrides("00000000-0000-4000-8000-000000000001", {});
  assert.deepEqual(await repository.getSessionOverrides("00000000-0000-4000-8000-000000000001"), {});
});

test("agent instructions share an atomic writer and a missing tool argument cannot clear rules", async (t) => {
  const { layout } = await fixture(t);
  const file = sessionInstructionsFile(layout, "00000000-0000-4000-8000-000000000001");
  assert.equal(await readSessionInstructions(file), "");
  await Promise.all([writeSessionInstructions(file, "first"), writeSessionInstructions(file, "second")]);
  assert.equal(await readSessionInstructions(file), "second");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const tool = instructionsTool(layout, "00000000-0000-4000-8000-000000000001");
  const denied = await tool.execute("id", { action: "set" }, undefined, undefined, {} as never);
  assert.equal(denied.isError, true);
  assert.equal(await readSessionInstructions(file), "second");
  await tool.execute("clear", { action: "set", content: "" }, undefined, undefined, {} as never);
  assert.equal(await readSessionInstructions(file), "");
  assert.deepEqual(await readdir(dirname(file)), ["INSTRUCTIONS.md"]);
});
