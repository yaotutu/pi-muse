import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import {
  agentInstructionsFile,
} from "../../adapters/storage/data-layout.js";
import {
  readAgentInstructions,
  writeAgentInstructions,
} from "../../adapters/storage/agent-instructions.js";
import { isAgentId } from "../../features/conversation/agent-id.js";
import { withPurpose } from "../../features/dream/purpose.js";
import {
  updateSkillsSchema,
  saveInstructionsSchema,
  updateAgentDreamSchema,
  resolveDreamPendingSchema,
  resetAgentSchema,
  createAgentSchema,
} from "../contracts/rest.js";
import { UnknownSkillError } from "../../features/skills/service.js";
import { AgentError } from "../../features/agents/types.js";
import { AgentCommunicationError } from "../../features/agent-communication/service.js";
import { capabilitySchema } from "../contracts/group-chat.js";

/**
 * 智能体管理路由：多智能体列表、重置会话、生命周期（含级联删除）、技能覆盖、专属指令与 Dream 配置。
 */
export const createAgentRoutes = (dependencies: HttpDependencies) => {
  const { conversationHub, layout, skills, dream } = dependencies;
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof AgentError) return c.json({ error: error.message, code: error.code }, error.status);
    if (error instanceof AgentCommunicationError) return c.json({ error: error.message, code: error.code }, error.code === "NOT_FOUND" ? 404 : error.code === "BUSY" ? 409 : 400);
    throw error;
  });
  app.get("/", async (c) => c.json({ agents: await dependencies.agents.list() }));
  app.get("/:agentId/capability", async (c) => c.json(await dependencies.groupRouting.capability(c.req.param("agentId"))));
  app.put("/:agentId/capability", async (c) => {
    const parsed = capabilitySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid capability", code: "INVALID_INPUT" }, 400);
    const result = await dependencies.conversationHub.withExistingAgent(c.req.param("agentId"), () =>
      dependencies.groupRouting.saveCapability(c.req.param("agentId"), parsed.data.capability));
    if (!result) throw new AgentCommunicationError("NOT_FOUND", "Agent not found");
    return c.json(result);
  });
  app.post("/", async (c) => {
    const parsed = createAgentSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid agentId", code: "INVALID_AGENT_ID" }, 400);
    return c.json({ agent: await dependencies.agents.create(parsed.data.agentId) });
  });
  app.post("/:agentId/reset", async (c) => {
    const parsed = resetAgentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid reset request", code: "INVALID_REQUEST" }, 400);
    return c.json(await dependencies.agents.reset(c.req.param("agentId"), parsed.data.clearSchedules));
  });

  // GET /api/agents/:agentId/skills - 读取智能体技能生效状态
  app.get("/:agentId/skills", async (c) => {
    const agentId = c.req.param("agentId");
    if (!isAgentId(agentId)) {
      return c.json({ error: "Invalid agentId", code: "INVALID_AGENT_ID" }, 400);
    }
    return c.json(await skills.describeAgent(agentId));
  });

  // PUT /api/agents/:agentId/skills - 保存智能体技能覆盖
  app.put("/:agentId/skills", async (c) => {
    const agentId = c.req.param("agentId");
    if (!isAgentId(agentId)) {
      return c.json({ error: "Invalid agentId", code: "INVALID_AGENT_ID" }, 400);
    }

    const body = await c.req.json().catch(() => undefined);
    const parsed = updateSkillsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", code: "INVALID_REQUEST" }, 400);
    }

    try {
      return await conversationHub.withAgent(agentId, async () => {
        await skills.updateAgentOverrides(agentId, parsed.data.overrides);
        return c.json(await skills.describeAgent(agentId));
      });
    } catch (error) {
      if (error instanceof UnknownSkillError) return c.json({ error: error.message, code: "UNKNOWN_SKILL" }, 400);
      throw error;
    }
  });

  // GET /api/agents/:agentId/instructions - 读取智能体专属规则
  app.get("/:agentId/instructions", async (c) => {
    const agentId = c.req.param("agentId");
    if (!isAgentId(agentId)) {
      return c.json({ error: "Invalid agentId", code: "INVALID_AGENT_ID" }, 400);
    }
    const file = agentInstructionsFile(layout, agentId);
    const instructions = await readAgentInstructions(file);
    return c.json({ instructions });
  });

  // PUT /api/agents/:agentId/instructions - 保存智能体专属规则（可选附带智能体用途）
  app.put("/:agentId/instructions", async (c) => {
    const agentId = c.req.param("agentId");
    if (!isAgentId(agentId)) {
      return c.json({ error: "Invalid agentId", code: "INVALID_AGENT_ID" }, 400);
    }

    const body = await c.req.json().catch(() => undefined);
    const parsed = saveInstructionsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid instructions request", code: "INVALID_REQUEST" }, 400);
    }

    return conversationHub.withAgent(agentId, async () => {
      const file = agentInstructionsFile(layout, agentId);
      const text =
        parsed.data.purpose !== undefined
          ? withPurpose(parsed.data.instructions, parsed.data.purpose)
          : parsed.data.instructions;
      await writeAgentInstructions(file, text);
      const instructions = await readAgentInstructions(file);
      return c.json({ instructions });
    });
  });

  // GET /api/agents/:agentId/dream - 读取智能体 Dream 状态与配置
  app.get("/:agentId/dream", async (c) => {
    const agentId = c.req.param("agentId");
    if (!isAgentId(agentId)) {
      return c.json({ error: "Invalid agentId", code: "INVALID_AGENT_ID" }, 400);
    }
    return c.json(await dream.describeAgent(agentId));
  });

  // PUT /api/agents/:agentId/dream - 保存智能体 Dream 开关与补充提示词
  app.put("/:agentId/dream", async (c) => {
    const agentId = c.req.param("agentId");
    if (!isAgentId(agentId)) {
      return c.json({ error: "Invalid agentId", code: "INVALID_AGENT_ID" }, 400);
    }
    const parsed = updateAgentDreamSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid dream request", code: "INVALID_REQUEST" }, 400);
    }
    return conversationHub.withAgent(agentId, async () => {
      return c.json(await dream.updateAgentSettings(agentId, parsed.data));
    });
  });

  // POST /api/agents/:agentId/dream/run - 立即运行当前智能体的 Dream 整理
  app.post("/:agentId/dream/run", async (c) => {
    const agentId = c.req.param("agentId");
    if (!isAgentId(agentId)) {
      return c.json({ error: "Invalid agentId", code: "INVALID_AGENT_ID" }, 400);
    }
    const result = await dream.runNow(agentId);
    if (!result.ok) {
      return c.json({ error: result.message }, result.code === "not_found" ? 404 : 409);
    }
    return c.json(result.state);
  });

  // POST /api/agents/:agentId/dream/pending/:pendingId - 处理待决建议
  app.post("/:agentId/dream/pending/:pendingId", async (c) => {
    const agentId = c.req.param("agentId");
    if (!isAgentId(agentId)) {
      return c.json({ error: "Invalid agentId", code: "INVALID_AGENT_ID" }, 400);
    }
    const parsed = resolveDreamPendingSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid dream pending decision", code: "INVALID_REQUEST" }, 400);
    }
    const result = await dream.resolvePending(
      agentId,
      c.req.param("pendingId"),
      parsed.data,
    );
    if (!result.ok) {
      return c.json({ error: result.message }, result.code === "not_found" ? 404 : 409);
    }
    return c.json(result.state);
  });

  app.delete("/:agentId", async (c) => c.json(await dependencies.agents.remove(c.req.param("agentId"))));
  return app;
};
