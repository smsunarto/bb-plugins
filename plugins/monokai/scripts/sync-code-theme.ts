// Vendors the Cursor Monokai TextMate layer into `code-theme-rules.json`.
//
// Import an explicitly selected editor-theme checkout. Normal builds render
// the checked-in rules and local CONTRACT.md without an external checkout.
//
// Colors are stored as role names, never hexes: the source holds the scope
// mapping, this workspace holds the palette. An unregistered hex is a contract
// question, so the sync stops rather than inventing a role for it.

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { type CodeThemeRuleFile, codeThemeRulesPath } from "./code-theme-rules";
import { roleValues, tokenRoles } from "./generate-theme";

// The plugin typechecks against bun-types/test only. The full bun-types clash
// with this workspace's @types/node, so declare the one runtime API used here.
declare const Bun: { JSONC: { parse(source: string): unknown } };

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
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { source: { type: "string" }, check: { type: "boolean", default: false } },
    allowPositionals: false,
  });
  if (!values.source?.trim()) {
    throw new Error("Usage: sync-code-theme.ts --source <editor-theme-directory> [--check]");
  }
  const themeRoot = resolve(values.source);
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
  const vendored = { source: "Cursor Monokai", rules } satisfies CodeThemeRuleFile;
  if (values.check) {
    // oxfmt reflows the vendored file, so compare data, not bytes.
    const current = JSON.parse(await readFile(codeThemeRulesPath, "utf8")) as unknown;
    if (JSON.stringify(current) !== JSON.stringify(vendored)) {
      throw new Error(
        "code-theme-rules.json differs from the selected source. Run bun run sync:code-theme --source <editor-theme-directory>.",
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
