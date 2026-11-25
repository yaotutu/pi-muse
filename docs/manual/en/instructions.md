# Instructions and prompts

Pi Muse assembles model context in a unified three-layer structure: repository-managed system prompts enforce consistent behavior and safety boundaries, your workspace instructions and profile documents act as the highest user authority, and each turn supplies the active input or untrusted batch data. This page describes current server source behavior; check your installed mobile Release for exact client UI.

## Three-Layer Prompt Structure {#three-layers}

For every model request, the server assembles three layers in order:

1. **System prompts (read-only, shipped with source)**: English templates stored centrally in the server repository under `prompts/` for reliable tool calling and cross-task consistency. By default, they direct the model to produce user-facing text (such as summaries, reasons, and notifications) in Simplified Chinese unless your instructions request another language. The server reads them from the repository (or the built `dist/prompts/` output) with **no** runtime data-directory overrides.
2. **User instructions and consolidated habits**: Markdown files you maintain inside the workspace (highest user authority), plus structured long-term behavioral habits maintained for SMS and News by the shared habit consolidation engine (and manually editable by you).
3. **Current turn input**: in chat, your message, conversation history, and on-demand recalled memories; in SMS or News background runs, recent unconsolidated feedback examples from the hot buffer plus raw items wrapped inside an explicit `UNTRUSTED INPUT DATA` boundary to defend against prompt injection.

## Five Managed Workspace Documents {#managed-files}

All persistent persona and instruction files live under the single instance workspace `DATA_DIR/workspace/`:

| File path (relative to `workspace/`) | Scope | Main edit entry points | Timing and limits |
| --- | --- | --- | --- |
| `assistant/AGENTS.md` | Shared assistant rules across all chat sessions | Settings → Assistant instructions; Workspace files; chat `instructions` tool (approval required) | Next chat turn; 20,000 chars per file; empty string clears |
| `assistant/SOUL.md` | Assistant persona, tone, and working style | Settings → Identity & Profile; Workspace files; model `write` / `edit` (approval required) | Next chat turn; 20,000 chars per file; empty string clears |
| `assistant/USER.md` | Your background, naming preference, and context | Settings → Identity & Profile; Workspace files; model `write` / `edit` (approval required) | Next chat turn; 20,000 chars per file; empty string clears |
| `subagents/sms/AGENTS.md` | SMS/information filtering and notification rules | Settings → SMS preferences; Workspace files; chat `subagent` tool (approval required) | Next SMS analysis batch; 20,000 chars per file |
| `subagents/news/AGENTS.md` | News RSS recommendation and filter rules | Settings → News preferences; Workspace files; chat `subagent` tool (approval required) | Next news screening batch; 20,000 chars per file |

Every document follows **last successful save wins**. News and SMS background pipelines never load chat skills, `assistant/AGENTS.md`, or global `memory.md`; the main chat collaborates with them explicitly via the unified `subagent` tool.

