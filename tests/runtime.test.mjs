import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { buildEnv, installFakeAgent, lastPrintArgv } from "./fake-agent-fixture.mjs";
import {
  FAKE_DATA_ENV,
  FAKE_SESSION_ENV,
  initGitRepo,
  makeTempDir,
  ROOT,
  run,
  runBridge,
  withPluginData
} from "./helpers.mjs";
import {
  generateJobId,
  listJobs,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "./.generated/plugins/fake-bridge/scripts/lib/state.mjs";

function setup(scenario = "default") {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeBinary = installFakeAgent(binDir, scenario);
  const log = path.join(pluginDataDir, "fake-agent.log");
  const env = (extra = {}) => buildEnv(fakeBinary, { [FAKE_DATA_ENV]: pluginDataDir, FAKE_AGENT_LOG: log, ...extra });
  return { pluginDataDir, log, env };
}

function reviewableRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 1;\n");
  run("git", ["add", "src.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 2;\n");
  return repo;
}

function committedRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

test("check reports ready when the fake agent is installed and authenticated", () => {
  const { env } = setup();
  const result = runBridge(["check", "--json"], { cwd: ROOT, env: env() });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.provider, "fake");
  assert.equal(payload.cli.available, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.readOnly.enforced, true);
  assert.equal(payload.sessionRuntime.mode, "plugin-owned");
});

test("check reports not ready when the auth probe fails", () => {
  const { env } = setup("not-logged-in");
  const result = runBridge(["check", "--json"], { cwd: ROOT, env: env() });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.ok(payload.nextSteps.includes("Run `fake-agent login`."));
});

test("check reports the CLI as unavailable when the binary is missing", () => {
  const { env } = setup();
  const result = runBridge(["check", "--json"], {
    cwd: ROOT,
    env: env({ FAKE_AGENT_BINARY: path.join(makeTempDir(), "missing-agent") })
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.cli.available, false);
  assert.ok(payload.nextSteps.includes("Install the fake agent."));
});

test("review renders the fake agent's answer under the provider title", () => {
  const { env } = setup();
  const repo = reviewableRepo();
  const result = runBridge(["review"], { cwd: repo, env: env() });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Fake Agent Review/m);
  assert.match(result.stdout, /Target: /);
  assert.match(result.stdout, /No material issues found/);
  assert.doesNotMatch(result.stdout, /WARNING/);
});

test("critique returns a structured findings payload", () => {
  const { env } = setup();
  const repo = reviewableRepo();
  const result = runBridge(["critique", "--json", "focus on docs"], { cwd: repo, env: env() });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review, "Critique");
  assert.equal(payload.agent.provider, "fake");
  assert.equal(payload.result?.verdict, "approve");
  assert.ok(Array.isArray(payload.result?.findings));
});

test("review and critique forward --model and --effort, read-only", () => {
  for (const [command, effort] of [
    ["review", "high"],
    ["critique", "medium"]
  ]) {
    const { env, log } = setup();
    const repo = reviewableRepo();
    const result = runBridge([command, "--model", "fake-model", "--effort", effort, "focus"], { cwd: repo, env: env() });

    assert.equal(result.status, 0, result.stderr);
    const argv = lastPrintArgv(log);
    assert.equal(argv[argv.indexOf("--model") + 1], "fake-model");
    assert.equal(argv[argv.indexOf("--effort") + 1], effort);
    assert.ok(argv.includes("--read-only"), argv.join(" "));
  }
});

test("a quoted $ARGUMENTS string after the command's own flags is still split", () => {
  // review.md runs `review --background "$ARGUMENTS"`; the delegate agent may run `run --write "<task>"`.
  const { env, log } = setup();
  const repo = reviewableRepo();
  const result = runBridge(["critique", "--json", "--model fake-model --effort high focus on auth"], { cwd: repo, env: env() });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /unknown option/i);
  const argv = lastPrintArgv(log);
  assert.equal(argv[argv.indexOf("--model") + 1], "fake-model");
  assert.equal(argv[argv.indexOf("--effort") + 1], "high");
  assert.match(argv[1], /focus on auth/);

  const writable = setup();
  const run = runBridge(["run", "--write", "--model fake-model make the change"], { cwd: repo, env: writable.env() });
  assert.equal(run.status, 0, run.stderr);
  const runArgv = lastPrintArgv(writable.log);
  assert.ok(!runArgv.includes("--read-only"));
  assert.equal(runArgv[runArgv.indexOf("--model") + 1], "fake-model");
  assert.equal(runArgv[1], "make the change");
});

