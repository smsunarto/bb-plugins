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
import { roleValues, tokenRoles } from "./generate-theme";

// The plugin typechecks against bun-types/test only. The full bun-types clash
// with this workspace's @types/node, so declare the one runtime API used here.
declare const Bun: { JSONC: { parse(source: string): unknown } };

const contractLinkPath = fileURLToPath(new URL("../CONTRACT.md", import.meta.url));

// Token roles by color, read from the generator's registry. Both sides are
// authored against CONTRACT.md, so a hex that is absent here means the contract
// moved and the palette has not caught up.
const roleByColor = new Map<string, string>(
  [...tokenRoles].map((role) => [roleValues[role], role]),
);

interface SourceRule {
  scope: string | string[];
  settings: { foreground?: string; background?: string; fontStyle?: string };
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
  // Any other argument would still rewrite the tracked rules.
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) {
    throw new Error(`Unknown argument(s): ${args.join(" ")}. Usage: sync-code-theme.ts [--check]`);
  }
  const themeRoot = await resolveThemeRoot();
  const layerPath = join(themeRoot, "themes", "generated-textmate.json");
  const mainPath = join(themeRoot, "themes", "Cursor Monokai-color-theme.json");

  const [layerSource, mainSource] = await Promise.all([
    readFile(layerPath, "utf8"),
    readFile(mainPath, "utf8"),
  ]);
  // The editor theme is JSONC. Comments carry the per-rule rationale the
  // contract asks for, and trailing commas come with them.
  const layer = Bun.JSONC.parse(layerSource) as { tokenColors: SourceRule[] };
  const main = Bun.JSONC.parse(mainSource) as { tokenColors: SourceRule[] };

  // VS Code merges an included theme first and lets the including file win, so
  // the flattened order has to be layer-then-main for the last rule to hold.
  const rules = convertRules([...layer.tokenColors, ...main.tokenColors]);
  const vendored = { source: "smsunarto-theme", rules } satisfies CodeThemeRuleFile;
  if (args.includes("--check")) {
    // oxfmt reflows the vendored file, so compare data, not bytes.
    const current = JSON.parse(await readFile(codeThemeRulesPath, "utf8")) as unknown;
    if (JSON.stringify(current) !== JSON.stringify(vendored)) {
      throw new Error(
        "code-theme-rules.json is behind smsunarto-theme. Run bun run sync:code-theme.",
      );
    }
    console.log(`code-theme-rules.json matches ${themeRoot}.`);
    return;
  }
  await writeFile(codeThemeRulesPath, `${JSON.stringify(vendored, null, 2)}\n`);
  console.log(`Vendored ${rules.length} rule(s) from ${themeRoot}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
