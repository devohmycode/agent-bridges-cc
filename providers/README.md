# Provider adapters

Each `<id>.mjs` file here default-exports one adapter. `npm run build` copies
it into `plugins/<pluginName>/scripts/lib/provider.mjs`, where
`core/scripts/lib/adapter.mjs` merges it over the defaults below. Adapters may
import the helpers of `./launch.mjs` (`launchFor`, `which`, `binaryOverride`,
`localAppData`, `parseJsonLines`).

## Identity and help text

| Field | Example | Used for |
| --- | --- | --- |
| `id` | `"cursor"` | agent and skill names (`cursor-delegate`, …), `AGENT_BRIDGES_DATA_CURSOR` |
| `pluginName` | `"cursor-bridge"` | plugin name and `/cursor-bridge:*` commands |
| `displayName` | `"Cursor"` | short name in messages |
| `productName` | `"Cursor Agent"` | report titles |
| `cliName` | `"cursor-agent"` | CLI name in messages |
| `installHint`, `authHint`, `modelHint` | | `check` output and command guidance |
| `readOnlyNote` | | how read-only is enforced, shown by `check` and the review command |

## Behaviour

| Field | Default | Meaning |
| --- | --- | --- |
| `efforts` | `null` | accepted `--effort` values; `null` means the flag is ignored with a warning |
| `promptVia` | `"arg"` | `"arg"`, `"stdin"` or `"file"`; long `"arg"` prompts are moved to a file automatically |
| `maxArgPromptChars` | `24000` | threshold for that move |
| `structuredOutput` | `"prompt"` | `"schema"` passes `schemaPath` to `buildRun` for critiques |
| `readOnlyPrompt` | none | text appended to every read-only prompt |
| `versionArgs` | `["--version"]` | availability probe |
| `authArgs` + `parseAuth(result)` | none | auth probe; return `{ loggedIn: true\|false\|null, detail }` |
| `checkAuth(env)` | none | alternative to `authArgs` when the CLI has no probe |
| `readOnlyEnforced(env)` | `() => true` | `false` makes `check` and read-only runs print `readOnlyNote` |

## Functions

- `resolveLaunch(env)` → `{ command, prefixArgs, env, shell, found }`. Use
  `launchFor(name, { env })` unless the CLI needs a special launcher (see
  Cursor and Warp on Windows). Never return `shell: true` for a CLI that
  receives the prompt in argv; the core then moves the prompt to a file.
- `buildRun(request)` → `{ args, stdin?, env?, sessionId? }`. `request` holds
  `prompt`, `promptFile` (set when the prompt went to a file), `runDir` (a
  temporary directory removed after the run), `cwd`, `write`, `model`,
  `effort`, `resumeSessionId`, `newSessionId` (a UUID the adapter may impose
  on the CLI), `schemaPath` and `env`. Return `sessionId` when it is known
  before the run.
- `parseRun({ stdout, stderr, status, plan, runDir })` →
  `{ finalMessage, sessionId?, notes?, failure? }`. `failure` turns an exit
  code 0 into a failed run; `notes` are appended to the rendered output.
- `resumeCommand(id)` → the shell command that reopens the session in the CLI.

Read-only safety has two layers: the flags that `buildRun` sets when
`write` is false, and the git snapshot the core takes around every read-only
run. Test both before shipping an adapter.
