import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeAgent } from "./fake-agent-fixture.mjs";
import { FAKE_SCRIPT, initGitRepo, makeTempDir, ROOT, run } from "./helpers.mjs";
import { parseFrontmatter, parseSections } from "./.generated/plugins/bridges-hub/scripts/lib/frontmatter.mjs";
import { loadCatalog, parseWorkflow } from "./.generated/plugins/bridges-hub/scripts/lib/catalog.mjs";
import { resolveProvider } from "./.generated/plugins/bridges-hub/scripts/lib/registry.mjs";
import {
  buildStepPrompt,
  interpolate,
  nextRunnable,
  resolveStep,
  validateWorkflow
} from "./.generated/plugins/bridges-hub/scripts/lib/workflow.mjs";

const HUB_SCRIPT = path.join(ROOT, "tests", ".generated", "plugins", "bridges-hub", "scripts", "hub.mjs");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function workflow(text) {
  return parseWorkflow(text, "test.md");
}

function profilesMap(entries = {}) {
  return new Map(Object.entries(entries).map(([name, fields]) => [name, { name, body: "Role.", ...fields }]));
}

// ------------------------------------------------------------------- parsing

test("frontmatter parses flat keys, quotes and trailing comments", () => {
  const { meta, body } = parseFrontmatter('---\nname: x\ndescription: "a: b"\nmode: read # default\n---\nBody\n');
  assert.deepEqual(meta, { name: "x", description: "a: b", mode: "read" });
  assert.equal(body, "Body");
});

test("frontmatter rejects nested YAML", () => {
  assert.throws(() => parseFrontmatter("---\nsteps:\n  - a\n---\n"), /expected `key: value`/);
});

test("sections split step headers from prompts", () => {
  const { preamble, sections } = parseSections("Intro\n\n## one\nprovider: cursor\nafter: a, b\n\nDo it.\nprovider: not a header\n\n## two\nJust a prompt.");
  assert.equal(preamble, "Intro");
  assert.deepEqual(sections[0].meta, { provider: "cursor", after: "a, b" });
  assert.equal(sections[0].body, "Do it.\nprovider: not a header");
  assert.deepEqual(sections[1].meta, {});
  assert.equal(sections[1].body, "Just a prompt.");
});

// ---------------------------------------------------------------- validation

test("validation accepts a well-formed workflow", () => {
  const wf = workflow("## a\nprovider: codex\n\n{{task}}\n\n## b\nprovider: cursor\nafter: a\n\nUse {{steps.a.output}}");
  assert.deepEqual(validateWorkflow(wf, { profiles: profilesMap() }), []);
});

test("validation reports cycles, unknown providers, profiles, keys and bad references", () => {
  const wf = workflow(
    [
      "## a\nprovider: codex\nafter: b\n\nx",
      "## b\nprovider: codex\nafter: a\n\nx",
      "## c\nprovider: nope\nprofile: ghost\ncolour: blue\n\n{{steps.d.output}} {{what}}",
      "## d\nprovider: codex\nmode: fast\n\nx"
    ].join("\n\n")
  );
  const problems = validateWorkflow(wf, { profiles: profilesMap() }).join("\n");
  assert.match(problems, /forms a cycle/);
  assert.match(problems, /unknown provider `nope`/);
  assert.match(problems, /unknown profile `ghost`/);
  assert.match(problems, /unknown key `colour`/);
  assert.match(problems, /mode must be read or write/);
});

test("a step may only reference steps it runs after", () => {
  const wf = workflow("## a\nprovider: codex\n\nx\n\n## b\nprovider: codex\n\n{{steps.a.output}}");
  assert.match(validateWorkflow(wf, { profiles: profilesMap() }).join("\n"), /not an earlier step/);
});

test("a step inherits provider and mode from its profile, and its own keys win", () => {
  const profiles = profilesMap({ sec: { provider: "codex", mode: "read" } });
  const [inherited, overridden] = workflow("## a\nprofile: sec\n\n## b\nprofile: sec\nprovider: cursor\nmode: write\n\nx").steps;
  assert.equal(resolveStep(inherited, profiles).provider, "codex");
  assert.equal(resolveStep(overridden, profiles).provider, "cursor");
  assert.equal(resolveStep(overridden, profiles).mode, "write");
});

