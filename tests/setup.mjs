#!/usr/bin/env node
// Generate the test-only `fake-bridge` plugin (core + tests/fixtures/fake-provider.mjs)
// and the hub into tests/.generated/plugins/. Runs once before `node --test`
// (see package.json) so test files can import its modules statically.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildHub, buildPlugin } from "../scripts/build.mjs";

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(TESTS, ".generated");
const PROVIDER = path.join(TESTS, "fixtures", "fake-provider.mjs");

const provider = (await import(pathToFileURL(PROVIDER).href)).default;
const staging = `${OUT}.tmp-${process.pid}`;
fs.rmSync(staging, { recursive: true, force: true });
buildPlugin({ ...provider, sourcePath: PROVIDER }, staging);
buildHub(staging);
fs.rmSync(OUT, { recursive: true, force: true });
fs.renameSync(staging, OUT);
process.stdout.write(`Generated ${path.relative(process.cwd(), path.join(OUT, "plugins", provider.pluginName))}\n`);
