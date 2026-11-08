# News reading

News is a global RSS collection and recommendation service, not a separate chat identity. Reading, sources and article feedback survive session reset/deletion. This page describes server semantics; native pages and real-model paths still require coordinated acceptance. Check the installed version.

## Reading and filtering {#reading}

Read all articles or successful model recommendations and optionally filter saved items. Ordering is descending publication time and stable id; missing/invalid publication dates use acceptance time. Cursors bind the filters, so restart pagination when filters change.

Details show sanitized text, source and recommendation reason. Titles, content and links are untrusted external data, not permission or user instructions. Model failures do not fabricate recommendations; the full timeline remains readable.

## Discuss in chat {#discuss-in-chat}

Use the existing current session by explicitly submitting an article reference and your question. No news-specific chat or separate discussion is created. Reading does not start chat or inject every article.

Synchronize current history before resending a reference with an unknown outcome. Article feedback is not an execution instruction; explicitly request actions in chat.

## Managing RSS sources {#sources}

Add a public HTTP(S) RSS2 URL and optional title. Addition actually fetches and validates XML. Credential-bearing URLs and Atom are not supported. DNS, SSRF, fixed-IP, per-hop redirect, size, depth, item-count, timeout and cancellation boundaries remain. DTD/entities, malformed XML and missing titles/readable content produce controlled errors instead of silently becoming empty sources.

Collection defaults to every 30 minutes. One source's failure does not block others. Removing a source stops future collection but keeps accepted articles, feedback and saves. Read back source lists before retrying unknown additions/deletions.

## Feedback and recommendations {#feedback}

Like/dislike are mutually exclusive and removable. Saved state is independent; the server also supports bounded comments. Feedback does not immediately call a model. Later batches read bounded recent examples; saves are weaker signals. A single reaction does not become a permanent rule.

Explicit preferences come from main INSTRUCTIONS.md. Saving news preferences and editing main instructions replace the same full text; the last successful save wins. Inspect the complete content rather than assuming a news-only append. Learned summaries remain separate and do not overwrite explicit instructions or USER.

Reasons and learned summaries default to concise Simplified Chinese while RSS titles/content retain their original language. Read back unknown writes instead of automatically resending. Client draft behavior depends on the adapted version.

## Refresh and failures {#refresh}

Manual refresh waits for collection and returns the added count, not model completion. Only one refresh runs at a time. Scheduled collection does not requeue failed articles; explicit refresh may requeue failures outside an active batch. Model failures are not automatically retried and active batches are not requeued.

Read status, sources and articles after an unknown collection result. A failed list read should only repeat the read, not automatically refresh sources. Controlled errors omit credentials and internal diagnostics.

## Boundaries {#boundaries}

News has no separate instructions, workspace, session, Dream or delivery binding. Recommendations do not generate chat system notifications or add a global polling/notification stream. Discussing an article does not change workspace, tool or approval boundaries.
