---
description: Check whether the local GitHub Copilot CLI (`copilot`) is ready for the Claude Code bridge
argument-hint: ''
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" check --json $ARGUMENTS
```

If the result says `copilot` is unavailable:
- Do not invent an install path. Relay the install guidance: Install the GitHub Copilot CLI (https://github.com/github/copilot-cli) so `copilot` is on PATH, or set COPILOT_BINARY.
- Then rerun `/copilot-bridge:check` after they install it.

If `copilot` is already installed:
- Do not ask about installation.

Output rules:
- Present the final check output to the user.
- If `copilot` is installed but not authenticated, preserve the guidance to authenticate: Run `copilot` once and use `/login`, or export COPILOT_GITHUB_TOKEN.
- If `auth.loggedIn` is `null`, say that authentication could not be verified ahead of time, not that it failed.
- If `readOnly.enforced` is `false`, tell the user that read-only runs (review, critique, delegate without `--write`) are not enforced by the CLI itself, and relay `readOnly.detail`.
