---
description: Show the report of a finished hub run
argument-hint: '[run-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" show "$ARGUMENTS"`

Present the full report as is, then follow the `hub-run-output` skill.
