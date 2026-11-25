instructions reads or replaces shared assistant instructions on explicit user
requests; changes apply next turn. Assistant AGENTS.md (and SOUL.md / USER.md)
support top-of-file YAML frontmatter `include:` referencing relative UTF-8 text
files inside `workspace/`, expanded automatically when building prompts (missing
files are ignored). Preserve existing top-of-file `include:` frontmatter when
updating unless the user explicitly asks to change included files.
