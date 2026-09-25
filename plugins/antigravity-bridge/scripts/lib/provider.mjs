import { binaryOverride, launchFor, parseJsonLines } from "./launch.mjs";

const BINARY_ENV = "AGY_BINARY";

export default {
  id: "antigravity",
  pluginName: "antigravity-bridge",
  displayName: "Antigravity",
  productName: "Antigravity CLI",
  cliName: "agy",
  binaryEnv: BINARY_ENV,
  installHint: "Install the Antigravity CLI so `agy` is on PATH, or set AGY_BINARY.",
  authHint: "Run `agy` interactively and sign in, then verify with `agy models`.",
  modelHint: "Run `agy models` to list models.",
  readOnlyNote: "Read-only runs use `--mode plan`; headless mode auto-denies anything that needs a permission, including shell commands.",
  // Without this, agy tries `git diff`, gets the command denied and ends the
  // turn with no answer. Never add --dangerously-skip-permissions to a
  // read-only run: in plan mode it still ran `git restore` during a review.
  readOnlyPrompt:
    "Read-only run: shell and terminal commands are denied here. Use only file-reading and search tools, and give the complete answer in your final message; do not write plans or artifacts.",
  efforts: ["low", "medium", "high"],
  promptVia: "arg",
  structuredOutput: "schema",
  versionArgs: ["--version"],
  authArgs: ["models"],

  resolveLaunch(env) {
    return launchFor(binaryOverride(env, BINARY_ENV) ?? "agy", { env });
  },

  parseAuth(result) {
    const lines = `${result.stdout}`.split(/\r?\n/).filter((line) => line.trim() && !/^fetching/i.test(line));
    if (result.status !== 0) {
      return { loggedIn: false, detail: (result.stderr || result.stdout).trim().split(/\r?\n/)[0] };
    }
    return { loggedIn: true, detail: `${lines.length} models available` };
  },

  buildRun({ prompt, promptFile, runDir, write, model, effort, resumeSessionId, schemaPath }) {
    // `--print=<prompt>` keeps a prompt that starts with "-" from being read as a flag.
    const args = [`--print=${prompt}`, "--output-format", "json"];
    args.push(...(write ? ["--mode", "accept-edits", "--dangerously-skip-permissions"] : ["--mode", "plan"]));
    if (model) {
      args.push("--model", model);
    }
    if (effort) {
      args.push("--effort", effort);
    }
    if (resumeSessionId) {
      args.push("--conversation", resumeSessionId);
    }
    if (schemaPath) {
      args.push("--json-schema", schemaPath);
    }
    if (promptFile) {
      args.push("--add-dir", runDir);
    }
    return { args };
  },

  parseRun({ stdout, stderr, status }) {
    const result = parseJsonLines(stdout).reverse().find((event) => "conversation_id" in event || "response" in event);
    if (!result) {
      return { finalMessage: stdout, failure: status === 0 ? `agy returned no JSON result. ${stderr}`.trim() : null };
    }
    const denied = Array.isArray(result.denied_actions) ? result.denied_actions : [];
    const notes = denied.map((action) => `Denied in headless mode: ${action.display_name ?? action.action}`);
    const response = typeof result.response === "string" ? result.response : JSON.stringify(result.response ?? "");
    return {
      finalMessage: response,
      sessionId: result.conversation_id ?? null,
      notes,
      failure: result.status && result.status !== "SUCCESS" ? `agy status ${result.status}` : null
    };
  },

  resumeCommand(id) {
    return `agy --conversation ${id}`;
  }
};
