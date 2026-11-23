Inspect and configure Pi Muse's registered background domain agents (such as sms and news).
Actions:
- list: view all registered domain agents, whether each is enabled, and capabilities.
- get_instructions: read a domain's explicit user instructions (`instructions`), consolidated user habits (`habits`), unconsolidated feedback count, and recent unconsolidated feedback examples.
- update_instructions: update a domain's explicit user instructions (`instructions`). Always call `get_instructions` first, concisely merge new user preferences without losing existing instructions (and preserve any existing top-of-file YAML frontmatter `include:` unless asked to modify it), and submit the complete instruction file for user approval. Note: domain `INSTRUCTIONS.md` supports top-of-file YAML frontmatter `include:` referencing relative UTF-8 text files inside `workspace/`, expanded automatically at model runtime while missing files are ignored.
- query: read-only inspection of domain items, articles, sources, or runs via `queryAction` (`overview` | `items` | `item` | `runs` | `run`).
