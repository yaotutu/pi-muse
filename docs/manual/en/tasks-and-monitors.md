# Scheduled jobs, web monitors, and activity history

This guide explains the current mobile client entries for scheduled jobs, web monitors, and activity history. The primary tabs are Messages, News, and Settings: create a job or monitor in main chat, then open Scheduled jobs or Web monitors under Settings → Data and tasks to manage it. Activity history is in the main-chat actions panel. This page is checked against current server and mobile source; it is not a test of a released APK.

## Purpose and Scope {#purpose-and-scope}

- **Scheduled job**: At the scheduled time, Pi Muse submits the job text as a user message to the origin session's current conversation and starts a real model run.
- **Web monitor**: The server periodically fetches one public HTTP(S) page and notifies the origin session when content changes or a keyword changes from not matched to matched.
- **Activity history**: A timeline of composite work explicitly registered by the model during real execution. It is not a collection of every chat, every tool call, or every background notification.

The chat `schedule` and `monitor` tools list and control records only in the current session and do not accept a cross-session target. Management pages in Settings use server REST endpoints, so inspecting or managing each record does not require a model run. There is no bottom Tasks aggregate page or topic-session picker.

## Prerequisites {#prerequisites}

- The phone is connected to the real server as described in [Quick Start](getting-started.md#connect-mobile-client) and uses the Android client matching current source.
- The server must keep running. By default it scans jobs every 30 seconds and web monitors every 60 seconds. A one-time job that expires while the service is stopped is not caught up.
- Creating a job requires the current session's `cron` skill; creating a monitor requires the `monitor` skill. Re-enable either in session settings if it was disabled.
- Due jobs and monitor checks may access external networks and incur model costs. Monitors access only public HTTP(S), and fetched content is untrusted data.

## View Activity History {#view-activity-history}

1. In Messages, tap the floating companion to open Main chat actions, or go to Settings → Data and tasks → Activity & Approvals.
2. Open 「历史」 (History) to see main's activities.
3. If activities exist, filter by running, waiting for approval, waiting for input, awaiting continuation, completed, failed, stopped, or interrupted.
4. Open an activity to inspect its goal, deliverable, progress, result, and safe step projection. Steps do not contain internal model reasoning or raw tool payloads.
5. Load the next page when more records exist. The list is ordered newest first by creation time; reopening the page, changing a filter, returning the app to the foreground, or receiving a relevant state change triggers a fresh read.

The current client provides activity history only for main in the main-chat actions panel, without an all-sessions scope switch. Ordinary answers, explanations, clarifications, and simple lookups usually do not create activities. `awaiting_continuation` means the previous run ended but the work is unfinished and requires an explicit request to continue in chat.

## Create and Control Scheduled Jobs {#scheduled-jobs}

1. Open Messages to enter main chat. A new job binds to its origin session; reset keeps it and rebinds it to the new history by default.
2. State the job content and its one-time or daily time in a message. For example: “Create a daily job at 09:00 to summarize today's todo items” or “Create a one-time job tomorrow at 09:00 Shanghai time to remind me to review the checklist.”
3. Wait for the model to actually call the `schedule` tool. A successful result should include the job ID and next execution time; a natural-language promise is not a scheduled job.
4. Open Settings → Data and tasks → Scheduled jobs, tap 「刷新任务」 (Refresh jobs), then select a job to inspect its prompt, time, and events. Edit the prompt, or pause, resume, cancel, or retry failed work as its state allows. These controls and deletion require confirmation. The current form does not edit the schedule time, and scheduling controls are not a Stop button for a running model.
5. You can also ask the model in main to list or cancel current-session jobs. The `schedule` tool has only create, list, and cancel actions; pause, resume, retry, and delete use Settings. REST management capabilities are not the same as model-tool capabilities.

A one-time time must include an explicit timezone. A daily job uses `HH:mm`, interpreted in the server local timezone returned by `/api/health`, not the phone timezone. Pause stops future scheduling only; cancel is not the stop button for an executing chat run; retry starts one real model run for a failed job and does not automatically resend an unknown operation.

## Create and Control Web Monitors {#web-monitors}

1. Open Messages to enter main chat. Monitor notifications go to the origin session.
2. Provide a public HTTP(S) URL, trigger condition, and check interval of at least five minutes. For example: “Monitor `https://example.com/product` and notify me when ‘restock’ appears; check every 5 minutes.”
3. There are only two trigger conditions: `change` means the content fingerprint changes; `contains` means a specified keyword changes from not matched to matched and requires a keyword.
4. Wait for the model to actually call the `monitor` tool, then use its list result to check the condition, interval, accumulated checks, and errors. Settings → Data and tasks → Web monitors lets you refresh the list, view titles, states, and URLs, pause, resume, or stop as each state allows, and delete after confirmation. The current page has no per-check history or condition-edit form.
5. The `monitor` tool in main can also list, pause, resume, and stop current-session monitors, but has no delete action. Stop is terminal; create a new monitor to continue.

For `change`, the first check only establishes a baseline and does not notify; later fingerprint changes do. For `contains`, continued matches do not repeat notifications—only a transition from not matched to matched does. Pause or stop affects future checks only; it does not start an immediate check or remove an already observed fact.

## Visible Results {#visible-results}

- After a job fires, the origin session's chat receives a user message beginning with 「⏰ [定时任务]」 and starts a real model run.
- When a monitor matches, the origin session receives a notification beginning with 「📡 [监控]」.
- Activity state and steps update from real execution. Failure, denial, cancellation, expiry, and interruption are preserved rather than disguised as success.

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
| The old task aggregate page is missing | The primary tabs are Messages, News, and Settings | Manage jobs and monitors under Settings → Data and tasks; activity history is in the main-chat actions panel's History page. |
| An operation result is unknown | Tool result and current-session state | Verify whether the record still exists and its state before retrying. Do not resend automatically. |

Deleting a topic session on the server irreversibly deletes its activity history, bound jobs, and monitors. The mobile app currently provides neither topic-session controls nor main deletion. To clear only main chat, use reset and decide on its confirmation card whether to clear jobs and monitors too.
