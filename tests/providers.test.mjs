import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import antigravity from "../providers/antigravity.mjs";
import copilot from "../providers/copilot.mjs";
import cursor from "../providers/cursor.mjs";
import devin from "../providers/devin.mjs";
import warp from "../providers/warp.mjs";
import { makeTempDir } from "./helpers.mjs";

const SESSION = "11111111-2222-4333-8444-555555555555";

function request(overrides = {}) {
  return {
    prompt: "do the thing",
    promptFile: null,
    runDir: makeTempDir(),
    cwd: "/repo",
    write: false,
    model: null,
    effort: null,
    resumeSessionId: null,
    newSessionId: SESSION,
    schemaPath: null,
    env: {},
    ...overrides
  };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function allValuesAfter(args, flag) {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []));
}

test("every provider declares the fields the core and templates rely on", () => {
  for (const provider of [antigravity, copilot, cursor, devin, warp]) {
    for (const field of ["id", "pluginName", "displayName", "productName", "cliName", "installHint", "authHint", "modelHint", "readOnlyNote"]) {
      assert.equal(typeof provider[field], "string", `${provider.id}.${field}`);
    }
    assert.equal(provider.pluginName, `${provider.id}-bridge`);
    for (const fn of ["resolveLaunch", "buildRun", "parseRun", "resumeCommand"]) {
      assert.equal(typeof provider[fn], "function", `${provider.id}.${fn}`);
    }
  }
});

// --- Cursor ---------------------------------------------------------------

test("cursor: read-only uses --mode ask and never --force; write uses --force", () => {
  const readOnly = cursor.buildRun(request());
  assert.equal(valueAfter(readOnly.args, "--mode"), "ask");
  assert.ok(!readOnly.args.includes("--force"));
  assert.ok(!readOnly.args.includes("--yolo"));
  assert.equal(readOnly.stdin, "do the thing", "the prompt goes through stdin, not argv");
  assert.ok(!readOnly.args.includes("do the thing"));
  assert.ok(readOnly.args.includes("-p"));
  assert.equal(valueAfter(readOnly.args, "--workspace"), "/repo");
  assert.equal(valueAfter(readOnly.args, "--output-format"), "json");

  const write = cursor.buildRun(request({ write: true }));
  assert.ok(write.args.includes("--force"));
  assert.ok(!write.args.includes("--mode"));
});

test("cursor: model and resume flags", () => {
  const plan = cursor.buildRun(request({ model: "gpt-5", resumeSessionId: "chat-1" }));
  assert.equal(valueAfter(plan.args, "--model"), "gpt-5");
  assert.equal(valueAfter(plan.args, "--resume"), "chat-1");
  assert.equal(cursor.efforts ?? null, null);
});

test("cursor: parseRun reads the json result event", () => {
  const stdout =
    '{"type":"result","subtype":"success","is_error":false,"duration_ms":7179,"duration_api_ms":7179,"result":"PONG","session_id":"dadb062e-4395-4f2e-8b01-b63372680206","request_id":"23c479e9-1550-4f1c-bd9e-7af9e1fd5d4a","usage":{"inputTokens":16553,"outputTokens":82,"cacheReadTokens":2912,"cacheWriteTokens":0}}\n';
  const parsed = cursor.parseRun({ stdout, stderr: "", status: 0 });
  assert.equal(parsed.finalMessage, "PONG");
  assert.equal(parsed.sessionId, "dadb062e-4395-4f2e-8b01-b63372680206");
  assert.equal(parsed.failure, null);

  const failed = cursor.parseRun({ stdout: '{"type":"result","is_error":true,"result":"boom","session_id":"x"}', stderr: "", status: 0 });
  assert.equal(failed.failure, "boom");

  const empty = cursor.parseRun({ stdout: "", stderr: "", status: 0 });
  assert.match(empty.failure, /no result event/);
});

// --- Devin ----------------------------------------------------------------

test("devin: read-only uses --permission-mode auto, write uses dangerous; prompt goes by file", () => {
  const runDir = makeTempDir();
  const readOnly = devin.buildRun(request({ runDir, promptFile: path.join(runDir, "prompt.md") }));
  assert.equal(valueAfter(readOnly.args, "--permission-mode"), "auto");
  assert.equal(valueAfter(readOnly.args, "--prompt-file"), path.join(runDir, "prompt.md"));
  assert.equal(valueAfter(readOnly.args, "--export"), path.join(runDir, "conversation.json"));
  assert.equal(valueAfter(readOnly.args, "--respect-workspace-trust"), "false");
  assert.equal(devin.promptVia, "file");

  const write = devin.buildRun(request({ runDir, promptFile: path.join(runDir, "prompt.md"), write: true }));
  assert.equal(valueAfter(write.args, "--permission-mode"), "dangerous");
});

