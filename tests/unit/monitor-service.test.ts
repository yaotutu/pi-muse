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

test("moving a monitor preserves the pending notification and leaves other owners unchanged", async () => {
  const { service } = createFixture();
  const topic = await service.create({ url: "https://example.com/topic", condition: "contains", value: "ALERT", originSessionId: "topic" });
  const main = await service.create({ url: "https://example.com/main", condition: "contains", value: "ALERT" });
  await service.check(topic.id, { body: "ALERT" });
  await service.check(main.id, { body: "ALERT" });
  const topicBefore = await service.get(topic.id);
  const mainBefore = await service.get(main.id);
  assert.ok(topicBefore?.pendingNotification);
  assert.ok(mainBefore?.pendingNotification);
  await service.moveByOriginSessionId("topic", "main");
  assert.deepEqual(await service.get(topic.id), { ...topicBefore, originSessionId: "main" });
  assert.deepEqual(await service.get(main.id), mainBefore);
});
