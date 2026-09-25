---
description: Create a custom profile (a role for a provider's agent)
argument-hint: '[name] [what the role should do]'
allowed-tools: Read, Write, Bash(node:*), AskUserQuestion
---

Help the user write a Bridges Hub profile, then validate it.

Raw arguments: `$ARGUMENTS`

1. Work out the role from the arguments. Ask with `AskUserQuestion` only for what you cannot infer:
   - where to save it: this project (`.claude/bridges-hub/profiles/`, shared with the repository) or all projects (`~/.claude/bridges-hub/profiles/`);
   - whether the role only reads (`mode: read`, the default) or edits files (`mode: write`);
   - optionally a default provider.
2. Look at `${CLAUDE_PLUGIN_ROOT}/profiles/` for the format and tone. Reusing a built-in name overrides that built-in.
3. Write `<name>.md`:

   ```markdown
   ---
   name: <name>
   description: <one line>
   mode: read
   provider: <optional default provider>
   ---
   <the role, written to the agent: what to focus on, what to ignore, what to return>
   ```

   Only these keys are allowed: `name`, `description`, `mode`, `provider`, `model`, `effort`. The body may use `{{task}}` and `{{vars.<name>}}`.
4. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" validate "<path to the file>"` and fix the file until it passes.
5. Tell the user how to use it: `/bridges-hub:ask <provider> --profile <name> <task>`, or `profile: <name>` in a workflow step.
