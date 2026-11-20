# News reading

News is a global RSS collection and recommendation service, not a separate chat identity. Reading, sources and article feedback survive main chat reset. This page describes the current source; check the installed version for the actual controls.

## Reading and filtering {#reading}

Read all articles or successful model recommendations and optionally filter saved items. Ordering is descending publication time and stable id; missing/invalid publication dates use acceptance time. Cursors bind the filters, so restart pagination when filters change.

Details show sanitized text, source and recommendation reason. Titles, content and links are untrusted external data, not permission or user instructions. Model failures do not fabricate recommendations; the full timeline remains readable.

## Discuss in chat {#discuss-in-chat}

Tap Discuss to return directly to main chat in Messages, appending an explicitly untrusted article reference to the existing draft. It is editable, is not sent automatically, and does not open a session picker. You can return to the original article. No news-specific chat or separate discussion is created; reading alone neither starts chat nor injects all articles into main.

Synchronize current history before resending a reference with an unknown outcome. Article feedback is not an execution instruction; explicitly request actions in chat.

## Managing RSS sources {#sources}

Add a public HTTP(S) RSS2 URL and optional title. Addition actually fetches and validates XML. Credential-bearing URLs and Atom are not supported. DNS, SSRF, fixed-IP, per-hop redirect, size, depth, item-count, timeout and cancellation boundaries remain. The final HTTP response must be successful. DTD/entities, malformed XML or a missing feed title produce controlled errors instead of silently becoming empty sources.

Items without an article title or stable identity (guid or a valid article link) are skipped. If more than half the items are invalid, parsing fails for the whole source on that attempt. Items with a title and stable identity but no body are retained, using the title as minimal content; this does not mean the full article was fetched. Adding a source only validates it, does not ingest articles, and returns the skipped-item count.

Duplicate checking removes fragments, normalizes scheme/host case and removes default ports. A duplicate error names the existing source ID; redirect destinations are not merged. Controlled fetch/parse categories distinguish network errors, private-target blocking, timeouts, HTTP status and parsing issues. Source lists keep an error message and optional details; legacy error categories are not inferred. Consult the server's generated API documentation for the exact fields.

Collection defaults to every 30 minutes. One source's failure does not block others. Removing a source stops future collection but keeps accepted articles, feedback and saves. Read back source lists before retrying unknown additions/deletions.

## Feedback and recommendations {#feedback}

Like/dislike are mutually exclusive and removable. Saved state is independent; the server also supports bounded comments. Feedback does not immediately call a model. Later batches read bounded recent examples; saves are weaker signals. A single reaction does not become a permanent rule.

Explicit preferences (`notes`) are stored independently in `news.sqlite` without modifying main `INSTRUCTIONS.md` or global profile files. You can replace the full text in Settings → News Preferences (last successful save wins) or ask the assistant in main chat to update them. The model-inferred profile (`learnedNotes`) remains separate and read-only, without overwriting explicit rules, chat instructions, or USER. In News Preferences, expand the learned interests section to see what the assistant has learned.

Reasons and learned summaries default to concise Simplified Chinese while RSS titles/content retain their original language. Read back unknown writes instead of automatically resending. Client draft behavior depends on the adapted version.

## Refresh and failures {#refresh}

Manual refresh waits for collection and returns added and skipped counts, not model completion. Only one refresh runs at a time. Scheduled collection does not requeue failed articles; explicit refresh may requeue failures outside an active batch. When a news model run is active, the refresh result has `resetDeferred=true`: failed items remain unchanged and are not automatically retried when the batch finishes. A value of `false` does not mean model analysis is complete. Model failures are not automatically retried.

Refresh can still return a successful response when one or all sources fail, so HTTP success alone does not establish source health; read source errors and categories. API callers must send a valid JSON empty object `{}`. Empty bodies, malformed JSON and extra fields are rejected without collection or failed-item reset.

Read status, sources and articles after an unknown collection result. A failed list read should only repeat the read, not automatically refresh sources. Controlled errors omit credentials and internal diagnostics.

## Storage {#storage}

Sources, articles, reactions, saves, comments, analysis batches, recommendations and learned summaries are stored in the server's separate `news.sqlite`, rather than rewriting a complete news JSON document at runtime. It is separate from the default `main.sqlite`; this does not mean memory, tasks or other modules have already migrated. Chat history remains managed by pi and is unchanged by this news-storage update.

The news API and the agent's [database tool](database.md) operate on the same news data. The agent can query, modify, extend schemas or drop tables without per-SQL approval. Breaking built-in table structures can make news unavailable; the system does not silently rebuild an empty database. Database operations do not automatically recompute previous recommendations or rerun a model.

Existing news JSON requires explicit import and cutover; startup does not automatically convert or delete it. Use a consistent SQLite backup method rather than copying only the main file while writes may still be committed in its WAL.

## Import legacy news {#import}

Operate only on an explicitly authorized instance. First stop its writes and background processing normally and retain a protected backup. Do not import while the old service is still changing news. The target `news.sqlite` and its sidecars must not exist.

From the server repository, replace these paths with the actual instance paths:

```sh
node --import tsx scripts/import-news-sqlite.ts \
  --source /path/to/data/news.json \
  --target /path/to/data/news.sqlite
```

The importer strictly validates the document, preserves IDs, times, order, feedback and analysis facts, verifies a read-back and returns counts. The source stays read-only: it is neither deleted nor rewritten, and runtime news uses SQLite as its only data source. An imported database is accepted only after data and the completion marker commit together. An interrupted import cannot start as empty news.

An existing target is refused; do not overwrite or delete it merely to retry. If import fails or its outcome is unknown, inspect the report, target state and backup before deciding what to do. After verification, start the new service and check health identity, sources, articles and feedback. This cutover does not require resetting chat or rotating the signing key.

## Boundaries {#boundaries}

News maintains its own independent preference rules and learned interest profile without touching main chat instructions, and still has no separate workspace, chat session, Dream state, or chat notification binding. Recommendations do not generate chat system notifications or add a global polling/notification stream. Discussing an article does not change workspace, tool, or approval boundaries.
