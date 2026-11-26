# Scheduled jobs, web monitors, and execution records

This guide explains the current mobile client entries for scheduled jobs, web monitors, and execution records. The primary tabs are Messages, News, and Settings: create a job or monitor in main chat, then open Scheduled jobs or Web monitors under Settings → Records and tasks to manage it. Current-session execution timelines appear both as a compact collapsible bar above tool-using replies and inside the session details panel. This page is checked against current server and mobile source; it is not a test of a released APK.

## Purpose and Scope {#purpose-and-scope}

- **Scheduled job**: At the scheduled time, Pi Muse submits the job text as a user message to the origin session's current conversation and starts a real model run.
- **Web monitor**: The server periodically fetches one public HTTP(S) page and notifies the origin session when content changes or a keyword changes from not matched to matched.
- **Execution records**: Each model run automatically records and persists a sanitized step timeline (tool calls, subagents, approvals, and file commits) without requiring explicit activity registration.

The chat `schedule` and `monitor` tools list and control records only in the current session and do not accept a cross-session target. Management pages in Settings use server REST endpoints, so inspecting or managing each record does not require a model run. There is no bottom Tasks aggregate page or topic-session picker.

## Prerequisites {#prerequisites}

- The phone is connected to the real server as described in [Quick Start](getting-started.md#connect-mobile-client) and uses the Android client matching current source.
- The server must keep running. By default it scans jobs every 30 seconds and web monitors every 60 seconds. A one-time job that expires while the service is stopped is not caught up.
- Creating a job requires the current session's `cron` skill; creating a monitor requires the `monitor` skill. Re-enable either in session settings if it was disabled.
- Due jobs and monitor checks may access external networks and incur model costs. Monitors access only public HTTP(S), and fetched content is untrusted data.

## View Execution Records {#view-activity-history}

1. When a reply uses tools, a compact process bar appears above that reply in chat; tap it to expand or collapse its steps inline.
2. In Messages, tap the assistant at the top to open the session details panel, which contains two tabs: 「执行记录」 (Execution records) and 「审批」 (Approvals).
3. In 「执行记录」, inspect live and historical runs ordered newest first, and expand any run card to inspect sanitized steps (excluding internal model reasoning, raw SQL, and raw file contents).
4. Tap any approval step to open its approval details (default 24-hour approval window; approving resumes execution in place).
5. Load the next page automatically or manually when more runs exist.

Plain-text replies with zero steps do not display a process bar.

## Create and Control Scheduled Jobs {#scheduled-jobs}

1. Open Messages to enter main chat. A new job belongs to the session that creates it. Resetting chat keeps the job.
2. State the job content and its one-time or daily time in a message. For example: “Create a daily job at 09:00 to summarize today's todo items” or “Create a one-time job tomorrow at 09:00 Shanghai time to remind me to review the checklist.”
3. Wait for the model to actually call the `schedule` tool. A successful result should include the job ID and next execution time; a natural-language promise is not a scheduled job.
4. Open Settings → Records and tasks → Scheduled jobs, tap 「刷新任务」 (Refresh jobs), then select a job to inspect its prompt, time, and events. Edit the prompt, or pause, resume, cancel, or retry failed work as its state allows. These controls and deletion require confirmation. The current form does not edit the schedule time, and scheduling controls are not a Stop button for a running model.
5. You can also ask the model in main to list or cancel current-session jobs. The `schedule` tool has only create, list, and cancel actions; pause, resume, retry, and delete use Settings. REST management capabilities are not the same as model-tool capabilities.

A one-time time must include an explicit timezone. A daily job uses `HH:mm`, interpreted in the server local timezone returned by `/api/health`, not the phone timezone. Pause stops future scheduling only; cancel is not the stop button for an executing chat run; retry starts one real model run for a failed job and does not automatically resend an unknown operation.

## Create and Control Web Monitors {#web-monitors}

1. Open Messages to enter main chat. Monitor notifications go to the origin session.
2. Provide a public HTTP(S) URL, trigger condition, and check interval of at least five minutes. For example: “Monitor `https://example.com/product` and notify me when ‘restock’ appears; check every 5 minutes.”
3. There are only two trigger conditions: `change` means the content fingerprint changes; `contains` means a specified keyword changes from not matched to matched and requires a keyword.
4. Wait for the model to actually call the `monitor` tool, then use its list result to check the condition, interval, accumulated checks, and errors. Settings → Records and tasks → Web monitors lets you refresh the list, view titles, states, and URLs, pause, resume, or stop as each state allows, and delete after confirmation. The current page has no per-check history or condition-edit form.
5. The `monitor` tool in main can also list, pause, resume, and stop current-session monitors, but has no delete action. Stop is terminal; create a new monitor to continue.

For `change`, the first check only establishes a baseline and does not notify; later fingerprint changes do. For `contains`, continued matches do not repeat notifications—only a transition from not matched to matched does. Pause or stop affects future checks only; it does not start an immediate check or remove an already observed fact.

## Visible Results {#visible-results}

- After a job fires, the origin session's chat receives a user message beginning with 「⏰ [定时任务]」 and starts a real model run.
- When a monitor matches, the origin session receives a notification beginning with 「📡 [监控]」.
- Run status and steps update from real execution. Failure, denial, cancellation, expiry, and interruption are preserved rather than disguised as success.

The default scan period means execution may start slightly later. If a tool result says the outcome is unknown, reread the current state before deciding whether to retry; do not automatically resend a write.

## Limits and Troubleshooting {#limits-and-troubleshooting}

| Symptom | Check | Action |
| --- | --- | --- |
| A job did not run at its time | Whether the server is running, the origin session is busy, or the scan is only slightly delayed | Wait for the next scan. A busy conversation delays the job. A one-time job missed during downtime is not caught up. |
| A one-time job did not run after restart | Whether its time expired | Expired jobs are not caught up; create a new one if needed. A daily job recalculates its next future time. |
| A job failed | Latest result and error state | Failure is not rerun automatically. Verify the impact, then retry manually in Settings → Scheduled jobs, or create a new job if needed. |
| A daily time behaves unexpectedly | Server timezone returned by `/api/health` | Enter `HH:mm` in server time; do not convert using the phone timezone. |
| A monitor does not notify | Condition, latest check, fetch error, and server state | `change` does not notify on the baseline or unchanged content; `contains` does not repeat while a match continues. |
| Monitor fetching fails | Whether the URL is public HTTP(S), reachable, and web tools are enabled | Fix the link or retry later. The error remains until the next successful check. |
| The old task aggregate page is missing | The primary tabs are Messages, News, and Settings | Manage jobs and monitors under Settings → Records and tasks; execution history is in the session details panel under Execution records. |
| An operation result is unknown | Tool result and current-session state | Verify whether the record still exists and its state before retrying. Do not resend automatically. |

When you delete a topic session, review its jobs and monitors before confirming. Delete them with the session or keep them and move them to the main chat. Kept schedules retain their timing, control state, latest result, and pending monitor notifications. If a job is running in the topic, wait for it to finish before choosing to keep the schedules. Resetting the main chat clears its history and keeps its schedules.
