import process from "node:process";

import { binaryOverride, launchFor, parseJsonLines } from "./launch.mjs";

const BINARY_ENV = "FAKE_AGENT_BINARY";

// Test-only provider driving tests/fake-agent-fixture.mjs.
export default {
  id: "fake",
  pluginName: "fake-bridge",
  displayName: "Fake",
  productName: "Fake Agent",
  cliName: "fake-agent",
  binaryEnv: BINARY_ENV,
  installHint: "Install the fake agent.",
  authHint: "Run `fake-agent login`.",
  modelHint: "Any model name works.",
  readOnlyNote: "Read-only runs pass `--read-only`.",
  efforts: ["low", "medium", "high"],
  promptVia: "arg",
  structuredOutput: "prompt",
  versionArgs: ["--version"],
  authArgs: ["status"],

  resolveLaunch(env) {
    const override = binaryOverride(env, BINARY_ENV);
    if (override && override.endsWith(".mjs")) {
      return { command: process.execPath, prefixArgs: [override], env: {}, shell: false, found: true };
    }
    return launchFor(override ?? "fake-agent", { env });
  },

  buildRun({ prompt, write, model, effort, resumeSessionId, newSessionId }) {
    const args = ["-p", prompt, "--output-format", "json"];
    if (!write) {
      args.push("--read-only");
    }
    if (model) {
      args.push("--model", model);
    }
    if (effort) {
      args.push("--effort", effort);
    }
    args.push(resumeSessionId ? "--resume" : "--session-id", resumeSessionId ?? newSessionId);
    return { args, sessionId: resumeSessionId ?? newSessionId };
  },

  parseRun({ stdout, stderr, status }) {
    const result = parseJsonLines(stdout).reverse().find((event) => event.type === "result");
    if (!result) {
      return { finalMessage: stdout, failure: status === 0 ? "fake-agent returned no result." : stderr.trim() || null };
    }
    return {
      finalMessage: result.result ?? "",
      sessionId: result.session_id ?? null,
      failure: result.is_error ? result.result : null
    };
  },

  resumeCommand(id) {
    return `fake-agent --resume ${id}`;
  }
};
