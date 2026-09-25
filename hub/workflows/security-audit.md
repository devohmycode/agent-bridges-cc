---
name: security-audit
description: Two independent security reviews, then a third provider cross-examines them
---
## codex
provider: codex
profile: security-review

Audit this scope of the repository for security issues: {{task}}

## copilot
provider: copilot
profile: security-review

Audit this scope of the repository for security issues: {{task}}

## cross-check
provider: grok-build
profile: security-review
after: codex, copilot

Two reviewers audited this scope: {{task}}

Check each finding below against the code. Confirm the real ones, reject the
false positives with the reason, and add anything both missed. End with the
confirmed findings ranked by severity.

Reviewer A (Codex):
{{steps.codex.output}}

Reviewer B (Copilot):
{{steps.copilot.output}}
