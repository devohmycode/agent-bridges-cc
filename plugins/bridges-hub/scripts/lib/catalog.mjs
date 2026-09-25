// Load profiles and workflows from three layers. A file in a more specific
// layer replaces a same-named one from a broader layer:
//   project  <repo>/.claude/bridges-hub/{profiles,workflows}/*.md
//   user     <claude config dir>/bridges-hub/{profiles,workflows}/*.md
//   builtin  <plugin>/{profiles,workflows}/*.md
//
// A profile can also build on others instead of replacing them:
//   extends: <name>        merge its `## Section`s into <name>'s (a profile
//                          extending its own name extends the broader layer)
//   include: <name>[#Sec]  append another profile, or one of its sections

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseFrontmatter, parseSections } from "./frontmatter.mjs";
import { claudeConfigDir } from "./registry.mjs";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const LAYERS = ["project", "user", "builtin"];
const NAME_PATTERN = /^[a-z0-9_][a-z0-9._-]*$/i;
const PROJECT_MARK = "Project-specific (takes precedence over the guidance above):";

export const PROFILE_KEYS = ["name", "description", "provider", "mode", "model", "effort", "extends", "include", "exclude", "vars"];
export const WORKFLOW_KEYS = ["name", "description", "exclude", "vars"];
export const STEP_KEYS = ["provider", "profile", "mode", "model", "effort", "after", "on_failure", "exclude"];

export function layerDirs(kind, { workspaceRoot, env = process.env }) {
  return {
    project: workspaceRoot ? path.join(workspaceRoot, ".claude", "bridges-hub", kind) : null,
    user: path.join(claudeConfigDir(env), "bridges-hub", kind),
    builtin: path.join(PLUGIN_ROOT, kind)
  };
}

