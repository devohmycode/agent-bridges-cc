import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ROOT } from "./helpers.mjs";

const PLUGINS_DIR = path.join(ROOT, "plugins");
const MARKETPLACE = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
const LOCAL_PLUGINS = MARKETPLACE.plugins.filter((entry) => typeof entry.source === "string");
const HUB = "bridges-hub";
const BRIDGE_PLUGINS = LOCAL_PLUGINS.filter((entry) => entry.name !== HUB);
const EXPECTED_COMMANDS = ["check.md", "critique.md", "delegate.md", "review.md", "runs.md", "show.md", "stop.md"];

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

function frontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  return match ? match[1] : null;
}

test("marketplace lists the five generated bridges, the hub and the official codex and grok-build plugins", () => {
  assert.deepEqual(
    BRIDGE_PLUGINS.map((entry) => entry.name).sort(),
    ["antigravity-bridge", "copilot-bridge", "cursor-bridge", "devin-bridge", "warp-bridge"]
  );
  assert.ok(LOCAL_PLUGINS.some((entry) => entry.name === HUB), "the hub is listed");
  const external = MARKETPLACE.plugins.filter((entry) => typeof entry.source !== "string");
  assert.deepEqual(external.map((entry) => entry.name).sort(), ["codex", "grok-build"]);
  for (const entry of external) {
    assert.equal(entry.source.source, "git-subdir");
    // The owner/repo shorthand is cloned over SSH and fails without a known GitHub host key.
    assert.match(entry.source.url, /^https:\/\/github\.com\//, `${entry.name} must use an HTTPS clone URL`);
    assert.equal(entry.version, undefined, `${entry.name} should track upstream, not pin a version`);
  }
  assert.deepEqual(fs.readdirSync(PLUGINS_DIR).sort(), LOCAL_PLUGINS.map((entry) => entry.name).sort());
});

for (const entry of BRIDGE_PLUGINS) {
  const pluginRoot = path.join(ROOT, entry.source);
  const plugin = entry.name;
  const id = plugin.replace(/-bridge$/, "");

  test(`${plugin}: manifest, commands, agent and skills are consistent`, () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.name, plugin);
    assert.equal(manifest.version, entry.version);

    assert.deepEqual(fs.readdirSync(path.join(pluginRoot, "commands")).sort(), EXPECTED_COMMANDS);
    assert.deepEqual(fs.readdirSync(path.join(pluginRoot, "agents")), [`${id}-delegate.md`]);
    assert.deepEqual(fs.readdirSync(path.join(pluginRoot, "skills")).sort(), [`${id}-delegate-runtime`, `${id}-run-output`]);

    const provider = fs.readFileSync(path.join(pluginRoot, "scripts", "lib", "provider.mjs"), "utf8");
    assert.match(provider, new RegExp(`pluginName: "${plugin}"`));
  });

  test(`${plugin}: generated markdown has frontmatter, no placeholders and no Grok leftovers`, () => {
    const markdown = listFiles(pluginRoot).filter((file) => file.endsWith(".md") && !/[\\/]prompts[\\/]/.test(file));
    for (const file of markdown) {
      const source = fs.readFileSync(file, "utf8");
      const rel = path.relative(pluginRoot, file);
      assert.ok(frontmatter(source), `${rel} should start with frontmatter`);
      assert.doesNotMatch(source, /\{\{|\}\}/, `${rel} has an unrendered placeholder`);
      assert.doesNotMatch(source, /grok/i, `${rel} mentions grok`);
    }
    for (const file of listFiles(path.join(pluginRoot, "scripts"))) {
      assert.doesNotMatch(fs.readFileSync(file, "utf8"), /grok/i, `${path.relative(pluginRoot, file)} mentions grok`);
    }
    assert.doesNotMatch(fs.readFileSync(path.join(pluginRoot, "prompts", "critique.md"), "utf8"), /\{\{AGENT_NAME\}\}.*Grok/);
  });

  test(`${plugin}: commands route through bridge.mjs and the plugin's own names`, () => {
    const read = (rel) => fs.readFileSync(path.join(pluginRoot, rel), "utf8");

    const review = read("commands/review.md");
    assert.match(review, /bridge\.mjs" review/);
    assert.match(review, new RegExp(`/${plugin}:runs`));
    assert.match(review, /AskUserQuestion/);
    assert.match(review, /run_in_background:\s*true/);
    assert.match(review, /Do not fix issues/i);
    assert.match(review, /\(Recommended\)/);

    const critique = read("commands/critique.md");
    assert.match(critique, /bridge\.mjs" critique/);
    assert.match(critique, new RegExp(`same review target selection as \`/${plugin}:review\``));

    const delegate = read("commands/delegate.md");
    assert.match(delegate, new RegExp(`subagent_type: "${plugin}:${id}-delegate"`));
    assert.match(delegate, /run-resume-candidate --json/);

    const agent = read(`agents/${id}-delegate.md`);
    assert.match(agent, new RegExp(`^name: ${id}-delegate$`, "m"));
    assert.match(agent, new RegExp(`- ${id}-delegate-runtime`));
    assert.match(agent, /bridge\.mjs" run/);
    assert.match(agent, /--resume-last/);

    const runtimeSkill = read(`skills/${id}-delegate-runtime/SKILL.md`);
    assert.match(runtimeSkill, new RegExp(`^name: ${id}-delegate-runtime$`, "m"));
    assert.match(runtimeSkill, /bridge\.mjs" run \[flags\] <<'BRIDGE_TASK'/);
    assert.match(agent, /<<'BRIDGE_TASK'/);
    for (const command of ["review", "critique"]) {
      const source = read(`commands/${command}.md`);
      assert.ok(
        source.includes(`bridge.mjs" ${command} --args-stdin <<'BRIDGE_ARGS'\n$ARGUMENTS\nBRIDGE_ARGS`),
        `${command}.md passes $ARGUMENTS through a quoted heredoc`
      );
      assert.ok(!source.includes('"$ARGUMENTS"'), `${command}.md must not quote $ARGUMENTS on the command line`);
    }

    const outputSkill = read(`skills/${id}-run-output/SKILL.md`);
    assert.match(outputSkill, new RegExp(`^name: ${id}-run-output$`, "m"));

    for (const command of ["check", "runs", "show", "stop"]) {
      assert.match(read(`commands/${command}.md`), new RegExp(`bridge\\.mjs" ${command}`));
    }

    const hooks = read("hooks/hooks.json");
    assert.match(hooks, /SessionStart/);
    assert.match(hooks, /SessionEnd/);
    assert.match(hooks, /session-lifecycle-hook\.mjs/);
  });
}

test("bridges-hub: manifest, commands, skill, built-ins and hooks are consistent", () => {
  const pluginRoot = path.join(PLUGINS_DIR, HUB);
  const read = (rel) => fs.readFileSync(path.join(pluginRoot, rel), "utf8");
  const entry = LOCAL_PLUGINS.find((item) => item.name === HUB);

  const manifest = JSON.parse(read(".claude-plugin/plugin.json"));
  assert.equal(manifest.name, HUB);
  assert.equal(manifest.version, entry.version);

  assert.deepEqual(fs.readdirSync(path.join(pluginRoot, "commands")).sort(), [
    "ask.md", "check.md", "flow.md", "list.md", "new-profile.md", "new-workflow.md", "runs.md", "show.md", "stop.md"
  ]);
  assert.deepEqual(fs.readdirSync(path.join(pluginRoot, "skills")), ["hub-run-output"]);
  assert.ok(!fs.existsSync(path.join(pluginRoot, "scripts", "lib", "agent.mjs")), "the hub drives no CLI of its own");
  assert.match(read("scripts/lib/provider.mjs"), /pluginName: "bridges-hub"/);

  for (const file of listFiles(path.join(pluginRoot, "commands"))) {
    const source = fs.readFileSync(file, "utf8");
    assert.ok(frontmatter(source), `${path.basename(file)} should start with frontmatter`);
    assert.match(source, /scripts\/hub\.mjs"/, `${path.basename(file)} routes through hub.mjs`);
  }
  assert.match(read("commands/flow.md"), /flow --dry-run --args-stdin <<'BRIDGE_ARGS'/);
  for (const command of ["flow", "ask"]) {
    assert.doesNotMatch(
      read(`commands/${command}.md`),
      /"[^"\n]*\$ARGUMENTS[^"\n]*"/,
      `${command}.md must not put $ARGUMENTS inside a quoted command line`
    );
  }
  assert.match(read("commands/flow.md"), /run_in_background:\s*true/);

  assert.ok(fs.readdirSync(path.join(pluginRoot, "profiles")).includes("security-review.md"));
  assert.ok(fs.readdirSync(path.join(pluginRoot, "workflows")).includes("implement-review.md"));
  assert.match(read("hooks/hooks.json"), /session-lifecycle-hook\.mjs/);
});