test("prompts wrap the profile as a role and interpolate earlier outputs", () => {
  const profiles = profilesMap({ sec: { body: "You audit {{task}}." } });
  const [step] = workflow("## b\nprovider: codex\nprofile: sec\nafter: a\n\nFindings: {{steps.a.output}}").steps;
  const prompt = buildStepPrompt(resolveStep(step, profiles), { task: "auth", steps: { a: { output: "A said hi" } } });
  assert.match(prompt, /<role>\nYou audit auth\.\n<\/role>/);
  assert.match(prompt, /Findings: A said hi/);
  assert.match(prompt, /read-only/);
  assert.throws(() => interpolate("{{vars.env}}", { vars: {} }), /--var env=/);
});

// ----------------------------------------------------------------- scheduling

test("scheduler runs reads side by side and a write step alone", () => {
  const steps = workflow(
    "## w1\nprovider: codex\nmode: write\n\n## r1\nprovider: codex\nafter: w1\n\n## r2\nprovider: codex\nafter: w1\n\n## w2\nprovider: codex\nmode: write\nafter: r1, r2"
  ).steps.map((step) => resolveStep(step, new Map()));
  const states = new Map(steps.map((step) => [step.id, { status: "pending" }]));
  const ids = () => nextRunnable(steps, states).map((step) => step.id);

  assert.deepEqual(ids(), ["w1"]);
  states.set("w1", { status: "running" });
  assert.deepEqual(ids(), [], "nothing starts beside a write step");
  states.set("w1", { status: "completed" });
  assert.deepEqual(ids(), ["r1", "r2"]);
  states.set("r1", { status: "completed" });
  states.set("r2", { status: "running" });
  assert.deepEqual(ids(), [], "w2 waits for r2");
  states.set("r2", { status: "completed" });
  assert.deepEqual(ids(), ["w2"]);
});

// ------------------------------------------------------------ catalog layers

test("project files override user files, which override built-ins", () => {
  const configDir = makeTempDir();
  const workspaceRoot = makeTempDir();
  write(path.join(configDir, "bridges-hub", "profiles", "security-review.md"), "---\ndescription: user\n---\nUser role.");
  write(path.join(configDir, "bridges-hub", "profiles", "mine.md"), "---\ndescription: user only\n---\nMine.");
  write(path.join(workspaceRoot, ".claude", "bridges-hub", "profiles", "security-review.md"), "---\ndescription: project\n---\nProject role.");

  const { items } = loadCatalog("profiles", { workspaceRoot, env: { CLAUDE_CONFIG_DIR: configDir } });
  assert.equal(items.get("security-review").source, "project");
  assert.equal(items.get("security-review").overrides, "user");
  assert.equal(items.get("mine").source, "user");
  assert.equal(items.get("implementer").source, "builtin");
});

// ------------------------------------------------------------------ registry

test("registry prefers a matching project install, then the agent-bridges user install", () => {
  const configDir = makeTempDir();
  const project = makeTempDir();
  const install = (name) => {
    const dir = makeTempDir();
    write(path.join(dir, "scripts", "bridge.mjs"), "");
    return dir;
  };
  const userInstall = install("user");
  const otherMarket = install("other");
  const projectInstall = install("project");
  write(
    path.join(configDir, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "cursor-bridge@elsewhere": [{ scope: "user", installPath: otherMarket, version: "9.9.9" }],
        "cursor-bridge@agent-bridges": [
          { scope: "user", installPath: userInstall, version: "0.1.0" },
          { scope: "project", projectPath: project, installPath: projectInstall, version: "0.2.0" }
        ]
      }
    })
  );
  const env = { CLAUDE_CONFIG_DIR: configDir };

  assert.equal(resolveProvider("cursor", { env, workspaceRoot: makeTempDir() }).version, "0.1.0");
  assert.equal(resolveProvider("cursor", { env, workspaceRoot: path.join(project, "sub") }).version, "0.2.0");
  const missing = resolveProvider("devin", { env });
  assert.equal(missing.found, false);
  assert.match(missing.reason, /\/plugin install devin-bridge@agent-bridges/);
  assert.equal(resolveProvider("grok", { env }).id, "grok-build");
});

// ----------------------------------------------------------------- end to end

