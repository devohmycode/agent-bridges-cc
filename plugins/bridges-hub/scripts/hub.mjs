#!/usr/bin/env node
// Bridges Hub: run a provider under a profile (`ask`) or chain several
// providers (`flow`), through the bridge plugins Claude Code installed.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { loadCatalog, loadFile, resolveProfile } from "./lib/catalog.mjs";
import { buildSingleJobSnapshot, buildStatusSnapshot, readStoredJob, resolveCancelableJob, resolveResultJob } from "./lib/job-control.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { knownProviderIds, PROVIDERS, resolveProvider } from "./lib/registry.mjs";
import { renderCancelReport, renderJobStatusReport, renderStatusReport, renderStoredJobResult } from "./lib/render.mjs";
import { makeRunDir, runWorkflow } from "./lib/runner.mjs";
import { claimJobTerminal, generateJobId, patchJobIfActive, upsertJob, writeJobFile } from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobRecord,
  resolveJobKillTargets,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import {
  buildStepPrompt,
  nextRunnable,
  profileWarnings,
  requiredInputs,
  resolveStep,
  validateProfile,
  validateWorkflow
} from "./lib/workflow.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT = fileURLToPath(import.meta.url);

function printUsage() {
  process.stdout.write(
    [
      "Bridges Hub for Claude Code",
      "",
      "Usage:",
      "  node scripts/hub.mjs check [--json]",
      "  node scripts/hub.mjs list [profiles|workflows] [--all] [--json]",
      "  node scripts/hub.mjs validate [name|file.md] [--json]",
      "  node scripts/hub.mjs ask <provider> [--profile <name>] [--write] [--model <m>] [--effort <e>] [--background] [--json] [task]",
      "  node scripts/hub.mjs flow <workflow> [--var key=value]... [--model <m>] [--effort <e>] [--dry-run] [--max-parallel <n>] [--background] [--json] [task]",
      "  node scripts/hub.mjs runs [run-id] [--all] [--json]",
      "  node scripts/hub.mjs show [run-id] [--json]",
      "  node scripts/hub.mjs stop [run-id] [--json]",
      ""
    ].join("\n")
  );
}

function output(value, asJson) {
  process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : value);
}

/**
 * Split a single "$ARGUMENTS" string and pull out repeatable `--var k=v`.
 * With `config.leading` (e.g. 1 for `flow <workflow>`), every token after
 * the first word of the task is task text, so a task may mention `--flags`.
 */
function parseInput(argv, config = {}) {
  const tokens = argv.length === 1 ? splitRawArgumentString(argv[0] ?? "") : argv;
  const valueOptions = ["cwd", ...(config.valueOptions ?? [])];
  const takesValue = new Set([...valueOptions.map((name) => `--${name}`), "-C", "-m"]);
  const vars = {};
  const rest = [];
  let positionals = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (config.leading != null && !token.startsWith("-")) {
      positionals += 1;
      if (positionals > config.leading) {
        rest.push("--", ...tokens.slice(index));
        break;
      }
    }
    if (takesValue.has(token)) {
      rest.push(token, tokens[(index += 1)]);
      continue;
    }
    const inline = /^--var=(.*)$/.exec(token);
    if (token === "--var" || inline) {
      const pair = inline ? inline[1] : tokens[(index += 1)];
      const eq = pair == null ? -1 : pair.indexOf("=");
      if (eq <= 0) {
        throw new Error("`--var` expects key=value.");
      }
      vars[pair.slice(0, eq)] = pair.slice(eq + 1);
      continue;
    }
    rest.push(token);
  }
  const parsed = parseArgs(rest.filter((token) => token !== undefined), {
    valueOptions,
    booleanOptions: ["json", ...(config.booleanOptions ?? [])],
    aliasMap: { C: "cwd", m: "model" },
    unknownMode: "warn"
  });
  for (const token of parsed.unknown) {
    process.stderr.write(`Warning: ignoring unknown option ${token}\n`);
  }
  const cwd = parsed.options.cwd ? path.resolve(process.cwd(), parsed.options.cwd) : process.cwd();
  return { ...parsed, vars, cwd, workspaceRoot: resolveWorkspaceRoot(cwd) };
}

