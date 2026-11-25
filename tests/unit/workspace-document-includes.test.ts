import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_WORKSPACE_INCLUDE_DEPTH,
  RESOLVED_WORKSPACE_TEXT_LIMIT,
  readResolvedProfileFile,
} from "../../src/adapters/storage/workspace-document-includes.js";

const makeWorkspace = async (t: test.TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-doc-includes-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "assistant"), { recursive: true });
  await mkdir(join(workspace, "subagents", "sms"), { recursive: true });
  await mkdir(join(workspace, "subagents", "news"), { recursive: true });
  await mkdir(join(workspace, "files"), { recursive: true });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace };
};

test("non-include documents, missing roots, middle rules and other frontmatter keys stay verbatim", async (t) => {
  const { workspace } = await makeWorkspace(t);
  const target = join(workspace, "assistant", "AGENTS.md");

  assert.equal(await readResolvedProfileFile(target, workspace), "");

  const plain = "Always answer concisely.\n\n---\n\nSecond section after divider.";
  await writeFile(target, plain, "utf8");
  assert.equal(await readResolvedProfileFile(target, workspace), plain);

  const stringFrontmatter = "---\nhello\n---\nworld";
  await writeFile(target, stringFrontmatter, "utf8");
  assert.equal(await readResolvedProfileFile(target, workspace), stringFrontmatter);

  const otherKey = "---\ntitle: Keep intact\n---\nMain rules here.";
  await writeFile(target, otherKey, "utf8");
  assert.equal(await readResolvedProfileFile(target, workspace), otherKey);

  const malformedYaml = "---\ninclude: [unclosed\n---\nFallback body.";
  await writeFile(target, malformedYaml, "utf8");
  assert.equal(await readResolvedProfileFile(target, workspace), malformedYaml);
});

test("frontmatter include resolves relative sibling, UTF-8, single string, inline array and CRLF paths", async (t) => {
  const { workspace } = await makeWorkspace(t);
  const smsMain = join(workspace, "subagents", "sms", "AGENTS.md");
  await writeFile(join(workspace, "subagents", "sms", "bank.md"), "Notify bank fraud alerts.", "utf8");
  await writeFile(join(workspace, "subagents", "sms", "快递规则.md"), "Notify pickup codes only.", "utf8");
  await writeFile(join(workspace, "subagents", "sms", "empty.md"), "   \n\t  ", "utf8");
  await writeFile(join(workspace, "files", "vip-contacts.md"), "Always notify Alice & Bob.", "utf8");

  await writeFile(
    smsMain,
    [
      "---",
      "include:",
      "  - ./bank.md",
      "  - ./快递规则.md",
      "  - empty.md",
      "  - ../../files/vip-contacts.md",
      "---",
      "",
      "Root SMS rule.",
    ].join("\r\n"),
    "utf8",
  );

  const resolved = await readResolvedProfileFile(smsMain, workspace);
  assert.equal(
    resolved,
    [
      "Root SMS rule.",
      "<!-- begin include: subagents/sms/bank.md -->\nNotify bank fraud alerts.\n<!-- end include: subagents/sms/bank.md -->",
      "<!-- begin include: subagents/sms/快递规则.md -->\nNotify pickup codes only.\n<!-- end include: subagents/sms/快递规则.md -->",
      "<!-- begin include: files/vip-contacts.md -->\nAlways notify Alice & Bob.\n<!-- end include: files/vip-contacts.md -->",
    ].join("\n\n"),
  );

  await writeFile(smsMain, "---\ninclude: bank.md\n---\nSingle entry.", "utf8");
  const single = await readResolvedProfileFile(smsMain, workspace);
  assert.match(single, /^Single entry\./);
  assert.match(single, /<!-- begin include: subagents\/sms\/bank\.md -->\nNotify bank fraud alerts\./);

  await writeFile(smsMain, "---\ninclude: [./bank.md, ../../files/vip-contacts.md]\n---\nInline array.", "utf8");
  const inline = await readResolvedProfileFile(smsMain, workspace);
  assert.match(inline, /Inline array\./);
  assert.match(inline, /Notify bank fraud alerts\./);
  assert.match(inline, /Always notify Alice & Bob\./);

  await writeFile(smsMain, "---\ninclude:\n  - ./bank.md\n---", "utf8");
  const onlyFrontmatter = await readResolvedProfileFile(smsMain, workspace);
  assert.equal(
    onlyFrontmatter,
    "<!-- begin include: subagents/sms/bank.md -->\nNotify bank fraud alerts.\n<!-- end include: subagents/sms/bank.md -->",
  );
});

