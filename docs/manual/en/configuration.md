# pi-muse Configuration

pi-muse reads its startup configuration from exactly one file:

```text
.pi-muse/config.json
```

The file must exist. A missing file, JSON syntax error, unknown field, invalid type, or unknown `schemaVersion` causes startup to fail. The server does not support legacy environment-variable configuration or `${ENV_NAME}` interpolation. The model API key is written directly in `model.apiKey`. `API_TARGET` for the repository's own `web/` is used only by Vite's `/api` proxy and is not a server configuration source.

## Create the Configuration {#create-configuration}

~~~sh
mkdir -p .pi-muse
cp -n config.example.json .pi-muse/config.json
chmod 600 .pi-muse/config.json
~~~

Then edit it:

~~~json
{
  "schemaVersion": 1,
  "server": {
    "host": "0.0.0.0",
    "port": 12330,
    "accessKey": "",
    "allowedOrigins": [
      "http://localhost:15173",
      "http://127.0.0.1:15173"
    ]
  },
  "model": {
    "baseUrl": "http://127.0.0.1:8000/v1",
    "id": "my-model",
    "apiKey": "paste-model-api-key-here",
    "contextWindow": 128000,
    "maxTokens": 16384
  },
  "runtime": {
    "runTimeoutMs": 600000,
    "schedulerIntervalMs": 30000
  },
  "tools": {
    "writable": {
      "enabled": true,
      "actionTimeoutMs": 86400000
    },
    "web": {
      "enabled": true
    },
    "weather": {
      "enabled": true,
      "defaultCity": "上海"
    },
    "browser": {
      "enabled": true,
      "allowPrivateTargets": false
    },
    "presentation": {
      "default": "hidden",
      "overrides": {
        "currentTime": "summary",
        "get_weather": "summary",
        "search_web": "summary",
        "memory": "summary",
        "schedule": "summary"
      }
    }
  }
}
~~~

Every section and field may be omitted as needed; omitted values use built-in defaults. `schemaVersion` is currently `1`.

## Field Reference {#field-reference}