function catalogs(workspaceRoot) {
  return {
    profiles: loadCatalog("profiles", { workspaceRoot }),
    workflows: loadCatalog("workflows", { workspaceRoot })
  };
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return "";
  }
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function cell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

// ---------------------------------------------------------------- check / list

function handleCheck(argv) {
  const { options, workspaceRoot } = parseInput(argv);
  const providers = knownProviderIds().map((id) => resolveProvider(id, { workspaceRoot }));
  const payload = { ready: providers.some((provider) => provider.found), providers };
  const lines = ["# Bridges Hub Check", "", "| Provider | Plugin | Installed | Version | Note |", "| --- | --- | --- | --- | --- |"];
  for (const provider of providers) {
    lines.push(`| ${provider.id} | ${cell(provider.plugin)} | ${provider.found ? "yes" : "no"} | ${cell(provider.version)} | ${cell(provider.reason)} |`);
  }
  if (!payload.ready) {
    lines.push("", "No bridge plugin is installed: install at least one from the `agent-bridges` marketplace.");
  }
  lines.push("", "Each bridge still needs its own CLI installed and signed in: run its `/<plugin>:check` (Codex: `/codex:setup`).");
  output(options.json ? payload : `${lines.join("\n")}\n`, options.json);
}

function describeLayer(item) {
  if (!item.overrides) {
    return item.source;
  }
  return `${item.source} (${item.extended ? "extends" : "overrides"} ${item.overrides})`;
}

function handleList(argv) {
  const { options, positionals, workspaceRoot } = parseInput(argv, { booleanOptions: ["all"] });
  const which = positionals[0] ?? "all";
  if (!["all", "profiles", "workflows"].includes(which)) {
    throw new Error("`list` takes `profiles`, `workflows`, or nothing.");
  }
  const { profiles, workflows } = catalogs(workspaceRoot);
  const payload = {};
  const lines = [];
  if (which !== "workflows") {
    // `_name` profiles are building blocks for `include`, hidden unless --all.
    payload.profiles = [...profiles.items.values()].filter((item) => options.all || !item.name.startsWith("_")).map(({ name, description, provider, mode, source, overrides, extended, file }) => ({ name, description, provider, mode: mode ?? "read", source, overrides, extended, file }));
    lines.push("# Profiles", "", "| Profile | Provider | Mode | Source | Description |", "| --- | --- | --- | --- | --- |");
    for (const item of payload.profiles) {
      lines.push(`| ${item.name} | ${cell(item.provider ?? "any")} | ${item.mode} | ${cell(describeLayer(item))} | ${cell(item.description)} |`);
    }
    lines.push("");
  }
  if (which !== "profiles") {
    payload.workflows = [...workflows.items.values()].map(({ name, description, steps, source, overrides, file }) => ({
      name,
      description,
      steps: steps.map((step) => step.id),
      order: waves(steps.map((step) => ({ ...step, mode: step.mode ?? "read" }))).map((wave) => wave.join(" + ")).join(" → "),
      source,
      overrides,
      file
    }));
    lines.push("# Workflows", "", "| Workflow | Steps | Source | Description |", "| --- | --- | --- | --- |");
    for (const item of payload.workflows) {
      lines.push(`| ${item.name} | ${cell(item.order)} | ${cell(describeLayer(item))} | ${cell(item.description)} |`);
    }
    lines.push("");
  }
  payload.problems = [...profiles.problems, ...workflows.problems];
  if (payload.problems.length > 0) {
    lines.push("Files that failed to load:", ...payload.problems.map((problem) => `- ${problem.file}: ${problem.message}`), "");
  }
  lines.push("Custom files go in `.claude/bridges-hub/{profiles,workflows}/` (project) or `~/.claude/bridges-hub/{profiles,workflows}/` (user).");
  output(options.json ? payload : `${lines.join("\n")}\n`, options.json);
}

