// Validation, prompt building and scheduling for profiles and workflows.
// Pure functions: nothing here spawns a process (see runner.mjs).

import process from "node:process";

import { isKnownProvider, normalizeProviderId } from "./registry.mjs";

const MODES = ["read", "write"];
const ON_FAILURE = ["stop", "continue"];
const STEP_ID = /^[a-z0-9][a-z0-9_-]*$/i;
const STEP_FIELDS = ["output", "status"];
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export function placeholders(text) {
  return [...String(text ?? "").matchAll(PLACEHOLDER)].map((match) => match[1]);
}

function checkPlaceholders(text, where, allowedSteps, problems) {
  for (const name of placeholders(text)) {
    if (name === "task" || /^vars\.[A-Za-z0-9_-]+$/.test(name)) {
      continue;
    }
    const step = /^steps\.([^.]+)\.([^.]+)$/.exec(name);
    if (!step) {
      problems.push(`${where}: unknown placeholder \`{{${name}}}\` (use task, vars.<name> or steps.<id>.output|status).`);
      continue;
    }
    if (!STEP_FIELDS.includes(step[2])) {
      problems.push(`${where}: \`{{${name}}}\` — a step exposes only ${STEP_FIELDS.join(" and ")}.`);
    } else if (!allowedSteps.has(step[1])) {
      problems.push(`${where}: \`{{${name}}}\` refers to \`${step[1]}\`, which is not an earlier step listed (directly or indirectly) in \`after\`.`);
    }
  }
}

export function validateProfile(profile, { env = process.env } = {}) {
  const problems = [];
  const where = `profile \`${profile.name}\``;
  if (!profile.body) {
    problems.push(`${where}: the body (the role given to the agent) is empty.`);
  }
  if (profile.mode && !MODES.includes(profile.mode)) {
    problems.push(`${where}: mode must be ${MODES.join(" or ")}, got \`${profile.mode}\`.`);
  }
  if (profile.provider && !isKnownProvider(profile.provider, env)) {
    problems.push(`${where}: unknown provider \`${profile.provider}\`.`);
  }
  for (const key of profile.extraKeys ?? []) {
    problems.push(`${where}: unknown key \`${key}\`.`);
  }
  checkPlaceholders(profile.body, where, new Set(), problems);
  return problems;
}

/** Ancestors of every step, or null when `after` has a cycle. */
function ancestorsOf(steps) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const memo = new Map();
  const visiting = new Set();
  const visit = (id) => {
    if (memo.has(id)) {
      return memo.get(id);
    }
    if (visiting.has(id)) {
      return null;
    }
    visiting.add(id);
    const result = new Set();
    for (const dep of byId.get(id)?.after ?? []) {
      if (!byId.has(dep)) {
        continue;
      }
      const inner = visit(dep);
      if (inner === null) {
        return null;
      }
      result.add(dep);
      inner.forEach((ancestor) => result.add(ancestor));
    }
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };
  for (const step of steps) {
    if (visit(step.id) === null) {
      return null;
    }
  }
  return memo;
}

/** Effective settings of a step: step keys win over its profile's. */
export function resolveStep(step, profiles) {
  const profile = step.profile ? profiles.get(step.profile) ?? null : null;
  return {
    ...step,
    profileItem: profile,
    provider: normalizeProviderId(step.provider ?? profile?.provider ?? ""),
    mode: step.mode ?? profile?.mode ?? "read",
    model: step.model ?? profile?.model ?? null,
    effort: step.effort ?? profile?.effort ?? null
  };
}

export function validateWorkflow(workflow, { profiles, env = process.env } = {}) {
  const problems = [];
  const where = `workflow \`${workflow.name}\``;
  if (workflow.steps.length === 0) {
    problems.push(`${where}: no steps. Add a \`## <step-id>\` section per step.`);
    return problems;
  }
  for (const key of workflow.extraKeys ?? []) {
    problems.push(`${where}: unknown key \`${key}\`.`);
  }

  const ids = new Set();
  for (const step of workflow.steps) {
    const at = `${where}, step \`${step.id}\``;
    if (!STEP_ID.test(step.id)) {
      problems.push(`${at}: invalid id (letters, digits, \`_\`, \`-\`).`);
    }
    if (ids.has(step.id)) {
      problems.push(`${at}: duplicate step id.`);
    }
    ids.add(step.id);
  }

  const ancestors = ancestorsOf(workflow.steps);
  if (ancestors === null) {
    problems.push(`${where}: \`after\` forms a cycle.`);
  }

  for (const raw of workflow.steps) {
    const at = `${where}, step \`${raw.id}\``;
    for (const key of raw.extraKeys ?? []) {
      problems.push(`${at}: unknown key \`${key}\`.`);
    }
    if (raw.profile && !profiles.has(raw.profile)) {
      problems.push(`${at}: unknown profile \`${raw.profile}\`.`);
    }
    const step = resolveStep(raw, profiles);
    if (!step.provider) {
      problems.push(`${at}: no provider (set \`provider:\` on the step or on its profile).`);
    } else if (!isKnownProvider(step.provider, env)) {
      problems.push(`${at}: unknown provider \`${step.provider}\`.`);
    }
    if (!MODES.includes(step.mode)) {
      problems.push(`${at}: mode must be ${MODES.join(" or ")}, got \`${step.mode}\`.`);
    }
    if (!ON_FAILURE.includes(step.onFailure)) {
      problems.push(`${at}: on_failure must be ${ON_FAILURE.join(" or ")}, got \`${step.onFailure}\`.`);
    }
    for (const dep of step.after) {
      if (!ids.has(dep)) {
        problems.push(`${at}: \`after\` names unknown step \`${dep}\`.`);
      } else if (dep === step.id) {
        problems.push(`${at}: a step cannot run after itself.`);
      }
    }
    if (!step.prompt && !step.profileItem) {
      problems.push(`${at}: needs a prompt, a profile, or both.`);
    }
    if (ancestors) {
      checkPlaceholders(step.prompt, at, ancestors.get(raw.id) ?? new Set(), problems);
    }
  }
  return problems;
}

