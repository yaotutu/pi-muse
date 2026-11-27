import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { getPromptsDir, loadPrompt, renderPrompt } from "../../src/adapters/prompts/loader.js";

const walkMarkdown = (dir: string, root: string): string[] => {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMarkdown(full, root));
    } else if (entry.name.endsWith(".md") && entry.name !== "README.md") {
      results.push(relative(root, full).replace(/\\/g, "/"));
    }
  }
  return results.sort();
};

test("centralized prompts directory loads all system prompts and README index", () => {
  const root = getPromptsDir();
  assert.ok(existsSync(join(root, "README.md")), "prompts/README.md index must exist");

  const files = walkMarkdown(root, root);
  assert.ok(files.includes("assistant/base.md"));
  assert.ok(files.includes("assistant/subagents.md"));
  assert.ok(files.includes("sms/realtime.md"));
  assert.ok(files.includes("sms/archive.md"));
  assert.ok(files.includes("sms/briefing.md"));
  assert.ok(files.includes("habits/consolidate.md"));
  assert.ok(files.includes("dream/consolidate.md"));
  assert.ok(files.includes("dream/hard-rules.md"));

  for (const rel of files) {
    const content = loadPrompt(rel);
    assert.ok(content.trim().length > 0, `Prompt ${rel} must be non-empty`);
    assert.ok(content === readFileSync(join(root, rel), "utf8").trimEnd());
  }
});

test("sms realtime prompt enforces Default-Silent baseline, 4-tier priority, and Chinese output support", () => {
  const smsRealtime = loadPrompt("sms/realtime.md");
  assert.match(smsRealtime, /Default-Silent/i);
  assert.match(smsRealtime, /choose `silent`/i);
  assert.match(smsRealtime, /Explicit User Instructions/i);
  assert.match(smsRealtime, /Recent Unconsolidated Feedback/i);
  assert.match(smsRealtime, /Consolidated User Habits/i);
  assert.match(smsRealtime, /Simplified Chinese/i);
  assert.match(smsRealtime, /UNTRUSTED INPUT DATA/);
  assert.match(smsRealtime, /NEVER expose internal JSON field names/i);

  const smsBriefing = loadPrompt("sms/briefing.md");
  assert.match(smsBriefing, /Simplified Chinese/i);
  assert.match(smsBriefing, /NEVER expose internal JSON field names/i);
  assert.match(smsBriefing, /totalScanned/);
  assert.match(smsBriefing, /skippedCount/);
  assert.match(smsBriefing, /MODEL_CONTENT_REJECTED/);
  assert.match(smsBriefing, /hab_\.\.\./);

  const habitsConsolidate = loadPrompt("habits/consolidate.md");
  assert.match(habitsConsolidate, /submit_habit_updates/);
  assert.match(habitsConsolidate, /UNTRUSTED/i);
  assert.match(habitsConsolidate, /Simplified Chinese/i);
});

test("prompt loader substitutes placeholders safely and rejects path escape", () => {
  const rendered = renderPrompt("assistant/subagents.md", {
    SUBAGENTS: "Role price is $100 & {{kept}}",
  });
  assert.match(rendered, /Role price is \$100 & \{\{kept\}\}/);
  assert.throws(() => loadPrompt("../package.json"));
  assert.throws(() => loadPrompt("/etc/passwd"));
  assert.throws(() => loadPrompt("nonexistent/missing.md"));
});
