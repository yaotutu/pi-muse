Inspect and configure Pi Muse's registered background domain agents (such as sms and news).
Actions:
- list: view all registered domain agents, whether each is enabled, and capabilities.
- get_instructions: read a domain's explicit user instructions (`instructions`), learned sensitivity profile (`learnedNotes`), and feedback examples.
- update_instructions: update a domain's explicit user instructions (`instructions`). Always call `get_instructions` first, concisely merge new user preferences without losing existing instructions, and submit the complete instruction file for user approval.
- query: read-only inspection of domain items, articles, sources, or runs via `queryAction` (`overview` | `items` | `item` | `runs` | `run`).
