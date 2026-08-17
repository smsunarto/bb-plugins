// The vendored TextMate layer: which scopes take which role.
//
// `code-theme-rules.json` is data, not a second palette — every color is a role
// name resolved by scripts/generate-theme.ts. `bun run sync:code-theme` rewrites
// it from the editor theme in the sibling smsunarto-theme checkout.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface CodeThemeRule {
  scope: string[];
  foreground?: string;
  background?: string;
  fontStyle?: string;
}

export interface CodeThemeRuleFile {
  source: string;
  rules: CodeThemeRule[];
}

export const codeThemeRulesPath = fileURLToPath(
  new URL("./code-theme-rules.json", import.meta.url),
);

export function readCodeThemeRules(): CodeThemeRuleFile {
  return JSON.parse(readFileSync(codeThemeRulesPath, "utf8")) as CodeThemeRuleFile;
}
