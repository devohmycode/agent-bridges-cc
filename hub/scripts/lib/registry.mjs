// Locate the bridge plugins Claude Code installed, so the hub can run a step
// through them. The hub vendors no adapter: each step is a subprocess of the
// provider plugin's own script, in its "task" mode with `--json`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PREFERRED_MARKETPLACE = "agent-bridges";
const OVERRIDE_PREFIX = "BRIDGES_HUB_PROVIDER_";

// Every family accepts `--json --write --model --effort --prompt-file --cwd`
// and prints `{ status, rawOutput, ... }` on stdout.
export const PROVIDERS = Object.freeze({
  cursor: { plugin: "cursor-bridge", script: "scripts/bridge.mjs", subcommand: "run", label: "Cursor Agent" },
  devin: { plugin: "devin-bridge", script: "scripts/bridge.mjs", subcommand: "run", label: "Devin" },
  copilot: { plugin: "copilot-bridge", script: "scripts/bridge.mjs", subcommand: "run", label: "GitHub Copilot" },
  antigravity: { plugin: "antigravity-bridge", script: "scripts/bridge.mjs", subcommand: "run", label: "Antigravity" },
  warp: { plugin: "warp-bridge", script: "scripts/bridge.mjs", subcommand: "run", label: "Warp Oz" },
  codex: { plugin: "codex", script: "scripts/codex-companion.mjs", subcommand: "task", label: "Codex" },
  "grok-build": { plugin: "grok-build", script: "scripts/grok-bridge.mjs", subcommand: "run", label: "Grok Build" }
});

const ALIASES = Object.freeze({ grok: "grok-build" });

export function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/** `BRIDGES_HUB_PROVIDER_<ID>=<script>` adds or overrides a provider (bridge family). */
function envOverrides(env) {
  const overrides = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(OVERRIDE_PREFIX) && value) {
      const id = key.slice(OVERRIDE_PREFIX.length).toLowerCase().replace(/_/g, "-");
      overrides[id] = value;
    }
  }
  return overrides;
}

export function normalizeProviderId(id) {
  const lowered = String(id ?? "").trim().toLowerCase();
  return ALIASES[lowered] ?? lowered;
}

export function knownProviderIds(env = process.env) {
  return [...new Set([...Object.keys(PROVIDERS), ...Object.keys(envOverrides(env))])].sort();
}

export function isKnownProvider(id, env = process.env) {
  return knownProviderIds(env).includes(normalizeProviderId(id));
}

function readInstalledPlugins(env) {
  const file = path.join(claudeConfigDir(env), "plugins", "installed_plugins.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed.plugins ?? {};
  } catch {
    return {};
  }
}

function isWithin(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pickInstall(installed, pluginName, workspaceRoot) {
  const candidates = [];
  for (const [key, entries] of Object.entries(installed)) {
    const at = key.lastIndexOf("@");
    const name = at === -1 ? key : key.slice(0, at);
    const marketplace = at === -1 ? "" : key.slice(at + 1);
    if (name !== pluginName || !Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (!entry?.installPath) {
        continue;
      }
      const scoped = entry.scope && entry.scope !== "user";
      if (scoped && !(entry.projectPath && workspaceRoot && isWithin(workspaceRoot, entry.projectPath))) {
        continue;
      }
      candidates.push({ ...entry, marketplace, rank: (scoped ? 0 : 2) + (marketplace === PREFERRED_MARKETPLACE ? 0 : 1) });
    }
  }
  candidates.sort((left, right) => left.rank - right.rank);
  return candidates[0] ?? null;
}

/**
 * Resolve a provider to the script that runs its tasks.
 * @returns {{ id, label, plugin, subcommand, script, version, marketplace, found, reason }}
 */
export function resolveProvider(id, { env = process.env, workspaceRoot = null } = {}) {
  const providerId = normalizeProviderId(id);
  const override = envOverrides(env)[providerId];
  const spec = PROVIDERS[providerId] ?? (override ? { plugin: providerId, script: null, subcommand: "run", label: providerId } : null);
  if (!spec) {
    return { id: providerId, found: false, reason: `Unknown provider \`${id}\`. Known: ${knownProviderIds(env).join(", ")}.` };
  }

  const base = { id: providerId, label: spec.label, plugin: spec.plugin, subcommand: spec.subcommand };
  if (override) {
    const found = fs.existsSync(override);
    return { ...base, script: override, version: null, marketplace: null, found, reason: found ? null : `Override script not found: ${override}` };
  }

  const install = pickInstall(readInstalledPlugins(env), spec.plugin, workspaceRoot);
  if (!install) {
    return { ...base, script: null, found: false, reason: `Plugin \`${spec.plugin}\` is not installed. Run \`/plugin install ${spec.plugin}@${PREFERRED_MARKETPLACE}\`.` };
  }
  const script = path.join(install.installPath, spec.script);
  const found = fs.existsSync(script);
  return {
    ...base,
    script,
    version: install.version ?? null,
    marketplace: install.marketplace || null,
    found,
    reason: found ? null : `Installed plugin \`${spec.plugin}\` has no ${spec.script}; reinstall it.`
  };
}
