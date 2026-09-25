---
description: Check whether the local Antigravity CLI (`agy`) is ready for the Claude Code bridge
argument-hint: ''
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" check --json $ARGUMENTS
```

If the result says `agy` is unavailable:
- Do not invent an install path. Relay the install guidance: Install the Antigravity CLI so `agy` is on PATH, or set AGY_BINARY.
- Then rerun `/antigravity-bridge:check` after they install it.

If `agy` is already installed:
- Do not ask about installation.

Output rules:
- Present the final check output to the user.
- If `agy` is installed but not authenticated, preserve the guidance to authenticate: Run `agy` interactively and sign in, then verify with `agy models`.
- If `auth.loggedIn` is `null`, say that authentication could not be verified ahead of time, not that it failed.
- If `readOnly.enforced` is `false`, tell the user that read-only runs (review, critique, delegate without `--write`) are not enforced by the CLI itself, and relay `readOnly.detail`.
