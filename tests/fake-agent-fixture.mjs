import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * Install a fake agent CLI (a Node script, launched through process.execPath
 * so it works on Windows without a shell) for hermetic tests.
 * @param {string} binDir
 * @param {"default"|"not-logged-in"|"fail-print"|"modifies-worktree"|"echo"|"slow"} scenario
 * @returns {string} path to set as FAKE_AGENT_BINARY
 */
export function installFakeAgent(binDir, scenario = "default") {
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "fake-agent.mjs");

  const source = `import fs from "node:fs";
import path from "node:path";

const scenario = ${JSON.stringify(scenario)};
const argv = process.argv.slice(2);

function flagValue(name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? null;
}

if (process.env.FAKE_AGENT_LOG) {
  fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ argv, scenario, cwd: process.cwd() }) + "\\n");
}

if (argv[0] === "--version") {
  process.stdout.write("fake-agent 1.0.0-fake\\n");
  process.exit(0);
}

if (argv[0] === "status") {
  if (scenario === "not-logged-in") {
    process.stderr.write("Not logged in.\\n");
    process.exit(1);
  }
  process.stdout.write("Logged in as tester\\n");
  process.exit(0);
}

if (argv[0] === "-p") {
  if (scenario === "fail-print") {
    process.stderr.write("fake agent failed the print run\\n");
    process.exit(2);
  }
  if (scenario === "slow") {
    await new Promise((resolve) => setTimeout(resolve, 60000));
  }
  if (scenario === "modifies-worktree") {
    fs.writeFileSync(path.join(process.cwd(), "touched-by-agent.txt"), "oops\\n");
  }
  const prompt = argv[1] ?? "";
  const sessionId = flagValue("--resume") ?? flagValue("--session-id") ?? "fake-session";
  let result;
  if (scenario === "echo") {
    result = "ECHO " + prompt;
  } else if (/Return only valid JSON/i.test(prompt)) {
    result = JSON.stringify({
      verdict: "approve",
      summary: "No material issues found in the reviewed changes.",
      findings: [],
      next_steps: ["Ship it."]
    });
  } else if (/code review/i.test(prompt)) {
    result = "Reviewed uncommitted changes.\\nNo material issues found.";
  } else {
    result = "Handled the requested task.";
  }
  process.stdout.write(JSON.stringify({ type: "result", result, session_id: sessionId, is_error: false }) + "\\n");
  process.exit(0);
}

process.stderr.write("fake agent: unknown invocation: " + argv.join(" ") + "\\n");
process.exit(1);
`;

  fs.writeFileSync(scriptPath, source, "utf8");
  return scriptPath;
}

export function buildEnv(fakeBinary, extra = {}) {
  const env = { ...process.env, FAKE_AGENT_BINARY: fakeBinary, ...extra };
  // Keep a developer's real session/data variables out of hermetic runs.
  delete env.AGENT_BRIDGES_SESSION_ID;
  delete env.CLAUDE_PLUGIN_DATA;
  if (!("AGENT_BRIDGES_DATA_FAKE" in extra)) {
    delete env.AGENT_BRIDGES_DATA_FAKE;
  }
  return env;
}

export function lastPrintArgv(logPath) {
  const lines = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const printRun = [...lines].reverse().find((entry) => entry.argv?.[0] === "-p");
  if (!printRun) {
    throw new Error("expected a headless fake-agent -p invocation");
  }
  return printRun.argv;
}