test("devin: model and resume flags", () => {
  const plan = devin.buildRun(request({ promptFile: "p.md", model: "opus", resumeSessionId: "general-columnist" }));
  assert.equal(valueAfter(plan.args, "--model"), "opus");
  assert.equal(valueAfter(plan.args, "--resume"), "general-columnist");
});

test("devin: parseRun takes the session id and final answer from the export", () => {
  const runDir = makeTempDir();
  fs.writeFileSync(
    path.join(runDir, "conversation.json"),
    JSON.stringify({
      schema_version: "ATIF-v1.7",
      session_id: "general-columnist",
      agent: { name: "devin", version: "3000.11.1" },
      steps: [
        { step_id: 8, source: "agent", message: "I'll review the changes." },
        { step_id: 9, source: "agent", message: "PONG", tool_calls: [] }
      ]
    })
  );
  const parsed = devin.parseRun({
    stdout: "I'll review the changes.PONG\n",
    stderr: "warning: rejected a tool call that requires confirmation. Running in non-interactive mode.\n",
    status: 0,
    runDir
  });
  assert.equal(parsed.sessionId, "general-columnist");
  assert.equal(parsed.finalMessage, "PONG");
  assert.equal(parsed.notes.length, 1);

  const noExport = devin.parseRun({ stdout: "PONG\n", stderr: "", status: 0, runDir: makeTempDir() });
  assert.equal(noExport.finalMessage, "PONG");
  assert.equal(noExport.sessionId, null);
});

// --- Copilot --------------------------------------------------------------

test("copilot: read-only denies the write and shell tools; write does not", () => {
  const readOnly = copilot.buildRun(request());
  assert.deepEqual(allValuesAfter(readOnly.args, "--deny-tool").sort(), ["shell", "write"]);
  assert.ok(readOnly.args.includes("--allow-all-tools"), "non-interactive mode requires --allow-all-tools");
  assert.ok(!readOnly.args.includes("--allow-all") && !readOnly.args.includes("--yolo"));
  assert.equal(valueAfter(readOnly.args, "-p"), "do the thing");

  const write = copilot.buildRun(request({ write: true }));
  assert.equal(allValuesAfter(write.args, "--deny-tool").length, 0);
});

test("copilot: preassigns a session id, resumes, and maps effort", () => {
  const fresh = copilot.buildRun(request({ model: "auto", effort: "high" }));
  assert.equal(valueAfter(fresh.args, "--session-id"), SESSION);
  assert.equal(fresh.sessionId, SESSION);
  assert.equal(valueAfter(fresh.args, "--model"), "auto");
  assert.equal(valueAfter(fresh.args, "--reasoning-effort"), "high");
  assert.ok(copilot.efforts.includes("xhigh"));

  const resumed = copilot.buildRun(request({ resumeSessionId: "abc" }));
  assert.equal(valueAfter(resumed.args, "--resume"), "abc");
  assert.ok(!resumed.args.includes("--session-id"));
  assert.equal(resumed.sessionId, "abc");

  const withFile = copilot.buildRun(request({ promptFile: "/tmp/run/prompt.md", runDir: "/tmp/run" }));
  assert.equal(valueAfter(withFile.args, "--add-dir"), "/tmp/run");
});

test("copilot: parseRun returns plain stdout with the preassigned session id", () => {
  const plan = copilot.buildRun(request());
  const parsed = copilot.parseRun({ stdout: "PONG\n\n", stderr: "", status: 0, plan });
  assert.equal(parsed.finalMessage, "PONG");
  assert.equal(parsed.sessionId, SESSION);
});

test("copilot: auth is only claimed when a token is exported", () => {
  assert.equal(copilot.checkAuth({ GH_TOKEN: "x" }).loggedIn, true);
  assert.equal(copilot.checkAuth({}).loggedIn, null);
});

// --- Antigravity ----------------------------------------------------------

test("antigravity: read-only uses --mode plan and never skips permissions", () => {
  const readOnly = antigravity.buildRun(request());
  assert.equal(valueAfter(readOnly.args, "--mode"), "plan");
  assert.ok(!readOnly.args.includes("--dangerously-skip-permissions"));
  assert.equal(readOnly.args[0], "--print=do the thing");
  assert.equal(typeof antigravity.readOnlyPrompt, "string");
  assert.match(antigravity.readOnlyPrompt, /shell and terminal commands are denied/);

  const write = antigravity.buildRun(request({ write: true }));
  assert.equal(valueAfter(write.args, "--mode"), "accept-edits");
  assert.ok(write.args.includes("--dangerously-skip-permissions"));
});

test("antigravity: model, effort, resume and schema flags", () => {
  const plan = antigravity.buildRun(
    request({ model: "gemini-3.8-flash-high", effort: "low", resumeSessionId: "conv-1", schemaPath: "/s.json" })
  );
  assert.equal(valueAfter(plan.args, "--model"), "gemini-3.8-flash-high");
  assert.equal(valueAfter(plan.args, "--effort"), "low");
  assert.equal(valueAfter(plan.args, "--conversation"), "conv-1");
  assert.equal(valueAfter(plan.args, "--json-schema"), "/s.json");
  assert.equal(antigravity.structuredOutput, "schema");
});

