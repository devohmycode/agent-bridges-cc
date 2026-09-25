#!/usr/bin/env node
// package.json holds the release version. `npm run build` copies it into every
// generated plugin.json and the marketplace; this script sets it and keeps
// those generated manifests in step (or checks that they are).
// External marketplace entries (codex, grok-build) carry no version: they
// track their upstream repositories.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function usage() {
  return [
    "Usage:",
    "  node scripts/bump-version.mjs <version>",
    "  node scripts/bump-version.mjs --check [version]",
    "",
    "Options:",
    "  --check       Verify manifest versions. Uses package.json when version is omitted.",
    "  --root <dir>  Run against a different repository root.",
    "  --help        Print this help."
  ].join("\n");
}

function parseArgs(argv) {
  const options = { check: false, root: process.cwd(), version: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--root") {
      options.root = argv[++i];
      if (!options.root) throw new Error("--root requires a directory.");
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (!arg.startsWith("-") && !options.version) {
      options.version = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, json) {
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

/** Every manifest field that must equal the package version. */
function versionFields(root) {
  const fields = [{ file: "package.json", label: "version", get: (j) => j.version, set: (j, v) => (j.version = v) }];
  const marketplaceFile = ".claude-plugin/marketplace.json";
  if (!fs.existsSync(path.join(root, marketplaceFile))) {
    return fields;
  }
  const marketplace = readJson(path.join(root, marketplaceFile));
  fields.push({
    file: marketplaceFile,
    label: "metadata.version",
    get: (j) => j.metadata?.version,
    set: (j, v) => {
      j.metadata = { ...(j.metadata ?? {}), version: v };
    }
  });
  for (const entry of marketplace.plugins ?? []) {
    if (typeof entry.source !== "string") {
      continue;
    }
    fields.push({
      file: marketplaceFile,
      label: `plugins[${entry.name}].version`,
      get: (j) => j.plugins.find((p) => p.name === entry.name)?.version,
      set: (j, v) => {
        j.plugins.find((p) => p.name === entry.name).version = v;
      }
    });
    const manifest = path.posix.join(entry.source.replace(/^\.\//, ""), ".claude-plugin", "plugin.json");
    if (fs.existsSync(path.join(root, manifest))) {
      fields.push({ file: manifest, label: "version", get: (j) => j.version, set: (j, v) => (j.version = v) });
    }
  }
  return fields;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const root = path.resolve(options.root);
  const fields = versionFields(root);

  if (options.check) {
    const expected = options.version ?? readJson(path.join(root, "package.json")).version;
    const stale = fields
      .map((field) => ({ ...field, actual: field.get(readJson(path.join(root, field.file))) }))
      .filter((field) => field.actual !== expected);
    if (stale.length > 0) {
      for (const field of stale) {
        process.stderr.write(`${field.file} ${field.label} is ${field.actual ?? "missing"}, expected ${expected}\n`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`All manifests are at ${expected}.`);
    return;
  }

  if (!options.version || !VERSION_PATTERN.test(options.version)) {
    throw new Error(`Provide a semantic version.\n${usage()}`);
  }
  const byFile = new Map();
  for (const field of fields) {
    const json = byFile.get(field.file) ?? readJson(path.join(root, field.file));
    field.set(json, options.version);
    byFile.set(field.file, json);
  }
  for (const [file, json] of byFile) {
    writeJson(path.join(root, file), json);
  }
  console.log(`Set version ${options.version} in ${[...byFile.keys()].join(", ")}.`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
