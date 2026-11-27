# Specialized Subagents

Pi Muse has one main assistant for everyday conversation, backed by a set of **specialized subagents**. Each subagent encapsulates its own prompts, tools, and rules, and can be invoked by background triggers, routed automatically from main chat, or both.

## Built-in Subagents {#builtin-subagents}

| Name | ID | Triggers | Responsibility |
| --- | --- | --- | --- |
| **SMS Assistant** | `sms` | Chat routing + Background | Screens incoming SMS (default-silent, notifying only for pickup codes, bills, travel, or security alerts), generates archive briefings, and handles SMS queries and `subagents/sms/AGENTS.md` updates from chat |
| **Browser Assistant** | `browser` | Chat routing | Operates the shared real GUI Chrome in an isolated context for multi-step browsing and extraction, requesting manual handoff at `/browser` on login or CAPTCHA gates |
| **Habits Consolidator** | `habits` | Background only | Periodically distills long-term user habits from likes, dislikes, bookmarks, and comments on SMS |
| **Dream Consolidator** | `dream` | Background only | Periodically reviews incremental main-chat messages and proposes long-term memory and profile updates for review |

## How They Work {#how-they-work}

- **Stateless across invocations**: Every subagent runs inside an isolated in-memory session per call with no shared conversation history and creates no session directory. Once finished, it returns a concise result to the main assistant or writes structured outputs to its domain store.
- **Automatic routing**: Just speak naturally in chat (e.g., ask about recent pickup codes, or browse a webpage). The main assistant routes the task to the matching subagent based on its declared capabilities and routing hint.
- **Approval-gated rule edits**: When you ask to change SMS filtering rules in chat, the corresponding subagent reads and merges the existing file, then submits the full diff for your explicit approval before saving.

## Output Channels & Chat Visibility {#output-and-visibility}

Each feature decides where its output belongs:
- **Dedicated views**: The full raw SMS list stays in its own page without cluttering main chat; bring specific items into chat whenever you want to discuss them.
- **Main chat notifications**: Important SMS alerts and archive briefings are posted directly into the main chat window. **All notifications posted into the main chat window are directly visible to the main assistant**, so you can follow up or adjust rules naturally right underneath them.

## Inspecting and Managing Subagents {#inspect-subagents}

The server exposes all registered subagents via `GET /api/subagents`, `GET /api/subagents/:id`, `PATCH /api/subagents/:id`, and `GET/PUT /api/subagents/:id/mcp`, allowing clients to display and manage:
- Identity, trigger modes (`chat` / `background`), unified enabled toggle (`PATCH /api/subagents/:id` governs both chat routing and background schedulers; `sms` defaults to off and auto-enables when SMS sync or SMS upload begins), and self-maintained `routingHint`
- Full built-in system prompts, bound tools, skills, and opt-in MCP bindings
- Linked user instruction files (`AGENTS.md`), `include:` diagnostics, and consolidated habits

To edit explicit SMS rules, use Settings, Workspace Files (`subagents/sms/AGENTS.md`), or ask the assistant in chat to propose an approved update.