function listMarkdown(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

export function splitList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** `vars: language=fr, target=api` → { language: "fr", target: "api" } */
export function parseVars(value, where) {
  const vars = {};
  for (const pair of splitList(value)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`${where}: \`vars\` expects \`key=value\` pairs separated by commas, got \`${pair}\`.`);
    }
    vars[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return vars;
}

export function parseProfile(text, file) {
  const { meta, body } = parseFrontmatter(text);
  const name = meta.name ?? path.basename(file, ".md");
  return {
    kind: "profile",
    name,
    description: meta.description ?? "",
    provider: meta.provider ?? null,
    mode: meta.mode ?? null,
    model: meta.model ?? null,
    effort: meta.effort ?? null,
    extends: meta.extends ?? null,
    include: splitList(meta.include),
    exclude: splitList(meta.exclude),
    vars: parseVars(meta.vars, `profile \`${name}\``),
    extraKeys: Object.keys(meta).filter((key) => !PROFILE_KEYS.includes(key)),
    body,
    file
  };
}

export function parseWorkflow(text, file) {
  const { meta, body } = parseFrontmatter(text);
  const { preamble, sections } = parseSections(body);
  const name = meta.name ?? path.basename(file, ".md");
  return {
    kind: "workflow",
    name,
    description: meta.description ?? "",
    exclude: splitList(meta.exclude),
    vars: parseVars(meta.vars, `workflow \`${name}\``),
    extraKeys: Object.keys(meta).filter((key) => !WORKFLOW_KEYS.includes(key)),
    preamble,
    steps: sections.map((section) => ({
      id: section.id,
      provider: section.meta.provider ?? null,
      profile: section.meta.profile ?? null,
      mode: section.meta.mode ?? null,
      model: section.meta.model ?? null,
      effort: section.meta.effort ?? null,
      after: splitList(section.meta.after),
      onFailure: section.meta.on_failure ?? "stop",
      exclude: splitList(section.meta.exclude),
      extraKeys: Object.keys(section.meta).filter((key) => !STEP_KEYS.includes(key)),
      prompt: section.body
    })),
    file
  };
}

// ------------------------------------------------------------ section merging

/** Split a profile body on `## ` headings, ignoring fenced code blocks. */
export function splitBody(body) {
  const preamble = [];
  const sections = [];
  let fence = null;
  for (const line of String(body ?? "").split("\n")) {
    const marker = /^\s*(```|~~~)/.exec(line);
    if (marker) {
      fence = fence === marker[1] ? null : fence ?? marker[1];
    }
    const heading = !fence && !marker ? /^##[ \t]+(.+?)[ \t]*$/.exec(line) : null;
    if (heading) {
      sections.push({ title: heading[1], lines: [] });
    } else {
      (sections.length ? sections[sections.length - 1].lines : preamble).push(line);
    }
  }
  return {
    preamble: preamble.join("\n").trim(),
    sections: sections.map(({ title, lines }) => ({ title, content: lines.join("\n").trim() }))
  };
}

function joinBody({ preamble, sections }) {
  return [preamble, ...sections.map(({ title, content }) => `## ${title}\n\n${content}`.trim())].filter(Boolean).join("\n\n");
}

function appendProjectPart(base, extra) {
  if (!extra) {
    return base;
  }
  return base ? `${base}\n\n${PROJECT_MARK}\n${extra}` : extra;
}

/** Overlay sections land under the base section of the same title. */
export function mergeBodies(baseBody, overlayBody) {
  const base = splitBody(baseBody);
  const overlay = splitBody(overlayBody);
  const merged = { preamble: appendProjectPart(base.preamble, overlay.preamble), sections: base.sections.map((section) => ({ ...section })) };
  for (const section of overlay.sections) {
    const target = merged.sections.find((candidate) => candidate.title.toLowerCase() === section.title.toLowerCase());
    if (target) {
      target.content = appendProjectPart(target.content, section.content);
    } else {
      merged.sections.push({ ...section });
    }
  }
  return joinBody(merged);
}

function sectionOf(profile, title) {
  const section = splitBody(profile.body).sections.find((candidate) => candidate.title.toLowerCase() === title.toLowerCase());
  if (!section) {
    throw new Error(`profile \`${profile.name}\` has no section \`## ${title}\`.`);
  }
  return `## ${section.title}\n\n${section.content}`;
}

/**
 * Resolve `extends` and `include` for a profile.
 * @param {object} item a parsed profile
 * @param {Map<string, object[]>} stacks name → versions, narrowest layer first
 * @param {number} depth index of `item` in its own stack
 */
export function resolveProfile(item, stacks, depth = 0, seen = new Set()) {
  const key = `${item.name}@${depth}`;
  if (seen.has(key)) {
    throw new Error(`profile \`${item.name}\`: \`extends\`/\`include\` form a cycle.`);
  }
  const trail = new Set(seen).add(key);
  const lookup = (name, from = 0) => {
    const stack = stacks.get(name) ?? [];
    if (!stack[from]) {
      throw new Error(
        from > 0
          ? `profile \`${item.name}\` extends \`${name}\`, but no broader layer defines \`${name}\`.`
          : `profile \`${item.name}\` refers to unknown profile \`${name}\`.`
      );
    }
    return resolveProfile(stack[from], stacks, from, trail);
  };

  let resolved = { ...item };
  if (item.extends) {
    const base = item.extends === item.name ? lookup(item.name, depth + 1) : lookup(item.extends);
    resolved = {
      ...item,
      description: item.description || base.description,
      provider: item.provider ?? base.provider,
      mode: item.mode ?? base.mode,
      model: item.model ?? base.model,
      effort: item.effort ?? base.effort,
      exclude: [...new Set([...base.exclude, ...item.exclude])],
      vars: { ...base.vars, ...item.vars },
      body: mergeBodies(base.body, item.body)
    };
  }
  for (const reference of item.include) {
    const [name, section] = reference.split("#");
    const included = lookup(name);
    const text = section ? sectionOf(included, section) : included.body;
    resolved.body = [resolved.body, text].filter(Boolean).join("\n\n");
  }
  return resolved;
}

// ------------------------------------------------------------------- loading

/**
 * Load every item of `kind` ("profiles" | "workflows"), resolving overrides.
 * @returns {{ items: Map<string, object>, stacks: Map<string, object[]>, problems: {file, message}[] }}
 */
export function loadCatalog(kind, options) {
  const parse = kind === "profiles" ? parseProfile : parseWorkflow;
  const dirs = layerDirs(kind, options);
  const stacks = new Map();
  const problems = [];

  for (const layer of LAYERS) {
    for (const file of listMarkdown(dirs[layer])) {
      try {
        const item = parse(fs.readFileSync(file, "utf8"), file);
        if (!NAME_PATTERN.test(item.name)) {
          throw new Error(`invalid name \`${item.name}\` (letters, digits, \`.\`, \`_\`, \`-\`).`);
        }
        const stack = stacks.get(item.name) ?? [];
        stack.push({ ...item, source: layer });
        stacks.set(item.name, stack);
      } catch (error) {
        problems.push({ file, message: error.message });
      }
    }
  }

  const items = new Map();
  for (const [name, stack] of stacks) {
    const top = { ...stack[0], overrides: stack[1]?.source ?? null };
    if (kind !== "profiles") {
      items.set(name, top);
      continue;
    }
    try {
      items.set(name, { ...resolveProfile(top, stacks), overrides: top.overrides, extended: Boolean(top.extends) });
    } catch (error) {
      problems.push({ file: top.file, message: error.message });
    }
  }
  return { items, stacks, problems };
}

/** Load a single file outside the layers (e.g. `validate path/to/file.md`). */
export function loadFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const { meta, body } = parseFrontmatter(text);
  const profileOnly = Object.keys(meta).some((key) => PROFILE_KEYS.includes(key) && !WORKFLOW_KEYS.includes(key));
  const isWorkflow = !profileOnly && parseSections(body).sections.some((section) => Object.keys(section.meta).length > 0);
  const item = isWorkflow ? parseWorkflow(text, file) : parseProfile(text, file);
  return { ...item, source: "file", overrides: null };
}
