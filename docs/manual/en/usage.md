# Core Capabilities

This page keeps only capability entry points. Detailed procedures live in their dedicated guides so the same workflow is not maintained twice.

## Conversations and Sessions {#conversations-and-agents}

The mobile app has three primary tabs: Messages, News, and Settings. Messages opens the permanent main chat directly, without a session picker. The server retains topic-session foundations with separate histories, instructions, and skill overrides, but the app currently exposes only main. All sessions share one flat workspace. Main supports streaming replies, Stop, and reset; see [Conversations](conversations-and-agents.md). Current source capabilities do not mean the installed APK has been updated; check its Release.

## Attachments, Files, and Approvals {#files-and-approvals}

Message attachments enter model context with chat history; workspace files are persistent server files; every model-initiated `write` or `edit` requires separate human approval. For their entry points, limits, and dangerous operations, see [Attachments, files, and approvals](files-and-approvals.md).

## Tasks, Goals, and Memory {#tasks-goals-and-memory}

- [News reading](news.md): RSS source management, recommended and all timelines, per-article feedback, and saves.
- [Tasks and webpage monitors](tasks-and-monitors.md): create jobs and monitors through chat and manage them in Settings; main-chat actions provide activity history.
- [Goals and milestones](goals.md): manage long-term goals and milestones in Settings → Goals or through chat, separately from scheduled task execution.
- [Memory and Dream](memory-and-dream.md): long-term memory search and management, plus separately configured consolidation.

## Profile and Settings {#profile-and-settings}

For editing assistant identity, persona, and user profile, as well as local theme and companion selection, connection maintenance, browser access, and Android app updates, see [Profile and settings](profile-and-settings.md).

## Browser {#browser}

The server provides a real graphical browser capability, with enabling and access scope controlled by configuration. For Docker and noVNC deployment, see [the browser guide](browser-docker.md). Settings → Browser opens the same server-side Chrome in a native WebView, using a one-time same-origin ticket obtained through the current connection rather than a separate desktop address or password. See [Profile and settings](profile-and-settings.md) for the entry point.

## Data and Network {#data-and-network}

The server instance directory stores plaintext conversations, memory, and credentials, so protect the directory and backups. Model requests send the content required by the current task to the configured external model service. HTTP can be used to connect, but it does not encrypt the AccessKey, Token, or conversation content. For more settings, see [Configuration](configuration.md).