On a brand-new workspace, the server also seeds a one-time `workspace/assistant/BOOTSTRAP.md` onboarding guide (injected into main chat only while both `SOUL.md` and `USER.md` are empty, guiding a short 1-2 turn conversation to establish your assistant's persona and your preferences). As soon as either `SOUL.md` or `USER.md` is saved with content—or if you delete `BOOTSTRAP.md`—it automatically retires and is never recreated on subsequent restarts.

## Splitting Files with Top-of-File Frontmatter {#frontmatter-include}

When an instruction or profile document grows complex, you do not have to keep everything inside one file. All **five** managed workspace Markdown documents support standard YAML Frontmatter `include:` at the **very top of the file** to pull in other plain-text files inside `workspace/`.

```markdown
---
include:
  - ./bank.md
  - ./delivery-rules.md
  - ../../files/vip-contacts.md
---

Keep all other messages silent by default.
```

Both single-string and inline-array syntax are also supported:

```markdown
---
include: ./bank.md
---
```

```markdown
---
include: [./bank.md, ./delivery-rules.md]
---
```

### Resolution Rules and Boundaries {#include-rules}

- **Must be at the very top**: expansion runs only when the file starts immediately with YAML Frontmatter containing an `include` key. Mid-document `---` horizontal rules, frontmatter without an `include` key (for example `title:` only), or malformed YAML are preserved verbatim without expansion.
- **Relative path base**: each path resolves relative to the **directory containing the current file**, including UTF-8 filenames (for example `./快递规则.md`). To share common lists such as `files/vip-contacts.md` across assistant and domain instructions, use relative `..` segments within `workspace/`.
- **Supported scope and strict exclusions**: all five managed workspace documents and any included child files can use `include:`. Consolidated or manual habit entries and raw SMS/news item payloads are **never** parsed for `include:`, preventing model output or untrusted input from reading other workspace files.
- **Workspace security boundary**: targets must resolve inside `workspace/` and be regular UTF-8 plain-text files without NUL bytes. Absolute paths, backslashes, `..` escaping outside `workspace/`, symlinks, directories, and binary files are skipped.
- **Depth, deduplication, and size cap**: nested includes are expanded up to `5` levels deep; self-cycles, mutual cycles, and diamond duplicates within a resolution pass are deduplicated automatically so each file is expanded at most once; the total expanded text is capped at `60,000` characters (appending `<!-- include truncated: resolved character limit reached -->` if exceeded).
- **Source markers**: each non-empty included file is wrapped in `<!-- begin include: <workspace-relative-path> -->` and `<!-- end include: <workspace-relative-path> -->` so the model knows which sub-file each section came from.

### Storage vs. Runtime Expansion {#include-storage-behavior}

- **Reads and saves always preserve raw text and return diagnostics**: HTTP endpoints (`/api/assistant/instructions`, `/api/profile`, `/api/information/preferences`, `/api/news/preferences`), the Workspace Files editor, and assistant read tools always return and save the raw Markdown including top-of-file `include:` frontmatter without writing expanded text back over your source file. In addition, `/api/assistant/instructions`, `/api/information/preferences`, and `/api/news/preferences` expose an `includes` diagnostics array reporting each resolved target's status (`loaded`, `missing`, `invalid`, `cycle`, `depth_exceeded`, `truncated`, `empty`) and workspace path.
- **Expanded dynamically before model calls**: each chat turn, SMS run, news screening batch, and Dream consolidation expands includes dynamically. Editing a child file takes effect on the next model call without re-saving the parent file.
- **Missing or invalid targets never block execution**: missing files, out-of-workspace paths, symlinks, and non-text targets are recorded in `includes` diagnostics and skipped during prompt assembly while keeping all valid instructions active.
- **Dream compatibility**: Dream reads expanded documents when deduplicating proposals, and appends approved pending suggestions to the end of raw `USER.md`, `SOUL.md`, or `AGENTS.md` files without flattening top-of-file frontmatter.

## SMS and News Domain Rules {#sms-and-news-domains}

### SMS Default-Silent Baseline and Four-Tier Precedence {#sms-precedence}

SMS processing is disabled by default. Its system prompt uses a **Default-Silent** baseline: uncertain messages without an explicit directive default to `silent` (promotions, carrier marketing, routine completed login OTPs, ordinary mid-transit shipping updates), while actionable alerts default to `notify` (pickup codes/delivery exceptions, unusual financial alerts, account security warnings, itinerary changes). Decisions follow strict precedence from highest to lowest:

1. **Your explicit instructions**: `workspace/subagents/sms/AGENTS.md` (highest authority).
2. **Recent unconsolidated feedback**: likes, dislikes, saves, and comments you left on recent SMS notifications in `main` chat (held in a hot buffer until consolidated into long-term habits).
3. **Consolidated user habits**: durable rules distilled incrementally by the cursor-driven habit engine (or added/edited manually by you) in `main.sqlite`, preserving early preferences even beyond the buffer window.
4. **Default-Silent baseline**: conservative fallback filter when higher tiers give no directive.

The SMS pipeline keeps two isolated channels sharing these preferences: daily realtime single-cycle processing (`realtime`, posting `notify` results only to `main` chat and staying quiet when all items are silent), and bulk historical archive processing (`archive`, incrementally submitting habit updates across batches without per-batch notifications and emitting at most one `<= 1,200`-character Chinese briefing once the archive queue drains). If an individual message is rejected by the upstream model's content safety review, it is automatically isolated on its own instead of failing the whole batch, and the archive briefing is still delivered while naturally noting how many messages were skipped.

### News Independent Screening and Feedback {#news-screening}

News collection uses `news.sqlite` independently and screens articles using `subagents/news/AGENTS.md`, consolidated habits, and unconsolidated per-article likes, dislikes, saves, and comments. Recommendations and reasons appear only inside News and never post chat notifications; see [News reading](news.md).

## Editing Methods and Security Boundaries {#editing-and-boundaries}

1. **Edit in Settings or Workspace Files**: update root files directly in Settings, or edit split child files in Workspace Files (see [Attachments, files, and approvals](files-and-approvals.md#manage-workspace-files), reviewing the full before/after preview before saving).
2. **Ask the assistant in chat**: ask the main assistant to inspect or propose updates via `instructions` or `subagent` (all model file writes still require version-bound human approval).

::: warning Security and privacy boundaries
- Custom instructions, profiles, skill switches, and expanded `include:` files never grant additional tools, loosen the `workspace/` path boundary, or bypass human `write` / `edit` approval (see [Attachments, files, and approvals](files-and-approvals.md)).
- Resolved instructions and profiles are sent to the configured external model provider; never place passwords, model API keys, AccessKeys, or secrets inside them.
:::

## Troubleshooting {#troubleshooting}

| Symptom | What to check | Action |
| --- | --- | --- |
| Editing a child file does not show expanded content in Settings GET | Expected behavior | Read/write APIs always preserve raw source text; run a new chat turn or screening batch to confirm the model follows the updated child file |
| Top `include:` text appears literally without expanding | Whether frontmatter is at the very top of the file and uses valid YAML with key `include` | Ensure nothing precedes the opening `---` (no blank lines or text before it) and YAML syntax is valid |
| One included file was ignored | Whether the file exists inside `workspace/`, has no symlinks, is valid UTF-8 text, and is within depth 5 | Verify the relative path from the parent file's directory in Workspace Files and ensure it is a non-empty regular text file |
| Truncation comment `resolved character limit reached` appears | Whether total expanded size exceeded `60,000` characters | Trim verbose rules or move reference-only material to files opened on demand via file tools |
| Cannot create a new child file with non-ASCII name in the UI | Workspace text-file creation path validation | Use ASCII filenames when creating files from the manual workspace UI; existing UTF-8 filenames can still be referenced by `include:` |
