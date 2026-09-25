import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

import { adapter } from "./adapter.mjs";
import { readJsonFile } from "./fs.mjs";
import { quoteForCmd } from "./launch.mjs";
import { runCommand } from "./process.mjs";

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

export function resolveLaunch(env = process.env) {
  return adapter.resolveLaunch(env);
}

function spawnArgs(launch, args) {
  const full = [...launch.prefixArgs, ...args];
  if (!launch.shell) {
    return { command: launch.command, args: full, shell: false };
  }
  // `.cmd` shims: hand cmd.exe one pre-quoted command line.
  const line = [quoteForCmd(launch.command), ...full.map(quoteForCmd)].join(" ");
  return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], shell: false, verbatim: true };
}

function launchEnv(launch, env) {
  return { ...(env ?? process.env), ...launch.env };
}

export function runAgentCommand(args = [], options = {}) {
  const launch = options.launch ?? resolveLaunch(options.env ?? process.env);
  const spec = spawnArgs(launch, args);
  return runCommand(spec.command, spec.args, {
    cwd: options.cwd,
    env: launchEnv(launch, options.env),
    input: options.input,
    maxBuffer: options.maxBuffer,
    shell: false,
    windowsVerbatimArguments: spec.verbatim
  });
}

export function getAgentAvailability(cwd, options = {}) {
  const launch = options.launch ?? resolveLaunch(options.env ?? process.env);
  const result = runAgentCommand(adapter.versionArgs, { cwd, env: options.env, launch });
  const binary = launch.command;
  if (result.error) {
    const missing = /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT";
    return { available: false, detail: missing ? `${adapter.cliName} not found` : result.error.message, binary };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return { available: false, detail, binary };
  }
  return { available: true, detail: firstLine(result.stdout || result.stderr) || "ok", binary };
}

export function getAgentAuthStatus(cwd, options = {}) {
  const availability = options.availability ?? getAgentAvailability(cwd, options);
  if (!availability.available) {
    return { available: false, loggedIn: false, detail: availability.detail, source: "availability" };
  }
  if (typeof adapter.checkAuth === "function") {
    return { available: true, source: "adapter", ...adapter.checkAuth(options.env ?? process.env) };
  }
  if (!adapter.authArgs) {
    return { available: true, loggedIn: null, detail: "not verified (no auth probe for this CLI)", source: "none" };
  }
  const result = runAgentCommand(adapter.authArgs, { cwd, env: options.env });
  if (result.error) {
    return { available: true, loggedIn: false, detail: result.error.message, source: "auth-probe" };
  }
  const parsed = adapter.parseAuth
    ? adapter.parseAuth(result)
    : { loggedIn: result.status === 0, detail: firstLine(result.stdout || result.stderr) };
  return {
    available: true,
    source: "auth-probe",
    ...parsed,
    detail: parsed.detail || (parsed.loggedIn ? "authenticated" : "not authenticated")
  };
}

function firstLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function createRunDir() {
  const root = path.join(os.tmpdir(), "agent-bridges-cc", adapter.pluginName);
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, "run-"));
}

function preparePrompt(prompt, runDir, launch) {
  const mustUseFile =
    adapter.promptVia === "file" ||
    (adapter.promptVia === "arg" && (launch.shell || prompt.length > adapter.maxArgPromptChars));
  if (!mustUseFile) {
    return { prompt, promptFile: null };
  }
  const promptFile = path.join(runDir, "prompt.md");
  fs.writeFileSync(promptFile, prompt, "utf8");
  if (adapter.promptVia === "file") {
    return { prompt, promptFile };
  }
  return {
    prompt: `Read the complete task instructions from the file ${promptFile} and follow them exactly. That file is the task; this line only points to it.`,
    promptFile
  };
}

function gitSnapshot(cwd) {
  const status = runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd, shell: false });
  if (status.error || status.status !== 0) {
    return null;
  }
  const diff = runCommand("git", ["diff", "HEAD", "--no-ext-diff", "--binary"], { cwd, shell: false, maxBuffer: 64 * 1024 * 1024 });
  const digest = crypto.createHash("sha256").update(diff.stdout ?? "").digest("hex");
  return { lines: status.stdout.split(/\r?\n/).filter(Boolean), digest };
}

function compareSnapshots(before, after) {
  if (!before || !after) {
    return null;
  }
  if (before.digest === after.digest && before.lines.join("\n") === after.lines.join("\n")) {
    return null;
  }
  const previous = new Set(before.lines);
  const changed = after.lines.filter((line) => !previous.has(line));
  return changed.length > 0 ? changed : ["(tracked file contents changed)"];
}

/**
 * Run the provider CLI once, non-interactively, and collect its final answer.
 * Read-only runs are bracketed by a git snapshot so that a provider without a
 * real read-only mode cannot silently modify the working tree.
 */