// -------------------------------------------------------------------- validate

function handleValidate(argv) {
  const { options, positionals, workspaceRoot } = parseInput(argv);
  const { profiles, workflows } = catalogs(workspaceRoot);
  const target = positionals.join(" ").trim();
  const problems = [...profiles.problems.map((p) => `${p.file}: ${p.message}`), ...workflows.problems.map((p) => `${p.file}: ${p.message}`)];
  const checked = [];
  const warnings = [];

  let items;
  if (!target) {
    items = [...profiles.items.values(), ...workflows.items.values()];
  } else if (target.endsWith(".md") || fs.existsSync(target)) {
    let item = loadFile(path.resolve(process.cwd(), target));
    if (item.kind === "profile") {
      // Resolve against the catalog; `extends: <own name>` targets its top version.
      try {
        item = resolveProfile(item, profiles.stacks, -1);
      } catch (error) {
        problems.push(error.message);
      }
      profiles.items.set(item.name, item);
    }
    items = [item];
  } else {
    const item = workflows.items.get(target) ?? profiles.items.get(target);
    if (!item) {
      throw new Error(`No profile or workflow named \`${target}\`. Run \`list\` to see them.`);
    }
    items = [item];
  }

  for (const item of items) {
    checked.push(`${item.kind} ${item.name}`);
    if (item.kind === "profile") {
      problems.push(...validateProfile(item));
      warnings.push(...profileWarnings(item));
    } else {
      problems.push(...validateWorkflow(item, { profiles: profiles.items }));
    }
  }
  const payload = { valid: problems.length === 0, checked, problems, warnings };
  const warningLines = warnings.length ? `\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}\n` : "";
  const rendered = payload.valid
    ? `Valid: ${checked.join(", ")}.\n${warningLines}`
    : `# Validation failed\n\n${problems.map((problem) => `- ${problem}`).join("\n")}\n${warningLines}`;
  output(options.json ? payload : rendered, options.json);
  if (!payload.valid) {
    process.exitCode = 1;
  }
}

// -------------------------------------------------------------- ask / flow plan

function planAsk({ options, positionals, workspaceRoot }) {
  const [providerId, ...taskWords] = positionals;
  if (!providerId) {
    throw new Error("Usage: ask <provider> [--profile <name>] [task]");
  }
  const { profiles } = catalogs(workspaceRoot);
  if (options.profile && !profiles.items.has(options.profile)) {
    throw new Error(`Unknown profile \`${options.profile}\`. Run \`list profiles\`.`);
  }
  const task = taskWords.join(" ").trim();
  if (!task) {
    throw new Error("Give the task to hand over after the provider name.");
  }
  const workflow = {
    kind: "workflow",
    name: `ask-${providerId}`,
    steps: [
      {
        id: "ask",
        provider: providerId,
        profile: options.profile ?? null,
        mode: options.write ? "write" : null,
        model: options.model ?? null,
        effort: options.effort ?? null,
        after: [],
        onFailure: "stop",
        extraKeys: [],
        prompt: ""
      }
    ]
  };
  const problems = validateWorkflow(workflow, { profiles: profiles.items });
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
  return {
    kind: "ask",
    title: `Ask ${providerId}${options.profile ? ` as ${options.profile}` : ""}`,
    workflowName: null,
    steps: workflow.steps.map((step) => resolveStep(step, profiles.items)),
    context: { task, vars: {} }
  };
}

