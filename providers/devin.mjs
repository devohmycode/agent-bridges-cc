import fs from "node:fs";
import path from "node:path";

import { binaryOverride, launchFor } from "./launch.mjs";

const BINARY_ENV = "DEVIN_BINARY";

function readExport(runDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, "conversation.json"), "utf8"));
  } catch {
    return null;
  }
}

export default {
  id: "devin",
  pluginName: "devin-bridge",
  displayName: "Devin",
  productName: "Devin CLI",
  cliName: "devin",
  binaryEnv: BINARY_ENV,
  installHint: "Install the Devin CLI so `devin` is on PATH, or set DEVIN_BINARY.",
  authHint: "Run `devin auth login`, then verify with `devin auth status`.",
  modelHint: "Run `devin models` to list models. The Devin CLI has no reasoning-effort flag.",
  readOnlyNote: "Read-only runs use `--permission-mode auto`, which auto-approves read-only tools and rejects the rest.",
  promptVia: "file",
  structuredOutput: "prompt",
  versionArgs: ["version"],
  authArgs: ["auth", "status"],

  resolveLaunch(env) {
    return launchFor(binaryOverride(env, BINARY_ENV) ?? "devin", { env });
  },

  parseAuth(result) {
    const text = `${result.stdout}\n${result.stderr}`.trim();
    const firstLine = text.split(/\r?\n/).find(Boolean);
    return { loggedIn: result.status === 0 && /logged in/i.test(text) && !/not logged in/i.test(text), detail: firstLine };
  },

  buildRun({ promptFile, runDir, write, model, resumeSessionId }) {
    const args = [
      "-p",
      "--prompt-file",
      promptFile,
      "--permission-mode",
      write ? "dangerous" : "auto",
      "--respect-workspace-trust",
      "false",
      "--export",
      path.join(runDir, "conversation.json")
    ];
    if (model) {
      args.push("--model", model);
    }
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }
    return { args };
  },

  parseRun({ stdout, stderr, runDir }) {
    const exported = readExport(runDir);
    const notes = String(stderr)
      .split(/\r?\n/)
      .filter((line) => /rejected a tool call/i.test(line));
    const lastAgentStep = exported?.steps?.filter((step) => step.source === "agent" && step.message).pop();
    return {
      // stdout interleaves narration from every turn; the export holds the final answer alone.
      finalMessage: lastAgentStep?.message || stdout.trim(),
      sessionId: exported?.session_id ?? null,
      notes
    };
  },

  resumeCommand(id) {
    return `devin --resume ${id}`;
  }
};
