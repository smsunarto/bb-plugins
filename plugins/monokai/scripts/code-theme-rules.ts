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

// Monaco's Monarch grammars emit token names, not TextMate scopes. Its theme
// matcher uses dotted prefixes, so these heads cover `tag.css`,
// `attribute.name.css`, and their peers. Monaco's inherited CSS themes also
// carry exact rules for numeric values. Those beat a prefix rule, so the
// numeric family includes the exact CSS-language postfixes as well. Keep this
// bridge separate from the vendored Cursor rules because sync:code-theme
// replaces that file wholesale.
const CSS_VALUE_CONSTANT_TOKENS = [
  "attribute.value.number",
  "attribute.value.hex",
  "attribute.value.unit",
] as const;

const CSS_LANGUAGE_POSTFIXES = ["css", "scss", "less"] as const;

const MONACO_TOKEN_RULES: readonly CodeThemeRule[] = [
  { scope: ["tag"], foreground: "code.keyword", fontStyle: "" },
  { scope: ["attribute.name"], foreground: "code.type", fontStyle: "" },
  { scope: ["attribute.value"], foreground: "code.string", fontStyle: "" },
  {
    scope: [
      ...CSS_VALUE_CONSTANT_TOKENS,
      ...CSS_VALUE_CONSTANT_TOKENS.flatMap((token) =>
        CSS_LANGUAGE_POSTFIXES.map((postfix) => `${token}.${postfix}`),
      ),
    ],
    foreground: "code.constant",
    fontStyle: "",
  },
  { scope: ["delimiter"], foreground: "text.ink", fontStyle: "" },
];

export function readCodeThemeRules(): CodeThemeRuleFile {
  const vendored = JSON.parse(
    readFileSync(codeThemeRulesPath, "utf8"),
  ) as CodeThemeRuleFile;
  return { ...vendored, rules: [...vendored.rules, ...MONACO_TOKEN_RULES] };
}