function planFlow({ options, positionals, vars: cliVars, workspaceRoot }) {
  const [name, ...taskWords] = positionals;
  if (!name) {
    throw new Error("Usage: flow <workflow> [--var key=value]... [task]");
  }
  const { profiles, workflows } = catalogs(workspaceRoot);
  const workflow = workflows.items.get(name);
  if (!workflow) {
    throw new Error(`Unknown workflow \`${name}\`. Run \`list workflows\`.`);
  }
  const problems = validateWorkflow(workflow, { profiles: profiles.items });
  if (problems.length > 0) {
    throw new Error(`Workflow \`${name}\` is invalid:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
  const task = taskWords.join(" ").trim();
  const vars = { ...workflow.vars, ...cliVars };
  const inputs = requiredInputs(workflow, profiles.items);
  const missing = inputs.vars.filter((key) => !(key in vars));
  if (missing.length > 0) {
    throw new Error(`Workflow \`${name}\` needs ${missing.map((key) => `\`--var ${key}=...\``).join(", ")}.`);
  }
  if (inputs.task && !task) {
    throw new Error(`Workflow \`${name}\` needs a task: \`flow ${name} <task>\`.`);
  }
  return {
    kind: "workflow",
    title: `Workflow ${name}`,
    workflowName: name,
    // `--model`/`--effort` fill in steps that set neither themselves nor via their profile.
    steps: workflow.steps.map((raw) => {
      const step = resolveStep(raw, profiles.items);
      return {
        ...step,
        model: step.model ?? options.model ?? null,
        effort: step.effort ?? options.effort ?? null,
        exclude: [...new Set([...workflow.exclude, ...step.exclude])]
      };
    }),
    context: { task, vars }
  };
}

function waves(steps) {
  const states = new Map(steps.map((step) => [step.id, { status: "pending" }]));
  const result = [];
  for (;;) {
    const batch = nextRunnable(steps, states, { maxParallel: Infinity });
    if (batch.length === 0) {
      return result;
    }
    batch.forEach((step) => states.set(step.id, { status: "completed" }));
    result.push(batch.map((step) => step.id));
  }
}

