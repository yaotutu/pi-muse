# Conversations and sessions

Pi Muse has one assistant and multiple chat sessions. Messages starts in the permanent main chat. You can create or switch to another session without carrying over chat history.

## Prerequisites {#prerequisites}

Follow [Getting started](getting-started.md#connect-mobile-client) and connect to a matching server version. Chat requires a configured external model.

## Session boundaries {#session-model}

Open the session list from Messages to create, switch to, rename, or delete a conversation. Switching sessions or opening News or Settings keeps each session’s draft and running turn.

Main cannot be deleted, but can be reset. Profile, long-term memory and the workspace remain global. Memory is retrieved on demand rather than loaded in full each turn.

The companion and a compact status label float together at the top center of the chat content area without reserving a full-width header row. The character stays transparent rather than sitting inside a large backing card. The short label shows current execution, pending approval, or synchronization state; its full text is also available to screen readers. The beginning of the chat content includes matching spacing so the first message does not collide with the companion. This spacing scrolls with the messages rather than acting as a fixed header.

Tap the character or its status to expand information for the active chat around the same character's original position, rather than opening a separate bottom sheet. The expanded view is a full page: the character stays centered at the top without moving, followed directly by Activity/Approvals/History. Close is the ✕ in the top-right corner. History shows all registered activities as a timeline without status filter chips. Assistant instructions and skills are managed in Settings. Close it with the close button or Android Back; reduced-motion settings switch the view immediately. Expanding, collapsing, and switching pages do not recreate the chat or clear its draft. The floating character does not appear over News or Settings.

## Local history and background synchronization {#local-history-and-sync}

The Android app keeps a display copy of recent saved chat messages, the composer's plain-text draft, and the reading position in app-private storage. When reopened, it shows local content first and checks the server in the background; unchanged content does not replace the message list. A first connection or a missing local copy still requires an initial history fetch. This describes the current source capability; the installed APK must include the corresponding change.

The local copy is neither a complete backup nor a second authority for server data. It retains at most 200 recent messages per session and at most eight sessions in a local document of up to 4 MiB in total; oversized message or tool content carries a local-cache truncation notice. It does not retain full historical image payloads, attachment drafts, in-progress replies, or unconfirmed submissions. Offline, you can read cached content and edit a text draft, but sending, message feedback, and approvals still require a connection and their respective state checks. The app does not queue offline messages for automatic sending.

While you are reading earlier messages, background synchronization does not force you to the latest message. Tapping the latest-message control, scrolling to the bottom, or sending a message resumes following. Reading positions use a message anchor; if that message is no longer in the recent cache or server history, the app falls back to available content. Switching to News or Settings still preserves the current chat.

Copies are isolated by server and session. Changing servers clears old local business data. A successful reset, or synchronization that discovers a different internal chat identity on the server, invalidates the old history copy and reading position. Cached content only provides an early display; it cannot authorize sending or approving against an outdated chat version. If synchronization fails, readable content stays visible with a synchronization error rather than being treated as current server state.

## Send and stop conversations {#send-and-stop-conversations}

Enter text directly in Messages, or attach images/text with that message as explained in [Attachments](files-and-approvals.md#send-attachments). Responses stream; tool and approval views show actual execution facts.

Each session has at most one active run. Stop targets that run, not later turns. Disconnecting the chat stream, stopping, timeout or server shutdown cancels the run and child calls and revokes pending approvals; completed side effects are not rolled back. Disconnecting the notification stream does not stop chat.

When sending or writing has an unknown outcome, synchronize authoritative history/state before acting again. Page changes do not automatically resend messages. Execution after application process termination is not promised.

## Message feedback {#message-feedback}

Saved user/assistant messages support like, dislike, reaction removal and comment management. Generating messages and tool results do not. Reactions are mutually exclusive; comments contain 1–4000 characters after trimming.

Feedback binds the public session, internal pi session and message id. Raw operations are stored separately; feedback does not change chat revision, start a model or train preferences. Old internal identities cannot receive feedback after reset. Read back unknown writes instead of retrying automatically.

## Assistant instructions and skills {#session-rules-and-skills}

Assistant instructions, skill switches, profile, long-term memory, permissions, and workspace are shared by all conversations. Open Settings → Assistant instructions and tap the text to read it. Tap Edit when you want to make changes. An empty field opens the editor directly. Tap Save at the bottom of the editor. The last successful save takes effect on the next turn in every conversation. The instruction limit is 20,000 characters. An empty value clears the instructions.

Long text in Settings starts with a preview. Save news recommendation rules and SMS alert rules from the editor. Profile and Dream have multiple settings. Keep text edits as a draft, then save on the settings page.

If saving instructions or skills has an unknown outcome, read back the server settings before deciding whether to submit the retained draft.

Skill selections are bound to their source identity. See [Skill directories and default switches](configuration.md#skill-directories) for more. Background domains such as News and SMS retain their own rules.

## News and SMS {#background-services}

News and SMS run as independent background domain sub-agents without chat skills, chat history access, or global memory access. You can edit their preference rules directly in Settings or ask the assistant in chat to update them.

- News collection and reading are described in [News](news.md). Discussing an article directly appends an explicitly untrusted reference to the existing draft of the active chat. It remains editable, is not sent automatically, and does not open a session picker. You can return to the original article.
- SMS is one global pipeline, disabled initially. After analysis, important SMS results are appended as system notifications to main history without an additional main-chat model response. Domain notification cards remain excluded from main chat model context unless you explicitly quote them into the conversation. Silent or failed batches do not manufacture notifications.

SMS collection requires the Android native module, system permission, enablement and a running application process. Collection after process termination and OS push are not promised. Check item/run records before retrying an import or execution with an unknown result.

## Subagent {#subagent}

The assistant can call `subagent` for a bounded single/parallel/chain operation. It has in-memory context only, creates no session or directory, uses the same workspace and returns its result directly to the caller. It cannot recursively delegate, schedule, monitor, register independent activity or change assistant instructions. Roles only narrow permissions. File changes still require individual approval; stopping the parent cancels child execution.

## Reset and delete sessions {#reset-and-delete-sessions}

### Reset chat history {#reset-current-session}

Reset cancels the current run and its approvals, clears chat history and feedback, and rotates the internal chat identity. The public session ID, shared settings, jobs, and web monitors are retained. If the result is unknown, read back session state before acting again.

### Delete a conversation {#delete-session}

Scheduled jobs and web monitors deliver results to their owning conversation. When deleting a conversation, review its schedules and choose whether to delete them or move them to the permanent main chat. Moving retains schedules and their run records. Old messages are removed with the conversation. If a job is still running in the conversation, wait for it to finish before moving its schedules. Main chat can be reset and remains available.
