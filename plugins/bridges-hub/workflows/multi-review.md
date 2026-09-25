---
name: multi-review
description: Three providers review the same changes independently, in parallel
---
Independent reviews catch different things. Claude compares them at the end.

## codex
provider: codex

Review the uncommitted changes in this repository (`git status`, `git diff`)
for correctness bugs, regressions and missing tests. {{task}}
List each finding with file, line, severity and fix.

## grok
provider: grok-build

Review the uncommitted changes in this repository (`git status`, `git diff`)
for correctness bugs, regressions and missing tests. {{task}}
List each finding with file, line, severity and fix.

## copilot
provider: copilot

Review the uncommitted changes in this repository (`git status`, `git diff`)
for correctness bugs, regressions and missing tests. {{task}}
List each finding with file, line, severity and fix.
