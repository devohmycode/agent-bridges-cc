import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeAgent, lastPrintArgv } from "./fake-agent-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import {
  buildReviewPrompt,
  getAgentAuthStatus,
  getAgentAvailability,
  parseStructuredOutput,
  runHeadlessAgent
} from "./.generated/plugins/fake-bridge/scripts/lib/agent.mjs";
import { launchFor, parseJsonLines, quoteForCmd, which } from "./.generated/plugins/fake-bridge/scripts/lib/launch.mjs";
import { bridgeCommand } from "./.generated/plugins/fake-bridge/scripts/lib/adapter.mjs";

function fakeEnv(scenario = "default") {
  const dir = makeTempDir();
  const binary = installFakeAgent(dir, scenario);
  const log = path.join(dir, "fake-agent.log");
  return { env: buildEnv(binary, { FAKE_AGENT_LOG: log }), log };
}

test("bridgeCommand builds plugin-scoped slash commands", () => {
  assert.equal(bridgeCommand("runs"), "/fake-bridge:runs");
  assert.equal(bridgeCommand("runs", "run-1"), "/fake-bridge:runs run-1");
  assert.equal(bridgeCommand("review", "--wait"), "/fake-bridge:review --wait");
});

test("which resolves files on PATH and returns null otherwise", () => {
  const dir = makeTempDir();
  const name = process.platform === "win32" ? "tool.exe" : "tool";
  fs.writeFileSync(path.join(dir, name), "", { mode: 0o755 });
  const env = { PATH: dir, PATHEXT: ".EXE;.CMD" };
  assert.equal(which("tool", { env }), path.join(dir, name));
  assert.equal(which("missing-tool", { env }), null);
});

test("launchFor flags Windows .cmd shims as needing a shell", () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "shim.cmd"), "@echo off\n");
  const launch = launchFor("shim", { env: { PATH: dir, PATHEXT: ".EXE;.CMD" }, platform: "win32" });
  assert.equal(launch.shell, true);
  assert.equal(launch.command, path.join(dir, "shim.cmd"));
});

test("quoteForCmd leaves plain args alone and escapes cmd metacharacters", () => {
  assert.equal(quoteForCmd("--flag"), "--flag");
  assert.equal(quoteForCmd("a b"), '"a b"');
  assert.equal(quoteForCmd('say "hi" & 100%'), '"say ""hi"" & 100^%"');
});

test("parseJsonLines skips non-JSON noise", () => {
  const events = parseJsonLines('noise\n{"a":1}\n{broken\n  {"b":2}\n');
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

test("availability and auth come from the provider probes", () => {
  const { env } = fakeEnv();
  assert.equal(getAgentAvailability(process.cwd(), { env }).available, true);
  assert.equal(getAgentAuthStatus(process.cwd(), { env }).loggedIn, true);

  const loggedOut = fakeEnv("not-logged-in");
  assert.equal(getAgentAuthStatus(process.cwd(), { env: loggedOut.env }).loggedIn, false);

  const missing = buildEnv(path.join(makeTempDir(), "nope"));
  const availability = getAgentAvailability(process.cwd(), { env: missing });
  assert.equal(availability.available, false);
  assert.equal(getAgentAuthStatus(process.cwd(), { env: missing }).loggedIn, false);
});

test("runHeadlessAgent captures the final message, session id and agent pid", async () => {
  const { env } = fakeEnv();
  const progress = [];
  const result = await runHeadlessAgent(makeTempDir(), {
    prompt: "check the thing",
    env,
    onProgress: (event) => progress.push(event)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.finalMessage, "Handled the requested task.");
  assert.equal(typeof result.threadId, "string");
  assert.ok(result.args.includes("--read-only"));
  assert.equal(typeof result.agentPid, "number");
  assert.ok(progress.some((event) => event?.agentPid === result.agentPid));
  assert.equal(result.readOnlyViolation, null);
});

test("runHeadlessAgent moves oversized argv prompts into a file", async () => {
  const { env, log } = fakeEnv();
  const longPrompt = `do the work ${"x".repeat(30000)}`;
  const result = await runHeadlessAgent(makeTempDir(), { prompt: longPrompt, env });

  assert.equal(result.status, 0, result.stderr);
  const argv = lastPrintArgv(log);
  assert.match(argv[1], /^Read the complete task instructions from the file .+prompt\.md/);
  assert.ok(argv[1].length < 1000);
});

test("runHeadlessAgent reports a failed run with stderr", async () => {
  const { env } = fakeEnv("fail-print");
  const result = await runHeadlessAgent(makeTempDir(), { prompt: "do it", env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fake agent failed the print run/);
});

test("parseStructuredOutput extracts fenced JSON", () => {
  const raw = 'Here you go:\n```json\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}\n```\n';
  const parsed = parseStructuredOutput(raw);
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
});

test("parseStructuredOutput does not let fallback clobber canonical fields", () => {
  const parsed = parseStructuredOutput('{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}', {
    parsed: { verdict: "needs-attention" },
    parseError: "stale",
    rawOutput: "stale",
    status: 7
  });
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
  assert.equal(parsed.status, 7);
});

test("buildReviewPrompt includes target and focus", () => {
  const prompt = buildReviewPrompt({
    targetLabel: "working tree diff",
    focusText: "auth boundaries",
    collectionGuidance: "Use the repository context below as primary evidence.",
    reviewInput: "## Git Status\n M app.js"
  });
  assert.match(prompt, /working tree diff/);
  assert.match(prompt, /auth boundaries/);
  assert.match(prompt, /Git Status/);
});
