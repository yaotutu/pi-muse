# Conversations and agents

This page covers the default Messages view, Agent private chats and settings, message feedback, stopping runs, session reset, and Agent deletion. Instructions match current source, not necessarily a released APK; check your installed release.

## Prerequisites {#prerequisites}

- The server is connected as described in [Quick Start](getting-started.md#connect-mobile-client); check the connection under 「设置」 → 「服务器连接」.
- An external model is configured. If the model is not configured, chat messages are rejected.
- Cold launch opens 「消息」 (Messages), the default group chat. The only primary tabs are 「消息」, 「新闻」 (News), and 「设置」 (Settings). Private chats, articles, source discussions, Agent Settings, and Agent Management are secondary pages with no bottom bar and an explicit Back control. Open global settings with the Settings tab; open an Agent’s configuration through 「设置」 → 「智能体管理」 → that Agent’s settings. Titles and avatars are not configuration shortcuts.

## Agents, Sessions, and Extensions {#agent-model}

An Agent is an independent execution and context owner, not just a session name. Each has private-chat contexts and separate discussion contexts in Messages, message history, dedicated instructions, skill switches, and private files. Reset changes the sessionId, not the stable agentId or dedicated configuration.

News and SMS are full Agents too. News reading, RSS management, and SMS background processing are added capabilities and views, not a restricted member type. They can chat, use their own instructions and skills, participate in Dream, own tasks, and receive notifications. Opening a chat does not enable collection or request SMS permission.

The instance model, SOUL/USER, identity profile, long-term memory, and skill assets remain shared. Existing tools and retrieval load memory on demand; the rename does not duplicate or automatically inject all memory. Explicit requests pass necessary content between Agents. The combined display never becomes shared model context.

The Agent version has no old Space/Thread interfaces or automatic data migration. Existing instances require a stopped service, a backup, and separately approved conversion; renaming the private-file directory alone is insufficient.

## Messages View and Directed Messages {#group-chat}

::: warning When the model service is unavailable
An unavailable model service triggers neither automatic forwarding nor resend; preserve the text and synchronize first. Source instructions may differ from the Release installed on your device; update and check the current interface.
:::

「消息」 (Messages) is a combined view, not a broadcast to every Agent or another Agent: it displays discussion messages and verified feature notifications with their actual sender avatars on one timeline. Each member has its own discussion context in Messages, separate from private chat. No model receives the complete combined timeline.

1. With no selected member or leading `@`, routing uses only this message, group settings, and public capabilities. A clear, unique match goes directly to that member. Ambiguous or overlapping matches show 「这条消息交给谁？」 with the original text and candidates; no target starts before selection. Ordinary conversation goes to the group default, initially Muse (`local-main`).
2. Use `@` to the left of the input to select a member, or start with `@display-name ` / `@Agent-ID `. Only that member receives this message, with highest priority and no routing classification or reconfirmation. The composer and target clear when the client takes ownership of the submission, so the next message has no explicit target. You can prepare the next draft during a reply; completion does not erase it. Unknown members produce an error, never fallback to main. One target per message is supported.
3. Members may explicitly ask another member for help through the real `agent` tool. The timeline shows the source, target, and responder. Only the request and explicitly supplied context reach the target; other messages are not broadcast.
4. Open 「成员」 (Members) at the top of the group to search by name or ID, including Agents that have never spoken. Each entry separates 「在群里 @」 (mention in group) from 「单独聊」 (private chat). Mentioning only selects the current message/draft target: it sends nothing and does not open private chat. Agents outside the actual group cannot be mentioned, but can be privately messaged without joining the group. Tapping a group-message avatar also opens private chat, never settings. Back restores the originating group draft and scroll position.
5. The send arrow becomes Stop while running. Use 「同步核对」 after an unknown network result; messages are never automatically resent. Disconnecting the stream, leaving the connection, or restarting the service cancels the associated run without rolling back completed operations. File changes still require the complete diff and approval; use the pending-approval entry when shown.

Messages supports text and tool results, but not attachments, message feedback, or multiple groups. Use private chat for attachments and feedback. SMS reminders and News “bring to conversation” still persist in the actual receiving Agent’s private chat; Messages only projects verified notifications, never ordinary private messages. Rebinding does not move old notifications. Resetting or deleting the receiving session removes its cleared notifications. Ordinary input follows group routing or the explicitly mentioned Agent and never implicitly follows up on a notification.

After sending, the original text is retained as a pending submission while you can edit the next draft. Confirmed acceptance releases only the old submission, never a newer draft. If authoritative readback confirms it was not accepted and is not running, the original is restored only into an empty composer. When a newer draft exists, explicitly restore or discard the old message; nothing is automatically resent.

### Choose a Recipient {#routing-confirmation}

- A suggestion card exists only within the current connection and is not a sent message. Selecting `@member` sends the card's original content as you to exactly one member. The default does not duplicate the answer, and any newer composer draft stays intact.
- 「取消」 (Cancel) sends nothing and changes no preferences. After an uncertain confirmation result, synchronize before acting; no automatic resend occurs. A removed recipient produces an error, not fallback to another member.
- Routing sees only the current new message and public capabilities, not private chat or the aggregated timeline. For unclear references, manually `@` a member and provide the necessary context; routing does not guess which notification you meant.
- Configure members and the default under [Default Group Collaboration](profile-and-settings.md#group-collaboration). Edit an Agent's public description by opening its Agent Settings (「设置」 → 「智能体管理」 → the corresponding Agent’s settings) → 「公开能力」 → Save. This is separate from private instructions and does not grant skills. Built-in News and SMS descriptions are editable too. Other Agents can also discover public capabilities through `agent` action `list`, without reading private instructions.

### Continue Processing a Notification {#continue-notification}

1. In Messages or the actual receiving private chat, tap 「继续处理」 below a notification. Its separate discussion shows the source and a quoted summary, with a composer such as 「回复短信…」 or 「回复新闻…」. Opening it does not call a model.
2. Send an explicit request. The server verifies the original notification and routes it to its real source Agent. SMS replies as SMS even when Muse received the notification. Rebinding does not change the source of old notifications. Mentions inside this discussion are plain text and do not change the recipient.
3. Follow-ups continue the same discussion. Other notifications, ordinary group chat, and private histories are not automatically included. The source may explicitly request another Agent’s help.
4. Return to the originating chat and tap 「查看讨论与处理结果」 to read replies. Ordinary chat and each notification discussion keep separate drafts for this connection. Switching pages does not stop generation. Returning restores the original Agent even when entering discussions from different private chats; contexts are never merged. Saved discussions can be reopened after client restart, but unsent drafts are not persisted.
5. Stop, approval, and uncertain-result rules match Messages: file changes still require a complete diff and human approval, and requests are never automatically retried. A cleared notification blocks new sends with an expired-source message. A missing existing discussion never silently starts fresh or falls back to Muse.

Comments and like/dislike remain feedback, not execution commands. Use 「继续处理」 to explicitly request an action.

The Messages header does not cover messages. Member avatars sit to the left of replies, with names, text, and tool results aligned in one column. A directed `@member` appears inline at the start of its message, without a background highlight: medium-weight white text in blue bubbles, or the theme accent color in member bubbles, with long text wrapping naturally. Code blocks, tables, and other block content retain their layout. Tool results for one reply initially share one low-emphasis “工具记录” (tool records) row, showing the count and actual result status. Failure and missing-result counts remain visible. Tap the row to expand each summary and source, then tap again to collapse. Stopped or failed labels stay below the affected reply, rather than collecting at the end of history.

## Send and Stop Conversations {#send-and-stop-conversations}

These steps apply to private chats; see [Messages View](#group-chat) for the combined timeline.

1. In 「消息」 (Messages), open 「成员」 (Members) and choose 「单独聊」 (private chat) for an Agent, or tap its group-message avatar. News and SMS have full independent private chats too. The secondary private-chat page has no bottom bar; use Back to return to its actual origin.
2. Enter text in the 「消息」 input field. To send an image or text file with this message, use the 「+」 button described in [the attachment guide](files-and-approvals.md#send-attachments).
3. Tap the send arrow to the right of the input field. The visible success signal is your message entering the chat list and the right-hand button becoming a stop square. Detailed execution status is available in the session panel.
4. The reply streams into the page. When the model calls tools, progress appears in message tool cards or the session panel's 「动态」 view.
5. To stop, tap the same right-side button. While a run is active it appears as a stop square; if run status is still synchronizing, the button is unavailable. Tap 「重新同步」 first.

After a successful stop, the stream shows stopped or finished. Switching agents or main pages within the same foreground connection does not actively stop generation in the original agent; return to see its progress. This does not promise background execution. Explicit stopping, a disconnected chat stream, leaving the current connection, or restarting the server still cancels the associated run and invalidates pending file approvals. Tool operations that already completed are not rolled back.

The primary bottom bar contains only 「消息 / 新闻 / 设置」 (Messages / News / Settings) and hides while the keyboard is open. Secondary pages have no bottom bar. Avatar long-press navigation, pinning, blank slots, the Agent More dock, horizontal chat switching, and Agent main-view preferences are not available. News always opens the reader from its primary tab; its private chat remains separate. Switching pages preserves connection-local drafts and in-progress replies. Sending follows the latest message; after scrolling up, tap 「回到最新」 to resume following.

### Agent Status {#avatar-status}

- Real Agent state is shown in the private-chat title, Agent Settings identity area, and 「动态与审批」 (Activity and Approvals). Primary tabs are not Agents and do not provide Agent status badges, unread counts, or red-dot indicators.
- Background processing being enabled or items being queued does not itself mean an Agent is working. State belongs to the Agent doing the work, not the notification receiver. Disconnected or unsynchronized state is unknown, not idle.
- Pending approval, failure, and requests for additional information are directly reachable in the messaging scenario; configuration and history management remain in Settings. Use Activity and Approvals, News/SMS settings, or global Dream settings for the relevant work details.
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

1. Open 「设置」 (Settings) → 「智能体管理」 (Agent Management) → the target Agent’s settings. Titles and avatars do not open configuration. Use Back on secondary pages; keyboards and overlays close first.
2. Agent Settings contain files, dedicated rules, skills, session management, activity, and approvals; News and SMS also have feature settings. There is no Reading/Chat main-view selector. Opening configuration does not clear messaging drafts or stop generation. Back returns through Agent Management to Settings, not to a different Agent’s chat.
3. Open Agent Management (「设置」 → 「智能体管理」) → 「添加智能体」. The server confirms creation before opening the new Agent’s settings, without switching the original chat. It persists without a first message and is available for private chat and notification binding. After an explicit group member list is saved, add the Agent under Default Group Collaboration before selecting it through mentions or automatic routing. Creation disables duplicate taps and Back. Failures stay in management; an uncertain result is checked by the original ID instead of automatically creating a second Agent.
4. Built-in names are Muse, News, and SMS. Other members use connection-local labels such as 「成员 1」. Persistent renaming and custom avatars are not available.

Each member is an existing Agent with independent private-chat history, workspace files, rules, and skill switches. Stable Agent IDs do not change when sessions reset. Assistant/user profiles, long-term memory, and skill assets remain instance-global. A member is not a separate account or an automatically distinct persona.

Opening 「动态与审批」 from Agent Settings overlays that page and initially shows Activity. Closing it or pressing Android Back leaves the settings page and its return destination unchanged. An open keyboard closes first.

News and SMS support private chat. Opening settings or chatting does not enable background processing, request SMS permission, or change notification binding. Background notifications default to main and can be rebound to any existing Agent. Private and cross-Agent discussion histories remain separate.

## Agent Rules and Skills {#agent-rules-and-skills}

1. Open Agent Settings (「设置」 → 「智能体管理」 → the corresponding Agent’s settings) and confirm the Agent name.
2. Open 「专属规则」 or 「技能」 as a separate child page. Rules can be read first, then edited as source with 「编辑规则」.
3. Enter how the assistant should work in this agent under 「智能体规则」, then tap 「保存规则」. After a successful save, the loaded value updates. Rules take effect from the next turn and do not rewrite generated history.
4. Change switches under 「智能体技能」 and tap 「保存技能」. Skill files are shared as one instance-level set; switches affect only the current agent and change the actual tools plus their matching prompt guidance from the next turn.

Agent rules are limited to 20,000 characters. On Back, keep drafts for this connection or explicitly discard them. Rules and skills are saved/discarded independently and do not affect other agents; changing servers or clearing local cache discards those local drafts.

## Features and Interaction Agents {#query-information-background}

Open feature settings from the News or SMS Agent Settings. Each has its own Agent for originals, processing records, preferences, and private-chat history. Background notifications default to main (`local-main`); selecting a chat does not change binding.

1. Open Agent Settings for News or SMS (「设置」 → 「智能体管理」 → the corresponding Agent’s settings), then open 「新闻设置」 or 「短信设置」.
2. Check 「交互承接智能体」 (Interaction agent). Use 「更换承接智能体」 to choose any Agent already established on the server. Unsaved local empty agents are not candidates.
3. A change affects only newly accepted background runs and newly started discussions. In-flight accepted runs keep their previous target. No feature data, preferences, or chat history moves; old messages retain their feature source. If saving has an unknown outcome, use 「刷新核对」 before another change; nothing is automatically resent.
4. See [News reading](news.md) for reading, RSS, and preferences. Manage SMS in its feature details, not in per-agent settings.

### Ask Another Agent to Handle a Task {#agent-communication}

In the current chat, explicitly ask the assistant to hand a parcel-message lookup to the SMS feature, or ask another agent to handle a task. The assistant can discover existing agents, execute the request in an independent discussion owned by the target, and bring its reply back. Main is not the only entry point: News and SMS Agents can also ask other Agents for help. Project agents trust each other by default; no notification rebinding or additional per-call agent authorization is required.

The target uses its own rules, skills, workspace, and existing information, without automatically copying either primary chat history. Follow-ups can continue the same discussion. If the target asks for clarification, answer that question before continuing; no model remains running while waiting for the user. Disabling automatic SMS processing does not prevent querying already ingested data, but it does not import the phone's historical inbox.

Request replies return to their caller; only unsolicited background notifications use the configured interaction agent. Stopping the current run cancels its associated requests. Failures are not automatically retried, and completed side effects are not rolled back. Resetting the target clears its discussions. Resetting the source does not delete another agent's discussions or deliver old replies into the new session.

Messages provides explicit `@` and an input-target indicator. Ordinary private-chat input still goes to the current member first. For explicit notification follow-ups, see [Continue Processing a Notification](#continue-notification). Comments remain feedback, not task execution.

### SMS Processing {#sms-processing}

1. Open SMS Agent Settings (「设置」 → 「智能体管理」 → the corresponding Agent’s settings) → 「短信设置」, and enable 「启用短信处理」 (off initially). Filtering rules and preferences are unified with the SMS agent instructions (`INSTRUCTIONS.md`), guiding how items are screened (actionable alerts vs silent).
2. In an Android native build, grant SMS permission. Automatic reception requires permission, a living app process, and the enabled feature. Leaving settings or switching chat agents does not stop listening. Reception after the OS terminates the app is not guaranteed. Expo Go does not include this local native module; manual text ingestion can test processing instead.
3. New items enter the SMS feature queue for real-model batch decisions. On initial setup or when using 「+ 批量导入历史短信」 to batch import history, the model runs a comprehensive analysis that aggregates actionable alerts (pick-up codes, unpaid bills, flights) into a single summary digest notification sent to the receiving agent, avoiding notification floods. Once the backlog is processed, it transitions to incremental evaluation, issuing concise single notifications only for new actionable messages while keeping marketing silent. This is not an OS push notification. The Messages view and the receiving private chat reload authoritative state through the same notification connection, including after reconnecting.
4. While SMS settings is open and the app is in the foreground, it reads settings, preferences, and the latest 10 items every five seconds. Silent background decisions also update the pending, processing, processed, or failed status. Periodic reads stop when the page closes or the app backgrounds; reopening or foregrounding checks state again. Both automatic reads and 「刷新核对」 preserve unsaved filtering guidance. Failed reads retain previous records rather than showing an empty list. Unknown write or analysis outcomes still require explicit 「刷新核对」; nothing is automatically resent or rerun.
5. In the receiving chat, explicitly ask for feedback such as “Dislike this SMS and notify me less about this kind.” The restricted `feature` tool follows the server-verified message source, reads originals, and saves reactions or comments to SMS. It does not write global memory or ordinary-agent rules, and one dislike is not a permanent ban.

Bubble reactions and comments on source-linked messages are read as current examples in the next feature run. Withdrawals, edits, and deletions use their latest projection. Rebinding does not rewrite old message sources. Reset clears that chat's bubble feedback and relations, not original feature items, item-level feedback, or preferences, and never restores cleared messages.

Existing generic per-agent information data and APIs remain in place. They are not migrated, deleted, or silently taken over by SMS. Previously enabled backgrounds still process within their original agent; their read-only `information` tool remains agent-local. Independent features use dedicated entry points and source-restricted tools, not arbitrary cross-agent file access.

## Reset and Delete Agents {#reset-and-delete-agents}

### Reset the Current Session {#reset-current-session}

1. Open target Agent Settings (「设置」 → 「智能体管理」 → the corresponding Agent’s settings) → 「会话管理」 → 「重置当前会话」.
2. Check the target agent shown in the dialog.
3. By default, reset stops the current run, clears that agent's private-chat history, its discussions and display records in Messages, message feedback, unfinished approvals, Dream consolidation cursor, latest consolidation result, and pending suggestions, then opens a fresh conversation. Agent rules, skill switches, Dream configuration, private workspace files, information settings, raw items, processing records, and preference notes are retained.
4. To also delete scheduled tasks and webpage monitors bound to the agent, select 「同时清理此智能体下的定时任务与网页监控」. It is unselected by default; jobs and monitors are rebound to the new session.
5. Tap 「确认重置」. Success shows 「会话已重置」, and a new conversation can begin.

Cleared chat history and message feedback cannot be recovered. Reset cancels information notifications that have not yet been written to history; historical publication links remain traceable, but feedback from the old session is not migrated as new preference examples. If the network result is unknown, the client keeps the unconfirmed state and pauses sending. Tap 「核对重置结果」 first; do not automatically retry the reset.

### Delete an Agent {#delete-agent}

1. Open Agent Management (「设置」 → 「智能体管理」).
2. Tap the delete button in the ordinary Agent’s row.
3. Check its name, Agent ID, and irreversible deletion scope in the confirmation dialog.
4. Tap 「确认删除」 or cancel without submitting. Deleting the active private-chat Agent falls back to Messages; deleting another Agent leaves the original chat unchanged.

::: danger Irreversible deletion
Deleting an agent permanently removes its private-chat history, its discussions and display records in Messages, message feedback, private workspace files, agent rules, skill configuration, Dream configuration and consolidation state, information processing data, and bound scheduled tasks and webpage monitors. The action cannot be undone and does not migrate data to the main agent. Muse, News, and SMS built-in members cannot be deleted. An agent bound to a feature must be explicitly rebound in the corresponding feature Agent’s settings before deletion; it never automatically falls back to main. Use 「重置当前会话」 when you only want to clear the conversation.
:::

If a delete request result is unknown, refresh the agent list and verify before resending. After deletion, creating an agent with the same ID later does not restore the old history.
