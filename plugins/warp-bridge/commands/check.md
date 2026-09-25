---
description: Check whether the local Warp Oz (`oz`) is ready for the Claude Code bridge
argument-hint: ''
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" check --json $ARGUMENTS
```

If the result says `oz` is unavailable:
- Do not invent an install path. Relay the install guidance: Install Warp and its `oz` CLI (https://docs.warp.dev/reference/cli), or set WARP_OZ_BINARY.
- Then rerun `/warp-bridge:check` after they install it.

If `oz` is already installed:
- Do not ask about installation.

Output rules:
- Present the final check output to the user.
- If `oz` is installed but not authenticated, preserve the guidance to authenticate: Run `oz login` (or export WARP_API_KEY), then verify with `oz whoami`.
- If `auth.loggedIn` is `null`, say that authentication could not be verified ahead of time, not that it failed.
- If `readOnly.enforced` is `false`, tell the user that read-only runs (review, critique, delegate without `--write`) are not enforced by the CLI itself, and relay `readOnly.detail`.
