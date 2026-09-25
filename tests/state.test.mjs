import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  ensurePrivateDir,
  ensureStateDir,
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolvePluginDataDir,
  resolveStateFile,
  saveState
} from "./.generated/plugins/fake-bridge/scripts/lib/state.mjs";

function withEnv(vars, fn) {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("resolveStateDir uses a temp-backed per-plugin, per-workspace directory", () => {
  withEnv({ AGENT_BRIDGES_DATA_FAKE: null, CLAUDE_PLUGIN_DATA: null }, () => {
    const stateDir = resolveStateDir(makeTempDir());
    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, /fake-bridge-runs/);
  });
});

test("resolveStateDir honors the plugin-specific data variable", () => {
  const pluginDataDir = makeTempDir();
  withEnv({ AGENT_BRIDGES_DATA_FAKE: pluginDataDir, CLAUDE_PLUGIN_DATA: null }, () => {
    const stateDir = resolveStateDir(makeTempDir());
    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  });
});

test("resolvePluginDataDir ignores another plugin's CLAUDE_PLUGIN_DATA", () => {
  const base = makeTempDir();
  const other = path.join(base, "cursor-bridge-agent-bridges");
  const own = path.join(base, "fake-bridge-agent-bridges");
  assert.equal(resolvePluginDataDir({ CLAUDE_PLUGIN_DATA: other }), null);
  assert.equal(resolvePluginDataDir({ CLAUDE_PLUGIN_DATA: own }), own);
  assert.equal(resolvePluginDataDir({ CLAUDE_PLUGIN_DATA: other, AGENT_BRIDGES_DATA_FAKE: own }), own);
  withEnv({ AGENT_BRIDGES_DATA_FAKE: null, CLAUDE_PLUGIN_DATA: other }, () => {
    assert.doesNotMatch(resolveStateDir(makeTempDir()), /cursor-bridge/);
  });
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: {},
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: {},
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("loadState quarantines corrupt state and throws instead of wiping", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "{not-json", "utf8");

  assert.throws(() => loadState(workspace), /corrupt|quarantined/i);

  const dirEntries = fs.readdirSync(path.dirname(stateFile));
  assert.ok(dirEntries.some((name) => name.startsWith("state.json.corrupt-")));
  assert.equal(fs.existsSync(stateFile), false);
});

test("loadState returns default state when the file is missing", () => {
  const workspace = makeTempDir();
  const state = loadState(workspace);
  assert.equal(state.version, 1);
  assert.deepEqual(state.jobs, []);
  assert.deepEqual(state.config, {});
});

test("ensurePrivateDir refuses a directory owned by another account", () => {
  const dir = path.join(makeTempDir(), "runs");
  fs.mkdirSync(dir);
  const otherUid = fs.lstatSync(dir).uid + 1;
  assert.throws(() => ensurePrivateDir(dir, otherUid), /not a directory owned by the current user/);
});

test("ensurePrivateDir refuses a non-directory at the path", () => {
  const file = path.join(makeTempDir(), "runs");
  fs.writeFileSync(file, "", "utf8");
  assert.throws(() => ensurePrivateDir(file, fs.lstatSync(file).uid), /not a directory owned by the current user/);
});

test("ensurePrivateDir tightens a group or world accessible directory", { skip: process.platform === "win32" }, () => {
  const dir = path.join(makeTempDir(), "runs");
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o777);
  ensurePrivateDir(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test("the tmp fallback state root is owner-only", { skip: process.platform === "win32" }, () => {
  withEnv({ AGENT_BRIDGES_DATA_FAKE: null, CLAUDE_PLUGIN_DATA: null }, () => {
    const workspace = makeTempDir();
    ensureStateDir(workspace);
    const root = path.dirname(resolveStateDir(workspace));
    assert.match(root, /fake-bridge-runs$/);
    assert.equal(fs.statSync(root).mode & 0o077, 0);
  });
});
