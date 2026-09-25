# Agent Bridges for Claude Code

> 🇫🇷 [Version française](README-FR.md)

A Claude Code marketplace that gathers, in one place, plugins for handing a
**review**, a **critique** or a **delegated task** to another coding agent
from inside Claude Code:

| Plugin | Agent | CLI | Origin |
| --- | --- | --- | --- |
| `codex` | OpenAI Codex | `codex` | official, [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (referenced, not copied) |
| `grok-build` | xAI Grok Build | `grok` | official, [xai-org/grok-build-plugin-cc](https://github.com/xai-org/grok-build-plugin-cc) (referenced, not copied) |
| `cursor-bridge` | Cursor Agent | `cursor-agent` | this repository |
| `devin-bridge` | Devin | `devin` | this repository |
| `copilot-bridge` | GitHub Copilot CLI | `copilot` | this repository |
| `antigravity-bridge` | Google Antigravity | `agy` | this repository |
| `warp-bridge` | Warp Oz | `oz` | this repository |

The five `*-bridge` plugins are generated from a single runtime, derived from
the Grok Build plugin (itself modelled on the Codex plugin): same commands,
same background run tracking, same rendering.

## Installation

```text
/plugin marketplace add devohmycode/agent-bridges-cc
/plugin install cursor-bridge@agent-bridges
/reload-plugins
```

Replace `cursor-bridge` with the plugin you want; several can be installed
side by side. `codex` and `grok-build` are fetched from their official
repositories at install time.

From a local clone:

```bash
claude plugin marketplace add "$(pwd)"
claude plugin install devin-bridge@agent-bridges
```

Requirements: Node.js ≥ 18.18 and the agent's CLI, installed and signed in.

## `*-bridge` commands

Every plugin exposes the same commands under its own prefix
(`/cursor-bridge:…`, `/devin-bridge:…`, and so on):

| Command | Purpose |
| --- | --- |
| `check` | Checks Node, the CLI, sign-in, and whether read-only is enforced |
| `review [--base <ref>] [--scope auto\|working-tree\|branch]` | Read-only review of the local git state |
| `critique [focus…]` | Review that challenges design choices; structured JSON output |
| `delegate [--resume\|--fresh] <task>` | Hands a task to the `<id>-delegate` subagent; writes allowed by default |
| `runs [id] [--wait]` | Active and recent runs |
| `show [id]` | Full result of a finished run |
| `stop [id]` | Stops a background run (agent and bridge processes) |

Common options: `--wait` / `--background`, `--model <model>`, and
`--effort <level>` where the CLI supports it.

## How each CLI is driven

| | Read-only (review, critique) | Write (delegate) | Resume | `--effort` |
| --- | --- | --- | --- | --- |
| Cursor | `--mode ask` | `--force` | `--resume <chatId>` | through the model: `--model 'model[effort=high]'` |
| Devin | `--permission-mode auto` | `--permission-mode dangerous` | `--resume <id>` | — |
| Copilot | `--deny-tool write --deny-tool shell` | `--allow-all-tools` | `--resume <id>` (id assigned up front) | `--reasoning-effort` |
| Antigravity | `--mode plan` | `--mode accept-edits --dangerously-skip-permissions` | `--conversation <id>` | `--effort` |
| Warp Oz | **not enforced** (see below) | optional agent profile | `--conversation <id>` | — |

The prompt goes through stdin (Cursor), a file (Devin) or argv. Beyond
24,000 characters it is written to a temporary file that the agent reads, to
stay under the Windows command-line limit.

### Read-only git guard

Every read-only run is bracketed by a `git status` + `git diff` snapshot. If
the working tree changed, the output ends with a warning listing the touched
files. The guard earned its place during development:
`agy --mode plan --dangerously-skip-permissions` ran a `git restore` in the
middle of a review. That flag is therefore never used for read-only runs.

### Warp Oz

`oz agent run` has no read-only mode. To enforce one, create a Warp agent
profile that forbids edits, then:

```bash
export WARP_BRIDGE_READONLY_PROFILE=<profile id>   # oz agent profile list
export WARP_BRIDGE_WRITE_PROFILE=<id>              # optional, for delegate
```

Without a profile, a review relies only on the prompt and on the git guard
above, and `check` says so. Every Oz run is also visible on `oz.warp.dev`
(the link is in the output); `--no-snapshot` turns off the end-of-run
snapshot upload.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `CURSOR_AGENT_BINARY`, `DEVIN_BINARY`, `COPILOT_BINARY`, `AGY_BINARY`, `WARP_OZ_BINARY` | Explicit CLI path |
| `WARP_BRIDGE_READONLY_PROFILE`, `WARP_BRIDGE_WRITE_PROFILE` | Warp agent profiles |
| `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` | Copilot authentication (otherwise the stored `/login`) |

On Windows, Cursor is launched directly through its bundled `node.exe` and
Warp through `warp.exe` (with `WARP_CLI_MODE=1`), bypassing the `.cmd`
shims.

## Development

```bash
npm run build         # regenerates plugins/ and .claude-plugin/marketplace.json
npm run check-build   # fails if the generated files are stale
npm test
```

- `core/`: shared runtime (bridge, run tracking, git, rendering, hooks).
- `providers/<id>.mjs`: one adapter per CLI (see `providers/README.md`).
- `templates/`: commands, agent and skills, with `{{…}}` variables.
- `plugins/`: **generated**, do not edit by hand; it is committed because
  Claude Code copies each plugin directory as is.

Adding an agent means writing a new `providers/<id>.mjs`, then running
`npm run build`.

## License

Apache-2.0. See `LICENSE` and `NOTICE` (xAI and OpenAI credits).