test("antigravity: parseRun reads the result and reports denied actions", () => {
  const ok = antigravity.parseRun({
    stdout:
      '{"conversation_id":"b6b5ee36-e384-4f56-96f5-056c65e5d671","status":"SUCCESS","response":"PONG\\n","duration_seconds":5.3374788,"num_turns":1}\n',
    stderr: "",
    status: 0
  });
  assert.equal(ok.finalMessage, "PONG\n");
  assert.equal(ok.sessionId, "b6b5ee36-e384-4f56-96f5-056c65e5d671");
  assert.equal(ok.failure, null);
  assert.deepEqual(ok.notes, []);

  const denied = antigravity.parseRun({
    stdout:
      'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.\n{"conversation_id":"6b6bf6ed-18dc-469e-8cd3-ec0640859479","status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}\n',
    stderr: "",
    status: 0
  });
  assert.equal(denied.sessionId, "6b6bf6ed-18dc-469e-8cd3-ec0640859479");
  assert.deepEqual(denied.notes, ["Denied in headless mode: RunCommand"]);

  const failed = antigravity.parseRun({ stdout: '{"conversation_id":"c","status":"ERROR","response":""}', stderr: "", status: 0 });
  assert.match(failed.failure, /ERROR/);
});

// --- Warp -----------------------------------------------------------------

test("warp: read-only is only enforced with a configured profile", () => {
  assert.equal(warp.readOnlyEnforced({}), false);
  assert.equal(warp.readOnlyEnforced({ WARP_BRIDGE_READONLY_PROFILE: "ro-profile" }), true);

  const withProfile = warp.buildRun(request({ env: { WARP_BRIDGE_READONLY_PROFILE: "ro-profile", WARP_BRIDGE_WRITE_PROFILE: "rw" } }));
  assert.equal(valueAfter(withProfile.args, "--profile"), "ro-profile");

  const writeProfile = warp.buildRun(request({ write: true, env: { WARP_BRIDGE_READONLY_PROFILE: "ro-profile", WARP_BRIDGE_WRITE_PROFILE: "rw" } }));
  assert.equal(valueAfter(writeProfile.args, "--profile"), "rw");

  const noProfile = warp.buildRun(request());
  assert.ok(!noProfile.args.includes("--profile"));
  assert.deepEqual(noProfile.args.slice(0, 2), ["agent", "run"]);
  assert.equal(valueAfter(noProfile.args, "--prompt"), "do the thing");
  assert.equal(valueAfter(noProfile.args, "--cwd"), "/repo");
  assert.ok(noProfile.args.includes("--no-snapshot"));
});

test("warp: model and resume flags", () => {
  const plan = warp.buildRun(request({ model: "claude-4", resumeSessionId: "conv-9" }));
  assert.equal(valueAfter(plan.args, "--model"), "claude-4");
  assert.equal(valueAfter(plan.args, "--conversation"), "conv-9");
});

test("warp: parseRun keeps the last agent message and the conversation id", () => {
  const stdout = [
    '{"type":"system","event_type":"run_started","run_id":"01a0d7df-de44-76f7-bf17-5790af539b83","run_url":"https://oz.warp.dev/runs/01a0d7df-de44-76f7-bf17-5790af539b83"}',
    '{"type":"system","event_type":"conversation_started","conversation_id":"89ce84ff-56ce-487e-b9d8-4166c0d10afe"}',
    '{"type":"agent","text":"Let me correct that by reading the file properly:\\n"}',
    '{"type":"agent","text":"PONG\\n"}'
  ].join("\n");
  const parsed = warp.parseRun({ stdout, stderr: "", status: 0 });
  assert.equal(parsed.finalMessage, "PONG");
  assert.equal(parsed.sessionId, "89ce84ff-56ce-487e-b9d8-4166c0d10afe");
  assert.deepEqual(parsed.notes, ["Oz run: https://oz.warp.dev/runs/01a0d7df-de44-76f7-bf17-5790af539b83"]);
  assert.equal(parsed.failure, null);

  const errored = warp.parseRun({ stdout: '{"type":"error","message":"quota exceeded"}', stderr: "", status: 1 });
  assert.equal(errored.failure, "quota exceeded");
});

test("resume commands point at each CLI", () => {
  assert.equal(cursor.resumeCommand("x"), "cursor-agent --resume x");
  assert.equal(devin.resumeCommand("x"), "devin --resume x");
  assert.equal(copilot.resumeCommand("x"), "copilot --resume x");
  assert.equal(antigravity.resumeCommand("x"), "agy --conversation x");
  assert.match(warp.resumeCommand("x"), /^oz agent run --conversation x /);
});
