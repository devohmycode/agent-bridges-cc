import { binaryOverride, launchFor } from "./launch.mjs";

const BINARY_ENV = "COPILOT_BINARY";
const TOKEN_ENVS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];

export default {
  id: "copilot",
  pluginName: "copilot-bridge",
  displayName: "Copilot",
  productName: "GitHub Copilot CLI",
  cliName: "copilot",
  binaryEnv: BINARY_ENV,
  installHint: "Install the GitHub Copilot CLI (https://github.com/github/copilot-cli) so `copilot` is on PATH, or set COPILOT_BINARY.",
  authHint: "Run `copilot` once and use `/login`, or export COPILOT_GITHUB_TOKEN.",
  modelHint: "Pass `--model <id>` (or `auto`). Effort maps to `--reasoning-effort`.",
  readOnlyNote: "Read-only runs deny the `write` and `shell` tools.",
  efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  promptVia: "arg",
  structuredOutput: "prompt",
  versionArgs: ["--version"],

  resolveLaunch(env) {
    return launchFor(binaryOverride(env, BINARY_ENV) ?? "copilot", { env });
  },

  // The CLI has no non-interactive auth probe; stored logins are only
  // discovered at run time. Report a token when one is exported.
  checkAuth(env) {
    const token = TOKEN_ENVS.find((name) => env[name]);
    if (token) {
      return { loggedIn: true, detail: `token from ${token}` };
    }
    return { loggedIn: null, detail: "not verified (Copilot CLI has no status command; a stored /login is used at run time)" };
  },

  buildRun({ prompt, promptFile, runDir, cwd, write, model, effort, resumeSessionId, newSessionId }) {
    const sessionId = resumeSessionId ?? newSessionId;
    const args = ["-p", prompt, "-s", "--no-color", "--no-ask-user", "--no-auto-update", "--allow-all-tools", "-C", cwd];
    if (!write) {
      args.push("--deny-tool", "write", "--deny-tool", "shell");
    }
    args.push(resumeSessionId ? "--resume" : "--session-id", sessionId);
    if (model) {
      args.push("--model", model);
    }
    if (effort) {
      args.push("--reasoning-effort", effort);
    }
    if (promptFile) {
      args.push("--add-dir", runDir);
    }
    return { args, sessionId };
  },

  parseRun({ stdout, plan }) {
    return { finalMessage: stdout.trim(), sessionId: plan.sessionId };
  },

  resumeCommand(id) {
    return `copilot --resume ${id}`;
  }
};
