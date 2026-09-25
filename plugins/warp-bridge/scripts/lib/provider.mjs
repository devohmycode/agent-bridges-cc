import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { binaryOverride, launchFor, localAppData, parseJsonLines } from "./launch.mjs";

const BINARY_ENV = "WARP_OZ_BINARY";
const READ_ONLY_PROFILE_ENV = "WARP_BRIDGE_READONLY_PROFILE";
const WRITE_PROFILE_ENV = "WARP_BRIDGE_WRITE_PROFILE";

// On Windows `oz.cmd` only sets WARP_CLI_MODE=1 and forwards to warp.exe.
// Launch warp.exe directly so no shell sits between us and the prompt.
function windowsDirectLaunch(env) {
  const base = localAppData(env);
  const candidates = [
    base && path.join(base, "Programs", "Warp", "warp.exe"),
    base && path.join(base, "Programs", "WarpPreview", "warp.exe")
  ].filter(Boolean);
  const exe = candidates.find((candidate) => fs.existsSync(candidate));
  return exe ? { command: exe, prefixArgs: [], env: { WARP_CLI_MODE: "1" }, shell: false, found: true } : null;
}

export default {
  id: "warp",
  pluginName: "warp-bridge",
  displayName: "Warp",
  productName: "Warp Oz",
  cliName: "oz",
  binaryEnv: BINARY_ENV,
  installHint: "Install Warp and its `oz` CLI (https://docs.warp.dev/reference/cli), or set WARP_OZ_BINARY.",
  authHint: "Run `oz login` (or export WARP_API_KEY), then verify with `oz whoami`.",
  modelHint: "Run `oz model list` to list models. Oz has no reasoning-effort flag.",
  readOnlyNote: `Oz has no read-only flag. Set ${READ_ONLY_PROFILE_ENV} to an agent profile whose permissions forbid edits; otherwise read-only runs rely on the prompt and on the bridge's git check.`,
  promptVia: "arg",
  structuredOutput: "prompt",
  versionArgs: ["--version"],
  authArgs: ["whoami"],

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
    return launchFor("oz", { env });
  },

  readOnlyEnforced(env) {
    return Boolean(binaryOverride(env, READ_ONLY_PROFILE_ENV));
  },

  parseAuth(result) {
    const text = `${result.stdout}\n${result.stderr}`.trim();
    const name = text.match(/Display Name:\s*(.+)/i)?.[1]?.trim();
    return { loggedIn: result.status === 0, detail: result.status === 0 ? `logged in${name ? ` as ${name}` : ""}` : text.split(/\r?\n/)[0] };
  },

  buildRun({ prompt, cwd, write, model, resumeSessionId, env }) {
    const args = ["agent", "run", "--prompt", prompt, "--cwd", cwd, "--output-format", "json", "--no-snapshot"];
    const profile = binaryOverride(env, write ? WRITE_PROFILE_ENV : READ_ONLY_PROFILE_ENV);
    if (profile) {
      args.push("--profile", profile);
    }
    if (model) {
      args.push("--model", model);
    }
    if (resumeSessionId) {
      args.push("--conversation", resumeSessionId);
    }
    return { args };
  },

  parseRun({ stdout, stderr, status }) {
    const events = parseJsonLines(stdout);
    const conversation = events.find((event) => event.event_type === "conversation_started");
    const run = events.find((event) => event.event_type === "run_started");
    const texts = events.filter((event) => event.type === "agent" && typeof event.text === "string").map((event) => event.text);
    const errors = events.filter((event) => event.type === "error" || event.event_type === "error");
    return {
      // Each agent event is one message; earlier ones are narration.
      finalMessage: (texts.at(-1) ?? "").trim(),
      sessionId: conversation?.conversation_id ?? null,
      notes: run?.run_url ? [`Oz run: ${run.run_url}`] : [],
      failure: errors.length > 0 ? errors.map((event) => event.message ?? JSON.stringify(event)).join("\n") : status !== 0 ? stderr.trim() : null
    };
  },

  resumeCommand(id) {
    return `oz agent run --conversation ${id} --prompt "<follow-up>"`;
  }
};
