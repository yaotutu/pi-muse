# Conversations and sessions

Pi Muse has one assistant identity. Sessions separate topics and chat contexts; all sessions share the workspace, profile and long-term memory. This page describes the refactored server semantics. Native client adaptation, Android paths and real-model acceptance still require coordinated verification; source documentation does not mean a released APK already implements them.

## Prerequisites {#prerequisites}

Follow [Getting started](getting-started.md#connect-mobile-client) and connect to a matching server version. Chat requires a configured external model. Navigation depends on the adapted and verified client release.

## Session list {#session-model}

Messages lists the default session and topic sessions. The permanent `main` session has the fixed title 默认会话. It cannot be deleted, but can be reset. Topic sessions receive a stable server-generated id and can be renamed, reset or deleted; their default title is 新会话. Main is first, followed by topics ordered by recent updates.

Each session keeps its own messages, attachments, tool results, instructions and skill overrides. Switching does not automatically send another session's history to the model. All sessions still use the same identity, model, SOUL/USER and long-term memory. Memory is retrieved on demand, not loaded in full each turn.

## Send and stop conversations {#send-and-stop-conversations}

Open a session to chat. Send text or attach images/text with that message as explained in [Attachments](files-and-approvals.md#send-attachments). Responses stream; tool and approval views show actual execution facts.

A session has at most one active run. Stop targets that run, not later turns. Sessions have independent contexts. Disconnecting the chat stream, stopping, timeout or server shutdown cancels the run and child calls and revokes pending approvals; completed side effects are not rolled back. Disconnecting the notification stream does not stop chat.

When sending or writing has an unknown outcome, synchronize authoritative history/state before acting again. Do not automatically resend. Draft, navigation and background behavior depend on the client release; execution after process termination is not promised.

## Message feedback {#message-feedback}

Saved user/assistant messages support like, dislike, reaction removal and comment management. Generating messages and tool results do not. Reactions are mutually exclusive; comments contain 1–4000 characters after trimming.

Feedback binds the public session, internal pi session and message id. Raw operations are stored separately; feedback does not change chat revision, start a model or train preferences. Old internal identities cannot receive feedback after reset. Read back unknown writes rather than retrying automatically.

## Session instructions and skills {#session-rules-and-skills}

Instructions are stored in the session INSTRUCTIONS.md and reread next turn. The limit is 20,000 characters; an empty string explicitly clears them. The last successful save wins without merging. Instructions cannot add tools, expand paths or bypass approval.

Skill texts are global assets; enablement overrides affect only this session and apply next turn. Main instructions also guide SMS filtering and news preferences. They are not automatically added to topic sessions.

## News and SMS {#background-services}

News is an RSS/recommendation pipeline; see [News](news.md). SMS is one global pipeline, disabled initially. After analysis, important SMS results are appended as system notifications to main history without an additional main-chat model response. Topic sessions do not receive them. Silent or failed batches do not manufacture notifications.

SMS collection requires the Android native module, system permission, enablement and a running application process. Collection after process termination and OS push are not promised. Check item/run records before retrying an import or execution with an unknown result.

## Subagent {#subagent}

The assistant can call `subagent` for a bounded single/parallel/chain operation. It has in-memory context only, creates no session or directory, uses the same workspace and returns its result directly to the caller. It cannot recursively delegate, schedule, monitor, register independent activity or change conversation instructions. Roles only narrow permissions. File changes still require individual approval; stopping the parent cancels child execution.

## Reset and deletion {#reset-and-delete-sessions}

### Reset the current session {#reset-current-session}

Confirm the target and irreversible scope before submitting. Reset stops execution, cancels approvals, clears chat JSONL and message feedback, and rotates the internal pi identity. The public id, title, instructions, skill overrides and workspace remain. Optionally remove the session's jobs and monitors; they are retained by default.

Main can also be reset. Reset does not delete news, SMS, global memory or global Dream configuration. If the result is unknown, reread history and the session list; do not repeat reset automatically.

### Delete a topic session {#delete-session}

::: danger Irreversible
Deleting a topic session removes its history, feedback, instructions, skill overrides, jobs and monitors. Main cannot be deleted. The workspace, news, SMS, identity and memory are global and survive topic deletion.
:::

Confirm explicitly before deletion. If the result is unknown, refresh the list first. Late messages, Stop, feedback or notifications cannot revive a deleted session. Create a new topic instead of trying to reuse a deleted id.
