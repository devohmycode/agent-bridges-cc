---
name: hub-run-output
description: Internal guidance for presenting Bridges Hub reports (ask and flow) back to the user
user-invocable: false
---

# Bridges Hub Report Output

When a hub report comes back:
- Keep the step table first: step, provider, mode, status, duration.
- Then give each step's output under its own heading, attributed to its provider. Do not merge outputs from different providers into one voice.
- For review steps, keep findings with their file paths, lines and severities exactly as reported, ordered by severity.
- When several providers reviewed the same thing, add a short comparison at the end: findings they agree on, findings only one of them raised, and contradictions. Label it as your synthesis.
- Report failed and skipped steps plainly, with the error the report gives. Do not present a partial run as complete.
- Steps in `write` mode may already have changed files. Point the user to `git status` / `git diff` instead of describing edits you have not checked.
- Do not fix issues, apply suggestions or rerun steps unless the user asks.