| Field | Default | Description |
| --- | --- | --- |
| `server.host` | `0.0.0.0` | By default, listens on all network interfaces for convenient LAN access. A non-loopback host with an empty `server.accessKey` only prints a warning; the user decides whether to add one. |
| `server.port` | `12330` | HTTP listening port. If it is occupied, startup fails directly and reports the occupying PID when `lsof` can determine it, falling back to a generic message where cross-platform lookup is unavailable. Coordinate a restart only after confirming the process belongs to this project's development service; never stop a production or unidentified process on your own. |
| `server.accessKey` | Empty | Service access key; this is not the model key. Leaving it empty prints a security warning for a non-loopback host but does not block startup. |
| `server.allowedOrigins` | Four origins: `localhost` and `127.0.0.1`, each on ports 15173 and 12330 | CORS origin array. Explicit configuration replaces the default list and is used by the repository's own Web UI. |
| `model.baseUrl` | Empty | OpenAI-compatible API root address, for example `/v1`; must be configured together with `model.id`. |
| `model.id` | Empty | The sole business model ID. Image attachments require this model to support vision input; it is not automatically switched or downgraded. |
| `model.apiKey` | Empty | Model API key, written directly in the configuration file. |
| `model.contextWindow` | `128000` | Must be greater than `model.maxTokens`. When left at the default, startup tries to match the model's real window from `/models`; explicit values take precedence. |
| `model.maxTokens` | `16384` | Maximum model output. |
| `runtime.runTimeoutMs` | `600000` | Execution budget for one chat turn, in milliseconds (10 minutes by default). Timing pauses while manual approval is pending and resumes with the remaining budget after all pending approvals finish; it does not receive a fresh full budget, and timeouts settle `SessionStatus.status` as `failed`. Approvals still expire according to their own TTL, explicit Stop cancels immediately, and client disconnection does not cancel server execution. This does not change jobs-trigger timeout semantics. |
| `runtime.schedulerIntervalMs` | `30000` | Scheduled-task scan interval. |
| `runtime.monitorScanIntervalMs` | `60000` | Webpage-monitor scan interval. |
| `runtime.dataDir` | Directory containing the configuration file | Relative paths are resolved against the configuration file's directory. An absolute path is recommended but not required. |
| `tools.writable.enabled` | `true` | Whether to register `write` / `edit` and allow `skills.save`; when enabled, every operation still requires individual manual approval. `skills.list/read` remains available when this is disabled. |
| `tools.writable.actionTimeoutMs` | `86400000` | Validity period for file-operation approval, in milliseconds (default 24 hours, max 7 days); an expired approval cannot commit a modification. |
| `tools.web.enabled` | `true` | Whether to declare `search_web` / `web_fetch` to the model. |
| `tools.web.timeoutMs` | `30000` | Total timeout budget for one web fetch, in milliseconds. It includes up to 6 redirects, with each hop consuming the remaining time. |
| `tools.web.maxResponseBytes` | `2000000` | Maximum size of one response. |
| `tools.web.maxContentChars` | `50000` | Default maximum number of characters returned by `web_fetch`. |
| `tools.web.searchResults` | `5` | Default number of search results; the tool parameter allows at most 10. |
| `tools.web.userAgent` | Browser user agent | User-Agent for web requests. |
| `tools.web.allowPrivateTargets` | `false` | Explicitly relaxes the private-network/loopback target restriction only for local integration work; all other request security boundaries remain unchanged. |
| `tools.weather.enabled` | `true` | Whether to declare `get_weather` to the model. |
| `tools.weather.defaultCity` | Empty | Default city used when the user does not specify one. When empty, the model asks for the city. |
| `tools.browser.enabled` | `true` | Whether to enable the real-browser domain and the unified `browser` tool. |
| `tools.browser.executablePath` | Empty | Path to the system Chrome executable. When omitted, Playwright's `chrome` channel is used. |
| `tools.browser.cdpUrl` | Empty | Optional credential-free HTTP(S)/WS(S) CDP endpoint to attach to an existing real Chrome instance. |
| `tools.browser.allowPrivateTargets` | `false` | Allows loopback and private-network pages only for local integration/testing; the default keeps the public HTTP(S) boundary. |
| `tools.browser.timeoutMs` | `30000` | Timeout for tab navigation and element operations. |
| `tools.presentation.default` | `hidden` | Tool presentation policy for the client's live stream and history projection: `hidden` hides tool calls, while `summary` sends only a controlled summary. |
| `tools.presentation.overrides` | `{}` | Overrides the default policy by tool name. Names follow the explicit registry in `src/adapters/pi/tools/index.ts`: `currentTime`, `database`, `instructions`, `memory`, `memory_search`, `schedule`, `subagent`, `goal`, `monitor`, `read`, `grep`, `find`, `ls`, `write`, `edit`, `skills`, `search_web`, `web_fetch`, `get_weather`, and `browser`. |

By default, the `.pi-muse/` directory containing `.pi-muse/config.json` is also the instance data directory. The current default instance directory is unified as `.pi-muse/`; legacy directories are neither read nor migrated automatically. In other words, sessions, memory, jobs, the workspace, and the configuration file stay in the same instance directory.

`runtime.dataDir: "."` also denotes the configuration file's directory, regardless of the starting process's cwd. If `".pi-muse"` is placed inside `.pi-muse/config.json`, it points to a nested `.pi-muse/` beneath it, not the identically named directory at the project root.

Public session IDs and internal pi IDs are distinct. `main` is permanent, topic sessions are explicit, chat histories are isolated, assistant instructions and skill switches are shared, and the workspace is one global root.

## Instance directory structure {#instance-directory-structure}

```text
DATA_DIR/
  workspace/
    assistant/                      USER.md, SOUL.md, AGENTS.md (fresh workspaces also seed one-time BOOTSTRAP.md)
    subagents/news/AGENTS.md  News recommendation instructions
    subagents/sms/AGENTS.md   SMS alert instructions
    files/                          Ordinary files
  sessions/
    index.json
    <sessionId>/                    history/
  state/
    assistant/                      memory.md, identity.json, skill-overrides.json
    main.sqlite                     Jobs, goals, approvals, SMS state, Dream state, message feedback, shared user habits
    news.sqlite                     News data (articles, feeds, article feedback)
    monitors.json                   Webpage monitors
  assets/                           companions/, skills/
  runtime/                        auth/, pi/, browser/, traces/, android-updates/
```

