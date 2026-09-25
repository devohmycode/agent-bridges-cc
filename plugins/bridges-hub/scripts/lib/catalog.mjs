// Load profiles and workflows from three layers. A file in a more specific
// layer replaces a same-named one from a broader layer:
//   project  <repo>/.claude/bridges-hub/{profiles,workflows}/*.md
//   user     <claude config dir>/bridges-hub/{profiles,workflows}/*.md
//   builtin  <plugin>/{profiles,workflows}/*.md

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseFrontmatter, parseSections } from "./frontmatter.mjs";
import { claudeConfigDir } from "./registry.mjs";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const LAYERS = ["project", "user", "builtin"];
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

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

function splitList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseProfile(text, file) {
  const { meta, body } = parseFrontmatter(text);
  return {
    kind: "profile",
    name: meta.name ?? path.basename(file, ".md"),
    description: meta.description ?? "",
    provider: meta.provider ?? null,
    mode: meta.mode ?? null,
    model: meta.model ?? null,
    effort: meta.effort ?? null,
    extraKeys: Object.keys(meta).filter((key) => !["name", "description", "provider", "mode", "model", "effort"].includes(key)),
    body,
    file
  };
}

export const STEP_KEYS = ["provider", "profile", "mode", "model", "effort", "after", "on_failure"];

export function parseWorkflow(text, file) {
  const { meta, body } = parseFrontmatter(text);
  const { preamble, sections } = parseSections(body);
  return {
    kind: "workflow",
    name: meta.name ?? path.basename(file, ".md"),
    description: meta.description ?? "",
    extraKeys: Object.keys(meta).filter((key) => !["name", "description"].includes(key)),
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
      extraKeys: Object.keys(section.meta).filter((key) => !STEP_KEYS.includes(key)),
      prompt: section.body
    })),
    file
  };
}

/**
 * Load every item of `kind` ("profiles" | "workflows"), resolving overrides.
 * @returns {{ items: Map<string, object>, problems: {file, message}[] }}
 */
export function loadCatalog(kind, options) {
  const parse = kind === "profiles" ? parseProfile : parseWorkflow;
  const dirs = layerDirs(kind, options);
  const items = new Map();
  const problems = [];

  // Broadest layer first so narrower layers overwrite.
  for (const layer of [...LAYERS].reverse()) {
    for (const file of listMarkdown(dirs[layer])) {
      try {
        const item = parse(fs.readFileSync(file, "utf8"), file);
        if (!NAME_PATTERN.test(item.name)) {
          throw new Error(`invalid name \`${item.name}\` (letters, digits, \`.\`, \`_\`, \`-\`).`);
        }
        const previous = items.get(item.name);
        items.set(item.name, { ...item, source: layer, overrides: previous ? previous.source : null });
      } catch (error) {
        problems.push({ file, message: error.message });
      }
    }
  }
  return { items, problems };
}

/** Load a single file outside the layers (e.g. `validate path/to/file.md`). */
export function loadFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const { body } = parseFrontmatter(text);
  const isWorkflow = /^##[ \t]+\S/m.test(body);
  const item = isWorkflow ? parseWorkflow(text, file) : parseProfile(text, file);
  return { ...item, source: "file", overrides: null };
}
