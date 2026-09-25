#!/usr/bin/env node
// Generate one self-contained Claude Code plugin per provider:
//   core/ (shared runtime) + providers/<id>.mjs + templates/ -> plugins/<plugin>/
// Claude Code copies each plugin directory on install, so nothing may be
// shared across plugins at run time; the generated trees are committed.
//
//   node scripts/build.mjs          write plugins/ and the marketplace manifest
//   node scripts/build.mjs --check  fail if the committed output is stale

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE = path.join(ROOT, "core");
const PROVIDERS = path.join(ROOT, "providers");
const TEMPLATES = path.join(ROOT, "templates");
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const MARKETPLACE_NAME = "agent-bridges";
const AUTHOR = { name: "DevOhMyCode" };

// Official plugins listed as-is so every bridge installs from one marketplace.
// They are fetched from their upstream repositories, not vendored here.
const EXTERNAL_PLUGINS = [
  {
    name: "codex",
    description: "Official OpenAI Codex plugin: review, adversarial review, rescue delegation and session transfer through the Codex app server.",
    author: { name: "OpenAI" },
    homepage: "https://github.com/openai/codex-plugin-cc",
    source: { source: "git-subdir", url: "openai/codex-plugin-cc", path: "plugins/codex" }
  },
  {
    name: "grok-build",
    description: "Official xAI Grok Build plugin: review, critique, delegation and Claude session import through the grok CLI.",
    author: { name: "xAI" },
    homepage: "https://github.com/xai-org/grok-build-plugin-cc",
    source: { source: "git-subdir", url: "xai-org/grok-build-plugin-cc", path: "plugins/grok-build" }
  }
];

export async function loadProviders() {
  const files = fs.readdirSync(PROVIDERS).filter((name) => name.endsWith(".mjs") && name !== "launch.mjs").sort();
  const providers = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(PROVIDERS, file)).href);
    providers.push({ file, ...mod.default });
  }
  return providers;
}

function templateVars(provider) {
  const efforts = provider.efforts ?? null;
  return {
    PLUGIN: provider.pluginName,
    NAME: provider.displayName,
    PRODUCT: provider.productName,
    CLI: provider.cliName,
    AGENT: `${provider.id}-delegate`,
    RUNTIME_SKILL: `${provider.id}-delegate-runtime`,
    OUTPUT_SKILL: `${provider.id}-run-output`,
    EFFORT_ARG: efforts ? ` [--effort <${efforts.join("|")}>]` : "",
    EFFORT_VALUES: efforts
      ? `Accepted effort values: ${efforts.map((value) => `\`${value}\``).join(", ")}.`
      : `\`${provider.cliName}\` has no reasoning-effort setting; the bridge ignores \`--effort\`.`,
    READONLY_NOTE: provider.readOnlyNote,
    INSTALL_HINT: provider.installHint,
    AUTH_HINT: provider.authHint
  };
}

function render(text, vars) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!(key in vars)) {
      throw new Error(`Unknown template variable ${match}`);
    }
    return vars[key];
  });
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
  });
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function pluginDescription(provider) {
  return `${provider.productName} ↔ Claude Code bridge for review, critique, and delegation.`;
}

export function buildPlugin(provider, outRoot) {
  const out = path.join(outRoot, "plugins", provider.pluginName);
  const vars = templateVars(provider);

  for (const rel of listFiles(CORE)) {
    writeFile(path.join(out, rel), fs.readFileSync(path.join(CORE, rel)));
  }
  writeFile(path.join(out, "scripts", "lib", "provider.mjs"), fs.readFileSync(provider.sourcePath ?? path.join(PROVIDERS, provider.file)));
  for (const rel of listFiles(TEMPLATES)) {
    const target = render(rel.split(path.sep).join("/"), vars);
    writeFile(path.join(out, target), render(fs.readFileSync(path.join(TEMPLATES, rel), "utf8"), vars));
  }
  for (const name of ["LICENSE", "NOTICE"]) {
    writeFile(path.join(out, name), fs.readFileSync(path.join(ROOT, name)));
  }
  const manifest = {
    name: provider.pluginName,
    version: PACKAGE.version,
    description: pluginDescription(provider),
    author: AUTHOR
  };
  writeFile(path.join(out, ".claude-plugin", "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function buildMarketplace(providers, outRoot) {
  const marketplace = {
    name: MARKETPLACE_NAME,
    owner: AUTHOR,
    metadata: {
      description: "Claude Code bridge plugins for Codex, Grok Build, Cursor, Devin, GitHub Copilot, Antigravity and Warp Oz: review, critique, and delegation.",
      version: PACKAGE.version
    },
    plugins: [
      ...EXTERNAL_PLUGINS,
      ...providers.map((provider) => ({
        name: provider.pluginName,
        description: pluginDescription(provider),
        version: PACKAGE.version,
        author: AUTHOR,
        source: `./plugins/${provider.pluginName}`
      }))
    ]
  };
  writeFile(path.join(outRoot, ".claude-plugin", "marketplace.json"), `${JSON.stringify(marketplace, null, 2)}\n`);
}

export async function build(outRoot) {
  const providers = await loadProviders();
  fs.rmSync(path.join(outRoot, "plugins"), { recursive: true, force: true });
  for (const provider of providers) {
    buildPlugin(provider, outRoot);
  }
  buildMarketplace(providers, outRoot);
  return providers;
}

function snapshot(root) {
  const files = new Map();
  for (const rel of [".claude-plugin/marketplace.json", ...listFiles(path.join(root, "plugins")).map((rel) => `plugins/${rel}`)]) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) {
      files.set(rel.split(path.sep).join("/"), fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n"));
    }
  }
  return files;
}

async function main() {
  if (process.argv.includes("--check")) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridges-build-"));
    try {
      await build(temp);
      const expected = snapshot(temp);
      const actual = fs.existsSync(path.join(ROOT, "plugins")) ? snapshot(ROOT) : new Map();
      const stale = [...new Set([...expected.keys(), ...actual.keys()])].filter((rel) => expected.get(rel) !== actual.get(rel));
      if (stale.length > 0) {
        process.stderr.write(`Generated plugins are stale. Run \`npm run build\`.\n${stale.map((rel) => `  ${rel}`).join("\n")}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write("Generated plugins are up to date.\n");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    return;
  }
  const providers = await build(ROOT);
  process.stdout.write(`Built ${providers.map((provider) => provider.pluginName).join(", ")}.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
