// Vendors the Cursor Monokai TextMate layer into `code-theme-rules.json`.
//
// The editor theme lives in a private sibling checkout, so it cannot be a
// dependency of this public workspace. CONTRACT.md is already a relative
// symlink into that checkout; this script follows the same link to find the
// source, which keeps the path in one place and fails loudly when the sibling
// is missing. CI never runs it — `generate:theme` renders the shipped JSON from
// the vendored rules and the palette below it.
//
// Colors are stored as role names, never hexes: the sibling holds the scope
// mapping, this workspace holds the palette. An unregistered hex is a contract
// question, so the sync stops rather than inventing a role for it.

import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type CodeThemeRuleFile, codeThemeRulesPath } from "./code-theme-rules";

const contractLinkPath = fileURLToPath(new URL("../CONTRACT.md", import.meta.url));

// Hexes as the editor theme spells them, mapped to this workspace's roles.
// Both sides are authored against CONTRACT.md, so a hex that is absent here
// means the contract moved and the palette has not caught up.
const roleByColor = new Map(
  Object.entries({
    "#E3E3DD": "text.ink",
    "#E3E3DD8C": "text.ink55",
    "#E3E3DD4D": "text.ink30",
    "#BEB89999": "text.comment60",
    "#FE5D86": "code.keyword",
    "#FE5D8699": "code.keyword60",
    "#9DDD54": "code.entity",
    "#F7D05C": "code.string",
    "#51DAE9": "code.type",
    "#A895FE": "code.constant",
    "#A895FEA0": "code.constant63",
    "#FF8342": "code.parameter",
    "#E34671": "feedback.error",
    "#F1B467": "feedback.warning",
    "#6796E6": "feedback.info",
    "#B267E6": "feedback.debug",
    "#181818": "ground.content",
  }).map(([color, role]) => [color.toLowerCase(), role]),
);

interface SourceRule {
  scope: string | string[];
  settings: { foreground?: string; background?: string; fontStyle?: string };
}

// The editor theme is JSONC — comments carry the per-rule rationale the
// contract asks for, and trailing commas come with them.
function parseJsonc(source: string): unknown {
  let out = "";
  let index = 0;
  let inString = false;
  while (index < source.length) {
    const character = source[index];
    if (inString) {
      out += character;
      if (character === "\\") {
        out += source[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      out += character;
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    out += character;
    index += 1;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as unknown;
}

async function resolveThemeRoot(): Promise<string> {
  const contractPath = await realpath(contractLinkPath).catch(() => null);
  if (contractPath === null) {
    throw new Error(
      `CONTRACT.md does not resolve. Check out smsunarto-theme beside this workspace so ${contractLinkPath} points at a file.`,
    );
  }
  return dirname(contractPath);
}

function toScopes(scope: string | string[]): string[] {
  const entries = Array.isArray(scope) ? scope : [scope];
  // A few upstream rules pack several scopes into one comma-joined string.
  // TextMate accepts both spellings; one shape here keeps the audit simple.
  return entries.flatMap((entry) =>
    entry
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function toRole(color: string, scope: readonly string[]): string {
  const role = roleByColor.get(color.toLowerCase());
  if (role === undefined) {
    throw new Error(
      `${color} on ${scope[0]} has no role. Amend CONTRACT.md and the palette before syncing.`,
    );
  }
  return role;
}

export function convertRules(source: readonly SourceRule[]): CodeThemeRuleFile["rules"] {
  return source.map((rule) => {
    const scope = toScopes(rule.scope);
    const converted: CodeThemeRuleFile["rules"][number] = { scope };
    if (rule.settings.foreground !== undefined) {
      converted.foreground = toRole(rule.settings.foreground, scope);
    }
    if (rule.settings.background !== undefined) {
      converted.background = toRole(rule.settings.background, scope);
    }
    if (rule.settings.fontStyle !== undefined) {
      converted.fontStyle = rule.settings.fontStyle;
    }
    return converted;
  });
}

async function main(): Promise<void> {
  const themeRoot = await resolveThemeRoot();
  const layerPath = join(themeRoot, "themes", "generated-textmate.json");
  const mainPath = join(themeRoot, "themes", "Cursor Monokai-color-theme.json");

  const [layerSource, mainSource] = await Promise.all([
    readFile(layerPath, "utf8"),
    readFile(mainPath, "utf8"),
  ]);
  const layer = parseJsonc(layerSource) as { tokenColors: SourceRule[] };
  const main = parseJsonc(mainSource) as { tokenColors: SourceRule[] };

  // VS Code merges an included theme first and lets the including file win, so
  // the flattened order has to be layer-then-main for the last rule to hold.
  const rules = convertRules([...layer.tokenColors, ...main.tokenColors]);
  const output = `${JSON.stringify({ source: "smsunarto-theme", rules } satisfies CodeThemeRuleFile, null, 2)}\n`;
  await writeFile(codeThemeRulesPath, output);
  console.log(`Vendored ${rules.length} rule(s) from ${themeRoot}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
