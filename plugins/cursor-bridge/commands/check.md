---
description: Check whether the local Cursor Agent (`cursor-agent`) is ready for the Claude Code bridge
argument-hint: ''
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" check --json $ARGUMENTS
```

If the result says `cursor-agent` is unavailable:
- Do not invent an install path. Relay the install guidance: Install the Cursor CLI (https://cursor.com/cli) so `cursor-agent` is on PATH, or set CURSOR_AGENT_BINARY.
- Then rerun `/cursor-bridge:check` after they install it.

If `cursor-agent` is already installed:
- Do not ask about installation.

Output rules:
- Present the final check output to the user.
- If `cursor-agent` is installed but not authenticated, preserve the guidance to authenticate: Run `cursor-agent login`, then verify with `cursor-agent status`.
- If `auth.loggedIn` is `null`, say that authentication could not be verified ahead of time, not that it failed.
- If `readOnly.enforced` is `false`, tell the user that read-only runs (review, critique, delegate without `--write`) are not enforced by the CLI itself, and relay `readOnly.detail`.
