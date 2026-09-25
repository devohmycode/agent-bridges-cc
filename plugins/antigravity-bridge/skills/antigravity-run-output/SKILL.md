---
name: antigravity-run-output
description: Internal guidance for presenting Antigravity CLI bridge output back to the user
user-invocable: false
---

# Antigravity CLI Run Output

When the helper returns Antigravity output:
- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review or critique output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If Antigravity marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- Preserve output sections when the prompt asked for them, such as observed facts, inferences, open questions, touched files, or next steps.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If Antigravity made edits, say so explicitly and list the touched files when the helper provides them.
- For `antigravity-bridge:antigravity-delegate`, do not turn a failed or incomplete Antigravity run into a Claude-side implementation attempt. Report the failure and stop.
- For `antigravity-bridge:antigravity-delegate`, if Antigravity was never successfully invoked, do not generate a substitute answer at all.
- CRITICAL: After presenting review or critique findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the helper reports malformed output or a failed Antigravity run, include the most actionable stderr lines and stop there instead of guessing.
- If the helper reports that setup or authentication is required, direct the user to `/antigravity-bridge:check` and do not improvise alternate auth flows.
