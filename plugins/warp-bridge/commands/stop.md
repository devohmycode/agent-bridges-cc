---
description: Stop an active background Warp Oz run in this repository
argument-hint: '[run-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" stop "$ARGUMENTS"`
