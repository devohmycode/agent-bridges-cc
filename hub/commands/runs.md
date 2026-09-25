---
description: Show active and recent hub runs (ask and flow) for this repository
argument-hint: '[run-id] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" runs "$ARGUMENTS"`

If the user did not pass a run ID, render the runs as one compact Markdown table and keep the follow-up commands. If they did, present the full output.
