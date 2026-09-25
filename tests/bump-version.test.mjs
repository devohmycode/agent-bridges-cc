import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, ROOT, run } from "./helpers.mjs";

const SCRIPT = path.join(ROOT, "scripts", "bump-version.mjs");

function writeJson(filePath, json) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeVersionFixture() {
  const root = makeTempDir();
  writeJson(path.join(root, "package.json"), { name: "agent-bridges-cc", version: "0.1.0" });
  writeJson(path.join(root, "plugins", "cursor-bridge", ".claude-plugin", "plugin.json"), { name: "cursor-bridge", version: "0.1.0" });
  writeJson(path.join(root, ".claude-plugin", "marketplace.json"), {
    metadata: { version: "0.1.0" },
    plugins: [
      { name: "codex", source: { source: "git-subdir", url: "openai/codex-plugin-cc", path: "plugins/codex" } },
      { name: "cursor-bridge", version: "0.1.0", source: "./plugins/cursor-bridge" }
    ]
  });
  return root;
}

test("bump-version updates package.json and the generated manifests", () => {
  const root = makeVersionFixture();
  const result = run(process.execPath, [SCRIPT, "--root", root, "1.2.3"], { cwd: ROOT });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(path.join(root, "package.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "plugins", "cursor-bridge", ".claude-plugin", "plugin.json")).version, "1.2.3");
  const marketplace = readJson(path.join(root, ".claude-plugin", "marketplace.json"));
  assert.equal(marketplace.metadata.version, "1.2.3");
  assert.equal(marketplace.plugins.find((p) => p.name === "cursor-bridge").version, "1.2.3");
  assert.equal(marketplace.plugins.find((p) => p.name === "codex").version, undefined, "external plugins track upstream");
});

test("bump-version rejects a non-semantic version", () => {
  const root = makeVersionFixture();
  const result = run(process.execPath, [SCRIPT, "--root", root, "one"], { cwd: ROOT });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /semantic version/);
});

test("bump-version check mode reports stale metadata", () => {
  const root = makeVersionFixture();
  writeJson(path.join(root, "package.json"), { name: "agent-bridges-cc", version: "0.2.0" });

  const result = run(process.execPath, [SCRIPT, "--root", root, "--check"], { cwd: ROOT });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugins\/cursor-bridge\/\.claude-plugin\/plugin\.json version/);
  assert.match(result.stderr, /\.claude-plugin\/marketplace\.json metadata\.version/);
  assert.doesNotMatch(result.stderr, /codex/);
});

test("repo manifests are in sync with package.json", () => {
  const result = run(process.execPath, [SCRIPT, "--check"], { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr);
});

test("generated plugins are up to date with core, providers and templates", () => {
  const result = run(process.execPath, [path.join(ROOT, "scripts", "build.mjs"), "--check"], { cwd: ROOT });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
