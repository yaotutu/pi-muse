# Specialized Subagents

Pi Muse has one main assistant for everyday conversation, backed by a set of **specialized subagents**. Each subagent encapsulates its own prompts, tools, and rules, and can be invoked by background triggers, routed automatically from main chat, or both.

## Built-in Subagents {#builtin-subagents}

| Name | ID | Triggers | Responsibility |
| --- | --- | --- | --- |
| **SMS Assistant** | `sms` | Chat routing + Background | Screens incoming SMS (default-silent, notifying only for pickup codes, bills, travel, or security alerts), generates archive briefings, and handles SMS queries and `subagents/sms/INSTRUCTIONS.md` updates from chat |
| **News Assistant** | `news` | Chat routing + Background | Screens RSS articles in the background, and handles news source/article queries and `subagents/news/INSTRUCTIONS.md` preference updates from chat |
| **Browser Assistant** | `browser` | Chat routing | Operates the shared real GUI Chrome in an isolated context for multi-step browsing and extraction, requesting manual handoff at `/browser` on login or CAPTCHA gates |
| **Habits Consolidator** | `habits` | Background only | Periodically distills long-term user habits from likes, dislikes, bookmarks, and comments on SMS and News |
| **Dream Consolidator** | `dream` | Background only | Periodically reviews incremental main-chat messages and proposes long-term memory and profile updates for review |

## How They Work {#how-they-work}

- **Stateless across invocations**: Every subagent runs inside an isolated in-memory session per call with no shared conversation history and creates no session directory. Once finished, it returns a concise result to the main assistant or writes structured outputs to its domain store.
- **Automatic routing**: Just speak naturally in chat (e.g., ask about recent pickup codes, adjust news topics, or browse a webpage). The main assistant routes the task to the matching subagent based on its declared capabilities and routing hint.
- **Approval-gated rule edits**: When you ask to change SMS or News filtering rules in chat, the corresponding subagent reads and merges the existing file, then submits the full diff for your explicit approval before saving.

## Output Channels & Chat Visibility {#output-and-visibility}

Each feature decides where its output belongs:
- **Dedicated views**: High-volume feeds such as News articles and the full raw SMS list stay in their own pages without cluttering main chat; bring specific items into chat whenever you want to discuss them.
- **Main chat notifications**: Important SMS alerts and archive briefings are posted directly into the main chat window. **All notifications posted into the main chat window are directly visible to the main assistant**, so you can follow up or adjust rules naturally right underneath them.

## Inspecting Subagent Configurations {#inspect-subagents}

The server exposes all registered subagents read-only via `GET /api/subagents` and `GET /api/subagents/:id`, allowing clients to display:
- Identity, trigger modes (`chat` / `background`), enabled status, and self-maintained `routingHint`
- Full built-in system prompts, bound tools, skills, and MCP bindings
- Linked user instruction files (`INSTRUCTIONS.md`), `include:` diagnostics, and consolidated habits

To edit explicit SMS or News rules, use Settings, Workspace Files (`subagents/sms/INSTRUCTIONS.md`, `subagents/news/INSTRUCTIONS.md`), or ask the assistant in chat to propose an approved update.