export function runHeadlessAgent(cwd, options = {}) {
  const launch = options.launch ?? resolveLaunch(options.env ?? process.env);
  const rawPrompt = String(options.prompt ?? "").trim() || options.defaultPrompt || "";
  if (!rawPrompt) {
    return Promise.reject(new Error(`A prompt is required for this ${adapter.displayName} run.`));
  }

  const write = Boolean(options.write);
  const fullPrompt = !write && adapter.readOnlyPrompt ? `${rawPrompt}

${adapter.readOnlyPrompt}` : rawPrompt;
  const runDir = createRunDir();
  const { prompt, promptFile } = preparePrompt(fullPrompt, runDir, launch);
  const plan = adapter.buildRun({
    prompt,
    promptFile,
    runDir,
    cwd: options.cwd ?? cwd,
    write,
    model: options.model ?? null,
    effort: options.effort ?? null,
    resumeSessionId: options.resumeSessionId ?? null,
    newSessionId: crypto.randomUUID(),
    schemaPath: options.schemaPath ?? null,
    env: options.env ?? process.env
  });

  const guard = !write && options.guardReadOnly !== false ? gitSnapshot(cwd) : null;
  const spec = spawnArgs(launch, plan.args);
  const platform = options.platform ?? process.platform;
  const detached = options.detached ?? platform !== "win32";

  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: { ...launchEnv(launch, options.env), ...(plan.env ?? {}) },
      stdio: [plan.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
      detached,
      windowsHide: true,
      windowsVerbatimArguments: spec.verbatim
    });

    const agentPid = child.pid ?? null;
    const knownSessionId = plan.sessionId ?? options.resumeSessionId ?? null;
    emitProgress(options.onProgress, `Running ${adapter.cliName} (${launch.command}).`, "starting", {
      threadId: knownSessionId,
      agentPid,
      pid: agentPid
    });

    if (plan.stdin != null) {
      child.stdin.on("error", () => {});
      child.stdin.end(plan.stdin);
    }

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

    child.on("error", (error) => {
      fs.rmSync(runDir, { recursive: true, force: true });
      reject(error);
    });

    child.on("close", (code, signal) => {
      let status = code ?? (signal ? 1 : 0);
      let parsed;
      try {
        parsed = adapter.parseRun({ stdout, stderr, status, plan, runDir });
      } catch (error) {
        parsed = { finalMessage: stdout.trimEnd(), failure: `Could not parse ${adapter.cliName} output: ${error.message}` };
      }
      fs.rmSync(runDir, { recursive: true, force: true });

      const sessionId = parsed.sessionId ?? knownSessionId;
      if (status === 0 && parsed.failure) {
        status = 1;
      }
      const readOnlyViolation = guard ? compareSnapshots(guard, gitSnapshot(cwd)) : null;
      emitProgress(
        options.onProgress,
        status === 0 ? `${adapter.displayName} finished.` : `${adapter.displayName} exited with status ${status}.`,
        status === 0 ? "finalizing" : "failed",
        { threadId: sessionId, agentPid }
      );
      resolve({
        status,
        signal,
        stdout,
        stderr: [parsed.failure, stderr.trim()].filter(Boolean).join("\n"),
        notes: parsed.notes ?? [],
        sessionId,
        threadId: sessionId,
        agentPid,
        finalMessage: String(parsed.finalMessage ?? "").trimEnd(),
        readOnlyViolation,
        args: plan.args,
        binary: launch.command
      });
    });
  });
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      ...fallback,
      parsed: null,
      parseError: fallback.failureMessage || `${adapter.displayName} did not return a final structured message.`,
      rawOutput: rawOutput ?? ""
    };
  }

  const text = String(rawOutput).trim();

  try {
    return {
      ...fallback,
      parsed: JSON.parse(text),
      parseError: null,
      rawOutput: text
    };
  } catch {
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return {
        ...fallback,
        parsed: JSON.parse(fenced[1].trim()),
        parseError: null,
        rawOutput: text
      };
    } catch (error) {
      return {
        ...fallback,
        parsed: null,
        parseError: error.message,
        rawOutput: text
      };
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return {
        ...fallback,
        parsed: JSON.parse(text.slice(start, end + 1)),
        parseError: null,
        rawOutput: text
      };
    } catch (error) {
      return {
        ...fallback,
        parsed: null,
        parseError: error.message,
        rawOutput: text
      };
    }
  }

  return {
    ...fallback,
    parsed: null,
    parseError: `Could not parse structured JSON from ${adapter.displayName} output.`,
    rawOutput: text
  };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export function schemaInstructionsFromPath(schemaPath) {
  if (!schemaPath || !fs.existsSync(schemaPath)) {
    return "";
  }
  const schema = readJsonFile(schemaPath);
  return [
    "Return only valid JSON matching this schema:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```"
  ].join("\n");
}

export function buildReviewPrompt({ targetLabel, focusText, collectionGuidance, reviewInput, schemaInstructions = "" }) {
  const parts = [
    "You are performing a careful code review of the repository changes described below.",
    `Target: ${targetLabel}`,
    focusText ? `User focus: ${focusText}` : "User focus: none",
    "",
    "Rules:",
    "- Review only; do not modify files.",
    "- Prefer material findings over style nits.",
    "- Ground every finding in the provided context or read-only inspection.",
    collectionGuidance || "Use the repository context below as primary evidence.",
    "",
    reviewInput || "(no context)",
    schemaInstructions ? `\n${schemaInstructions}` : ""
  ];
  return parts.filter((line) => line !== undefined).join("\n");
}
