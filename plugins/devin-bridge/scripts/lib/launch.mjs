import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const WINDOWS_SHELL_EXTENSIONS = new Set([".cmd", ".bat"]);

function pathEntries(env) {
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  return String(raw).split(path.delimiter).filter(Boolean);
}

function windowsExtensions(env) {
  const raw = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return String(raw)
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a command name to an absolute path the way the shell would.
 * Returns null when nothing matches.
 */
export function which(command, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const hasDir = command.includes("/") || command.includes("\\");
  const dirs = hasDir ? [""] : pathEntries(env);
  const exts = platform === "win32" ? ["", ...windowsExtensions(env)] : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir ? path.join(dir, `${command}${ext}`) : `${command}${ext}`;
      if (platform === "win32" && ext === "" && !path.extname(candidate)) {
        continue;
      }
      if (isFile(candidate)) {
        return path.resolve(candidate);
      }
    }
  }
  return null;
}

/**
 * Build a launch spec for a binary: `{ command, prefixArgs, env, shell }`.
 * Windows `.cmd`/`.bat` shims cannot be spawned without a shell; they are
 * flagged so callers keep untrusted text (prompts) out of argv.
 */
export function launchFor(command, options = {}) {
  const platform = options.platform ?? process.platform;
  const resolved = which(command, options) ?? command;
  const shell = platform === "win32" && WINDOWS_SHELL_EXTENSIONS.has(path.extname(resolved).toLowerCase());
  return {
    command: resolved,
    prefixArgs: [],
    env: {},
    shell,
    found: resolved !== command || isFile(command)
  };
}

/**
 * Quote one argument for `cmd.exe /d /s /c`. Only used for `.cmd` shims, and
 * never with prompt text (prompts go through a file in that case).
 */
export function quoteForCmd(arg) {
  const value = String(arg);
  if (value && !/[\s"^&|<>%!()]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""').replace(/([%!^])/g, "^$1")}"`;
}

export function binaryOverride(env, name) {
  const value = env?.[name];
  return value && String(value).trim() ? String(value).trim() : null;
}

export function localAppData(env = process.env) {
  return env.LOCALAPPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Local") : null);
}

export function parseJsonLines(text) {
  const events = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON noise interleaved with the event stream.
    }
  }
  return events;
}