function hubSetup(scenario = "echo") {
  const repo = makeTempDir();
  initGitRepo(repo);
  const log = path.join(makeTempDir(), "fake-agent.log");
  const env = buildEnv(installFakeAgent(makeTempDir(), scenario), {
    AGENT_BRIDGES_DATA_FAKE: makeTempDir(),
    AGENT_BRIDGES_DATA_HUB: makeTempDir(),
    CLAUDE_CONFIG_DIR: makeTempDir(),
    BRIDGES_HUB_PROVIDER_FAKE: FAKE_SCRIPT,
    FAKE_AGENT_LOG: log
  });
  write(
    path.join(repo, ".claude", "bridges-hub", "workflows", "chain.md"),
    [
      "---",
      "name: chain",
      "description: three chained fake steps",
      "---",
      "## first",
      "provider: fake",
      "",
      "Plan {{task}} for {{vars.target}}",
      "",
      "## second",
      "provider: fake",
      "after: first",
      "",
      "Review this: {{steps.first.output}}",
      "",
      "## apply",
      "provider: fake",
      "mode: write",
      "after: second",
      "",
      "Apply after {{steps.second.status}}"
    ].join("\n")
  );
  const hub = (args) => run(process.execPath, [HUB_SCRIPT, ...args], { cwd: repo, env });
  const prompts = () =>
    fs
      .readFileSync(log, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line).argv)
      .filter((argv) => argv[0] === "-p");
  return { repo, env, hub, prompts };
}

test("flow chains step outputs and runs write steps without --read-only", () => {
  const { hub, prompts } = hubSetup();
  const result = hub(["flow", "--json", "--var", "target=api", "chain", "the", "--fast", "path"]);
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "completed");
  assert.deepEqual(Object.values(payload.steps).map((step) => step.status), ["completed", "completed", "completed"]);
  assert.match(payload.steps.first.output, /^ECHO Plan the --fast path for api/);
  assert.match(payload.steps.second.output, /Review this: ECHO Plan the --fast path/);

  const [first, second, apply] = prompts();
  assert.ok(first.includes("--read-only"));
  assert.ok(second.includes("--read-only"));
  assert.ok(!apply.includes("--read-only"), "a write step runs the bridge with --write");
  assert.match(apply[1], /Apply after completed/);
});

test("flow reports a failed step and skips the steps after it", () => {
  const { hub } = hubSetup("fail-print");
  const result = hub(["flow", "--json", "--var", "target=api", "chain", "x"]);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "failed");
  assert.equal(payload.steps.first.status, "failed");
  assert.equal(payload.steps.second.status, "skipped");
  assert.equal(payload.steps.apply.status, "skipped");
});

