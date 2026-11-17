# Conversations and sessions

Pi Muse has one assistant identity. The mobile app currently focuses on the default main chat: tapping 消息 (Messages) opens chat directly, without choosing or creating a session. This page describes the current source; check the corresponding release for the installed app's controls.

## Prerequisites {#prerequisites}

Follow [Getting started](getting-started.md#connect-mobile-client) and connect to a matching server version. Chat requires a configured external model.

## Main chat {#session-model}

Messages directly uses the permanent `main` session, showing messages and a composer instead of a session list. Switching to News or Settings keeps the draft and does not stop the running stream merely because chat is hidden.

Main cannot be deleted, but can be reset. Profile, long-term memory and the workspace remain global. Memory is retrieved on demand rather than loaded in full each turn.

The companion and a compact status label float together at the top center of the chat content area without reserving a full-width header row. The character stays transparent rather than sitting inside a large backing card. The short label shows current execution, pending approval, or synchronization state; its full text is also available to screen readers. The beginning of the chat content includes matching spacing so the first message does not collide with the companion. This spacing scrolls with the messages rather than acting as a fixed header.

Tap the character or its status to expand main-chat information around the same character's original position, rather than opening a separate bottom sheet. The expanded view is a full page: the character stays centered at the top without moving, followed directly by Activity/Approvals/History. Close is the ✕ in the top-right corner. History shows all registered activities as a timeline without status filter chips. Reset, instructions, and skills live in the Settings assistant group. Close it with the close button or Android Back; reduced-motion settings switch the view immediately. Expanding, collapsing, and switching pages do not recreate the chat or clear its draft. The floating character does not appear over News or Settings.

## Local history and background synchronization {#local-history-and-sync}

The Android app keeps a display copy of recent saved chat messages, the composer's plain-text draft, and the reading position in app-private storage. When reopened, it shows local content first and checks the server in the background; unchanged content does not replace the message list. A first connection or a missing local copy still requires an initial history fetch. This describes the current source capability; the installed APK must include the corresponding change.

The local copy is neither a complete backup nor a second authority for server data. It retains at most 200 recent messages per session and at most eight sessions in a local document of up to 4 MiB in total; oversized message or tool content carries a local-cache truncation notice. It does not retain full historical image payloads, attachment drafts, in-progress replies, or unconfirmed submissions. Offline, you can read cached content and edit a text draft, but sending, message feedback, and approvals still require a connection and their respective state checks. The app does not queue offline messages for automatic sending.

While you are reading earlier messages, background synchronization does not force you to the latest message. Tapping the latest-message control, scrolling to the bottom, or sending a message resumes following. Reading positions use a message anchor; if that message is no longer in the recent cache or server history, the app falls back to available content. Switching to News or Settings still preserves the current chat.

Copies are isolated by server and session. Changing servers clears old local business data. A successful reset, or synchronization that discovers a different internal chat identity on the server, invalidates the old history copy and reading position. Cached content only provides an early display; it cannot authorize sending or approving against an outdated chat version. If synchronization fails, readable content stays visible with a synchronization error rather than being treated as current server state.

## Send and stop conversations {#send-and-stop-conversations}

Enter text directly in Messages, or attach images/text with that message as explained in [Attachments](files-and-approvals.md#send-attachments). Responses stream; tool and approval views show actual execution facts.

Main has at most one active run. Stop targets that run, not later turns. Disconnecting the chat stream, stopping, timeout or server shutdown cancels the run and child calls and revokes pending approvals; completed side effects are not rolled back. Disconnecting the notification stream does not stop chat.

When sending or writing has an unknown outcome, synchronize authoritative history/state before acting again. Page changes do not automatically resend messages. Execution after application process termination is not promised.

## Message feedback {#message-feedback}

Saved user/assistant messages support like, dislike, reaction removal and comment management. Generating messages and tool results do not. Reactions are mutually exclusive; comments contain 1–4000 characters after trimming.

Feedback binds the public session, internal pi session and message id. Raw operations are stored separately; feedback does not change chat revision, start a model or train preferences. Old internal identities cannot receive feedback after reset. Read back unknown writes instead of retrying automatically.

## Main chat instructions and skills {#session-rules-and-skills}

Use the instruction and skill controls in chat actions or Settings to configure main. Instructions are stored in main INSTRUCTIONS.md and reread next turn. The limit is 20,000 characters; an empty string explicitly clears them. The last successful save wins without merging. Instructions cannot add tools, expand paths or bypass approval.

Skill texts are global assets, with selections saved per session and applied next turn. Every skill defaults to off. The catalog distinguishes instance-owned, built-in owned, and shared `~/.agents/skills/` sources. Instance-owned names take priority, with no fallback when disabled. Selections bind to sources instead of moving automatically to a namesake; reading instructions or approving creation does not enable a skill. See [Skill directories and default switches](configuration.md#skill-directories) for directories, read-only boundaries, and maintenance; consult the current server `/docs` for source fields and instruction-detail endpoints. Main instructions also guide SMS filtering and news preferences, so inspect the complete content when saving.

## News and SMS {#background-services}

News is an RSS/recommendation pipeline; see [News](news.md). Discussing an article directly appends an explicitly untrusted reference to the existing main draft. It remains editable, is not sent automatically, and does not open a session picker. You can return to the original article.

SMS is one global pipeline, disabled initially. After analysis, important SMS results are appended as system notifications to main history without an additional main-chat model response. Silent or failed batches do not manufacture notifications.

SMS collection requires the Android native module, system permission, enablement and a running application process. Collection after process termination and OS push are not promised. Check item/run records before retrying an import or execution with an unknown result.

## Subagent {#subagent}

The assistant can call `subagent` for a bounded single/parallel/chain operation. It has in-memory context only, creates no session or directory, uses the same workspace and returns its result directly to the caller. It cannot recursively delegate, schedule, monitor, register independent activity or change conversation instructions. Roles only narrow permissions. File changes still require individual approval; stopping the parent cancels child execution.

## Reset main chat {#reset-and-delete-sessions}

### Confirm the reset scope {#reset-current-session}

The entry is Settings → Danger zone → Reset main chat. Confirm the irreversible scope before submitting. Reset stops execution, cancels approvals, clears chat JSONL and message feedback, and rotates the internal pi identity. The public id, instructions, skill overrides and workspace remain. Optionally remove jobs and monitors; they are retained by default.

Reset does not delete news, SMS, global memory or global Dream configuration. If the result is unknown, reread history and state; do not repeat reset automatically.

### Topic controls are deferred {#delete-session}

The mobile app currently provides no topic creation, selection, switching, renaming or deletion controls. The server's multi-session foundation remains. Hiding client controls does not delete existing topic data or change the rule that main cannot be deleted.