Workspace Files shows assistant documents, domain instructions, and ordinary files; see [Instructions and prompts](instructions.md). Pull down to refresh the directory, or open the top-right menu to create a text file or jump to another directory. Settings and the workspace editor read and write the same raw Markdown files; the five managed instruction and profile documents also support top-of-file YAML Frontmatter `include:` references expanded dynamically before model calls. Main and topic chats share assistant documents. News and SMS each read their own domain instructions. A delegated subagent holds context for its current run. The layout starts fresh and does not import old instance data.

## Android update mirror

After a successful GitHub release, an empty `POST /updates/android/refresh` requests a sync from the fixed official repository. The request requires neither login nor a secret. The server keeps recent packages under `runtime/android-updates/` and publishes a new manifest after verifying the size and SHA-256 of every APK. A failed sync leaves the previous release available.

Supported Android clients check `/updates/android/latest` on their saved server first and fall back to official GitHub if the mirror or APK validation fails. The mirror can use the existing HTTP address. The package name and signing certificate must match the installed app. For a first installation, use the official HTTPS release page.

## Data Storage and Security Boundaries {#data-storage-and-security-boundaries}

- **Data is stored in plaintext**: conversation history, user profile, memory, workspace, and state files are all plaintext. The instance directory, `auth.key` (the signing key), and every instance backup contain sensitive credentials and personal data. Protect their permissions strictly as sensitive data (`0700`/`0600` is recommended), and never expose or upload them.
- **Access credential validity**: login Tokens are long-lived and survive service restarts. After `server.accessKey` changes and the service restarts with the new configuration, all old Tokens become invalid.
- **Single-process ownership and failure handling**: one process exclusively owns one `DATA_DIR`. If a file is corrupted or its format is invalid, the service reports a clear error and never restores an empty state by silently deleting damaged data. Stop the service and restore offline from a valid backup.

## Skill directories and default switches {#skill-directories}

The server discovers standard `SKILL.md` skills from three sources: the instance-owned `DATA_DIR/assets/skills/`, built-in skills shipped with the server, and the server process user's shared `~/.agents/skills/` directory. The home directory belongs to the user running the server; container deployments must mount the intended shared directory where that user can read it.

Names resolve in the order instance-owned > built-in > shared. The catalog identifies the source and current selection; disabling the winning source never activates a lower-priority namesake. Defaults differ by source: built-in skills follow the `assets/skills-defaults.json` manifest shipped with the server (all nine currently default on and may be adjusted per release), while shared and instance-created skills always default to off until the user manually saves a selection. Newly discovered or created non-built-in skills never enable themselves, and disabled skills are not assembled into a model turn. Manually saved selections always override defaults; selections bind to source identities, so a new source does not inherit another source's switch.

The shared directory is read-only. Pi Muse does not copy or modify its skills or generate private configuration there. Standard skills need no extra `config.json`; historical skill configuration files are left untouched and no longer control default activation. Old name-only choices are ignored. Use Assistant skills to select them again. The server exposes a unified catalog, full instruction details, and selection-saving endpoints; consult the current `/docs` for fields and errors. This does not imply that older clients already display source groups.

In Settings → 助手技能 (Assistant skills), use the switches to choose which skills chat sessions can use, then save your changes. Tap a skill name to view its source and instructions. Shared skills come from the server’s shared directory, are read-only, and are off by default.

After editing switches, tap 保存技能 (Save skills); changes take effect next turn and bind to source identities. When a refreshed catalog selects a different namesake source, the old draft and instructions are not applied to it; select again from the current catalog. Older APKs without these client changes can still use their existing list and switch controls but may not show sources or instructions.

Shared skill-folder entry links are supported by resolving the actual skill root. Internal links, out-of-bound files, and oversized instructions are diagnosed rather than loaded. Shared scripts and `extension.ts` are never executed. Enabling a skill does not enable bash, install dependencies, or expand tool permissions. Ordinary `read` receives only the exact enabled skill instructions and supported text resources, not access to the entire home directory.

These `SKILL.md` skills and shared switches apply only to chat sessions; background domain sub-agents such as SMS, News, and future domains never inject chat skills and rely solely on their domain prompts, independent explicit rule boards, and shared consolidated habits.

## File Write Approvals {#file-write-approvals}