function renderDryRun(plan, workspaceRoot) {
  const lines = [`# ${plan.title} (dry run)`, ""];
  if (plan.context.task) {
    lines.push(`Task: ${plan.context.task}`, "");
  }
  lines.push("| Step | Provider | Installed | Profile | Mode | After |", "| --- | --- | --- | --- | --- | --- |");
  for (const step of plan.steps) {
    const provider = resolveProvider(step.provider, { workspaceRoot });
    lines.push(`| ${step.id} | ${step.provider} | ${provider.found ? "yes" : `no — ${cell(provider.reason)}`} | ${cell(step.profile ?? "")} | ${step.mode} | ${cell(step.after.join(", "))} |`);
  }
  lines.push("", `Order: ${waves(plan.steps).map((wave) => wave.join(" + ")).join(" → ")}`, "");
  const placeholderSteps = Object.fromEntries(plan.steps.map((step) => [step.id, { output: `<output of ${step.id}>`, status: "<status>" }]));
  for (const step of plan.steps) {
    lines.push(`## Prompt for \`${step.id}\``, "", "```text", buildStepPrompt(step, { ...plan.context, steps: placeholderSteps }).trimEnd(), "```", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderReport(plan, run, jobId) {
  const lines = [`# ${plan.title}`, ""];
  if (plan.context.task) {
    lines.push(`Task: ${plan.context.task}`);
  }
  lines.push(`Status: ${run.status}`);
  if (jobId) {
    lines.push(`Run: ${jobId}`);
  }
  lines.push("", "| Step | Provider | Mode | Status | Duration |", "| --- | --- | --- | --- | --- |");
  for (const step of plan.steps) {
    const result = run.results.get(step.id);
    lines.push(`| ${step.id} | ${PROVIDERS[step.provider]?.label ?? step.provider} | ${step.mode} | ${result.status} | ${formatDuration(result.durationMs)} |`);
  }
  for (const step of plan.steps) {
    const result = run.results.get(step.id);
    lines.push("", `## ${step.id} — ${PROVIDERS[step.provider]?.label ?? step.provider} (${step.mode}, ${result.status})`, "");
    lines.push(result.output || result.error || "(no output)");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// ------------------------------------------------------------------- execution

async function executePlan(plan, { cwd, workspaceRoot, jobId, maxParallel, logFile, echo }) {
  const stepPids = new Set();
  const stepSummary = () =>
    Object.fromEntries(plan.steps.map((step) => [step.id, { provider: step.provider, mode: step.mode }]));
  // Bookkeeping must never abort a run (e.g. a state lock timeout under load).
  const track = (patch) => {
    try {
      patchJobIfActive(workspaceRoot, jobId, patch);
    } catch (error) {
      appendLogLine(logFile, `Could not record progress: ${error.message}`);
    }
  };
  const log = (message) => {
    appendLogLine(logFile, message);
    if (echo) {
      process.stderr.write(`[bridges-hub] ${message}\n`);
    }
  };

  const run = await runWorkflow(plan.steps, {
    context: plan.context,
    cwd,
    env: process.env,
    workspaceRoot,
    maxParallel,
    runDir: makeRunDir(),
    onEvent: (event) => {
      if (event.type === "step-start") {
        log(`Step ${event.step.id}: ${event.provider.label} (${event.step.mode}) started.`);
        if (jobId) {
          track({ phase: `step ${event.step.id}`, steps: stepSummary() });
        }
      } else if (event.type === "step-spawn" && event.pid) {
        stepPids.add(event.pid);
        if (jobId) {
          track({ agentPid: event.pid, stepPids: [...stepPids] });
        }
      } else if (event.type === "step-end") {
        log(`Step ${event.step.id}: ${event.result.status} in ${formatDuration(event.result.durationMs)}.`);
      }
    }
  });

  const results = Object.fromEntries([...run.results].map(([id, result]) => [id, result]));
  const rendered = renderReport(plan, run, jobId);
  return {
    exitStatus: run.status === "completed" ? 0 : 1,
    threadId: null,
    turnId: null,
    payload: { status: run.status, workflow: plan.workflowName, task: plan.context.task, steps: results },
    rendered,
    summary: `${plan.title}: ${run.status}`
  };
}

function createHubJob(plan, workspaceRoot) {
  return createJobRecord({
    id: generateJobId(plan.kind === "ask" ? "ask" : "flow"),
    kind: plan.kind,
    kindLabel: plan.kind,
    title: plan.title,
    workspaceRoot,
    jobClass: "task",
    summary: plan.context.task ? plan.context.task.slice(0, 96) : plan.title,
    write: plan.steps.some((step) => step.mode === "write")
  });
}

function spawnWorker(cwd, jobId) {
  const child = spawn(process.execPath, [SCRIPT, "flow-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

async function launchPlan(plan, parsed) {
  const { options, cwd, workspaceRoot } = parsed;
  const maxParallel = Math.max(1, Number(options["max-parallel"] ?? 3) || 3);
  if (options["dry-run"]) {
    output(options.json ? { plan } : renderDryRun(plan, workspaceRoot), options.json);
    return;
  }
  for (const step of plan.steps) {
    const provider = resolveProvider(step.provider, { workspaceRoot });
    if (!provider.found) {
      throw new Error(`Step \`${step.id}\`: ${provider.reason}`);
    }
  }

  const job = createHubJob(plan, workspaceRoot);
  const logFile = createJobLogFile(workspaceRoot, job.id, job.title);

  if (options.background) {
    const record = { ...job, status: "queued", phase: "queued", logFile, request: { plan, cwd, maxParallel } };
    writeJobFile(workspaceRoot, job.id, record);
    upsertJob(workspaceRoot, record);
    const child = spawnWorker(cwd, job.id);
    patchJobIfActive(workspaceRoot, job.id, { pid: child.pid ?? null, bridgePid: child.pid ?? null });
    appendLogLine(logFile, "Queued for background execution.");
    const payload = { jobId: job.id, status: "queued", title: job.title, logFile };
    output(options.json ? payload : `${job.title} started in the background as ${job.id}. Check \`/bridges-hub:runs ${job.id}\` for progress.\n`, options.json);
    return;
  }

  const execution = await runTrackedJob(
    { ...job, logFile },
    () => executePlan(plan, { cwd, workspaceRoot, jobId: job.id, maxParallel, logFile, echo: !options.json }),
    { logFile }
  );
  output(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
}

async function handleWorker(argv) {
  const { options, workspaceRoot } = parseInput(argv, { valueOptions: ["job-id"] });
  const jobId = options["job-id"];
  const stored = jobId ? readStoredJob(workspaceRoot, jobId) : null;
  if (!stored?.request?.plan) {
    throw new Error(`No stored run request for ${jobId ?? "(missing --job-id)"}.`);
  }
  const { plan, cwd, maxParallel } = stored.request;
  await runTrackedJob(
    { ...stored, workspaceRoot },
    () => executePlan(plan, { cwd, workspaceRoot, jobId, maxParallel, logFile: stored.logFile, echo: false }),
    { logFile: stored.logFile }
  );
}

// ------------------------------------------------------------ runs / show / stop

function handleRuns(argv) {
  const { options, positionals, cwd } = parseInput(argv, { booleanOptions: ["all"] });
  if (positionals[0]) {
    const snapshot = buildSingleJobSnapshot(cwd, positionals[0]);
    output(options.json ? snapshot : renderJobStatusReport(snapshot.job), options.json);
    return;
  }
  const report = buildStatusSnapshot(cwd, { all: options.all });
  output(options.json ? report : renderStatusReport(report), options.json);
}

function handleShow(argv) {
  const { options, positionals, cwd } = parseInput(argv);
  const { workspaceRoot, job } = resolveResultJob(cwd, positionals[0] ?? "");
  const storedJob = readStoredJob(workspaceRoot, job.id);
  output(options.json ? { job, storedJob } : renderStoredJobResult(job, storedJob), options.json);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function handleStop(argv) {
  const { options, positionals, cwd } = parseInput(argv);
  const { workspaceRoot, job } = resolveCancelableJob(cwd, positionals[0] ?? "", { env: process.env });
  const existing = { ...job, ...(readStoredJob(workspaceRoot, job.id) ?? {}) };
  const claim = claimJobTerminal(workspaceRoot, job.id, "cancelled", { errorMessage: "Stopped by user.", phase: "cancelled" });
  if (!claim.claimed && claim.status !== "cancelled") {
    output(options.json ? { jobId: job.id, status: claim.status, alreadyTerminal: true } : `Run ${job.id} is already ${claim.status}.\n`, options.json);
    return;
  }
  // Steps first: a foreground hub on POSIX does not lead a process group.
  const targets = [...new Set([...(existing.stepPids ?? []), ...resolveJobKillTargets(existing)])];
  // taskkill /T can fail on part of a tree (e.g. a console host) after killing
  // the rest, so judge by whether the process is still alive.
  const kills = targets.map((pid) => {
    try {
      return { pid, ...terminateProcessTree(pid) };
    } catch (error) {
      return { pid, attempted: true, delivered: !isAlive(pid), error: error.message };
    }
  });
  const delivered = kills.some((kill) => kill.delivered);
  appendLogLine(existing.logFile, `Stopped by user (kill delivered: ${delivered}).`);
  const payload = { jobId: job.id, status: "cancelled", title: job.title, killDelivered: delivered, killTargets: targets };
  output(options.json ? payload : renderCancelReport({ ...existing, ...payload }), options.json);
}

// ------------------------------------------------------------------------ main

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  switch (subcommand) {
    case undefined:
    case "help":
    case "--help":
      printUsage();
      return;
    case "check":
      return handleCheck(argv);
    case "list":
      return handleList(argv);
    case "validate":
      return handleValidate(argv);
    case "ask": {
      const parsed = parseInput(argv, {
        leading: 1,
        valueOptions: ["profile", "model", "effort"],
        booleanOptions: ["write", "background", "dry-run"]
      });
      return launchPlan(planAsk(parsed), parsed);
    }
    case "flow": {
      const parsed = parseInput(argv, {
        leading: 1,
        valueOptions: ["max-parallel", "model", "effort"],
        booleanOptions: ["background", "dry-run"]
      });
      return launchPlan(planFlow(parsed), parsed);
    }
    case "flow-worker":
      return handleWorker(argv);
    case "runs":
      return handleRuns(argv);
    case "show":
      return handleShow(argv);
    case "stop":
      return handleStop(argv);
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
