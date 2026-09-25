---
name: implement-review
description: Cursor implements, Codex and Grok Build review in parallel, Cursor applies the fixes
---
Copy this file to `.claude/bridges-hub/workflows/` and change the providers
to the ones you have installed.

## implement
provider: cursor
profile: implementer

{{task}}

## security
provider: codex
profile: security-review
after: implement

Review the uncommitted changes in this repository (`git status`, `git diff`).
They were made for this task: {{task}}

Implementer's summary:
{{steps.implement.output}}

## critique
provider: grok-build
profile: architecture-critic
after: implement

Challenge the design of the uncommitted changes in this repository
(`git status`, `git diff`). They were made for this task: {{task}}

## fix
provider: cursor
profile: implementer
after: security, critique

Address the review findings below on the uncommitted changes. Fix what is
real, and explain briefly why you left anything out.

Security review:
{{steps.security.output}}

Design critique:
{{steps.critique.output}}
