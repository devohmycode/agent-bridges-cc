---
description: Run a multi-provider workflow (several bridges chained on one task)
argument-hint: '<workflow> [--var key=value]... [--model <m>] [--effort <e>] [--max-parallel <n>] [--wait|--background] [--dry-run] [task]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Run a Bridges Hub workflow. Each step runs through an installed bridge plugin; steps in `write` mode edit the working tree.

Raw slash-command arguments:
`$ARGUMENTS`

1. Always preview first, in the foreground:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" flow "--dry-run $ARGUMENTS"
   ```

   - If it fails (unknown workflow, invalid file, missing `--var` or task, provider not installed), show the error and stop. Suggest `/bridges-hub:list workflows` or `/bridges-hub:check` when relevant.
   - If the raw arguments include `--dry-run`, present the preview and stop there.
   - Otherwise, show the step table and order in a few lines. Do not paste the prompts unless asked.

2. Choose how to run it:
   - If the raw arguments include `--background` or `--wait`, do not ask.
   - Otherwise use `AskUserQuestion` once with `Run in background (Recommended)` and `Wait for results`. Workflows chain several agents and often take longer than the 10-minute limit of a foreground command.
   - If any step is in `write` mode, say so in the question: those steps will edit files in this repository.

3. Run it:
   - Background:
     ```typescript
     Bash({
       command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" flow "--background $ARGUMENTS"`,
       description: "Bridges Hub workflow",
       run_in_background: true
     })
     ```
     Then tell the user: "Workflow started in the background. Check `/bridges-hub:runs` for progress and `/bridges-hub:show` for the report. Stop with `/bridges-hub:stop`."
   - Foreground: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" flow "$ARGUMENTS"` with a 600000 ms timeout, then present the report following the `hub-run-output` skill.

Do not fix anything the steps report unless the user asks you to.