/** Names of `{{vars.x}}` a workflow needs, and whether it uses `{{task}}`. */
export function requiredInputs(workflow, profiles) {
  const vars = new Set();
  let task = false;
  for (const raw of workflow.steps) {
    const step = resolveStep(raw, profiles);
    for (const text of [step.prompt, step.profileItem?.body]) {
      for (const name of placeholders(text)) {
        if (name === "task") {
          task = true;
        } else if (name.startsWith("vars.")) {
          vars.add(name.slice(5));
        }
      }
    }
  }
  return { vars: [...vars].sort(), task };
}

export function interpolate(text, context) {
  return String(text ?? "").replace(PLACEHOLDER, (match, name) => {
    if (name === "task") {
      return context.task ?? "";
    }
    if (name.startsWith("vars.")) {
      const key = name.slice(5);
      if (!Object.prototype.hasOwnProperty.call(context.vars ?? {}, key)) {
        throw new Error(`Missing value for \`{{${name}}}\`. Pass \`--var ${key}=...\`.`);
      }
      return context.vars[key];
    }
    const step = /^steps\.([^.]+)\.([^.]+)$/.exec(name);
    if (step) {
      const result = context.steps?.[step[1]];
      return result ? String(result[step[2]] ?? "") : "";
    }
    return match;
  });
}

/**
 * The prompt sent to the provider: the profile as a role, then the step
 * instructions. A step without a prompt works on the task itself.
 */
export function buildStepPrompt(step, context) {
  const instructions = step.prompt ? interpolate(step.prompt, context) : context.task ?? "";
  const role = step.profileItem ? interpolate(step.profileItem.body, context).trim() : "";
  const sections = [];
  if (role) {
    sections.push(`<role>\n${role}\n</role>`);
  }
  if (instructions.trim()) {
    sections.push(instructions.trim());
  }
  if (step.mode === "read") {
    sections.push("Do not modify any file: this step is read-only.");
  }
  return `${sections.join("\n\n")}\n`;
}

/**
 * Pick the steps to start now. Read steps run side by side; a write step
 * runs alone, since every step shares one working tree.
 * @param {object[]} steps resolved steps, in declaration order
 * @param {Map<string, {status: string}>} states "pending" | "running" | "completed" | "failed" | "skipped"
 */
export function nextRunnable(steps, states, { maxParallel = 3 } = {}) {
  const running = steps.filter((step) => states.get(step.id)?.status === "running");
  if (running.some((step) => step.mode === "write")) {
    return [];
  }
  const ready = steps.filter((step) => {
    if (states.get(step.id)?.status !== "pending") {
      return false;
    }
    return step.after.every((dep) => {
      const status = states.get(dep)?.status;
      return status === "completed" || (status === "failed" && steps.find((s) => s.id === dep)?.onFailure === "continue");
    });
  });

  const picked = [];
  for (const step of ready) {
    if (step.mode === "write") {
      if (running.length === 0 && picked.length === 0) {
        return [step];
      }
      // Hold later reads back too, so the write step gets the tree to itself soon.
      break;
    }
    if (running.length + picked.length < maxParallel) {
      picked.push(step);
    }
  }
  return picked;
}

/** Steps that can never run once `failedId` stopped the workflow. */
export function blockedBy(steps, states) {
  return steps.filter((step) => {
    if (states.get(step.id)?.status !== "pending") {
      return false;
    }
    return step.after.some((dep) => {
      const status = states.get(dep)?.status;
      const depStep = steps.find((s) => s.id === dep);
      return status === "skipped" || (status === "failed" && depStep?.onFailure !== "continue");
    });
  });
}
