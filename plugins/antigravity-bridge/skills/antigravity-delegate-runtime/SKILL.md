---
name: antigravity-delegate-runtime
description: Internal helper contract for calling the bridge runtime from Claude Code
user-invocable: false
---

# Antigravity CLI Delegate Runtime

Use this skill only inside the `antigravity-bridge:antigravity-delegate` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs" run [flags] <<'BRIDGE_TASK'` followed by the task text on the next lines and `BRIDGE_TASK` alone on the last line.
- Flags (`--write`, `--background`, `--resume-last`, `--model`, `--effort`) go on the command line; the task text goes only in the heredoc, which `run` reads as the prompt verbatim. Never put the task text inside the command line: the shell would expand `$(...)`, backticks and quotes in it. Keep the delimiter quoted.

Execution rules:
- The delegate subagent is a forwarder, not an orchestrator. Its only job is to invoke `run` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Antigravity CLI strings, or any other Bash activity.
- Do not call `check`, `review`, `critique`, `runs`, `show`, or `stop` from `antigravity-bridge:antigravity-delegate`.
- Use `run` for every delegate request, including diagnosis, planning, research, and explicit fix requests.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Default to a write-capable Antigravity run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `run` invocation per delegate handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only for short enqueue semantics. Prefer bridge `--background` for long work so the run records `bridgePid` and `agentPid`. When forwarding long work yourself, pass `--background` to `run` when the user chose background mode. Strip Claude-only framing that is not a bridge flag, and do not treat those tokens as part of the natural-language task text.
- If the forwarded request includes `--model`, pass it through to `run`.
- If the forwarded request includes `--effort`, pass it through to `run`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `run --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `run`, even if the request sounds like a follow-up.
- Accepted effort values: `low`, `medium`, `high`.
- `run --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous delegate run.

Safety rules:
- Default to write-capable Antigravity work in `antigravity-bridge:antigravity-delegate` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, stop runs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `run` command exactly as-is.
- If the Bash call fails or Antigravity cannot be invoked, return nothing.
