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
// `attribute.name.css`, and their peers. Monaco's inherited themes also carry
// exact language-postfixed rules. Those beat a prefix rule, so each bridged
// family includes the exact postfixes it needs. Keep this bridge separate from
// the vendored Cursor rules because sync:code-theme replaces that file
// wholesale.
const CSS_VALUE_CONSTANT_TOKENS = [
  "attribute.value.number",
  "attribute.value.hex",
  "attribute.value.unit",
] as const;

const CSS_LANGUAGE_POSTFIXES = ["css", "scss", "less"] as const;

const TYPESCRIPT_LANGUAGE_POSTFIXES = ["js", "ts"] as const;

function withLanguagePostfixes(tokens: readonly string[], postfixes: readonly string[]): string[] {
  return [
    ...tokens,
    ...tokens.flatMap((token) => postfixes.map((postfix) => `${token}.${postfix}`)),
  ];
}

const MONACO_NUMBER_TOKENS = [
  "number",
  "number.float",
  "number.hex",
  "number.octal",
  "number.binary",
] as const;

const MONACO_REGEXP_TOKENS = ["regexp"] as const;

const MONACO_ESCAPE_TOKENS = ["regexp.escape", "regexp.escape.control", "string.escape"] as const;

const MONACO_TOKEN_RULES: readonly CodeThemeRule[] = [
  { scope: ["tag"], foreground: "code.keyword", fontStyle: "" },
  { scope: ["attribute.name"], foreground: "code.type", fontStyle: "" },
  { scope: ["attribute.value"], foreground: "code.string", fontStyle: "" },
  {
    scope: [
      ...withLanguagePostfixes(CSS_VALUE_CONSTANT_TOKENS, CSS_LANGUAGE_POSTFIXES),
      ...withLanguagePostfixes(MONACO_NUMBER_TOKENS, TYPESCRIPT_LANGUAGE_POSTFIXES),
    ],
    foreground: "code.constant",
    fontStyle: "",
  },
  {
    scope: withLanguagePostfixes(MONACO_REGEXP_TOKENS, TYPESCRIPT_LANGUAGE_POSTFIXES),
    foreground: "code.string",
    fontStyle: "",
  },
  {
    scope: withLanguagePostfixes(MONACO_ESCAPE_TOKENS, TYPESCRIPT_LANGUAGE_POSTFIXES),
    foreground: "code.constant",
    fontStyle: "",
  },
  // Monarch calls every capitalized JavaScript or TypeScript identifier a
  // type, including imported components and SCREAMING_SNAKE_CASE values. The
  // Cursor contract requires proof of a semantic role before spending cyan,
  // so the lexical fallback stays plain foreground.
  {
    scope: withLanguagePostfixes(["identifier", "type.identifier"], TYPESCRIPT_LANGUAGE_POSTFIXES),
    foreground: "text.ink",
    fontStyle: "",
  },
  { scope: ["storage.type"], foreground: "code.type", fontStyle: "italic" },
  { scope: ["entity.name.function"], foreground: "code.entity", fontStyle: "" },
  {
    scope: ["entity.name.function.declaration"],
    foreground: "code.entity",
    fontStyle: "bold",
  },
  { scope: ["variable.parameter"], foreground: "code.parameter", fontStyle: "italic" },
  {
    scope: ["variable.parameter.reference"],
    foreground: "code.parameter",
    fontStyle: "",
  },
  { scope: ["entity.name.type"], foreground: "code.type", fontStyle: "" },
  { scope: ["delimiter"], foreground: "text.ink", fontStyle: "" },
];

export function readCodeThemeRules(): CodeThemeRuleFile {
  const vendored = JSON.parse(readFileSync(codeThemeRulesPath, "utf8")) as CodeThemeRuleFile;
  return { ...vendored, rules: [...vendored.rules, ...MONACO_TOKEN_RULES] };
}
