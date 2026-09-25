import test from "node:test";
import assert from "node:assert/strict";

import { expandRawArguments, parseArgs, splitRawArgumentString } from "./.generated/plugins/fake-bridge/scripts/lib/args.mjs";

test("parseArgs handles value, boolean, and alias options", () => {
  const result = parseArgs(["--cwd", "/tmp", "--json", "-m", "model-x", "remaining"], {
    valueOptions: ["cwd", "model"],
    booleanOptions: ["json"],
    aliasMap: { m: "model" }
  });

  assert.deepEqual(result.options, {
    cwd: "/tmp",
    json: true,
    model: "model-x"
  });
  assert.deepEqual(result.positionals, ["remaining"]);
});

test("splitRawArgumentString respects quotes and escapes", () => {
  const tokens = splitRawArgumentString(`review --base main "focus on auth" keep\\ going`);
  assert.deepEqual(tokens, ["review", "--base", "main", "focus on auth", "keep going"]);
});

test("parseArgs throws when a value option is missing its value", () => {
  assert.throws(
    () =>
      parseArgs(["--model"], {
        valueOptions: ["model"]
      }),
    /Missing value for --model/
  );
});

test("parseArgs can warn on unknown long options without treating them as positionals", () => {
  const result = parseArgs(["--scpoe", "working-tree", "focus text"], {
    valueOptions: ["scope"],
    unknownMode: "warn"
  });
  assert.deepEqual(result.unknown, ["--scpoe"]);
  assert.deepEqual(result.positionals, ["working-tree", "focus text"]);
  assert.equal(result.options.scope, undefined);
});

test("expandRawArguments splits $ARGUMENTS, alone or after the command's own flags", () => {
  assert.deepEqual(expandRawArguments(["--base main focus"]), ["--base", "main", "focus"]);
  assert.deepEqual(expandRawArguments(["   "]), []);
  assert.deepEqual(expandRawArguments(["--background", "--base HEAD~1 focus text"], ["base"]), [
    "--background",
    "--base",
    "HEAD~1",
    "focus",
    "text"
  ]);
  assert.deepEqual(expandRawArguments(["--background", ""]), ["--background"]);
});

test("expandRawArguments leaves structured argv and option values whole", () => {
  const structured = ["--json", "--cwd", "C:/My Repo", "--prompt-file", "C:/Temp Dir/p.md"];
  assert.deepEqual(expandRawArguments(structured, ["cwd", "prompt-file"]), structured);
  assert.deepEqual(expandRawArguments(["--prompt-file", "C:/Temp Dir/p.md"], ["prompt-file"]), [
    "--prompt-file",
    "C:/Temp Dir/p.md"
  ]);
  assert.deepEqual(expandRawArguments(["--json", "single"]), ["--json", "single"]);
});
