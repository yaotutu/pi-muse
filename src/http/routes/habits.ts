import { Hono, type Context } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { HabitError } from "../../features/habits/errors.js";
import {
  consolidateHabitsRequestSchema,
  createHabitRequestSchema,
  updateHabitRequestSchema,
} from "../contracts/habits.js";

const failure = (error: unknown) => {
  if (error instanceof HabitError) {
    const status =
      error.code === "INVALID_INPUT" ? 400
      : error.code === "NOT_FOUND" ? 404
      : error.code === "SHUTDOWN" ? 503
      : 409;
    return {
      status,
      body: { error: error.message, code: error.code },
    } as const;
  }
  return undefined;
};

/** 通用习惯引擎 HTTP 路由（/api/habits/:domain/*）。 */
export const createHabitsRoutes = (dependencies: Pick<HttpDependencies, "habits">) => {
  const { habits } = dependencies;
  const app = new Hono();

  const handle = async (c: Context, work: () => Promise<unknown>) => {
    try {
      return c.json(await work());
    } catch (error) {
      const mapped = failure(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  };

  app.get("/:domain", (c) => handle(c, () => habits.getOverview(c.req.param("domain"))));

  app.post("/:domain", async (c) => {
    const parsed = createHabitRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid habit payload", code: "INVALID_INPUT" }, 400);
    return handle(c, async () => ({ habit: await habits.addHabit(c.req.param("domain"), parsed.data.text, "manual") }));
  });

  app.patch("/:domain/:habitId", async (c) => {
    const parsed = updateHabitRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid habit payload", code: "INVALID_INPUT" }, 400);
    return handle(c, async () => ({
      habit: await habits.updateHabit(c.req.param("domain"), c.req.param("habitId"), parsed.data.text),
    }));
  });

  app.delete("/:domain/:habitId", (c) =>
    handle(c, () => habits.deleteHabit(c.req.param("domain"), c.req.param("habitId"))),
  );

  app.post("/:domain/consolidate", async (c) => {
    const parsed = consolidateHabitsRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid consolidate request", code: "INVALID_INPUT" }, 400);
    return handle(c, () => habits.consolidate(c.req.param("domain")));
  });

  return app;
};
