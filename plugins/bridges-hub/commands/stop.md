---
description: Stop an active hub run and the provider steps it started
argument-hint: '[run-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" stop "$ARGUMENTS"`
