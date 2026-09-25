export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const unknownMode = config.unknownMode ?? "positional";
  const options = {};
  const positionals = [];
  const unknown = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      if (unknownMode === "error") {
        throw new Error(`Unknown option --${rawKey}`);
      }
      if (unknownMode === "warn") {
        unknown.push(token);
        continue;
      }
      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    if (unknownMode === "error") {
      throw new Error(`Unknown option -${shortKey}`);
    }
    if (unknownMode === "warn") {
      unknown.push(token);
      continue;
    }
    positionals.push(token);
  }

  return { options, positionals, unknown };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += /[\s'"\\]/.test(character) ? character : `\\${character}`;
      escaping = false;
      continue;
    }

    // A backslash only escapes what the splitter would otherwise act on, so
    // Windows paths (C:\Users\me) keep theirs.
    if (character === "\\" && !quote) {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    // Quotes group words only at the start of a token: the apostrophe in
    // "l'auth" or "don't" stays text.
    if ((character === "'" || character === "\"") && current === "") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Turn the argv of a command into tokens. Slash commands pass `$ARGUMENTS` as one
 * quoted string, sometimes after flags the command adds itself
 * (`review --background "$ARGUMENTS"`, `run --write "<task>"`): that string is split
 * too. It is left whole when it is the value of a value option, or when other
 * values come before it — a caller that already passes structured argv.
 */
export function expandRawArguments(argv, valueOptions = []) {
  if (argv.length === 0) {
    return [];
  }
  if (argv.length === 1) {
    return argv[0] && argv[0].trim() ? splitRawArgumentString(argv[0]) : [];
  }
  const raw = argv[argv.length - 1];
  const leading = argv.slice(0, -1);
  const takesValue = new Set(valueOptions.map((name) => `--${name}`));
  const onlyFlags = leading.every((token) => token.startsWith("-") && (token.includes("=") || !takesValue.has(token)));
  if (!onlyFlags) {
    return argv;
  }
  if (!raw.trim()) {
    return leading;
  }
  if (!/\s/.test(raw.trim())) {
    return argv;
  }
  return [...leading, ...splitRawArgumentString(raw)];
}

/**
 * Commands pass free text through stdin, in a quoted heredoc, so the shell
 * never expands it (`$(…)`, backticks, quotes):
 *   node bridge.mjs review --args-stdin <<'ARGS'
 *   $ARGUMENTS
 *   ARGS
 * `--args-stdin` is replaced by the tokens read from stdin.
 */
export const ARGS_STDIN_FLAG = "--args-stdin";

export function resolveArguments(argv, valueOptions = [], readStdin = () => "") {
  const index = argv.indexOf(ARGS_STDIN_FLAG);
  if (index === -1) {
    return expandRawArguments(argv, valueOptions);
  }
  const rest = [...argv.slice(0, index), ...argv.slice(index + 1)];
  return [...expandRawArguments(rest, valueOptions), ...splitRawArgumentString(readStdin() ?? "")];
}