test("review rejects effort values the provider does not list", () => {
  const { env } = setup();
  const repo = reviewableRepo();
  for (const effort of ["extreme", "xhigh", "max"]) {
    const result = runBridge(["review", "--effort", effort], { cwd: repo, env: env() });
    assert.notEqual(result.status, 0, `expected rejection for --effort ${effort}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unsupported reasoning effort/i);
  }
});

test("run is read-only by default and write-capable with --write", () => {
  const readOnly = setup();
  const repo = committedRepo();
  const first = runBridge(["run", "check auth preflight"], { cwd: repo, env: readOnly.env() });
  assert.equal(first.status, 0, first.stderr);
  assert.ok(lastPrintArgv(readOnly.log).includes("--read-only"));

  const writable = setup();
  const second = runBridge(["run", "--write", "make the change"], { cwd: repo, env: writable.env() });
  assert.equal(second.status, 0, second.stderr);
  assert.ok(!lastPrintArgv(writable.log).includes("--read-only"));
});

test("read-only runs warn when the agent changes the working tree", () => {
  const { env } = setup("modifies-worktree");
  const repo = reviewableRepo();
  const result = runBridge(["review"], { cwd: repo, env: env() });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WARNING: Fake changed the working tree during a read-only run:/);
  assert.match(result.stdout, /touched-by-agent\.txt/);
});

test("write runs do not trigger the read-only working-tree warning", () => {
  const { env } = setup("modifies-worktree");
  const repo = committedRepo();
  const result = runBridge(["run", "--write", "touch something"], { cwd: repo, env: env() });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /WARNING/);
});

test("run surfaces agent failures with a non-zero exit", () => {
  const { env } = setup("fail-print");
  const repo = committedRepo();
  const result = runBridge(["run", "do it"], { cwd: repo, env: env() });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /fake agent failed the print run/);
});

test("run delegates through the fake agent and stores a finished job", () => {
  const { env, pluginDataDir } = setup();
  const repo = committedRepo();
  const result = runBridge(["run", "check auth preflight"], { cwd: repo, env: env() });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);

  withPluginData(pluginDataDir, () => {
    const jobs = listJobs(repo);
    assert.ok(jobs.length >= 1);
    assert.equal(jobs[0].jobClass, "task");
    assert.equal(jobs[0].status, "completed");
    assert.ok(jobs[0].threadId, "the session id assigned by the provider should be stored");
  });
});

test("runs and show surface the latest finished run with the resume command", () => {
  const { env } = setup();
  const repo = committedRepo();
  const task = runBridge(["run", "--json", "do a small thing"], { cwd: repo, env: env() });
  assert.equal(task.status, 0, task.stderr);
  const threadId = JSON.parse(task.stdout).threadId;
  assert.ok(threadId);

  const status = runBridge(["runs", "--json"], { cwd: repo, env: env() });
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.latestFinished?.status, "completed");

  const result = runBridge(["show"], { cwd: repo, env: env() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
  assert.match(result.stdout, new RegExp(`Fake session ID: ${threadId}`));
  assert.match(result.stdout, new RegExp(`Resume in Fake: fake-agent --resume ${threadId}`));
});

test("--resume-last continues the stored provider session", () => {
  const { env, log } = setup();
  const repo = committedRepo();
  const sessionEnv = { [FAKE_SESSION_ENV]: "claude-session-1" };

  const first = runBridge(["run", "--json", "first task"], { cwd: repo, env: env(sessionEnv) });
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout).threadId;

  const candidate = runBridge(["run-resume-candidate", "--json"], { cwd: repo, env: env(sessionEnv) });
  assert.equal(candidate.status, 0, candidate.stderr);
  const payload = JSON.parse(candidate.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.candidate?.threadId, threadId);

  const resumed = runBridge(["run", "--resume-last", "keep going"], { cwd: repo, env: env(sessionEnv) });
  assert.equal(resumed.status, 0, resumed.stderr);
  const argv = lastPrintArgv(log);
  assert.equal(argv[argv.indexOf("--resume") + 1], threadId);
});

function processAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code !== "ESRCH";
  }
  if (process.platform === "win32") {
    return true;
  }
  // Zombies still accept kill(0); treat them as not running.
  const ps = run("ps", ["-p", String(pid), "-o", "stat="]);
  const stat = String(ps.stdout ?? "").trim().toUpperCase();
  return Boolean(stat) && !stat.includes("Z");
}

async function waitUntilDead(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processAlive(pid);
}

test("stop terminates a tracked sleeper process and marks the run cancelled", async () => {
  const { env, pluginDataDir } = setup();
  const repo = committedRepo();

  const sleeper = () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
      cwd: repo,
      stdio: "ignore",
      detached: true
    });
    child.unref();
    return child.pid;
  };
  const agentPid = sleeper();
  const bridgePid = sleeper();

  try {
    const jobId = withPluginData(pluginDataDir, () => {
      const id = generateJobId("run");
      const jobsDir = path.join(resolveStateDir(repo), "jobs");
      fs.mkdirSync(jobsDir, { recursive: true });
      const logFile = path.join(jobsDir, `${id}.log`);
      fs.writeFileSync(logFile, "", "utf8");
      const job = {
        id,
        kind: "task",
        kindLabel: "delegate",
        title: "Fake Agent Delegate",
        workspaceRoot: repo,
        jobClass: "task",
        summary: "fake running",
        status: "running",
        phase: "running",
        bridgePid,
        pid: bridgePid,
        agentPid,
        logFile,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      writeJobFile(repo, id, job);
      upsertJob(repo, job);
      return id;
    });

    const result = runBridge(["stop", jobId, "--json"], { cwd: repo, env: env() });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "cancelled");
    assert.equal(payload.jobId, jobId);
    assert.equal(payload.killDelivered, true);
    assert.ok(payload.killTargets?.includes(agentPid));
    assert.ok(payload.killTargets?.includes(bridgePid));

    withPluginData(pluginDataDir, () => {
      assert.equal(listJobs(repo).find((entry) => entry.id === jobId)?.status, "cancelled");
    });

    assert.equal(await waitUntilDead(agentPid), true);
    assert.equal(await waitUntilDead(bridgePid), true);
  } finally {
    for (const pid of [agentPid, bridgePid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  }
});

test("enqueueBackgroundJob writes the job file before spawning the worker", async () => {
  const { enqueueBackgroundJob } = await import("./.generated/plugins/fake-bridge/scripts/bridge.mjs");
  const repo = makeTempDir();
  const pluginDataDir = makeTempDir();

  await withPluginData(pluginDataDir, async () => {
    const events = [];
    const job = {
      id: generateJobId("run"),
      kind: "task",
      kindLabel: "delegate",
      title: "Fake Agent Delegate",
      workspaceRoot: repo,
      jobClass: "task",
      summary: "bg order",
      write: false
    };

    const result = enqueueBackgroundJob(
      repo,
      job,
      { kind: "task", cwd: repo, prompt: "hello", write: false, resumeLast: false, jobId: job.id },
      {
        spawnWorker(cwd, jobId) {
          events.push("spawn");
          const stored = readStoredJobFromDisk(repo, jobId);
          events.push(stored ? "job-present-at-spawn" : "job-missing-at-spawn");
          assert.ok(stored, "job file must exist before worker spawn");
          assert.equal(stored.status, "queued");
          assert.equal(stored.pid, null);
          return { pid: 424242 };
        }
      }
    );

    assert.deepEqual(events, ["spawn", "job-present-at-spawn"]);
    assert.equal(result.payload.status, "queued");
    assert.equal(result.payload.pid, 424242);
    assert.equal(result.payload.bridgePid, 424242);
    assert.equal(listJobs(repo)[0].pid, 424242);
  });
});

test("a background run completes through the detached worker", async () => {
  const { env } = setup();
  const repo = committedRepo();
  const queued = runBridge(["run", "--background", "--json", "background task"], { cwd: repo, env: env() });
  assert.equal(queued.status, 0, queued.stderr);
  const { jobId } = JSON.parse(queued.stdout);

  const waited = runBridge(["runs", jobId, "--wait", "--timeout-ms", "30000", "--json"], { cwd: repo, env: env() });
  assert.equal(waited.status, 0, waited.stderr);
  const snapshot = JSON.parse(waited.stdout);
  assert.equal(snapshot.job.status, "completed");

  const shown = runBridge(["show", jobId], { cwd: repo, env: env() });
  assert.match(shown.stdout, /Handled the requested task/);
});

function readStoredJobFromDisk(workspaceRoot, jobId) {
  const jobFile = path.join(resolveStateDir(workspaceRoot), "jobs", `${jobId}.json`);
  return fs.existsSync(jobFile) ? JSON.parse(fs.readFileSync(jobFile, "utf8")) : null;
}
