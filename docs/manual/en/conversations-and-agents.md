# Conversations and agents

This page covers the default All view, Agent private chats and settings, message feedback, stopping runs, session reset, and Agent deletion. Instructions match current source, not necessarily a released APK; check your installed release.

## Prerequisites {#prerequisites}

- The server is connected as described in [Quick Start](getting-started.md#connect-mobile-client); check the connection under 「设置」 → 「服务器连接」.
- An external model is configured. If the model is not configured, chat messages are rejected.
- Cold launch opens 「全部」 (All), without bottom tabs or a conversation list. Tap a top avatar to switch All or Agent main views (usually private chat; News defaults to reading); tapping the selected avatar does nothing. Long-press All for 「全局设置」 (Global Settings), or an Agent avatar for its Agent Settings. There is no chat top-right button. Add and delete live in Global Settings → 「智能体管理」 (Agent Management).

## Agents, Sessions, and Extensions {#agent-model}

An Agent is an independent execution and context owner, not just a session name. Each has private-chat contexts and separate discussion contexts in All, message history, dedicated instructions, skill switches, and private files. Reset changes the sessionId, not the stable agentId or dedicated configuration.

News and SMS are full Agents too. News reading, RSS management, and SMS background processing are added capabilities and views, not a restricted member type. They can chat, use their own instructions and skills, participate in Dream, own tasks, and receive notifications. Opening a chat does not enable collection or request SMS permission.

The instance model, SOUL/USER, identity profile, long-term memory, and skill assets remain shared. Existing tools and retrieval load memory on demand; the rename does not duplicate or automatically inject all memory. Explicit requests pass necessary content between Agents. The combined display never becomes shared model context.

The Agent version has no old Space/Thread interfaces or automatic data migration. Existing instances require a stopped service, a backup, and separately approved conversion; renaming the private-file directory alone is insufficient.

## All View and Directed Messages {#group-chat}

「全部」 (All) is a combined view, not a broadcast to every Agent or another Agent: it displays discussion messages and verified feature notifications with their actual sender avatars on one timeline. Each member has its own discussion context in All, separate from private chat. No model receives the complete combined timeline.

1. With no member selected and no leading `@`, only Muse (main, `local-main`) receives and answers. Other members neither receive nor automatically answer.
2. Use `@` to the left of the input to select a member, or start with `@display-name ` / `@Agent-ID `. Only that member receives this message. The composer and target clear when the client takes ownership of the submission, so the next message defaults to main. You can prepare the next draft during a reply; completion does not erase it. Unknown members produce an error, never fallback to main. One target per message is supported.
3. Members may explicitly ask another member for help through the real `agent` tool. The timeline shows the source, target, and responder. Only the request and explicitly supplied context reach the target; other messages are not broadcast.
4. Tap a top Agent avatar for its main view; News defaults to reading and can be changed to Chat in its settings. A sender avatar in a message opens that Agent’s settings directly. Back returns to the originating chat without changing its active Agent.
5. The send arrow becomes Stop while running. Use 「同步核对」 after an unknown network result; messages are never automatically resent. Disconnecting the stream, leaving the connection, or restarting the service cancels the associated run without rolling back completed operations. File changes still require the complete diff and approval; use the pending-approval entry when shown.

All supports text and tool results, but not attachments, message feedback, or multiple groups. Use private chat for attachments and feedback. SMS reminders and News “bring to conversation” still persist in the actual receiving Agent’s private chat; All only projects verified notifications, never ordinary private messages. Rebinding does not move old notifications. Resetting or deleting the receiving session removes its cleared notifications. Ordinary input still goes to main or the explicitly mentioned Agent and never implicitly follows up on a notification.

After sending, the original text is retained as a pending submission while you can edit the next draft. Confirmed acceptance releases only the old submission, never a newer draft. If authoritative readback confirms it was not accepted and is not running, the original is restored only into an empty composer. When a newer draft exists, explicitly restore or discard the old message; nothing is automatically resent.

### Continue Processing a Notification {#continue-notification}

1. In All or the actual receiving private chat, tap 「继续处理」 below a notification. Its separate discussion shows the source and a quoted summary, with a composer such as 「回复短信…」 or 「回复新闻…」. Opening it does not call a model.
2. Send an explicit request. The server verifies the original notification and routes it to its real source Agent. SMS replies as SMS even when Muse received the notification. Rebinding does not change the source of old notifications. Mentions inside this discussion are plain text and do not change the recipient.
3. Follow-ups continue the same discussion. Other notifications, ordinary group chat, and private histories are not automatically included. The source may explicitly request another Agent’s help.
4. Return to the originating chat and tap 「查看讨论与处理结果」 to read replies. Ordinary chat and each notification discussion keep separate drafts for this connection. Switching pages does not stop generation. Saved discussions can be reopened after client restart, but unsent drafts are not persisted.
5. Stop, approval, and uncertain-result rules match All: file changes still require a complete diff and human approval, and requests are never automatically retried. A cleared notification blocks new sends with an expired-source message. A missing existing discussion never silently starts fresh or falls back to Muse.

Comments and like/dislike remain feedback, not execution commands. Use 「继续处理」 to explicitly request an action.

The All header does not cover messages. Member avatars sit to the left of replies, with names, text, and tool results aligned in one column. A directed `@member` appears inline at the start of its message, without a background highlight: medium-weight white text in blue bubbles, or the theme accent color in member bubbles, with long text wrapping naturally. Code blocks, tables, and other block content retain their layout. Tool results for one reply initially share one low-emphasis “工具记录” (tool records) row, showing the count and actual result status. Failure and missing-result counts remain visible. Tap the row to expand each summary and source, then tap again to collapse. Stopped or failed labels stay below the affected reply, rather than collecting at the end of history.

## Send and Stop Conversations {#send-and-stop-conversations}

These steps apply to private chats; see [All View](#group-chat) for the combined timeline.

1. Tap a top Agent avatar to enter private chat; if News currently uses Reading, first choose Chat under 「主视图」 in its settings. A quick horizontal swipe in the message reading area switches adjacent chats without wrapping at either end. The input and settings pages do not switch chats on swipe.
2. Enter text in the 「消息」 input field. To send an image or text file with this message, use the 「+」 button described in [the attachment guide](files-and-approvals.md#send-attachments).
3. Tap the send arrow to the right of the input field. The visible success signal is your message entering the chat list and the right-hand button becoming a stop square. Detailed execution status is available in the session panel.
4. The reply streams into the page. When the model calls tools, progress appears in message tool cards or the session panel's 「动态」 view.
5. To stop, tap the same right-side button. While a run is active it appears as a stop square; if run status is still synchronizing, the button is unavailable. Tap 「重新同步」 first.

After a successful stop, the stream shows stopped or finished. Switching agents or main pages within the same foreground connection does not actively stop generation in the original agent; return to see its progress. This does not promise background execution. Explicit stopping, a disconnected chat stream, leaving the current connection, or restarting the server still cancels the associated run and invalidates pending file approvals. Tool operations that already completed are not rolled back.

The top avatar strip occupies normal layout space and never overlaps messages. All stays at the far left, followed by pinned Agents and then unpinned Agents. Both groups sort by recent meaningful activity; Muse has no special fixed position. New requests, replies, readable news results, delivered notifications, and actionable suggestions count as activity. Viewing a chat, background heartbeats, and streamed tokens do not reorder avatars. Touches, taps, and swipes temporarily freeze the order until release. A quick horizontal swipe over messages selects the adjacent chat without wrapping. Vertical reading, the composer, child pages, and horizontal code/table scrolling do not switch chats. The keyboard hides avatar labels to save reading space. Switching preserves each connection-local draft and in-progress reply. Sending follows the latest message; after scrolling up, tap 「回到最新」 to resume following.

### Avatar Status and Pinning {#avatar-status}

- The outer ring still marks the selected chat. A small lower-right badge shows work: a gently animated blue indicator for working, an amber pause for waiting for you, and a red `!` for a current problem. Idle has no badge. Enabling background processing or having queued items does not itself mean work is running.
- Badges never show counts. All has no badge or aggregated status. SMS, News, and memory consolidation belong to the Agent doing the work, not the Agent receiving a notification.
- Disconnected or unsynchronized state uses a gray dash, never idle. Reduced motion keeps the working indicator static. Historical problems do not return after server restart; a new attempt from the same source or five minutes clears the hint, while actual records remain in their detail views.
- Long-press an Agent avatar and toggle 「置顶智能体」 (Pin Agent) in its settings. Pins persist on this device for the current server, remain after client restart, and do not mix between servers. A failed save displays an error instead of claiming the pin succeeded.
- The settings identity area shows a current-state explanation. Use Activity and Approvals, News/SMS settings, or global Dream settings for work, approval, and problem details. Badges are not separate tap targets and open no extra panels.
- The Activity and Approvals header shows the same Agent-wide state, not just whether its ordinary private chat is running. A notification discussion awaiting file approval also appears as waiting here.

After a message has definitely failed, tap「恢复到输入框」to recover it. If a new draft already exists, you may cancel, copy that draft somewhere safe and clear the input before recovering the old message, or tap「放弃未发送消息」and confirm. Discarding removes only that unsent message, preserves the current draft, and cannot be undone. Messages with an unconfirmed save result cannot be discarded or automatically resent.

An agent permits one chat run at a time. If message ownership or history revision is unconfirmed, the client locks the send action. Tap 「重新同步」 and reconcile authoritative history; do not bypass the lock by repeatedly killing the app or resending.

## Message Feedback, Comments, and Copy {#message-feedback}

1. Long-press a saved user or assistant message bubble in the chat page. A message currently generating, a local message still being sent, and tool results cannot receive feedback. Messages that already have a reaction or comments also show a badge at the bubble edge; tap the badge to reopen the menu.
2. Tap 「喜欢」 or 「不喜欢」 in the reaction pill. The two reactions are mutually exclusive. Tapping the current reaction again removes it; tapping the other one switches it.
3. Tap 「评论」 to open the comments panel. Enter 1–4000 characters and tap 「发送」; the server trims leading and trailing whitespace.
4. Tap 「编辑」 on an existing comment to change and save it. Tap 「删除」 and confirm to delete the current comment. One message can have multiple comments.
5. Tap 「复制消息」 to copy that message text to the system clipboard. Copying is local; if it fails, the page asks you to try again.

Feedback is saved as server business data for the current agent, current session, and that message. Recording it does not enter chat history, change the conversation revision, or trigger preference training. The server retains the original operation history for reaction changes and for comment additions, edits, and pre-deletion text. Deleting a comment only hides it from the current list. If information processing is explicitly enabled for the agent, its background decision may read currently valid feedback examples for that agent; withdrawing, editing, or deleting feedback takes effect through the latest projection.

If a feedback write times out, disconnects, or has an unknown result, the interface locks further changes and shows 「刷新核对反馈」. Complete a read-back and verify before acting again; the client does not automatically retry. Resetting the current session deletes all message feedback for that agent, and deleting the agent removes it as well.

## Manage Members and Agents {#manage-agents}

1. Tap a top avatar to switch chats. Long-press All for global settings, or an Agent avatar for its settings. Tapping the selected avatar does nothing. Android Back returns private chat to All; keyboards and overlays close first.
2. Agent Settings contain files, dedicated rules, skills, session management, activity, and approvals. News also offers 「主视图」 (Main view); News and SMS each have feature settings. Inspecting another Agent does not change the original chat, its draft, or ongoing generation. Back returns to the original All view, private chat, news reader, or notification discussion. Successfully changing the main view from the active News main page returns to the selected view; settings opened from a notification discussion still return to that discussion. Settings opened from Agent Management return there.
3. Long-press All → 「智能体管理」 → 「添加智能体」. The server confirms creation before opening the new Agent’s settings, without switching the original chat. It persists without a first message and is immediately available for mentions and notification binding. Creation disables duplicate taps and Back. Failures stay in management; an uncertain result is checked by the original ID instead of automatically creating a second Agent.
4. Built-in names are Muse, News, and SMS. Other members use connection-local labels such as 「成员 1」. Persistent renaming and custom avatars are not available.

Each member is an existing Agent with independent private-chat history, workspace files, rules, and skill switches. Stable Agent IDs do not change when sessions reset. Assistant/user profiles, long-term memory, and skill assets remain instance-global. A member is not a separate account or an automatically distinct persona.

Opening 「动态与审批」 from Agent Settings overlays that page and initially shows Activity. Closing it or pressing Android Back leaves the settings page and its return destination unchanged. An open keyboard closes first.

News and SMS support private chat. Opening settings or chatting does not enable background processing, request SMS permission, or change notification binding. Background notifications default to main and can be rebound to any existing Agent. Private and cross-Agent discussion histories remain separate.

## Agent Rules and Skills {#agent-rules-and-skills}

1. Long-press the top Agent avatar to open its settings and confirm the Agent name.
2. Open 「专属规则」 or 「技能」 as a separate child page. Rules can be read first, then edited as source with 「编辑规则」.
3. Enter how the assistant should work in this agent under 「智能体规则」, then tap 「保存规则」. After a successful save, the loaded value updates. Rules take effect from the next turn and do not rewrite generated history.
4. Change switches under 「智能体技能」 and tap 「保存技能」. Skill files are shared as one instance-level set; switches affect only the current agent and change the actual tools plus their matching prompt guidance from the next turn.

Agent rules are limited to 20,000 characters. On Back, keep drafts for this connection or explicitly discard them. Rules and skills are saved/discarded independently and do not affect other agents; changing servers or clearing local cache discards those local drafts.

## Features and Interaction Agents {#query-information-background}

Open feature settings from the News or SMS Agent Settings. Each has its own Agent for originals, processing records, preferences, and private-chat history. Background notifications default to main (`local-main`); selecting a chat does not change binding.

1. Long-press the News or SMS avatar for Agent Settings, then open its feature settings.
2. Check 「交互承接智能体」 (Interaction agent). Use 「更换承接智能体」 to choose any Agent already established on the server. Unsaved local empty agents are not candidates.
3. A change affects only newly accepted background runs and newly started discussions. In-flight accepted runs keep their previous target. No feature data, preferences, or chat history moves; old messages retain their feature source. If saving has an unknown outcome, use 「刷新核对」 before another change; nothing is automatically resent.
4. See [News reading](news.md) for reading, RSS, and preferences. Manage SMS in its feature details, not in per-agent settings.

### Ask Another Agent to Handle a Task {#agent-communication}

In the current chat, explicitly ask the assistant to hand a parcel-message lookup to the SMS feature, or ask another agent to handle a task. The assistant can discover existing agents, execute the request in an independent discussion owned by the target, and bring its reply back. Main is not the only entry point: News and SMS Agents can also ask other Agents for help. Project agents trust each other by default; no notification rebinding or additional per-call agent authorization is required.

The target uses its own rules, skills, workspace, and existing information, without automatically copying either primary chat history. Follow-ups can continue the same discussion. If the target asks for clarification, answer that question before continuing; no model remains running while waiting for the user. Disabling automatic SMS processing does not prevent querying already ingested data, but it does not import the phone's historical inbox.

Request replies return to their caller; only unsolicited background notifications use the configured interaction agent. Stopping the current run cancels its associated requests. Failures are not automatically retried, and completed side effects are not rolled back. Resetting the target clears its discussions. Resetting the source does not delete another agent's discussions or deliver old replies into the new session.

All provides explicit `@` and an input-target indicator. Ordinary private-chat input still goes to the current member first. For explicit notification follow-ups, see [Continue Processing a Notification](#continue-notification). Comments remain feedback, not task execution.

### SMS Processing {#sms-processing}

1. Long-press the SMS avatar, then open 「短信设置」 and enable 「启用短信处理」 (off initially). Save filtering guidance, such as notifying about important bills while keeping marketing silent.
2. In an Android native build, grant SMS permission. Automatic reception requires permission, a living app process, and the enabled feature. Leaving settings or switching chat agents does not stop listening. Reception after the OS terminates the app is not guaranteed. Expo Go does not include this local native module; manual text ingestion can test processing instead.
3. New items enter the SMS feature queue for real-model batch decisions. Silent items create no chat messages. Important results enter the bound agent with 「来自短信」 (From SMS). This is not an OS push notification. The All view and the receiving private chat reload authoritative state through the same notification connection, including after reconnecting.
4. While SMS settings is open and the app is in the foreground, it reads settings, preferences, and the latest 10 items every five seconds. Silent background decisions also update the pending, processing, processed, or failed status. Periodic reads stop when the page closes or the app backgrounds; reopening or foregrounding checks state again. Both automatic reads and 「刷新核对」 preserve unsaved filtering guidance. Failed reads retain previous records rather than showing an empty list. Unknown write or analysis outcomes still require explicit 「刷新核对」; nothing is automatically resent or rerun.
5. In the receiving chat, explicitly ask for feedback such as “Dislike this SMS and notify me less about this kind.” The restricted `feature` tool follows the server-verified message source, reads originals, and saves reactions or comments to SMS. It does not write global memory or ordinary-agent rules, and one dislike is not a permanent ban.

Bubble reactions and comments on source-linked messages are read as current examples in the next feature run. Withdrawals, edits, and deletions use their latest projection. Rebinding does not rewrite old message sources. Reset clears that chat's bubble feedback and relations, not original feature items, item-level feedback, or preferences, and never restores cleared messages.

Existing generic per-agent information data and APIs remain in place. They are not migrated, deleted, or silently taken over by SMS. Previously enabled backgrounds still process within their original agent; their read-only `information` tool remains agent-local. Independent features use dedicated entry points and source-restricted tools, not arbitrary cross-agent file access.

## Reset and Delete Agents {#reset-and-delete-agents}

### Reset the Current Session {#reset-current-session}

1. Go to Agent Settings → 「会话管理」 → 「重置当前会话」.
2. Check the target agent shown in the dialog.
3. By default, reset stops the current run, clears that agent's private-chat history, its discussions and display records in All, message feedback, unfinished approvals, Dream consolidation cursor, latest consolidation result, and pending suggestions, then opens a fresh conversation. Agent rules, skill switches, Dream configuration, private workspace files, information settings, raw items, processing records, and preference notes are retained.
4. To also delete scheduled tasks and webpage monitors bound to the agent, select 「同时清理此智能体下的定时任务与网页监控」. It is unselected by default; jobs and monitors are rebound to the new session.
5. Tap 「确认重置」. Success shows 「会话已重置」, and a new conversation can begin.

Cleared chat history and message feedback cannot be recovered. Reset cancels information notifications that have not yet been written to history; historical publication links remain traceable, but feedback from the old session is not migrated as new preference examples. If the network result is unknown, the client keeps the unconfirmed state and pauses sending. Tap 「核对重置结果」 first; do not automatically retry the reset.

### Delete an Agent {#delete-agent}

1. Long-press All, then open Global Settings → 「智能体管理」.
2. Tap the delete button in the ordinary Agent’s row.
3. Check its name, Agent ID, and irreversible deletion scope in the confirmation dialog.
4. Tap 「确认删除」 or cancel without submitting. Deleting the active private-chat Agent falls back to All; deleting another Agent leaves the original chat unchanged.

::: danger Irreversible deletion
Deleting an agent permanently removes its private-chat history, its discussions and display records in All, message feedback, private workspace files, agent rules, skill configuration, Dream configuration and consolidation state, information processing data, and bound scheduled tasks and webpage monitors. The action cannot be undone and does not migrate data to the main agent. Muse, News, and SMS built-in members cannot be deleted. An agent bound to a feature must be explicitly rebound in the corresponding feature Agent’s settings before deletion; it never automatically falls back to main. Use 「重置当前会话」 when you only want to clear the conversation.
:::

If a delete request result is unknown, refresh the agent list and verify before resending. After deletion, creating an agent with the same ID later does not restore the old history.
