---
description: Check whether the local {{PRODUCT}} (`{{CLI}}`) is ready for the Claude Code bridge
argument-hint: ''
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" check --json $ARGUMENTS
```

If the result says `{{CLI}}` is unavailable:
- Do not invent an install path. Relay the install guidance: {{INSTALL_HINT}}
- Then rerun `/{{PLUGIN}}:check` after they install it.

If `{{CLI}}` is already installed:
- Do not ask about installation.

Output rules:
- Present the final check output to the user.
- If `{{CLI}}` is installed but not authenticated, preserve the guidance to authenticate: {{AUTH_HINT}}
- If `auth.loggedIn` is `null`, say that authentication could not be verified ahead of time, not that it failed.
- If `readOnly.enforced` is `false`, tell the user that read-only runs (review, critique, delegate without `--write`) are not enforced by the CLI itself, and relay `readOnly.detail`.