- `write` / `edit` operate only in DATA_DIR/workspace/. Every change needs a complete preview, human approval and file-version binding. Denial, expiry, cancellation or version changes prevent commit. Traversal/symlinks are refused; no bash tool is provided.
- Every operation requires separate manual approval. The approval payload retains the complete before/after text and file version; the text to replace for `edit` must match exactly one location.
- Path safety and file version are checked again before commit. If the file changes while waiting, the old approval cannot authorize an overwrite; the operation and approval must be initiated again.
- Rejection, approval expiration, or cancellation of the run prevents that modification from being committed. A service restart cancels pending approvals left by the previous process. Approval validity is fixed by the `expiresAt` recorded when it is created, and expiry and cancellation state are checked again before commit.
- The `skills` tool takes `action=list|read|save`, `name`, optional `file` (default `SKILL.md`), and the complete `content` required by save. A name may contain only lowercase letters, digits, or single hyphens and is limited to 64 characters. Allowed files are `SKILL.md` and supported UTF-8 text under `references/` or `assets/` with `.md`, `.txt`, `.json`, `.csv`, `.yaml`, or `.yml` extensions; each file is limited to 100KB.
- Use `skills.save` only for an explicit user request. It writes only `DATA_DIR/assets/skills/<name>`; saving a built-in or shared name creates an instance-owned override without changing the original source, and the new source still requires manual activation. A resource can be saved only after a valid instance `SKILL.md` exists. Its approval preview uses `scope=skill`, and path `<name>/<file>`, with the same version binding and pre-commit path, cancellation, expiry, and file-change checks.
- New skills default to off; no skill `config.json` is created or modified. After the user manually enables a skill, its definition, references, and assets take effect on the next model turn—the current turn does not gain new instructions or extension capabilities. Rejection, expiry, Stop, or a file change while waiting writes nothing, and an unknown result is never resent automatically.
- Skill maintenance refuses deletion, directory operations, direct `config.json` edits, scripts/code, binaries, nested `SKILL.md`, absolute paths, traversal, and symlinks. For an enabled skill, ordinary `read` additionally exposes only its `SKILL.md` and supported resource text—not ls/grep/find or neighboring files. Subagents inherit only the parent turn's actual tool and source-identity upper bounds; roles may only narrow them, and each skill write still requires approval.
- Disabling `tools.writable.enabled` removes `write` / `edit` and refuses `skills.save` in a controlled way while retaining `skills.list/read`. Tool presentation policy cannot skip approval or enable write capability that has been disabled.

To create and use a skill:

1. Manually enable `skill-creator` in assistant settings and ensure that the server permits approval-protected file writes; without that skill, the model has no skill-maintenance tool. Selection and instruction-detail endpoints are documented in the server's `/docs`; client controls depend on the installed version.
2. Explicitly tell the assistant which skill to create or revise, for example, "Create a Linux news filtering skill that prioritizes kernel and distribution updates."
3. Inspect the complete approval preview for each skill-file change. Approve only after checking the target and before/after content, then verify the actual write receipt; approval alone does not mean the save succeeded.
4. Manually enable the new instance-owned skill and use it on the next turn. Editing an already enabled skill of the same source also takes effect next turn; creating an override or approving a save does not enable a new source.

## Tool Presentation Policy {#tool-presentation-policy}

Presentation configuration affects the live stream and history projection consumed by the repository's own Web UI. It does not disable tools, change the complete result received by the model, or rewrite pi JSONL. Restart the service after changing the configuration for it to take effect; existing history is re-projected according to the current policy, with no second history store or online migration. File-operation approval is an independent security process and is not skipped merely because a tool card is hidden.

- `hidden`: the live stream does not send that tool's complete `TOOL_CALL_*` group, and history does not return that call or its corresponding tool result. Only ordinary user/assistant text remains.
- `summary`: displays an existing card using the original tool name and stable ID. Parameters are uniformly `{}`, and the result uses a controlled summary. For example, saving memory shows only “Memory saved”（“已保存记忆”） rather than the memory text; reading a file only confirms completion without displaying its content.
- Search summaries retain the source URL/title but remove the snippet and provider diagnostics, as well as the URL query/fragment. A source link that depends on query parameters may therefore not open directly; when the original link is needed, the final reply should provide it. Search failure uses a valid `{error}` and is never misrepresented as “found 0 sources”.
- The example configuration explicitly enables summaries for time, weather, search, memory, and reminders. **When the entire presentation section is omitted, all tools are hidden by default.** Unknown tool names or invalid modes cause startup to fail. Policies can be preconfigured for disabled Web/weather tools, but presentation configuration cannot enable those capabilities.
- This is a presentation choice, not an information-confidentiality boundary: the model can still reference raw results in its final answer, and ordinary assistant text before a call, such as “Let me check,” continues to stream. `summary` still has a card and is not completely silent.

