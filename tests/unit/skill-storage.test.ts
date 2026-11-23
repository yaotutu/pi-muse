import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDataLayout } from "../../src/adapters/storage/data-layout.js";
import { createSkillRepository } from "../../src/adapters/storage/skill-repository.js";
import { createSkillsService, UnknownSkillError } from "../../src/features/skills/service.js";
import { readAssistantInstructions, writeAssistantInstructions } from "../../src/adapters/storage/assistant-instructions.js";
import { instructionsTool } from "../../src/adapters/pi/tools/instructions.js";

const document = (name: string, body = "# Body\n") => `---\nname: ${name}\ndescription: A skill used for testing.\n---\n${body}`;
const putSkill = async (root: string, name: string, content = document(name)) => {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), content);
  return directory;
};
const fixture = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const root = await mkdtemp(join(tmpdir(), "skill-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = createDataLayout(join(root, "instance"));
  const shared = join(root, "shared");
  // 每个测试显式注入隔离目录，不扫描开发者真实 HOME 技能。
  const repository = createSkillRepository(layout, shared);
  return { root, shared, layout, repository, service: createSkillsService(repository) };
};

test("skill overrides only default on missing files and preserve damaged documents", async (t) => {
  const { layout, repository } = await fixture(t);
  assert.deepEqual(await repository.getOverrides(), {});
  const file = layout.assistantSkillOverridesFile;
  await assert.rejects(stat(dirname(file)), { code: "ENOENT" });
  await mkdir(dirname(file), { recursive: true });
  for (const original of ["{broken", "[]", '{"overrides":{"cron":"yes"}}', '{"overrides":{},"schemaVersion":1}']) {
    await writeFile(file, original);
    await assert.rejects(repository.getOverrides(), /Invalid skills-overrides document/);
    await assert.rejects(repository.setOverrides({ cron: false }), /Invalid skills-overrides document/);
    assert.equal(await readFile(file, "utf8"), original);
  }
});

test("built-ins follow the shipped default manifest; shared and created skills default off without writes", async (t) => {
  const { layout, shared, repository, service } = await fixture(t);
  await repository.listSkills();
  await assert.rejects(stat(layout.root), { code: "ENOENT" });
  await assert.rejects(stat(shared), { code: "ENOENT" });
  const directory = await putSkill(layout.skillsDir, "custom-meta", '---\nname: custom-meta\ndescription: >\n  Multiline skill description\n  parsed by pi.\nsource: shared\n---\n# Body\n');
  await putSkill(shared, "shared-meta");
  let catalog = await repository.listSkills();
  assert.deepEqual(new Set(catalog.skills.map((skill) => skill.source)), new Set(["builtin", "user", "shared"]));
  assert.ok(catalog.skills.every((skill) => skill.id === `${skill.source}/${skill.name}`));
  assert.ok(catalog.skills.every((skill) => skill.defaultEnabled === (skill.source === "builtin")),
    "仅随服务端发布的内置清单可默认开启；通用与自建一律默认关闭");
  const own = catalog.skills.find((skill) => skill.name === "custom-meta")!;
  assert.match(own.description, /Multiline skill description parsed by pi/);
  assert.equal(own.source, "user", "frontmatter cannot spoof source");
  assert.equal(own.path, directory);
  assert.deepEqual(await readdir(directory), ["SKILL.md"]);
  const original = "invalid-json";
  await writeFile(join(directory, "config.json"), original);
  catalog = await repository.listSkills();
  assert.ok(catalog.skills.some((skill) => skill.id === "user/custom-meta"));
  assert.equal(await readFile(join(directory, "config.json"), "utf8"), original);
  assert.deepEqual(await readdir(directory), ["SKILL.md", "config.json"]);
  const described = await service.describe();
  assert.ok(described.skills.every((skill) => skill.enabled === skill.defaultEnabled), "无手动选择时按默认值生效");
  assert.deepEqual((await service.getEnabledSkillDefinitions()).map((skill) => skill.id),
    described.skills.filter((skill) => skill.enabled).map((skill) => skill.id));
  assert.ok(described.skills.every((skill) => !("path" in skill)));
  await assert.rejects(stat(dirname(layout.assistantSkillOverridesFile)), { code: "ENOENT" });
});

test("priority is user > builtin > shared and a disabled winner never falls back", async (t) => {
  const { layout, shared, repository, service } = await fixture(t);
  const builtin = (await repository.listSkills()).skills.find((skill) => skill.source === "builtin")!;
  await putSkill(shared, builtin.name);
  assert.equal((await service.findSkill(builtin.name))?.source, "builtin");
  await service.updateOverrides({ [builtin.id]: true });
  const directory = await putSkill(layout.skillsDir, builtin.name);
  assert.equal((await service.findSkill(builtin.name))?.source, "user");
  assert.equal((await service.describeSkill(builtin.name)).enabled, false);
  assert.ok((await service.getEnabledSkillDefinitions()).every((skill) => skill.name !== builtin.name), "关闭的自有覆盖不回退到内置默认开启");
  await assert.rejects(service.updateOverrides({ [builtin.id]: true }), UnknownSkillError);
  await service.updateOverrides({ [`user/${builtin.name}`]: true });
  assert.deepEqual(await repository.getOverrides(), { [`user/${builtin.name}`]: true });
  await rm(directory, { recursive: true });
  // 选择仍绑定 user 来源；builtin 凭自身默认值恢复生效，不继承 user 的显式开启。
  assert.equal((await service.describeSkill(builtin.name)).enabled, true);
  assert.deepEqual((await repository.getOverrides()), { [`user/${builtin.name}`]: true });
  const catalog = await repository.listSkills();
  assert.equal(catalog.skills.filter((skill) => skill.name === builtin.name).length, 1);
  assert.ok(catalog.diagnostics.some((item) => /shadowed/.test(item.message)));
});

test("manual choices bind to the winning source when sources appear or disappear", async (t) => {
  const { layout, shared, repository, service } = await fixture(t);
  await putSkill(shared, "switchable");
  await service.updateOverrides({ "shared/switchable": true });
  assert.deepEqual(await repository.getOverrides(), { "shared/switchable": true });
  const own = await putSkill(layout.skillsDir, "switchable");
  assert.equal((await service.describeSkill("switchable")).enabled, false);
  await service.updateOverrides({ "user/switchable": true });
  await rm(own, { recursive: true });
  const described = await service.describeSkill("switchable");
  assert.equal(described.source, "shared");
  assert.equal(described.enabled, false);
  const enabledAfterSwitch = await service.getEnabledSkillDefinitions();
  assert.ok(enabledAfterSwitch.every((skill) => skill.name !== "switchable"), "来源切换后目标技能不再装配");
  assert.ok(enabledAfterSwitch.some((skill) => skill.source === "builtin"), "内置默认开启不受来源切换影响");
});

test("bare skill names do not enable a source and cannot be saved", async (t) => {
  const { layout, shared, repository, service } = await fixture(t);
  const own = await putSkill(layout.skillsDir, "by-name");
  await putSkill(shared, "by-name");
  await repository.setOverrides({ "by-name": true });
  assert.equal((await service.describeSkill("by-name")).enabled, false);
  await rm(own, { recursive: true });
  assert.equal((await service.describeSkill("by-name")).enabled, false);
  await assert.rejects(service.updateOverrides({ "by-name": true }), { message: "Unknown skill source ID" });
  assert.deepEqual(await repository.getOverrides(), { "by-name": true });
});

test("prototype-like names stay disabled until explicitly selected by source", async (t) => {
  const { layout, repository, service } = await fixture(t);
  await putSkill(layout.skillsDir, "constructor");
  assert.equal((await service.describeSkill("constructor")).enabled, false);
  assert.ok((await service.getEnabledSkillDefinitions()).every((skill) => skill.source === "builtin"));
  await repository.setOverrides({ constructor: true, "user/constructor": false });
  assert.equal((await service.describeSkill("constructor")).enabled, false);
  await service.updateOverrides({ "user/constructor": true });
  assert.equal((await service.describeSkill("constructor")).enabled, true);
});

test("shared entry symlinks load their canonical skill root, but linked files and resources are rejected", async (t) => {
  const { root, layout, shared, repository, service } = await fixture(t);
  await mkdir(shared, { recursive: true });
  const canonical = await putSkill(join(root, "packages"), "portable");
  await symlink(canonical, join(shared, "portable"), "dir");
  const skill = await service.findSkill("portable");
  assert.equal(skill?.path, await realpath(canonical));
  assert.equal(skill?.id, "shared/portable");
  assert.equal((await service.describeSkill("portable")).content, document("portable"));
  const aliasTarget = await putSkill(join(root, "packages"), "portable-alias");
  await symlink(aliasTarget, join(shared, "Directory_Alias"), "dir");
  assert.equal((await service.findSkill("portable-alias"))?.path, await realpath(aliasTarget));
  const outside = join(root, "outside.md");
  await writeFile(outside, document("linked-file"));
  const linkedFile = join(shared, "linked-file");
  await mkdir(linkedFile);
  await symlink(outside, join(linkedFile, "SKILL.md"));
  const linkedResource = await putSkill(shared, "linked-resource");
  await mkdir(join(linkedResource, "references"));
  await symlink(outside, join(linkedResource, "references", "secret.md"));
  await mkdir(layout.skillsDir, { recursive: true });
  await symlink(canonical, join(layout.skillsDir, "portable"), "dir");
  const catalog = await repository.listSkills();
  assert.ok(!catalog.skills.some((item) => item.name === "linked-file" || item.name === "linked-resource"));
  assert.equal(catalog.skills.find((item) => item.name === "portable")?.source, "shared");
  assert.ok(catalog.diagnostics.some((item) => item.path === "shared/linked-file"));
  assert.ok(catalog.diagnostics.some((item) => item.path === "shared/linked-resource"));
});

test("unsafe own directory roots and invalid shared entries produce only controlled logical diagnostics", async (t) => {
  const { root, layout, shared, repository } = await fixture(t);
  const other = join(root, "other");
  await putSkill(other, "outside");
  await mkdir(dirname(layout.skillsDir), { recursive: true });
  await symlink(other, layout.skillsDir, "dir");
  await mkdir(join(shared, "missing-document"), { recursive: true });
  await putSkill(shared, "bad-description", "---\nname: bad-description\n---\nBody\n");
  await putSkill(shared, "bad-yaml", `---\ndescription: [\n${root}\n---\n`);
  await writeFile(join(shared, "unsupported.txt"), "not a skill");
  await symlink(join(root, "missing-target"), join(shared, "broken"));
  if (process.getuid?.() !== 0) {
    const unreadable = await putSkill(shared, "unreadable");
    await chmod(join(unreadable, "SKILL.md"), 0);
  }
  const catalog = await repository.listSkills();
  assert.ok(!catalog.skills.some((item) => item.source !== "builtin"));
  assert.ok(catalog.diagnostics.length >= 5);
  const serialized = JSON.stringify(catalog.diagnostics);
  assert.ok(!serialized.includes(root));
  assert.ok(!serialized.includes(await realpath(root)));
  assert.ok(catalog.diagnostics.every((item) => !item.path.startsWith("/") && !item.message.includes("/")));
  assert.ok(catalog.diagnostics.some((item) => item.path === "user"));
  if (process.getuid?.() !== 0) assert.ok(catalog.diagnostics.some((item) => item.path === "shared/unreadable"));
});

test("skill details contain full bounded UTF-8 content and unknown or oversized skills stay unavailable", async (t) => {
  const { layout, shared, repository, service } = await fixture(t);
  const prefix = document("bounded", "");
  const content = prefix + "x".repeat(100 * 1024 - Buffer.byteLength(prefix));
  await putSkill(layout.skillsDir, "bounded", content);
  await service.updateOverrides({ "user/bounded": true });
  const described = await service.describeSkill("bounded");
  assert.equal(described.content, content);
  assert.equal(described.id, "user/bounded");
  assert.equal(described.source, "user");
  assert.equal(described.defaultEnabled, false);
  assert.equal(described.enabled, true);
  assert.ok(!("path" in described));
  const enabled = await service.getEnabledSkillDefinitions();
  assert.ok(enabled.some((skill) => skill.id === "user/bounded" && skill.path === join(layout.skillsDir, "bounded")));
  assert.ok(enabled.some((skill) => skill.source === "builtin"), "内置默认开启与显式自建选择并存");
  assert.ok(enabled.every((skill) => skill.id === "user/bounded" || skill.source === "builtin"));
  await putSkill(shared, "oversized", document("oversized", "中".repeat(40 * 1024)));
  await putSkill(layout.skillsDir, "invalid-utf8");
  await writeFile(join(layout.skillsDir, "invalid-utf8", "SKILL.md"), Buffer.from([0xff]));
  assert.equal(await repository.readSkill("oversized"), undefined);
  assert.equal(await repository.readSkill("missing"), undefined);
  await assert.rejects(service.describeSkill("oversized"), UnknownSkillError);
  await assert.rejects(service.describeSkill("missing"), UnknownSkillError);
  const catalog = await repository.listSkills();
  assert.ok(catalog.diagnostics.some((item) => item.path === "shared/oversized"));
  assert.ok(!catalog.skills.some((item) => item.name === "invalid-utf8"));
});

test("overrides replace serially with private permissions and unknown names fail without writing", async (t) => {
  const { layout, repository, service } = await fixture(t);
  const builtin = (await repository.listSkills()).skills.find((skill) => skill.source === "builtin")!;
  const writes = Array.from({ length: 12 }, (_, index) => service.updateOverrides({ [builtin.id]: index % 2 === 0 }));
  await Promise.all(writes);
  assert.deepEqual(await repository.getOverrides(), { [builtin.id]: false });
  const file = layout.assistantSkillOverridesFile;
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dirname(file)), ["skill-overrides.json"]);
  const before = await readFile(file, "utf8");
  await assert.rejects(service.updateOverrides({ "unknown-skill": true }), UnknownSkillError);
  await assert.rejects(service.updateOverrides({ [`shared/${builtin.name}`]: true }), UnknownSkillError);
  assert.equal(await readFile(file, "utf8"), before);
  await service.updateOverrides({});
  assert.deepEqual(await repository.getOverrides(), {});
});

test("agent instructions share an atomic writer and a missing tool argument cannot clear rules", async (t) => {
  const { layout } = await fixture(t);
  const file = layout.assistantInstructionsFile;
  assert.equal(await readAssistantInstructions(file), "");
  await Promise.all([writeAssistantInstructions(file, "first"), writeAssistantInstructions(file, "second")]);
  assert.equal(await readAssistantInstructions(file), "second");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const tool = instructionsTool(layout);
  const denied = await tool.execute("id", { action: "set" }, undefined, undefined, {} as never);
  assert.equal(denied.isError, true);
  assert.equal(await readAssistantInstructions(file), "second");
  const noApproval = await tool.execute("clear", { action: "set", content: "" }, undefined, undefined, {} as never);
  assert.equal(noApproval.isError, true);
  assert.equal(await readAssistantInstructions(file), "second");
  assert.deepEqual(await readdir(dirname(file)), ["INSTRUCTIONS.md"]);
});
