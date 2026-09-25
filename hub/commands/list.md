---
description: List the profiles and workflows available to the hub (built-in, user and project)
argument-hint: '[profiles|workflows]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" list "$ARGUMENTS"`

Present the output as is. Keep the Source column: it tells the user which file wins when a project or user file overrides a built-in one.
