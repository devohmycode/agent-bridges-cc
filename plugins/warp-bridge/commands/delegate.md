---
description: Delegate investigation, an explicit fix request, or follow-up work to the Warp Oz delegate subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [what Warp should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `warp-bridge:warp-delegate` subagent via the `Agent` tool (`subagent_type: "warp-bridge:warp-delegate"`), forwarding the raw user request as the prompt.
`warp-bridge:warp-delegate` is a subagent, not a skill — do not call `Skill(warp-bridge:warp-delegate)` (no such skill) or `Skill(warp-bridge:delegate)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Warp's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `warp-bridge:warp-delegate` subagent in the background.
- If the request includes `--wait`, run the `warp-bridge:warp-delegate` subagent in the foreground.
- If neither flag is present, default to foreground.
- Prefer bridge `--background` for long or open-ended work so the run records both `bridgePid` (Node worker) and `agentPid` (`oz` child).
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `run`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `run` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Warp, check for a resumable delegate thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" run-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Warp thread or start a new one.
- The two choices must be:
  - `Continue current Warp thread`
  - `Start a new Warp thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Warp thread (Recommended)` first.
- Otherwise put `Start a new Warp thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" run ...` and return that command's stdout as-is.
- Return the Warp bridge stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/warp-bridge:runs`, fetch `/warp-bridge:show`, call `/warp-bridge:stop`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `run` command.
- If the helper reports that Warp is missing or unauthenticated, stop and tell the user to run `/warp-bridge:check`.
- If the user did not supply a request, ask what Warp should investigate or fix.
