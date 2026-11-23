import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { UnknownSkillError } from "../../features/skills/service.js";
import { writeAssistantInstructions } from "../../adapters/storage/assistant-instructions.js";
import { inspectProfileFile } from "../../adapters/storage/workspace-document-includes.js";
import { saveInstructionsSchema, updateSkillsSchema } from "../contracts/rest.js";

/** 助手配置由所有会话共同读取，独立于会话生命周期。 */
export const createAssistantRoutes = ({ layout, skills }: Pick<HttpDependencies, "layout" | "skills">) => {
  const app = new Hono();
  app.get("/instructions", async (c) => {
    const inspected = await inspectProfileFile(layout.assistantInstructionsFile, layout.workspaceDir);
    return c.json({ instructions: inspected.raw, includes: inspected.includes });
  });
  app.put("/instructions", async (c) => {
    const parsed = saveInstructionsSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid instructions", code: "INVALID_REQUEST" }, 400);
    await writeAssistantInstructions(layout.assistantInstructionsFile, parsed.data.instructions, undefined, layout.workspaceDir);
    const inspected = await inspectProfileFile(layout.assistantInstructionsFile, layout.workspaceDir);
    return c.json({ instructions: inspected.raw, includes: inspected.includes });
  });
  app.get("/skills", async (c) => c.json(await skills.describe()));
  app.get("/skills/:name", async (c) => {
    const name = c.req.param("name");
    if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return c.json({ error: "Invalid skill name", code: "INVALID_SKILL_NAME" }, 400);
    try {
      return c.json(await skills.describeSkill(name));
    } catch (error) {
      if (error instanceof UnknownSkillError) return c.json({ error: "Skill not found", code: "SKILL_NOT_FOUND" }, 404);
      throw error;
    }
  });
  app.put("/skills", async (c) => {
    const parsed = updateSkillsSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid skills", code: "INVALID_REQUEST" }, 400);
    await skills.updateOverrides(parsed.data.overrides);
    return c.json(await skills.describe());
  });
  return app;
};
