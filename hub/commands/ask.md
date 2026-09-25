---
description: Hand a task to one provider, optionally under a profile (role)
argument-hint: '<provider> [--profile <name>] [--write] [--model <m>] [--effort <e>] [--background] [task]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Run one provider through its bridge plugin, with a profile giving it a role (for example `--profile security-review`).

Raw slash-command arguments:
`$ARGUMENTS`

- The first argument is the provider: `cursor`, `devin`, `copilot`, `antigravity`, `warp`, `codex` or `grok-build`.
- If the provider or the task is missing, ask for it with `AskUserQuestion` (offer the profiles from `/bridges-hub:list profiles` when the user seems to want a role). Do not guess the task.
- The run is read-only unless `--write` is passed or the profile's mode is `write`. A profile from the repository's `.claude/bridges-hub/profiles` with `mode: write` is refused without `--write`. When it will write, say so before running.
- With `--background`:
  ```typescript
  Bash({
    command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" ask "$ARGUMENTS"`,
    description: "Bridges Hub ask",
    run_in_background: true
  })
  ```
  Then point the user to `/bridges-hub:runs` and `/bridges-hub:show`.
- Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" ask "$ARGUMENTS"` in the foreground with a 600000 ms timeout.

Present the result following the `hub-run-output` skill. Do not act on it unless the user asks.
