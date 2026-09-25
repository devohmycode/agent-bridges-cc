---
description: Show which bridge plugins the hub can use in this repository
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" check "$ARGUMENTS"`

Present the table as is. For every provider marked not installed, keep its install note. Remind the user that each bridge also needs its own CLI signed in (its `/<plugin>:check`, or `/codex:setup` for Codex).
