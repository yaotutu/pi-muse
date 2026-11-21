# Long-term memory and Dream

Memory, SOUL/USER and Dream are global instance resources. Chat text remains session-specific. Assistant instructions and skill switches are shared. This page describes current server semantics; native client and real-model paths still require coordinated acceptance. Check the installed release.

## Prerequisites {#prerequisites}

Connect to an accessible matching server. Browsing/managing memory does not require a model; Dream requires a configured external model.

## Manage long-term memories {#manage-long-term-memories}

Use memory settings to browse, search by keyword, add, edit or delete. The limit is 500 records, each 1–2000 characters. A full store rejects additions rather than discarding records. Search is case-insensitive substring matching.

Memories live as plain text in `profile/memory.md`, one record per line with a stable id, so you can read or edit them directly. Tool edits and deletes still match by id exactly. If the file format is damaged the server reports a clear error instead of treating it as an empty store or silently dropping records.

Deletion is irreversible and affects all sessions without deleting chat. Never store passwords, keys, tokens or other secrets. Read the full store before retrying a write with an unknown outcome. A failed read is not an empty store.

## Memory and profile boundaries {#memory-and-profile-boundaries}

- USER, SOUL, identity and memory are global. SOUL/USER are reread each turn; memory is retrieved on demand rather than injected in full.
- Chat sessions share assistant instructions and skill switches. News and SMS have their own preferences.
- There is one shared workspace root. Shared files do not merge chat histories.
- Feedback itself does not start Dream, a model or training. Information processing may explicitly read bounded current main feedback examples.

## Configure Dream {#configure-dream}

Dream has one global enablement setting and one prompt in profile/DREAM.md. There are no per-session settings, inheritance or supplemental prompts. The prompt limit is 20,000 characters; saving an empty string restores the built-in default. In Settings → Dream, expand the custom instructions section to edit the prompt.

Every two hours the background service scans existing sessions, reads new messages using source cursors and skips busy sessions. Disabling only affects later scans and does not undo writes. Prompts, instructions and skills cannot expand the consolidation tool set.

The model round can only submit structured proposals. It has no file, network, shell, delegation or arbitrary configuration tools. External data is untrusted; credentials, assistant guesses presented as user facts and permission changes must not be stored.

## Run Dream manually {#run-dream-manually}

Save or explicitly discard configuration drafts first. An immediate request processes sessions in sequence. Only one consolidation flow is admitted; model requests are not retried automatically. No new messages means no model call.

- completed: all work for that source succeeded; only then is its cursor advanced.
- partial: some writes/proposals succeeded but an error occurred. The cursor stays unchanged and completed writes are not rolled back.
- failed: execution failed or startup reconciled an interrupted round. This status alone does not prove that nothing was written earlier.

Extraction uses new messages and bounded overlapping context. User profile, persona, assistant instructions and memory are global. Applying a profile or instruction proposal always requires confirmation. The write compares the version read during confirmation to protect concurrent edits. Existing memory edit/delete must cite an exact id; an uncertain edit must not become an addition.

Leaving the page or a client timeout does not establish remote cancellation. Read results and target contents before running again. Shutdown cancels active model work; restart marks running records failed without resuming them.

## Resolve pending suggestions {#resolve-dream-suggestions}

Up to 50 deduplicated pending proposals are kept globally with their source session. Before applying, inspect the full text, reason, source and target. Choose USER, SOUL, assistant instructions or new memory, or explicitly dismiss.

The source identifies where a proposal came from. Applying changes to a global target affects all sessions. Dismissal only removes the proposal, not chat. Read the list and target after an unknown write rather than automatically resending.

## Reset and delete effects {#dream-reset-and-delete}

Session reset/deletion does not delete global Dream configuration or previously written profile/memory. Pending proposals remain available for review after a source session is deleted. See [Session management](conversations-and-agents.md#reset-and-delete-sessions) for irreversible history/feedback effects.

## Limits and failures {#limits-and-failures}

Model failures, invalid proposals, concurrent edits, full memory or shutdown can cause failure/partial completion. There is no automatic rollback or retry. Scope classification depends on model understanding; the server enforces permission, tool and version boundaries, not whether a real-world fact applies to every topic. Writes affect later turns, not existing chat text.
