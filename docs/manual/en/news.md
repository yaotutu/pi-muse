# News Reading

The News member has its own private chat and reading view. Tap the top News avatar to open private chat, then tap the selected avatar again to open its profile, then 「阅读新闻」 for recommended and all-article timelines. The private-chat gear opens the current Agent Settings; the All view top-right opens Members and Settings. The reader has no chat box or bottom tab. Back returns to the News profile, then to All, Members and Settings, or private chat that opened that profile. The server reuses the existing information processing and model runtime internally; it does not add a separate recommendation engine.

## Reading and Filtering {#reading}

- The reading page has one top row for 「Recommended／All」, saved articles, sources, and fetching. It opens on Recommended and shows articles immediately below the row. Open 「Sources」 to see fetch time, analysis progress, and failure counts.
- 「Recommended」 contains only articles explicitly selected by a completed structured model run, with a short reason for each article. Articles not selected by the model remain readable under 「All」.
- 「All」 is ordered newest first by publication time. When publication time is invalid, the server uses the first acceptance time. The saved filter only filters the list and does not change ordering.
- Tap an article to read safe text cleaned by the server. Long-press it to open the same style of action menu as chat messages, without also opening the detail view. In the detail view, long-press the title or body to open the menu. Original links allow only credential-free HTTP(S) URLs. External titles, content, and links are untrusted data.
- Accepted articles, recommendations, feedback, and saves are restored from the server after a restart.

## Discuss in Chat {#discuss-in-chat}

Tap 「带到会话讨论」 (Discuss in chat) in article details. The server reads the original and writes it to the news feature's bound agent, then the client opens that chat. It does not invoke the model or ask a question on your behalf. The message shows 「来自新闻」 (From news); continue asking questions or explicitly request reactions/comments saved back to news. Reading does not push every article into chat.

The default interaction agent is main. Check or change it in the News profile → 「新闻设置」. RSS and news preferences also belong to news, not the currently selected chat. If submission times out or disconnects, inspect the receiving chat, return to the article, then tap 「已核对，恢复操作」 (Checked, resume) and confirm. Operations unlock only after the chat can be read successfully; the previous discussion is never resent. Resetting an agent retains the binding, and future discussions use its new session.

## Managing RSS Sources {#sources}

1. Tap the Sources icon at the top of the reader, or open 「RSS 来源管理」 from news settings. Existing subscriptions appear first, followed by collection and analysis status; the fixed header returns to the actual entry point. Tap 「添加来源」 to expand the form, then enter a public HTTP(S) RSS2 URL and optional title.
2. Expand 「推荐中文来源」 in the add form, then choose 「填入」 (Fill) to populate it. Review the URL and title, then tap 「添加来源」 (Add source) to submit, or enter them manually. Examples include 少数派, 36氪, 机器之心, and IT之家; availability depends on each website. Only RSS2 is supported, not Atom.
3. Collapsing the form or leaving the page retains input within the current connection. Reopen it to continue. If creation has an uncertain result, the form stays visible; explicitly read back, review, and unlock before another attempt. The server fetches and validates the XML when the source is added. URLs containing embedded credentials are rejected.
4. The Sources page shows fetch time, pending analysis, and analysis failures. Each source shows its latest fetch time and controlled error. If one source is malformed or temporarily unavailable, other sources and existing articles remain usable.
5. Deleting a source stops future collection only. Accepted articles, comments, reactions, and saves are retained.

The server collects every 30 minutes by default; background collection only fetches new items and does not automatically requeue articles already known to have failed. Manual refresh completes RSS collection and returns the number of new articles; article analysis continues in the background. Refresh does not wait for the complete model run and does not automatically resend an unknown result. If an item lacks a title or readable body, the whole source records a controlled parse error instead of being silently treated as empty.

## Feedback and Recommendations {#feedback}

- Long-press an article to choose like, dislike, save, or comments from its menu. Tapping outside the menu or pressing Android Back only dismisses it. Screen-reader users can use the article's 「打开文章操作」 (Open article actions) custom action.
- Like and dislike are mutually exclusive. Selecting the active reaction again clears it. Saving is independent of reactions and can be undone from the menu.
- Articles without feedback have no action-button row. Existing feedback appears as a small badge; tap it to reopen the menu.
- The menu's 「评论」 (Comments) entry opens the article detail's comments section. Comments are stored per article and support add and delete. Blank comments are rejected, and each comment is limited to 4,000 characters.
- Feedback does not immediately invoke the model. The next background analysis reads recent articles, feedback, comments, and saves as local evidence; saves are a weaker signal.
- Explicit preferences are saved by the user. Learned notes are a summary updated by the server from feedback. They are stored separately, and learned notes never overwrite explicit preferences, agent rules, or the global user profile.
- For newly initialized News Agents, the default rules require recommendation reasons and learned notes in concise Simplified Chinese. RSS titles and content remain in their original language and are not translated.

Open the News profile → 「新闻设置」 and save explicit notes under 「新闻偏好」. Use 「RSS 来源管理」 to manage subscriptions. When opened from settings, Back returns through news settings and the member profile, then to the list or private chat, rather than detouring through the news reader.

Unsaved preference drafts remain only in memory for the current connection. Visiting RSS, another member, or chat and returning, or returning from the background, preserves input. Reopening or foregrounding checks server state but only updates unchanged notes. Failed reads retain the draft and previously loaded preferences. 「刷新核对」 also preserves unsaved input. If a save outcome is unknown, reopening does not unlock saving: explicitly check state before saving again; nothing is automatically resent. Only 「保存偏好」 submits explicit notes; saving an empty field clears them. Switching connections or restarting the app does not restore unsaved drafts.

## Refresh and Failures {#refresh}

- The refresh icon in the reading toolbar starts one manual fetch. If reading the article list fails, a separate 「Retry list」 action rereads the list and status without fetching again. A manual fetch returns a conflict when one is already running; fetches are neither queued nor run concurrently.
- When the outcome of a fetch write is unknown, reread and check the status before explicitly unlocking it. The client does not resend automatically.
- Collection failures appear as controlled errors in news status or the source list. A malformed source is not silently treated as empty.
- When model analysis fails, the all-articles timeline remains readable. The recommended view contains only confirmed successful results.
- Another manual refresh can requeue articles already known to have failed. A running batch is not reordered.
- While the news page is in the foreground and status says processing, it may briefly reread status and lists, then stop at a terminal state. News adds no new SSE or global polling.

## Boundaries {#boundaries}

News does not fetch full web pages, provide search or vector recommendations, send system notifications, or support OPML. The chat `feature` tool only reads and records feedback through an existing verified source; it does not browse all feature data. News is a member with private chat, files, and rules. It can receive notifications and configure skills and Dream like other Agents; built-in Agents cannot be deleted. Chatting does not enable RSS processing.
