# News Reading

News is a full Agent with its own private chat and reading page. Tapping News in the bottom bar (or selecting it from the bottom 「更多」 panel) opens the reading main view by default. Tap the top title bar for Agent Settings, then choose Reading or Chat under 「主视图」 (Main view). This preference is saved locally per server and Agent; instructions, memory, and conversations are unchanged. The reader has no composer, and article details hide the bottom bar for reading. Switching Agents or visiting settings retains the open article and reading position. Android Back first closes the article or sources, then returns from the reading root to All. The server reuses existing information processing and model capabilities rather than a separate recommendation engine.

## Reading and Filtering {#reading}

- A thin divider separates feed items without per-article cards. Each item shows its source, Chinese-formatted time, title, and up to two excerpt lines. Choose Recommended or All from the filter menu; saved articles have a separate filter, while sources and manual fetching live under 「更多」 (More). The default is Recommended. Open 「RSS 来源」 (RSS sources) for fetch time, analysis progress, and failure counts.
- 「Recommended」 contains only articles explicitly selected by a completed structured model run. Recommendation reasons appear in article details. Articles not selected by the model remain readable under 「All」.
- 「All」 is ordered newest first by publication time. When publication time is invalid, the server uses the first acceptance time. The saved filter only filters the list and does not change ordering.
- Tap an article for full-page details with safe text cleaned by the server, recommendation reasons, and selectable body text. The detail toolbar contains only Back, without an original-link button or More menu. Feedback and discussion stay fixed at the bottom instead of scrolling with the body. External titles and content remain untrusted data.
- Accepted articles, recommendations, feedback, and saves are restored from the server after a restart.

## Discuss in Chat {#discuss-in-chat}

Tap 「讨论」 (Discuss) in the fixed bottom action bar of article details. The server reads the original and writes it to the news feature's bound agent, then the client opens that chat. It does not invoke the model or ask a question on your behalf. The message shows 「来自新闻」 (From news); continue asking questions or explicitly request reactions/comments saved back to news. Reading does not push every article into chat.

The default interaction agent is main. Check or change it in the News Agent Settings → 「新闻设置」. RSS and news preferences also belong to news, not the currently selected chat. If submission times out or disconnects, inspect the receiving chat, return to the article, then tap 「已核对，恢复操作」 (Checked, resume) and confirm. Operations unlock only after the chat can be read successfully; the previous discussion is never resent. Resetting an agent retains the binding, and future discussions use its new session.

## Managing RSS Sources {#sources}

1. Open 「更多」 (More) → 「来源与状态」 (Sources and status) at the top of the reading list, or open 「RSS 来源管理」 from news settings. Existing subscriptions appear first, followed by collection and analysis status; the fixed header returns to the actual entry point. Tap 「添加来源」 to expand the form, then enter a public HTTP(S) RSS2 URL and optional title.
2. Expand 「推荐中文来源」 in the add form, then choose 「填入」 (Fill) to populate it. Review the URL and title, then tap 「添加来源」 (Add source) to submit, or enter them manually. Examples include 少数派, 36氪, 机器之心, and IT之家; availability depends on each website. Only RSS2 is supported, not Atom.
3. Collapsing the form or leaving the page retains input within the current connection. Reopen it to continue. If creation has an uncertain result, the form stays visible; explicitly read back, review, and unlock before another attempt. The server fetches and validates the XML when the source is added. URLs containing embedded credentials are rejected.
4. The Sources page shows fetch time, pending analysis, and analysis failures. Each source shows its latest fetch time and controlled error. If one source is malformed or temporarily unavailable, other sources and existing articles remain usable.
5. Deleting a source stops future collection only. Accepted articles, comments, reactions, and saves are retained.

The server collects every 30 minutes by default; background collection only fetches new items and does not automatically requeue articles already known to have failed. Manual refresh completes RSS collection and returns the number of new articles; article analysis continues in the background. Refresh does not wait for the complete model run and does not automatically resend an unknown result. If an item lacks a title or readable body, the whole source records a controlled parse error instead of being silently treated as empty.

## Feedback and Recommendations {#feedback}

- Every article directly shows Like, Dislike, and Save. The action group is right-aligned in list rows and the fixed detail footer, and may wrap on narrow screens. No long-press menu is needed.
- Like and dislike are mutually exclusive. Selecting the active reaction again clears it. Saving is independent and toggles off on another tap. Disliking does not immediately remove the current item.
- Icons, labels, and themed backgrounds distinguish selected states. A write temporarily locks other feedback on the same article. An uncertain outcome requires explicit readback, review, and unlock; it is never resent automatically.
- The reader no longer displays comment lists, inputs, or badges. Existing server-side comments are retained rather than deleted by the UI change.
- Feedback does not immediately invoke the model. The next background analysis reads recent articles, feedback, comments, and saves as local evidence; saves are a weaker signal.
- Explicit preferences are saved by the user. Learned notes are a summary updated by the server from feedback. They are stored separately, and learned notes never overwrite explicit preferences, agent rules, or the global user profile.
- For newly initialized News Agents, the default rules require recommendation reasons and learned notes in concise Simplified Chinese. RSS titles and content remain in their original language and are not translated.

Open the News Agent Settings → 「新闻设置」 and save explicit notes under 「新闻偏好」. Use 「RSS 来源管理」 to manage subscriptions. When opened from settings, Back returns through news settings and Agent Settings, then to the originating chat, news reader, notification discussion, or Agent Management, never a different origin.

Unsaved preference drafts remain only in memory for the current connection. Visiting RSS, another member, or chat and returning, or returning from the background, preserves input. Reopening or foregrounding checks server state but only updates unchanged notes. Failed reads retain the draft and previously loaded preferences. 「刷新核对」 also preserves unsaved input. If a save outcome is unknown, reopening does not unlock saving: explicitly check state before saving again; nothing is automatically resent. Only 「保存偏好」 submits explicit notes; saving an empty field clears them. Switching connections or restarting the app does not restore unsaved drafts.

## Refresh and Failures {#refresh}

- 「抓取新文章」 (Fetch new articles) under the reading list's More menu starts one fetch. If reading the article list fails, a separate 「Retry list」 action rereads the list and status without fetching again. A manual fetch returns a conflict when one is already running; fetches are neither queued nor run concurrently.
- When the outcome of a fetch write is unknown, reread and check the status before explicitly unlocking it. The client does not resend automatically.
- Collection failures appear as controlled errors in news status or the source list. A malformed source is not silently treated as empty.
- When model analysis fails, the all-articles timeline remains readable. The recommended view contains only confirmed successful results.
- Another manual refresh can requeue articles already known to have failed. A running batch is not reordered.
- While the news page is in the foreground and status says processing, it may briefly reread status and lists, then stop at a terminal state. News adds no new SSE or global polling.

## Boundaries {#boundaries}

News does not fetch full web pages, provide search or vector recommendations, send system notifications, or support OPML. The chat `feature` tool only reads and records feedback through an existing verified source; it does not browse all feature data. News is a member with private chat, files, and rules. It can receive notifications and configure skills and Dream like other Agents; built-in Agents cannot be deleted. Chatting does not enable RSS processing.
