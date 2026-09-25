---
description: Check whether the local Devin CLI (`devin`) is ready for the Claude Code bridge
argument-hint: ''
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" check --json $ARGUMENTS
```

If the result says `devin` is unavailable:
- Do not invent an install path. Relay the install guidance: Install the Devin CLI so `devin` is on PATH, or set DEVIN_BINARY.
- Then rerun `/devin-bridge:check` after they install it.

If `devin` is already installed:
- Do not ask about installation.

Output rules:
- Present the final check output to the user.
- If `devin` is installed but not authenticated, preserve the guidance to authenticate: Run `devin auth login`, then verify with `devin auth status`.
- If `auth.loggedIn` is `null`, say that authentication could not be verified ahead of time, not that it failed.
- If `readOnly.enforced` is `false`, tell the user that read-only runs (review, critique, delegate without `--write`) are not enforced by the CLI itself, and relay `readOnly.detail`.
