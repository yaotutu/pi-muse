import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../support/test-service.js";
import { createConfig } from "../../src/config/load-config.js";
import {
  subagentDetailResponseSchema,
  subagentsListResponseSchema,
} from "../../src/http/contracts/subagents.js";

test("GET /api/subagents and GET /api/subagents/:id expose all 5 specialized subagents and full capabilities", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-subagents-api-"));
  const accessKey = "subagents-test-key";
  const service = await createService(createConfig({
    runtime: { dataDir },
    server: { host: "127.0.0.1", accessKey },
  }));
  try {
    const login = await service.app.request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessKey }),
    });
    assert.equal(login.status, 200);
    const { token } = (await login.json()) as { token: string };
    const headers = { authorization: `Bearer ${token}` };

    const listRes = await service.app.request("/api/subagents", { headers });
    assert.equal(listRes.status, 200);
    const listBody = subagentsListResponseSchema.parse(await listRes.json());
    assert.deepEqual(
      listBody.subagents.map((item) => item.id),
      ["sms", "news", "browser", "habits", "dream"],
    );

    // 验证所有 5 个 Subagent 详情都严格满足契约并暴露提示词、工具、技能与 MCP 槽位
    for (const id of ["sms", "news", "browser", "habits", "dream"]) {
      const detailRes = await service.app.request(`/api/subagents/${id}`, { headers });
      assert.equal(detailRes.status, 200);
      const detail = subagentDetailResponseSchema.parse(await detailRes.json());
      assert.equal(detail.id, id);
      assert.equal(detail.executionPolicy.stateless, true);
      assert.ok(detail.prompts.length >= 1, `${id} should expose builtin prompts`);
      assert.ok(detail.capabilities.tools.length >= 1, `${id} should expose tools`);
      assert.ok(Array.isArray(detail.capabilities.skills));
      assert.ok(Array.isArray(detail.capabilities.mcp));
      if (id === "sms" || id === "news" || id === "browser") {
        assert.ok(typeof detail.routingHint === "string" && detail.routingHint.length > 0, `${id} should own routingHint`);
      } else {
        assert.equal(detail.routingHint, null);
      }
      if (id === "sms" || id === "news") {
        assert.equal(detail.hasUserInstructions, true);
        assert.equal(detail.editability.userInstructions, "editable");
        assert.ok(detail.userInstructions?.path.endsWith("AGENTS.md"));
      } else {
        assert.equal(detail.hasUserInstructions, false);
        assert.equal(detail.userInstructions, null);
      }
    }

    const badId = await service.app.request("/api/subagents/INVALID!", { headers });
    assert.equal(badId.status, 400);

    const missing = await service.app.request("/api/subagents/scout", { headers });
    assert.equal(missing.status, 404);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
