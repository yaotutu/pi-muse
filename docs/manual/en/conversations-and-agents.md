# Conversations and agents

This page covers the default group chat, private chats, member profiles, message feedback, stopping runs, resetting a session, and deleting an agent in the mobile client. Entry points and limits were checked against current mobile and server source; source does not automatically equal a released APK. Follow the UI in your installed release.

## Prerequisites {#prerequisites}

- The server is connected as described in [Quick Start](getting-started.md#connect-mobile-client); check the connection under 「设置」 → 「服务器连接」.
- An external model is configured. If the model is not configured, chat messages are rejected.
- Cold launch opens 「群聊」 (group chat), without bottom navigation or a separate conversation list. The top avatar strip switches between the group and Agent private chats. The group top-right opens 「群组信息」 (Group Information); a private chat opens its current Agent Settings. Global settings are at the top-right of Group Information, which also provides Add Agent.

## Agents, Sessions, and Extensions {#agent-model}

An Agent is an independent execution and context owner, not just a session name. Each has private-chat and group-discussion contexts, message history, dedicated instructions, skill switches, and private files. Reset changes the sessionId, not the stable agentId or dedicated configuration.

News and SMS are full Agents too. News reading, RSS management, and SMS background processing are added capabilities and views, not a restricted member type. They can chat, use their own instructions and skills, participate in Dream, own tasks, and receive notifications. Opening a chat does not enable collection or request SMS permission.

The instance model, SOUL/USER, identity profile, long-term memory, and skill assets remain shared. Existing tools and retrieval load memory on demand; the rename does not duplicate or automatically inject all memory. Explicit requests pass necessary content between Agents. Group display never becomes shared model context.

The Agent version has no old Space/Thread interfaces or automatic data migration. Existing instances require a stopped service, a backup, and separately approved conversion; renaming the private-file directory alone is insufficient.

## Default Group and Directed Messages {#group-chat}

The group is not another Agent: it displays group messages and verified feature notifications with their actual sender avatars on one timeline. Each member has its own group context, separate from private chat. No model receives the complete group transcript.

1. With no member selected and no leading `@`, only Muse (main, `local-main`) receives and answers. Other members neither receive nor automatically answer.
2. Use `@` to the left of the input to select a member, or start with `@display-name ` / `@Agent-ID `. Only that member receives this message. After a confirmed send and read-back, the target clears, so the next message defaults to main. Unknown members produce an error, never fallback to main. One target per message is supported.
3. Members may explicitly ask another member for help through the real `agent` tool. The timeline shows the source, target, and responder. Only the request and explicitly supplied context reach the target; other messages are not broadcast.
4. Tap a message avatar or a member in Group Information to open its profile, then 「发消息」 for private chat. That private chat top-right opens its Agent Settings. Group Information returns to group chat; profiles return to their actual entry page.
5. The send arrow becomes Stop while running. Use 「同步核对」 after an unknown network result; messages are never automatically resent. Disconnecting the stream, leaving the connection, or restarting the service cancels the associated run without rolling back completed operations. File changes still require the complete diff and approval; use the pending-approval entry when shown.

The current group supports text and tool-result display, not attachments, message feedback, notification-card continuation, or multiple groups. Use private chat for attachments and feedback. SMS background notifications and News Discuss in Chat remain stored only in the actual receiving private chat. The default group shows a read-only projection of notifications with server-verified feature markers, never ordinary private messages. Each notification identifies its source and offers a receiving-member/private-chat action. It opens the actual recipient of that notification, not the current binding. Rebinding does not move old notifications; resetting or deleting the recipient removes cleared notifications from the group. Viewing does not call a model or change the group input target. Ordinary group replies still go to main or the explicit `@` target, without automatically referring to the notification.

The group header does not cover messages. Member avatars sit to the left of replies, with names, text, and tool results aligned in one column. A directed `@member` appears inline at the start of its message, without a background highlight: medium-weight white text in blue bubbles, or the theme accent color in member bubbles, with long text wrapping naturally. Code blocks, tables, and other block content retain their layout. Tool results for one reply initially share one low-emphasis “工具记录” (tool records) row, showing the count and actual result status. Failure and missing-result counts remain visible. Tap the row to expand each summary and source, then tap again to collapse. Stopped or failed labels stay below the affected reply, rather than collecting at the end of history.

## Send and Stop Conversations {#send-and-stop-conversations}

These steps apply to private chats; see [Default Group](#group-chat) for the group.

1. Tap an Agent in the top avatar strip to enter private chat. Tap the selected avatar again or long-press any avatar to open its profile, then use 「发消息」.
2. Enter text in the 「消息」 input field. To send an image or text file with this message, use the 「+」 button described in [the attachment guide](files-and-approvals.md#send-attachments).
3. Tap the send arrow to the right of the input field. The visible success signal is your message entering the chat list and the right-hand button becoming a stop square. Detailed execution status is available in the session panel.
4. The reply streams into the page. When the model calls tools, progress appears in message tool cards or the session panel's 「动态」 view.
5. To stop, tap the same right-side button. While a run is active it appears as a stop square; if run status is still synchronizing, the button is unavailable. Tap 「重新同步」 first.

After a successful stop, the stream shows stopped or finished. Switching agents or main pages within the same foreground connection does not actively stop generation in the original agent; return to see its progress. This does not promise background execution. Explicit stopping, a disconnected chat stream, leaving the current connection, or restarting the server still cancels the associated run and invalidates pending file approvals. Tool operations that already completed are not rolled back.

The top avatar strip occupies normal layout space and never overlaps messages. Group comes first, followed by Muse, News, SMS, and other Agents; activity timestamps do not reorder it. A quick horizontal swipe over messages selects the adjacent chat without wrapping. Vertical reading, the composer, child pages, and horizontal code/table scrolling do not switch chats. The keyboard hides avatar labels to save reading space. Detailed status stays in Activity and Approvals. Switching preserves each connection-local draft and in-progress reply. Sending follows the latest message; after scrolling up, tap 「回到最新」 to resume following.

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

1. Switch chats with the top avatar strip. Tap the selected avatar again or long-press an avatar to open its profile. Android Back returns a private chat to the group, which is the root page; keyboards and overlays close first.
2. Profiles contain 「发消息」, files, dedicated rules, skills, session management, activity, and approvals. News and SMS also have their own feature settings. Global settings open from the top-right of Group Information. Profiles return to their source group, Group Information, or private chat; the News reader returns to the News profile. Foreground resume preserves the current page.
3. Tap 「添加智能体」 in Group Information to create the Agent on the server before opening its profile. It persists without a first message and is immediately available for mentions or notification binding. Creation disables repeat taps; errors stay in Group Information. An uncertain response is checked by the original ID rather than automatically creating another Agent.
4. Built-in names are Muse, News, and SMS. Other members use connection-local labels such as 「成员 1」. Persistent renaming and custom avatars are not available.

Each member is an existing Agent with independent private-chat history, workspace files, rules, and skill switches. Stable Agent IDs do not change when sessions reset. Assistant/user profiles, long-term memory, and skill assets remain instance-global. A member is not a separate account or an automatically distinct persona.

Opening 「动态与审批」 from a member profile or Agent Settings overlays that page and initially shows 「动态」 (Activity). Closing the panel with its close button or Android Back leaves you on the original profile or Agent Settings, without entering private chat or changing that page's return destination. When the keyboard is open, Android Back dismisses it first.

News and SMS support private chats. Opening a profile or chatting does not enable background processing, request SMS permissions, or change the notification recipient. Background notifications still default to main and can be rebound to any existing Agent. Private chats and cross-agent discussions do not merge histories.

## Agent Rules and Skills {#agent-rules-and-skills}

1. Open member profile and confirm the current agent name on the full-screen home.
2. Open 「专属规则」 or 「技能」 as a separate child page. Rules can be read first, then edited as source with 「编辑规则」.
3. Enter how the assistant should work in this agent under 「智能体规则」, then tap 「保存规则」. After a successful save, the loaded value updates. Rules take effect from the next turn and do not rewrite generated history.
4. Change switches under 「智能体技能」 and tap 「保存技能」. Skill files are shared as one instance-level set; switches affect only the current agent and change the actual tools plus their matching prompt guidance from the next turn.

Agent rules are limited to 20,000 characters. On Back, keep drafts for this connection or explicitly discard them. Rules and skills are saved/discarded independently and do not affect other agents; changing servers or clearing local cache discards those local drafts.

## Features and Interaction Agents {#query-information-background}

Open News or SMS settings from its member profile. Each has its own Agent for originals, processing records, preferences, and private-chat history. Background notifications still default to main (`local-main`); selecting a private chat does not change the binding.

1. Open the News or SMS member profile, then its feature settings.
2. Check 「交互承接智能体」 (Interaction agent). Use 「更换承接智能体」 to choose any Agent already established on the server. Unsaved local empty agents are not candidates.
3. A change affects only newly accepted background runs and newly started discussions. In-flight accepted runs keep their previous target. No feature data, preferences, or chat history moves; old messages retain their feature source. If saving has an unknown outcome, use 「刷新核对」 before another change; nothing is automatically resent.
4. See [News reading](news.md) for reading, RSS, and preferences. Manage SMS in its feature details, not in per-agent settings.

### Ask Another Agent to Handle a Task {#agent-communication}

In the current chat, explicitly ask the assistant to hand a parcel-message lookup to the SMS feature, or ask another agent to handle a task. The assistant can discover existing agents, execute the request in an independent discussion owned by the target, and bring its reply back. Main is not the only entry point: News and SMS Agents can also ask other Agents for help. Project agents trust each other by default; no notification rebinding or additional per-call agent authorization is required.

The target uses its own rules, skills, workspace, and existing information, without automatically copying either primary chat history. Follow-ups can continue the same discussion. If the target asks for clarification, answer that question before continuing; no model remains running while waiting for the user. Disabling automatic SMS processing does not prevent querying already ingested data, but it does not import the phone's historical inbox.

Request replies return to their caller; only unsolicited background notifications use the configured interaction agent. Stopping the current run cancels its associated requests. Failures are not automatically retried, and completed side effects are not rolled back. Resetting the target clears its discussions. Resetting the source does not delete another agent's discussions or deliver old replies into the new session.

Group chat provides explicit `@` and an input-target indicator. Ordinary private-chat input still goes to the current member first. Notification-card continuation and a dedicated discussion screen are not available; feedback comments are not task execution.

### SMS Processing {#sms-processing}

1. Open the SMS profile → 「短信设置」 and enable 「启用短信处理」 (off initially). Save filtering guidance, such as notifying about important bills while keeping marketing silent.
2. In an Android native build, grant SMS permission. Automatic reception requires permission, a living app process, and the enabled feature. Leaving settings or switching chat agents does not stop listening. Reception after the OS terminates the app is not guaranteed. Expo Go does not include this local native module; manual text ingestion can test processing instead.
3. New items enter the SMS feature queue for real-model batch decisions. Silent items create no chat messages. Important results enter the bound agent with 「来自短信」 (From SMS). This is not an OS push notification. The default group and the receiving private chat reload authoritative state through the same notification connection, including after reconnecting.
4. While SMS settings is open and the app is in the foreground, it reads settings, preferences, and the latest 10 items every five seconds. Silent background decisions also update the pending, processing, processed, or failed status. Periodic reads stop when the page closes or the app backgrounds; reopening or foregrounding checks state again. Both automatic reads and 「刷新核对」 preserve unsaved filtering guidance. Failed reads retain previous records rather than showing an empty list. Unknown write or analysis outcomes still require explicit 「刷新核对」; nothing is automatically resent or rerun.
5. In the receiving chat, explicitly ask for feedback such as “Dislike this SMS and notify me less about this kind.” The restricted `feature` tool follows the server-verified message source, reads originals, and saves reactions or comments to SMS. It does not write global memory or ordinary-agent rules, and one dislike is not a permanent ban.

Bubble reactions and comments on source-linked messages are read as current examples in the next feature run. Withdrawals, edits, and deletions use their latest projection. Rebinding does not rewrite old message sources. Reset clears that chat's bubble feedback and relations, not original feature items, item-level feedback, or preferences, and never restores cleared messages.

Existing generic per-agent information data and APIs remain in place. They are not migrated, deleted, or silently taken over by SMS. Previously enabled backgrounds still process within their original agent; their read-only `information` tool remains agent-local. Independent features use dedicated entry points and source-restricted tools, not arbitrary cross-agent file access.

## Reset and Delete Agents {#reset-and-delete-agents}

### Reset the Current Session {#reset-current-session}

1. Go to member profile → 「会话管理」 → 「重置当前会话」.
2. Check the target agent shown in the dialog.
3. By default, reset stops the current run, clears that agent's private-chat history, group discussions and display records, message feedback, unfinished approvals, Dream consolidation cursor, latest consolidation result, and pending suggestions, then opens a fresh conversation. Agent rules, skill switches, Dream configuration, private workspace files, information settings, raw items, processing records, and preference notes are retained.
4. To also delete scheduled tasks and webpage monitors bound to the agent, select 「同时清理此智能体下的定时任务与网页监控」. It is unselected by default; jobs and monitors are rebound to the new session.
5. Tap 「确认重置」. Success shows 「会话已重置」, and a new conversation can begin.

Cleared chat history and message feedback cannot be recovered. Reset cancels information notifications that have not yet been written to history; historical publication links remain traceable, but feedback from the old session is not migrated as new preference examples. If the network result is unknown, the client keeps the unconfirmed state and pauses sending. Tap 「核对重置结果」 first; do not automatically retry the reset.

### Delete a Agent {#delete-agent}

1. Open the ordinary member profile you want to delete.
2. Open member profile → 「会话管理」.
3. Scroll to 「删除当前智能体」 and tap it to open the confirmation card.
4. Check the deletion scope, then tap 「确认删除」.

::: danger Irreversible deletion
Deleting an agent permanently removes its private-chat history, group discussions and display records, message feedback, private workspace files, agent rules, skill configuration, Dream configuration and consolidation state, information processing data, and bound scheduled tasks and webpage monitors. The action cannot be undone and does not migrate data to the main agent. Muse, News, and SMS built-in members cannot be deleted. An agent bound to a feature must be explicitly rebound in 「设置」 before deletion; it never automatically falls back to main. Use 「重置当前会话」 when you only want to clear the conversation.
:::

If a delete request result is unknown, refresh the agent list and verify before resending. After deletion, creating an agent with the same ID later does not restore the old history.