test("flow refuses a missing --var and dry-run shows the plan without running", () => {
  const { hub, prompts, env } = hubSetup();
  const missing = hub(["flow", "chain", "x"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--var target=/);

  const dry = hub(["flow", "--dry-run", "--var", "target=api", "chain", "x"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Order: first → second → apply/);
  assert.match(dry.stdout, /Review this: <output of first>/);
  assert.ok(!fs.existsSync(env.FAKE_AGENT_LOG) || prompts().length === 0, "dry run starts no agent");
});

test("ask runs one provider under a profile", () => {
  const { hub, prompts } = hubSetup();
  const result = hub(["ask", "--json", "fake", "--profile", "security-review", "check", "the", "login"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).steps.ask.status, "completed");
  const [argv] = prompts();
  assert.match(argv[1], /<role>\nYou are a senior application security reviewer/);
  assert.match(argv[1], /check the login/);
});

test("ask refuses a project profile that switches to write mode without --write", () => {
  const { repo, hub, prompts, env } = hubSetup();
  write(
    path.join(repo, ".claude", "bridges-hub", "profiles", "security-review.md"),
    "---\nmode: write\n---\nRewrite whatever you like."
  );
  const refused = hub(["ask", "--json", "fake", "--profile", "security-review", "audit", "this"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /mode: write.*--write/s);
  assert.ok(!fs.existsSync(env.FAKE_AGENT_LOG) || prompts().length === 0, "no agent is started");

  const allowed = hub(["ask", "--json", "--write", "fake", "--profile", "security-review", "audit", "this"]);
  assert.equal(allowed.status, 0, allowed.stderr);
  const [argv] = prompts();
  assert.ok(!argv.includes("--read-only"), "an explicit --write runs the bridge in write mode");
});

test("flow --background records a run that runs and show can read", async () => {
  const { hub } = hubSetup();
  const queued = hub(["flow", "--background", "--json", "--var", "target=api", "chain", "x"]);
  assert.equal(queued.status, 0, queued.stderr);
  const { jobId } = JSON.parse(queued.stdout);

  let status = "queued";
  for (let attempt = 0; attempt < 150 && !["completed", "failed", "cancelled"].includes(status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const snapshot = JSON.parse(hub(["runs", jobId, "--json"]).stdout);
    status = snapshot.job.status;
  }
  assert.equal(status, "completed");

  const shown = hub(["show", jobId]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /# Workflow chain/);
  assert.match(shown.stdout, /\| apply \| fake \| write \| completed \|/);
});

test("stop cancels a running workflow and kills its step", async () => {
  const { hub } = hubSetup("slow");
  const queued = hub(["flow", "--background", "--json", "--var", "target=api", "chain", "x"]);
  assert.equal(queued.status, 0, queued.stderr);
  const { jobId } = JSON.parse(queued.stdout);

  let job = null;
  for (let attempt = 0; attempt < 150 && !job?.agentPid && !["failed", "completed"].includes(job?.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    job = JSON.parse(hub(["runs", jobId, "--json"]).stdout).job;
  }
  assert.ok(job?.agentPid, `the first step started: ${JSON.stringify(job)}
${job?.logFile ? fs.readFileSync(job.logFile, "utf8") : ""}`);

  const stopped = hub(["stop", jobId, "--json"]);
  assert.equal(stopped.status, 0, stopped.stderr);
  const payload = JSON.parse(stopped.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.killDelivered, true);
  assert.equal(JSON.parse(hub(["runs", jobId, "--json"]).stdout).job.status, "cancelled");
});

test("validate flags an invalid project workflow", () => {
  const { hub, repo } = hubSetup();
  write(path.join(repo, ".claude", "bridges-hub", "workflows", "broken.md"), "## a\nprovider: fake\nafter: ghost\n\nx");
  const result = hub(["validate", "broken"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /unknown step `ghost`/);
});

// ------------------------------------------------ extends, include, defaults

function layered() {
  const configDir = makeTempDir();
  const workspaceRoot = makeTempDir();
  const user = (name, text) => write(path.join(configDir, "bridges-hub", "profiles", `${name}.md`), text);
  const project = (name, text) => write(path.join(workspaceRoot, ".claude", "bridges-hub", "profiles", `${name}.md`), text);
  const load = () => loadCatalog("profiles", { workspaceRoot, env: { CLAUDE_CONFIG_DIR: configDir } });
  return { user, project, load };
}

test("extends merges an overlay into the broader profile of the same name, section by section", () => {
  const { user, project, load } = layered();
  user("scan", "---\nmode: read\nexclude: dist/**\nvars: lang=en\n---\nGeneric intro.\n\n## Triage\n\nNever report style.\n\n## Report\n\nTable.");
  project("scan", "---\nextends: scan\nexclude: vendor/**\nvars: lang=fr\n---\nThis repo is decker.\n\n## Triage\n\nNever report the mirror.\n\n## Extra\n\nOnly here.");

  const { items, problems } = load();
  assert.deepEqual(problems, []);
  const scan = items.get("scan");
  assert.equal(scan.source, "project");
  assert.equal(scan.extended, true);
  assert.equal(scan.mode, "read");
  assert.deepEqual(scan.exclude, ["dist/**", "vendor/**"]);
  assert.deepEqual(scan.vars, { lang: "fr" });
  assert.match(scan.body, /^Generic intro\.\n\nProject-specific \(takes precedence over the guidance above\):\nThis repo is decker\./);
  assert.match(scan.body, /## Triage\n\nNever report style\.\n\nProject-specific[^\n]*\nNever report the mirror\./);
  assert.match(scan.body, /## Report\n\nTable\.\n\n## Extra\n\nOnly here\.$/);
});

test("include appends a whole profile or one section, and cycles are reported", () => {
  const { project, load } = layered();
  project("_common", "---\ndescription: shared\n---\n## Remediation\n\nOne commit per finding.\n\n## Language\n\nFrench.");
  project("fix", "---\ninclude: _common#remediation, implementer\n---\nFix it.");
  project("loop-a", "---\ninclude: loop-b\n---\nA");
  project("loop-b", "---\ninclude: loop-a\n---\nB");

  const { items, problems } = load();
  const fix = items.get("fix").body;
  assert.match(fix, /^Fix it\.\n\n## Remediation\n\nOne commit per finding\.\n\nYou are a careful senior engineer/);
  assert.doesNotMatch(fix, /French/);
  assert.ok(problems.some((problem) => /cycle/.test(problem.message)));
  assert.ok(!items.has("loop-a"));
});

test("extends reports a missing base", () => {
  const { project, load } = layered();
  project("lonely", "---\nextends: lonely\n---\nX");
  const { problems } = load();
  assert.match(problems[0].message, /no broader layer defines `lonely`/);
});

test("profile and workflow vars are defaults, --var wins, and excludes reach the prompt", () => {
  const profiles = profilesMap({ sec: { body: "Audit in {{vars.lang}}.", vars: { lang: "en", depth: "1" }, exclude: ["dist/**"] } });
  const wf = workflow("---\nvars: lang=fr\nexclude: vendor/**\n---\n## a\nprovider: codex\nprofile: sec\nexclude: *.min.js\n\nDepth {{vars.depth}}, focus {{vars.focus}}");
  const step = resolveStep(wf.steps[0], profiles);
  assert.deepEqual(step.exclude, ["dist/**", "*.min.js"]);

  const prompt = buildStepPrompt({ ...step, exclude: [...wf.exclude, ...step.exclude] }, { vars: { ...wf.vars, focus: "auth" } });
  assert.match(prompt, /Audit in fr\./);
  assert.match(prompt, /Depth 1, focus auth/);
  assert.match(prompt, /Out of scope: do not read, analyze or report on files matching `vendor\/\*\*`, `dist\/\*\*`, `\*\.min\.js`\./);
});

test("flow uses workflow var defaults and fills in --effort for steps without one", () => {
  const { hub, repo, prompts } = hubSetup();
  write(
    path.join(repo, ".claude", "bridges-hub", "workflows", "defaults.md"),
    "---\nvars: target=web\n---\n## one\nprovider: fake\n\nShip {{task}} to {{vars.target}}\n\n## two\nprovider: fake\neffort: low\nafter: one\n\nok"
  );
  const result = hub(["flow", "--json", "--effort", "high", "defaults", "v2"]);
  assert.equal(result.status, 0, result.stderr);
  const [one, two] = prompts();
  assert.match(one[1], /Ship v2 to web/);
  assert.equal(one[one.indexOf("--effort") + 1], "high");
  assert.equal(two[two.indexOf("--effort") + 1], "low");
});

test("list hides _partial profiles unless --all, and validate warns about long profiles", () => {
  const { hub, repo } = hubSetup();
  write(path.join(repo, ".claude", "bridges-hub", "profiles", "_part.md"), "---\ndescription: part\n---\nPart.");
  write(path.join(repo, ".claude", "bridges-hub", "profiles", "huge.md"), `---\ndescription: huge\n---\n${"word ".repeat(6000)}`);
  assert.doesNotMatch(hub(["list", "profiles"]).stdout, /_part/);
  assert.match(hub(["list", "profiles", "--all"]).stdout, /_part/);

  const validated = hub(["validate", "huge"]);
  assert.equal(validated.status, 0, validated.stderr);
  assert.match(validated.stdout, /Warnings:\n- profile `huge`: \d+ characters/);
});

test("flow reads its arguments from stdin with --args-stdin, unexpanded", () => {
  const { repo, env, prompts } = hubSetup();
  const result = run(process.execPath, [HUB_SCRIPT, "flow", "--json", "--args-stdin"], {
    cwd: repo,
    env,
    input: "--var target=api chain check l'auth $(touch pwned)\n"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(prompts()[0][1], /Plan check l'auth \$\(touch pwned\) for api/);
  assert.equal(fs.existsSync(path.join(repo, "pwned")), false);
});
