# Pi Muse Manual

This manual introduces installation, connection, daily use, and security boundaries for the Pi Muse server and clients. It is checked against the current repository source; current source does not automatically equal a released package. Check your client build's actual release notes for its supported capabilities.

## Where to Start {#where-to-start}

- [Quick Start](getting-started.md): install the server, connect the phone, send a message, and receive a reply.
- [Conversations and sessions](conversations-and-agents.md): send and stop conversations, switch sessions, reset chat history, and delete sessions.
- [Instructions and prompts](instructions.md): three-layer prompt structure, the five managed workspace documents, and top-of-file Frontmatter `include:` splitting.
- [News reading](news.md): manage RSS sources, browse recommended and all timelines, and use per-article feedback.
- [Attachments, files, and approvals](files-and-approvals.md): distinguish message attachments, workspace files, and model file-write approvals.
- [Tasks and webpage monitors](tasks-and-monitors.md): manage scheduled jobs and webpage monitors through chat tools, and review activity records.
- [Goals and milestones](goals.md): the concept of long-term goals, model-context injection, and chat-based management, distinguished from scheduled execution.
- [Memory and Dream](memory-and-dream.md): manage long-term memory, configure consolidation, and review pending suggestions.
- [Profile and settings](profile-and-settings.md): edit assistant and user profiles, choose a theme, and manage connections, browser access, and app updates.
- [Core Capabilities](usage.md): overview of tasks, goals, memory, browser, and data boundaries.
- [Configuration](configuration.md): look up server configuration fields and the data directory.
- [Real Browser](browser.md): operate the headed GUI Chrome across mobile/desktop `/browser` and slim Docker deployment.
- [Development](development.md): local documentation site, business development, and API documentation entry points.
- [FAQ](troubleshooting.md): diagnose connections, AccessKeys, models, attachments, and approvals.

The repository's `web/` directory is used for HTTP/SSE integration testing; the primary product client is a separate mobile app. For API integration, use the running server's `/docs` and `/openapi.json` as the authoritative references.
