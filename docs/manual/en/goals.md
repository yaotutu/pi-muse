# Long-term goals

This guide explains the concept of long-term goals, how goals enter model context, and how to manage them in chat today. It was checked against current server and mobile source; source inspection is not a live business test or a test of a released APK. Follow the UI and release notes of the version you installed.

## Purpose and Scope {#purpose-and-scope}

Long-term goals are global records and do not belong to an agent. Active goals are not preloaded into the prompt; when an agent's `goal` skill is enabled, the model queries global goals on demand through the `goal` tool when planning or answering goal-related questions.

A goal itself does not execute a plan, create scheduled jobs, monitor pages, or call tools automatically. To perform work, explicitly delegate it in chat or create jobs and monitors separately as described in [Scheduled jobs, web monitors, and activity history](tasks-and-monitors.md).

## Prerequisites {#prerequisites}

- The phone is connected to the real server as described in [Quick Start](getting-started.md#connect-mobile-client).
- The current mobile client has no standalone goal-management entry: the primary navigation is only 「消息 / 新闻 / 设置」 (Messages / News / Settings). There is no goals page, and goals were not moved into Settings. Existing goal data and server-side goal capabilities are retained and are not deleted by the navigation change.
- To let the model create, list, toggle milestones, or change goal status in chat, keep the current session's `goal` skill enabled. Built-in skills are enabled by default.

## Manage Goals in Chat {#manage-goals-in-chat}

1. In any session chat, explicitly ask the model to act on goals, for example “Create a goal: clear the inbox weekly, with two milestones” or “Change goal ×× to paused”.
2. The model executes through the `goal` tool; the tool result is authoritative. A verbal promise is not proof of creation or change — ask the model to list goals again to verify.
3. Goals are global records: creating or changing one in any agent affects all sessions. Switching agents does not lose or duplicate goals.

Using the `goal` tool in chat is model execution and incurs model-call costs. When a write result is unknown, ask for a read-back of the list and verify before issuing the instruction again; do not repeat the same command in a loop.

## Visible Results {#visible-results}

- A new goal is saved as a global goal with the initial status 「进行中」 (in progress).
- 「进行中」 goals can be queried on demand through the `goal` tool and remain available to every agent; paused, completed, and archived goals are no longer supplied as active.
- Milestone checks change the progress and next unfinished milestone returned by the next query.
- Setting a goal to 「已完成」 automatically checks every unfinished milestone. Conversely, checking every milestone does not automatically complete the goal; completion requires an explicit status change.

## Limits and Troubleshooting {#limits-and-troubleshooting}

| Symptom | Check | Action |
| --- | --- | --- |
| Cannot find a goals page | Current client navigation | The current mobile client has no standalone goal-management entry. This is expected; existing goal data and server capabilities are retained. |
| A goal does not influence answers | Whether its status is 「进行中」 | Only active goals are available to the `goal` tool. Completed or archived goals are no longer supplied. |
| You want to change goal details | Whether the goal already exists | Current source cannot edit an existing goal's title, description, category, or milestone text, nor add or remove individual milestones. Create the corrected goal, verify it, then handle the old one through whatever entry your installed version actually provides. |
| All milestones are checked but the goal is not completed | The goal status | Milestones never complete the goal automatically. Explicitly change its status to 「已完成」. |
| The model claims creation but nothing changed | Tool receipts and read-back | Trust the goal list read back from the server. For an unknown result, verify first; do not resend automatically. |
| Goals remain visible after switching agents | Whether the goal is global | This is expected. Global goals affect all sessions, and deleting an agent does not delete goals. |
