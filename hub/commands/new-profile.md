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

   Allowed keys: `name`, `description`, `mode`, `provider`, `model`, `effort`, and:
   - `extends: <profile>` to add project-specific guidance to an existing profile instead of copying it: each `## Section` of this file is appended under the same section of the base, marked as taking precedence. A profile named like its base (for example a project `security-review.md` with `extends: security-review`) extends the user or built-in version;
   - `include: <profile>[#<Section>], …` to append another profile, or one of its sections (profiles named `_…` are building blocks, hidden from `list`);
   - `exclude: <glob>, …` for files the agent must leave out;
   - `vars: key=value, …` for default values of `{{vars.<key>}}`.
   The body may use `{{task}}` and `{{vars.<name>}}`.
4. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" validate "<path to the file>"` and fix the file until it passes.
5. Tell the user how to use it: `/bridges-hub:ask <provider> --profile <name> <task>`, or `profile: <name>` in a workflow step.
