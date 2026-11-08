import assert from "node:assert/strict";
import { test } from "node:test";
import { createMonitorService } from "../../src/features/monitors/monitor-service.js";
import type { Monitor, MonitorRepository } from "../../src/features/monitors/types.js";

const createFixture = () => {
  let items: Monitor[] = [];
  const repository: MonitorRepository = {
    read: async () => structuredClone(items),
    update: async (change) => {
      const changed = change(structuredClone(items));
      if (changed.items) items = changed.items;
      return changed.result;
    },
  };
  const service = createMonitorService(repository);
  return { service, getRaw: () => items };
};

test("clearPendingByOriginSessionId clears explicit agent and defaults missing originSessionId to main", async () => {
  const { service } = createFixture();

  // 1. 创建显式智能体监控与无 originSessionId（缺省）监控
  const explicit = await service.create({
    url: "https://example.com/explicit",
    condition: "contains",
    value: "ALERT",
    originSessionId: "agent-custom",
  });
  const defaultMain = await service.create({
    url: "https://example.com/main",
    condition: "contains",
    value: "ALERT",
    // 省略 originSessionId
  });

  // 模拟检查产生待投递通知
  await service.check(explicit.id, { body: "ALERT-FOUND" });
  await service.check(defaultMain.id, { body: "ALERT-FOUND" });

  assert.ok((await service.get(explicit.id))?.pendingNotification);
  assert.ok((await service.get(defaultMain.id))?.pendingNotification);

  // 2. 清理无关智能体，不影响已有待投递项
  const clearedOther = await service.clearPendingByOriginSessionId("other-agent");
  assert.equal(clearedOther, 0);
  assert.ok((await service.get(explicit.id))?.pendingNotification);
  assert.ok((await service.get(defaultMain.id))?.pendingNotification);

  // 3. 清理显式智能体，仅清除该显式智能体的待投递项
  const clearedExplicit = await service.clearPendingByOriginSessionId("agent-custom");
  assert.equal(clearedExplicit, 1);
  assert.equal((await service.get(explicit.id))?.pendingNotification, undefined);
  assert.ok((await service.get(defaultMain.id))?.pendingNotification);

  // 4. 清理 main，清除缺省 originSessionId 的待投递项
  const clearedMain = await service.clearPendingByOriginSessionId("main");
  assert.equal(clearedMain, 1);
  assert.equal((await service.get(defaultMain.id))?.pendingNotification, undefined);
});

test("PATCH monitor modifying originSessionId discards pendingNotification to prevent leak to new agent", async () => {
  const { service } = createFixture();

  // 1. 从显式智能体改绑到另一显式智能体
  const explicit = await service.create({
    url: "https://example.com/task1",
    condition: "contains",
    value: "KW",
    originSessionId: "agent-alpha",
  });
  await service.check(explicit.id, { body: "KW" });
  assert.ok((await service.get(explicit.id))?.pendingNotification);

  // 仅修改无关字段（如 title），pendingNotification 保留
  const updatedTitle = await service.update(explicit.id, { title: "Renamed Title" });
  assert.ok(updatedTitle?.pendingNotification);

  // 修改 originSessionId 改绑到新智能体，必须丢弃旧通知
  const rebound = await service.update(explicit.id, { originSessionId: "agent-beta" });
  assert.equal(rebound?.originSessionId, "agent-beta");
  assert.equal(rebound?.pendingNotification, undefined);

  // 2. 缺省 originSessionId (main) 改绑到新智能体，也丢弃旧通知
  const defaultMain = await service.create({
    url: "https://example.com/task2",
    condition: "contains",
    value: "KW",
  });
  await service.check(defaultMain.id, { body: "KW" });
  assert.ok((await service.get(defaultMain.id))?.pendingNotification);

  const reboundMain = await service.update(defaultMain.id, { originSessionId: "agent-gamma" });
  assert.equal(reboundMain?.originSessionId, "agent-gamma");
  assert.equal(reboundMain?.pendingNotification, undefined);

  // 3. 显式修改为相同 originSessionId 时，不丢弃通知
  await service.check(defaultMain.id, { body: "NO-MATCH" });
  await service.check(defaultMain.id, { body: "KW-NEW" });
  assert.ok((await service.get(defaultMain.id))?.pendingNotification);
  const sameAgentUpdate = await service.update(defaultMain.id, { originSessionId: "agent-gamma" });
  assert.ok(sameAgentUpdate?.pendingNotification);
});
