---
description: Delegate investigation, an explicit fix request, or follow-up work to the GitHub Copilot CLI delegate subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [what Copilot should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `copilot-bridge:copilot-delegate` subagent via the `Agent` tool (`subagent_type: "copilot-bridge:copilot-delegate"`), forwarding the raw user request as the prompt.
`copilot-bridge:copilot-delegate` is a subagent, not a skill — do not call `Skill(copilot-bridge:copilot-delegate)` (no such skill) or `Skill(copilot-bridge:delegate)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Copilot's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `copilot-bridge:copilot-delegate` subagent in the background.
- If the request includes `--wait`, run the `copilot-bridge:copilot-delegate` subagent in the foreground.
- If neither flag is present, default to foreground.
- Prefer bridge `--background` for long or open-ended work so the run records both `bridgePid` (Node worker) and `agentPid` (`copilot` child).
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `run`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `run` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Copilot, check for a resumable delegate thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" run-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Copilot thread or start a new one.
- The two choices must be:
  - `Continue current Copilot thread`
  - `Start a new Copilot thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Copilot thread (Recommended)` first.
- Otherwise put `Start a new Copilot thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" run ...` and return that command's stdout as-is.
- Return the Copilot bridge stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/copilot-bridge:runs`, fetch `/copilot-bridge:show`, call `/copilot-bridge:stop`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `run` command.
- If the helper reports that Copilot is missing or unauthenticated, stop and tell the user to run `/copilot-bridge:check`.
- If the user did not supply a request, ask what Copilot should investigate or fix.
