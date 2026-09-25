---
description: Create a custom multi-provider workflow
argument-hint: '[name] [what the workflow should do]'
allowed-tools: Read, Write, Bash(node:*), AskUserQuestion
---

Help the user write a Bridges Hub workflow, then validate it.

Raw arguments: `$ARGUMENTS`

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" check` to see which providers are installed, and `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" list` for the existing profiles and workflows.
2. Work out the steps from the arguments. Ask with `AskUserQuestion` only for what you cannot infer: where to save it (`.claude/bridges-hub/workflows/` for this project, `~/.claude/bridges-hub/workflows/` for all projects), and which provider takes which step.
3. Write `<name>.md`, one `## <step-id>` section per step:

   ```markdown
   ---
   name: <name>
   description: <one line>
   ---
   ## implement
   provider: cursor
   profile: implementer

   {{task}}

   ## review
   provider: codex
   profile: security-review
   after: implement

   Review the uncommitted changes made for: {{task}}
   Notes from the implementer: {{steps.implement.output}}
   ```

   Rules:
   - The `key: value` lines come right after the heading, then a blank line, then the prompt.
   - Workflow frontmatter keys: `name`, `description`, `exclude` (globs left out of every step), `vars` (`key=value, …` defaults).
   - Step keys: `provider`, `profile`, `mode` (`read` or `write`), `model`, `effort`, `after` (comma-separated step ids), `on_failure` (`stop` or `continue`), `exclude`.
   - A step's settings override its profile's. Without a prompt, the step works on `{{task}}`.
   - Placeholders: `{{task}}`, `{{vars.<name>}}` (from `--var name=value`), and `{{steps.<id>.output}}` / `{{steps.<id>.status}}` for steps listed, directly or indirectly, in `after`.
   - Steps without a dependency between them run in parallel; a `write` step always runs alone.
4. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" validate "<path to the file>"` and fix the file until it passes, then `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" flow "--dry-run <name> example task"` to show the plan.
5. Tell the user how to run it: `/bridges-hub:flow <name> <task>`.
