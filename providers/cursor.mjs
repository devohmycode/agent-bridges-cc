import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { binaryOverride, launchFor, localAppData, parseJsonLines } from "./launch.mjs";

const BINARY_ENV = "CURSOR_AGENT_BINARY";

// The Windows installer ships `cursor-agent.cmd` -> PowerShell -> the newest
// `versions/<v>/node.exe index.js`. Launch that pair directly: no shell, and
// the prompt can be piped through stdin.
function windowsDirectLaunch(env) {
  const root = localAppData(env) && path.join(localAppData(env), "cursor-agent");
  const versionsDir = root && path.join(root, "versions");
  if (!versionsDir || !fs.existsSync(versionsDir)) {
    return null;
  }
  const versions = fs
    .readdirSync(versionsDir)
    .filter((name) => /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(name))
    .sort((left, right) => versionKey(right) - versionKey(left) || right.localeCompare(left));
  for (const version of versions) {
    const node = path.join(versionsDir, version, "node.exe");
    const entry = path.join(versionsDir, version, "index.js");
    if (fs.existsSync(node) && fs.existsSync(entry)) {
      return { command: node, prefixArgs: [entry], env: { CURSOR_INVOKED_AS: "cursor-agent.cmd" }, shell: false, found: true };
    }
  }
  return null;
}

function versionKey(name) {
  const [year, month, day] = name.split("-")[0].split(".");
  return Number(`${year}${month.padStart(2, "0")}${day.padStart(2, "0")}`);
}

export default {
  id: "cursor",
  pluginName: "cursor-bridge",
  displayName: "Cursor",
  productName: "Cursor Agent",
  cliName: "cursor-agent",
  binaryEnv: BINARY_ENV,
  installHint: "Install the Cursor CLI (https://cursor.com/cli) so `cursor-agent` is on PATH, or set CURSOR_AGENT_BINARY.",
  authHint: "Run `cursor-agent login`, then verify with `cursor-agent status`.",
  modelHint: "Run `cursor-agent models` to list models. Reasoning effort is set through the model, e.g. --model 'claude-opus-4-8[effort=high]'.",
  readOnlyNote: "Read-only runs use `--mode ask` (read-only Q&A).",
  promptVia: "stdin",
  structuredOutput: "prompt",
  versionArgs: ["--version"],
  authArgs: ["status"],

  resolveLaunch(env) {
    const override = binaryOverride(env, BINARY_ENV);
    if (override) {
      return launchFor(override, { env });
    }
    if (process.platform === "win32") {
      const direct = windowsDirectLaunch(env);
      if (direct) {
        return direct;
      }
    }
    return launchFor("cursor-agent", { env });
  },

  parseAuth(result) {
    const text = `${result.stdout}\n${result.stderr}`.trim();
    const loggedIn = result.status === 0 && !/not (logged|authenticated)/i.test(text);
    return { loggedIn, detail: text.split(/\r?\n/).find(Boolean)?.replace(/^[^\w]+/, "") };
  },

  buildRun({ cwd, write, model, resumeSessionId, prompt }) {
    const args = ["-p", "--output-format", "json", "--trust", "--workspace", cwd];
    // `plan` mode drafts a plan instead of answering; `ask` is read-only and answers.
    args.push(...(write ? ["--force"] : ["--mode", "ask"]));
    if (model) {
      args.push("--model", model);
    }
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }
    return { args, stdin: prompt };
  },

  parseRun({ stdout, stderr, status }) {
    const result = parseJsonLines(stdout).reverse().find((event) => event.type === "result");
    if (!result) {
      return { finalMessage: stdout, failure: status === 0 ? "cursor-agent returned no result event." : null };
    }
    return {
      finalMessage: result.result ?? "",
      sessionId: result.session_id ?? null,
      failure: result.is_error ? result.result || stderr || "cursor-agent reported an error." : null
    };
  },

  resumeCommand(id) {
    return `cursor-agent --resume ${id}`;
  }
};