If you want chat to display only assistant text, add this inside the existing `tools` section:

~~~json
"presentation": {
  "default": "hidden",
  "overrides": {}
}
~~~

## Real Browser {#real-browser}

The browser domain uses `playwright-core` to drive a real headed Google Chrome instance (`headless: false`; headless mode is not provided), or attaches to an existing real Chrome via `tools.browser.cdpUrl`. Chrome starts lazily with its persistent profile at `DATA_DIR/runtime/browser/profile/`; the responsive viewer `/browser`, the workbench Browser tab, and the Agent's unified `browser` tool share the same instance and login state. When the server shuts down, WS subscribers disconnect and Chrome closes gracefully. For headless Linux servers, use the slim Docker deployment (`Xvfb + google-chrome-stable + Node` without VNC/noVNC); see [the Real Browser Guide](browser.md).

`/browser` hard-codes no host or port: it calls relative REST APIs and connects same-origin `ws://` or `wss://` on `/ws/browser` with dynamic mobile/desktop viewport switching, touch gestures, pinch-zoom, native IME input bar, and real-time file/handoff pushes, working over both HTTP LAN and HTTPS reverse proxies (forward `/ws/browser` upgrades when behind HTTPS). Clients can authenticate via Bearer-issued `POST /api/browser/viewer-ticket` -> `/browser/launch?ticket=...` (setting an `HttpOnly; SameSite=Strict` cookie scoped only to `/api/browser/*` excluding `viewer-ticket`, then redirecting `303` to `/browser`), silent empty-key boot when `server.accessKey` is empty, or the AccessKey login form (URL `accessKey`/`key` params are stripped immediately). `GET /api/browser/status` reports browser availability, running state, and viewport without triggering a lazy launch.

Only public HTTP(S) is allowed by default; explicitly set `tools.browser.allowPrivateTargets: true` when local test pages must be accessed. This address rule is only a base implementation shared with web tools—the browser domain does not depend on `web_fetch`. The browser never exposes arbitrary JavaScript `evaluate`, cookies, localStorage, or password values to the model; external page titles, text, element names, and screenshots are treated as untrusted data.

## Error Policy {#error-policy}

- The configuration file is required; if it does not exist, there is no environment-variable fallback.
- JSON syntax errors, unknown fields, invalid types, or an unknown `schemaVersion` cause startup to fail.
- `model.baseUrl` and `model.id` must both be empty or both configured.
- `model.baseUrl` accepts only credential-free HTTP(S) URLs without a query or fragment.
- A non-loopback `server.host` should be paired with `server.accessKey`. The current default behavior is only a warning—not a block—when the host is `0.0.0.0` and accessKey is empty.
- The service never creates or rewrites the configuration file automatically, preventing startup paths from unexpectedly overwriting a hand-written configuration.
- Web requests allow only public HTTP(S) by default and block loopback, private, link-local, and reserved addresses; every redirect is validated again. For local integration, explicitly set `tools.web.allowPrivateTargets: true`; this does not change the other request security constraints.

## Keys and File Permissions {#keys-and-file-permissions}

`config.json` may contain both a model key and the workspace access key:

- Do not commit it to Git; `.pi-muse/` is already in gitignore.
- Do not screenshot it or paste its full contents into chat.
- Keep permissions at `0600` where possible.
- The server does not write keys to logs, return them to clients, or write them into pi session files.
- Protect configuration-file backups with the same safeguards as sensitive credentials.

## Mock Configuration {#mock-configuration}

`pnpm dev:mock` does not read `.pi-muse/config.json` and does not call a real model. It explicitly constructs an isolated configuration in `scripts/dev-mock.ts`:

- Listens on `127.0.0.1:17891`
- Uses a fake provider
- Uses `.pi-muse/mock` as its data directory

The mock port and directory do not offer environment-variable overrides. If they must be changed, modify the explicit configuration object in the script directly.