test("nested includes respect max depth 5 and stop expanding beyond depth 5", async (t) => {
  assert.equal(MAX_WORKSPACE_INCLUDE_DEPTH, 5);
  assert.equal(RESOLVED_WORKSPACE_TEXT_LIMIT, 60_000);
  const { workspace } = await makeWorkspace(t);
  const dir = join(workspace, "assistant");

  await writeFile(join(dir, "d6.md"), "DEPTH-6-SHOULD-NOT-EXPAND", "utf8");
  await writeFile(join(dir, "d5.md"), "---\ninclude: [./d6.md]\n---\nDEPTH-5-BODY", "utf8");
  await writeFile(join(dir, "d4.md"), "---\ninclude: [./d5.md]\n---\nDEPTH-4-BODY", "utf8");
  await writeFile(join(dir, "d3.md"), "---\ninclude: [./d4.md]\n---\nDEPTH-3-BODY", "utf8");
  await writeFile(join(dir, "d2.md"), "---\ninclude: [./d3.md]\n---\nDEPTH-2-BODY", "utf8");
  await writeFile(join(dir, "d1.md"), "---\ninclude: [./d2.md]\n---\nDEPTH-1-BODY", "utf8");
  const root = join(dir, "AGENTS.md");
  await writeFile(root, "---\ninclude: [./d1.md]\n---\nDEPTH-0-ROOT", "utf8");

  const resolved = await readResolvedProfileFile(root, workspace);
  for (let i = 0; i <= 5; i++) {
    assert.ok(resolved.includes(i === 0 ? "DEPTH-0-ROOT" : `DEPTH-${i}-BODY`), `missing depth ${i}`);
  }
  assert.ok(!resolved.includes("DEPTH-6-SHOULD-NOT-EXPAND"), "depth 6 must not be expanded");
});

test("cycles and diamond includes resolve safely without duplication or recursion errors", async (t) => {
  const { workspace } = await makeWorkspace(t);
  const dir = join(workspace, "assistant");
  const root = join(dir, "AGENTS.md");

  await writeFile(join(dir, "shared.md"), "DIAMOND-SHARED-ONCE", "utf8");
  await writeFile(join(dir, "b.md"), "---\ninclude: [./AGENTS.md, ./shared.md]\n---\nFROM-B", "utf8");
  await writeFile(join(dir, "c.md"), "---\ninclude: [./b.md, ./shared.md]\n---\nFROM-C", "utf8");
  await writeFile(root, "---\ninclude: [./AGENTS.md, ./b.md, ./c.md]\n---\nROOT-CYCLE", "utf8");

  const resolved = await readResolvedProfileFile(root, workspace);
  assert.ok(resolved.includes("ROOT-CYCLE"));
  assert.ok(resolved.includes("FROM-B"));
  assert.ok(resolved.includes("FROM-C"));
  assert.equal(resolved.split("DIAMOND-SHARED-ONCE").length - 1, 1);
});

test("missing, escaping, absolute, symlinked, directory and non-text includes are silently skipped", async (t) => {
  const { root: dataRoot, workspace } = await makeWorkspace(t);
  const smsDir = join(workspace, "subagents", "sms");
  const smsMain = join(smsDir, "AGENTS.md");
  await writeFile(join(dataRoot, "outside-secret.txt"), "TOP-SECRET-OUTSIDE", "utf8");
  await writeFile(join(smsDir, "valid.md"), "VALID-INCLUDED-RULE", "utf8");
  await mkdir(join(smsDir, "subdir"));
  await writeFile(join(smsDir, "binary.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  await symlink(join(dataRoot, "outside-secret.txt"), join(smsDir, "escape-link.md"));
  await symlink(join(smsDir, "valid.md"), join(smsDir, "internal-link.md"));

  await writeFile(
    smsMain,
    [
      "---",
      "include:",
      "  - ./missing.md",
      "  - ./subdir",
      "  - ./escape-link.md",
      "  - ./internal-link.md",
      "  - ./binary.bin",
      "  - ../../../outside-secret.txt",
      "  - /etc/passwd",
      "  - .\\valid.md",
      "  - ./valid.md",
      "---",
      "Keep running safely.",
    ].join("\n"),
    "utf8",
  );

  const resolved = await readResolvedProfileFile(smsMain, workspace);
  assert.ok(resolved.includes("Keep running safely."));
  assert.ok(resolved.includes("<!-- begin include: subagents/sms/valid.md -->\nVALID-INCLUDED-RULE\n<!-- end include: subagents/sms/valid.md -->"));
  assert.ok(!resolved.includes("TOP-SECRET-OUTSIDE"));
  assert.ok(!resolved.includes("internal-link.md"));

  // Root file itself as a symlink still fails closed just like readProfileFile.
  const badRoot = join(smsDir, "root-link.md");
  await symlink(join(smsDir, "valid.md"), badRoot);
  await assert.rejects(() => readResolvedProfileFile(badRoot, workspace));
});

test("resolved content strictly enforces total character cap with truncation notice", async (t) => {
  const { workspace } = await makeWorkspace(t);
  const dir = join(workspace, "assistant");
  const root = join(dir, "AGENTS.md");

  await writeFile(join(dir, "first.md"), "A".repeat(120), "utf8");
  await writeFile(join(dir, "second.md"), "B".repeat(500), "utf8");
  await writeFile(root, "---\ninclude: [./first.md, ./second.md]\n---\nRoot short.", "utf8");

  const resolved = await readResolvedProfileFile(root, workspace, { maxChars: 220 });
  assert.ok(resolved.length <= 220, `expected length <= 220, got ${resolved.length}`);
  assert.ok(resolved.includes("Root short."));
  assert.ok(resolved.includes("<!-- include truncated: resolved character limit reached -->"));
});
