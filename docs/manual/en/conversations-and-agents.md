# Conversations and sessions

Pi Muse has one assistant identity. The mobile app currently focuses on the default main chat: tapping 消息 (Messages) opens chat directly, without choosing or creating a session. This page describes the current source; check the corresponding release for the installed app's controls.

## Prerequisites {#prerequisites}

Follow [Getting started](getting-started.md#connect-mobile-client) and connect to a matching server version. Chat requires a configured external model.

## Main chat {#session-model}

Messages directly uses the permanent `main` session, showing messages and a composer instead of a session list. Switching to News or Settings keeps the draft and does not stop the running stream merely because chat is hidden.

Main cannot be deleted, but can be reset. Profile, long-term memory and the workspace remain global. Memory is retrieved on demand rather than loaded in full each turn.

The companion floats directly at the top center of the chat content area with no backing card or border, and no longer reserves a full-width header row. Poses convey the status, and the exact status is kept in the companion screen-reader label. Messages can scroll to the top and behind the companion; you can still swipe the chat on either side. Tap the companion to open main-chat actions for execution, approvals, history, reset, instructions and skills. The companion appears only in Messages; switching to News or Settings does not recreate the chat.

## Send and stop conversations {#send-and-stop-conversations}

Enter text directly in Messages, or attach images/text with that message as explained in [Attachments](files-and-approvals.md#send-attachments). Responses stream; tool and approval views show actual execution facts.

Main has at most one active run. Stop targets that run, not later turns. Disconnecting the chat stream, stopping, timeout or server shutdown cancels the run and child calls and revokes pending approvals; completed side effects are not rolled back. Disconnecting the notification stream does not stop chat.

When sending or writing has an unknown outcome, synchronize authoritative history/state before acting again. Page changes do not automatically resend messages. Execution after application process termination is not promised.

## Message feedback {#message-feedback}

Saved user/assistant messages support like, dislike, reaction removal and comment management. Generating messages and tool results do not. Reactions are mutually exclusive; comments contain 1–4000 characters after trimming.

Feedback binds the public session, internal pi session and message id. Raw operations are stored separately; feedback does not change chat revision, start a model or train preferences. Old internal identities cannot receive feedback after reset. Read back unknown writes instead of retrying automatically.

## Main chat instructions and skills {#session-rules-and-skills}

Use the instruction and skill controls in chat actions or Settings to configure main. Instructions are stored in main INSTRUCTIONS.md and reread next turn. The limit is 20,000 characters; an empty string explicitly clears them. The last successful save wins without merging. Instructions cannot add tools, expand paths or bypass approval.

Skill texts are global assets; enablement overrides apply to main next turn. Main instructions also guide SMS filtering and news preferences, so inspect the complete content when saving.

## News and SMS {#background-services}

News is an RSS/recommendation pipeline; see [News](news.md). Discussing an article directly appends an explicitly untrusted reference to the existing main draft. It remains editable, is not sent automatically, and does not open a session picker. You can return to the original article.

SMS is one global pipeline, disabled initially. After analysis, important SMS results are appended as system notifications to main history without an additional main-chat model response. Silent or failed batches do not manufacture notifications.

SMS collection requires the Android native module, system permission, enablement and a running application process. Collection after process termination and OS push are not promised. Check item/run records before retrying an import or execution with an unknown result.

## Subagent {#subagent}

The assistant can call `subagent` for a bounded single/parallel/chain operation. It has in-memory context only, creates no session or directory, uses the same workspace and returns its result directly to the caller. It cannot recursively delegate, schedule, monitor, register independent activity or change conversation instructions. Roles only narrow permissions. File changes still require individual approval; stopping the parent cancels child execution.

## Reset main chat {#reset-and-delete-sessions}

### Confirm the reset scope {#reset-current-session}

Confirm the irreversible scope before submitting. Reset stops execution, cancels approvals, clears chat JSONL and message feedback, and rotates the internal pi identity. The public id, instructions, skill overrides and workspace remain. Optionally remove jobs and monitors; they are retained by default.

Reset does not delete news, SMS, global memory or global Dream configuration. If the result is unknown, reread history and state; do not repeat reset automatically.

### Topic controls are deferred {#delete-session}

The mobile app currently provides no topic creation, selection, switching, renaming or deletion controls. The server's multi-session foundation remains. Hiding client controls does not delete existing topic data or change the rule that main cannot be deleted.
