// Run steps through the installed bridge plugins and schedule a workflow.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveProvider } from "./registry.mjs";
import { blockedBy, buildStepPrompt, nextRunnable } from "./workflow.mjs";

const STDERR_TAIL_CHARS = 4000;

function tail(text, limit = STDERR_TAIL_CHARS) {
  const value = String(text ?? "").trim();
  return value.length > limit ? `…${value.slice(-limit)}` : value;
}

/** The provider scripts print one JSON document with `--json`. */
export function parseProviderPayload(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/^\{/m);
    if (start === -1) {
      return null;
    }
    try {
      return JSON.parse(text.slice(start));
    } catch {
      return null;
    }
  }
}

export function makeRunDir(prefix = "bridges-hub-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Run one step through its provider's task command.
 * @returns {Promise<{status: "completed"|"failed", output: string, error: string|null, exitCode: number|null, durationMs: number}>}
 */
export function runProviderTask({ provider, prompt, mode, model, effort, cwd, env, runDir, stepId, onSpawn }) {
  const started = Date.now();
  const promptFile = path.join(runDir, `${stepId}.prompt.md`);
  fs.writeFileSync(promptFile, prompt, "utf8");

  const args = [provider.script, provider.subcommand, "--json", "--cwd", cwd, "--prompt-file", promptFile];
  if (mode === "write") {
    args.push("--write");
  }
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", effort);
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    onSpawn?.(child.pid);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const finish = (exitCode, spawnError) => {
      const payload = parseProviderPayload(stdout);
      const output = typeof payload?.rawOutput === "string" ? payload.rawOutput.trim() : "";
      const succeeded = !spawnError && exitCode === 0 && payload && (payload.status ?? 0) === 0;
      const error = succeeded
        ? null
        : spawnError?.message || tail(stderr) || (payload ? `${provider.label} reported status ${payload.status}.` : `${provider.label} returned no JSON result.`);
      resolve({
        status: succeeded ? "completed" : "failed",
        output: output || (succeeded ? "" : error),
        error,
        exitCode,
        durationMs: Date.now() - started
      });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code, null));
  });
}

/**
 * Run a validated workflow. `steps` are resolved steps (see resolveStep).
 * @returns {Promise<{status: "completed"|"failed", results: Map<string, object>}>}
 */
export async function runWorkflow(steps, { context, cwd, env, workspaceRoot, maxParallel = 3, runDir = makeRunDir(), onEvent }) {
  const states = new Map(steps.map((step) => [step.id, { status: "pending" }]));
  const providers = new Map();
  for (const step of steps) {
    if (!providers.has(step.provider)) {
      const provider = resolveProvider(step.provider, { env, workspaceRoot });
      if (!provider.found) {
        throw new Error(`Step \`${step.id}\`: ${provider.reason}`);
      }
      providers.set(step.provider, provider);
    }
  }

  const running = new Map();
  let stopped = false;

  const launch = (step) => {
    const provider = providers.get(step.provider);
    const prompt = buildStepPrompt(step, { ...context, steps: Object.fromEntries([...states].map(([id, state]) => [id, state])) });
    states.set(step.id, { status: "running", startedAt: new Date().toISOString(), provider: step.provider });
    onEvent?.({ type: "step-start", step, provider });
    const promise = runProviderTask({
      provider,
      prompt,
      mode: step.mode,
      model: step.model,
      effort: step.effort,
      cwd,
      env,
      runDir,
      stepId: step.id,
      onSpawn: (pid) => onEvent?.({ type: "step-spawn", step, pid })
    }).then((result) => {
      states.set(step.id, { ...states.get(step.id), ...result });
      running.delete(step.id);
      onEvent?.({ type: "step-end", step, provider, result });
      if (result.status === "failed" && step.onFailure !== "continue") {
        stopped = true;
      }
    });
    running.set(step.id, promise);
  };

  for (;;) {
    if (stopped) {
      for (const step of steps) {
        if (states.get(step.id).status === "pending") {
          states.set(step.id, { status: "skipped", error: "Skipped: an earlier step failed." });
        }
      }
    } else {
      for (const step of blockedBy(steps, states)) {
        states.set(step.id, { status: "skipped", error: "Skipped: a step it depends on did not complete." });
      }
      for (const step of nextRunnable(steps, states, { maxParallel })) {
        launch(step);
      }
    }
    if (running.size === 0) {
      break;
    }
    await Promise.race(running.values());
  }
  for (const step of steps) {
    if (states.get(step.id).status === "pending") {
      states.set(step.id, { status: "skipped", error: "Skipped: its dependencies never completed." });
    }
  }

  const failed = steps.some((step) => {
    const status = states.get(step.id).status;
    return status === "skipped" || (status === "failed" && step.onFailure !== "continue");
  });
  return { status: failed ? "failed" : "completed", results: states };
}
