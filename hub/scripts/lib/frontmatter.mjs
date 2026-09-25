// Minimal, dependency-free parsing for profile and workflow files.
//
// Only flat `key: value` pairs are supported, both in the `---` frontmatter
// and in the header of each `## <step>` section. Nested YAML is rejected on
// purpose: the files stay easy to write by hand and to validate.

const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*)\s*:(.*)$/;

function cleanValue(raw) {
  let value = raw.trim();
  // A trailing comment needs a space before `#` so values like `a#b` survive.
  const comment = value.search(/\s#/);
  if (comment !== -1) {
    value = value.slice(0, comment).trim();
  }
  if (value.length >= 2 && /^(["']).*\1$/.test(value)) {
    value = value.slice(1, -1);
  }
  return value === "" ? null : value;
}

function parseKeyLines(lines, where) {
  const meta = {};
  for (const [offset, line] of lines.entries()) {
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }
    const match = KEY_LINE.exec(line);
    if (!match || /^\s/.test(line)) {
      throw new Error(`${where}, line ${offset + 1}: expected \`key: value\`, got \`${line.trim()}\`.`);
    }
    const key = match[1].toLowerCase().replace(/-/g, "_");
    if (Object.prototype.hasOwnProperty.call(meta, key)) {
      throw new Error(`${where}: duplicate key \`${key}\`.`);
    }
    meta[key] = cleanValue(match[2]);
  }
  return meta;
}

/** Split `---` frontmatter from the Markdown body. */
export function parseFrontmatter(text) {
  const normalized = String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) {
    return { meta: {}, body: normalized.trim() };
  }
  return {
    meta: parseKeyLines(match[1].split("\n"), "frontmatter"),
    body: normalized.slice(match[0].length).trim()
  };
}

/**
 * Split a workflow body into `## <id>` sections. Each section starts with
 * `key: value` lines; the first blank line ends them and the rest is the
 * step prompt. Text before the first section is returned as `preamble`.
 */
export function parseSections(body) {
  const lines = String(body).split("\n");
  const preamble = [];
  const sections = [];
  let current = null;

  for (const line of lines) {
    const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (heading) {
      current = { id: heading[1], lines: [] };
      sections.push(current);
      continue;
    }
    (current ? current.lines : preamble).push(line);
  }

  return {
    preamble: preamble.join("\n").trim(),
    sections: sections.map(({ id, lines: sectionLines }) => {
      let start = 0;
      while (start < sectionLines.length && !sectionLines[start].trim()) {
        start += 1;
      }
      let end = start;
      while (end < sectionLines.length && sectionLines[end].trim()) {
        end += 1;
      }
      const header = sectionLines.slice(start, end);
      const looksLikeHeader = header.length > 0 && header.every((line) => KEY_LINE.test(line) && !/^\s/.test(line));
      return {
        id,
        meta: looksLikeHeader ? parseKeyLines(header, `step \`${id}\``) : {},
        body: (looksLikeHeader ? sectionLines.slice(end) : sectionLines).join("\n").trim()
      };
    })
  };
}
