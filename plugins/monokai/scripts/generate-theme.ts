import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { type CodeThemeRule, readCodeThemeRules } from "./code-theme-rules";

function withAlpha(color: string, alpha: number): string {
  return `${color}${alpha.toString(16).padStart(2, "0")}`;
}

const palette = {
  ground: {
    chrome: "#141414",
    content: "#181818",
    recessed: "#1e1e1e",
    raised: "#262626",
    selection: "#404040",
  },
  control: {
    primary: "#363635",
    edge: "#3c3c3c",
    paneDivider: "#2b2b2b",
  },
  text: {
    ink: "#e3e3dd",
    comment: "#beb899",
  },
  accent: "#88c0d0",
  feedback: {
    error: "#e34671",
    warning: "#f1b467",
    success: "#3fa266",
    info: "#6796e6",
    debug: "#b267e6",
  },
  code: {
    keyword: "#fe5d86",
    entity: "#9ddd54",
    string: "#f7d05c",
    type: "#51dae9",
    constant: "#a895fe",
    // Values passed into scope. The bb chrome has no parameter role, so this
    // hue reaches only the code theme — it is here because CONTRACT.md owns it,
    // not because a CSS token spends it.
    parameter: "#ff8342",
  },
  contentTint: {
    comment: "#7c7865",
    white: "#adada9",
    blue: "#7cacfe",
    purple: "#bdb2fe",
    cyan: "#75f0ff",
  },
} as const satisfies Record<string, unknown>;

// Every rendered color is named by role here. The CSS template refers to these
// names, never to palette hexes, so a palette change starts and ends in code.
// Alpha variants derive from their base role; the byte is explicit because its
// opacity is part of the role.
const roleValues = {
  "ground.chrome": palette.ground.chrome,
  "ground.chromeScrim": withAlpha(palette.ground.chrome, 0xeb),
  "ground.content": palette.ground.content,
  "ground.recessed": palette.ground.recessed,
  "ground.raised": palette.ground.raised,
  "ground.selection": palette.ground.selection,
  "ground.selection60": withAlpha(palette.ground.selection, 0x99),
  "control.primary": palette.control.primary,
  "control.edge": palette.control.edge,
  "control.paneDivider": palette.control.paneDivider,
  "text.ink": palette.text.ink,
  "text.ink03": withAlpha(palette.text.ink, 0x08),
  "text.ink07": withAlpha(palette.text.ink, 0x11),
  "text.ink08": withAlpha(palette.text.ink, 0x12),
  "text.ink12": withAlpha(palette.text.ink, 0x1e),
  "text.ink17": withAlpha(palette.text.ink, 0x2c),
  "text.ink20": withAlpha(palette.text.ink, 0x32),
  "text.ink25": withAlpha(palette.text.ink, 0x40),
  "text.ink30": withAlpha(palette.text.ink, 0x4d),
  "text.ink55": withAlpha(palette.text.ink, 0x8c),
  "text.ink74": withAlpha(palette.text.ink, 0xbd),
  "text.comment60": withAlpha(palette.text.comment, 0x99),
  "accent.base": palette.accent,
  "accent.match": withAlpha(palette.accent, 0x44),
  "accent.matchBorder": withAlpha(palette.accent, 0x66),
  "feedback.error": palette.feedback.error,
  "feedback.error08": withAlpha(palette.feedback.error, 0x14),
  "feedback.error13": withAlpha(palette.feedback.error, 0x22),
  "feedback.error27": withAlpha(palette.feedback.error, 0x44),
  "feedback.error30": withAlpha(palette.feedback.error, 0x4d),
  "feedback.warning": palette.feedback.warning,
  "feedback.warning12": withAlpha(palette.feedback.warning, 0x1f),
  "feedback.success": palette.feedback.success,
  "feedback.success13": withAlpha(palette.feedback.success, 0x22),
  "feedback.success27": withAlpha(palette.feedback.success, 0x44),
  "feedback.info": palette.feedback.info,
  "feedback.debug": palette.feedback.debug,
  "code.keyword": palette.code.keyword,
  "code.keyword60": withAlpha(palette.code.keyword, 0x99),
  "code.entity": palette.code.entity,
  "code.string": palette.code.string,
  "code.type": palette.code.type,
  "code.constant": palette.code.constant,
  "code.constant63": withAlpha(palette.code.constant, 0xa0),
  "code.parameter": palette.code.parameter,
  "content.comment": palette.contentTint.comment,
  "content.white": palette.contentTint.white,
  "content.blue": palette.contentTint.blue,
  "content.purple": palette.contentTint.purple,
  "content.cyan": palette.contentTint.cyan,
} as const satisfies Record<string, string>;

interface CssRule {
  selectors: string[];
  declarations: Map<string, string>;
}

const templatePath = fileURLToPath(new URL("./bb-monokai.template.css", import.meta.url));
const themePath = fileURLToPath(new URL("../themes/bb-monokai.css", import.meta.url));
const codeThemePath = fileURLToPath(new URL("../themes/bb-monokai-code.json", import.meta.url));

// bb registers the shipped file under its own name, so this one is only what a
// reader sees in a stack trace. It stays distinct from the CSS theme's name so
// the two cannot be confused in a log line.
const CODE_THEME_NAME = "bb Monokai Code";

// Roles a syntax token may spend. Narrower than the chrome registry on purpose:
// the code hues carry kind, the ink ladder and comment tint carry the text
// tiers, feedback marks invalid and log levels, and the content ground is the
// one legal background. The accent, the control colors and the ANSI content
// tints are chrome-only — a token wearing one would claim a meaning it does not
// have.
const tokenRoles = new Set<keyof typeof roleValues>([
  "text.ink",
  "text.ink55",
  "text.ink30",
  "text.comment60",
  "code.keyword",
  "code.keyword60",
  "code.entity",
  "code.string",
  "code.type",
  "code.constant",
  "code.constant63",
  "code.parameter",
  "feedback.error",
  "feedback.warning",
  "feedback.info",
  "feedback.debug",
  "ground.content",
]);

const allowedBases = new Set(
  Object.values(roleValues).map((color) => color.slice(1, 7).toLowerCase()),
);

const generatedBanner = `/* GENERATED by scripts/generate-theme.ts from bb-monokai.template.css.
 * Change CONTRACT.md, then the generator/template; never edit this file. */\n`;

export function renderTheme(template: string): string {
  const renderedHexes = [...stripComments(template).matchAll(/#[0-9a-fA-F]{3,8}\b/g)];
  if (renderedHexes.length > 0) {
    throw new Error(
      `Theme template contains rendered hex(es): ${[...new Set(renderedHexes.map((match) => match[0]))].join(", ")}. Use symbolic roles.`,
    );
  }
  const unknown = new Set<string>();
  const rendered = template.replace(/\{\{([A-Za-z0-9.]+)\}\}/g, (_match, role: string) => {
    const value = roleValues[role as keyof typeof roleValues];
    if (value === undefined) {
      unknown.add(role);
      return `{{${role}}}`;
    }
    return value;
  });
  if (unknown.size > 0) {
    throw new Error(`Unknown theme role(s): ${[...unknown].sort().join(", ")}`);
  }
  const unresolved = rendered.match(/\{\{[^\n{}]+\}\}/g);
  if (unresolved !== null) {
    throw new Error(`Malformed theme role placeholder(s): ${unresolved.join(", ")}`);
  }
  return `${generatedBanner}${rendered.trimStart()}`;
}

interface CodeThemeSettings {
  foreground?: string;
  background?: string;
  fontStyle?: string;
}

export interface CodeTheme {
  name: string;
  type: "dark";
  colors: Record<string, string>;
  tokenColors: Array<{ scope: string[]; settings: CodeThemeSettings }>;
}

function tokenColor(role: string, scope: readonly string[], violations: string[]): string {
  if (!tokenRoles.has(role as keyof typeof roleValues)) {
    violations.push(`${scope[0] ?? "(no scope)"}: ${role} is not a token role`);
    return "#000000";
  }
  return roleValues[role as keyof typeof roleValues];
}

// Renders the vendored scope map against the palette. bb hands the result to
// Shiki, which reads `colors` for the default pair and `tokenColors` for the
// rest; there is no language server behind a diff, so the editor theme's
// semantic layer has nothing to resolve here and is left out.
export function renderCodeTheme(rules: readonly CodeThemeRule[]): CodeTheme {
  const violations: string[] = [];
  const tokenColors = rules.map((rule) => {
    if (rule.scope.length === 0) {
      violations.push("a rule carries no scope");
    }
    const settings: CodeThemeSettings = {};
    if (rule.foreground !== undefined) {
      settings.foreground = tokenColor(rule.foreground, rule.scope, violations);
    }
    if (rule.background !== undefined) {
      settings.background = tokenColor(rule.background, rule.scope, violations);
    }
    if (rule.fontStyle !== undefined) {
      settings.fontStyle = rule.fontStyle;
    }
    if (Object.keys(settings).length === 0) {
      violations.push(`${rule.scope[0] ?? "(no scope)"}: a rule with no settings`);
    }
    return { scope: rule.scope, settings };
  });
  if (violations.length > 0) {
    throw new Error(
      `bb Monokai code theme audit failed — ${violations.length} violation(s):\n  ${violations.join("\n  ")}`,
    );
  }
  return {
    name: CODE_THEME_NAME,
    type: "dark",
    colors: {
      "editor.background": roleValues["ground.content"],
      "editor.foreground": roleValues["text.ink"],
    },
    tokenColors,
  };
}

function stripComments(source: string): string {
  // Preserve newlines so diagnostics still point at the source line. Comments
  // may name foreign upstream defaults; only rendered declarations are audited.
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseRules(source: string, violations: string[]): CssRule[] {
  const rules: CssRule[] = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of source.matchAll(rulePattern)) {
    const declarations = new Map<string, string>();
    const declarationPattern = /([\w-]+)\s*:\s*([^;{}]+);/g;
    for (const declaration of match[2].matchAll(declarationPattern)) {
      const name = declaration[1].trim();
      if (declarations.has(name)) {
        violations.push(`${normalize(match[1])}: duplicate ${name}`);
      }
      declarations.set(name, normalize(declaration[2]));
    }
    rules.push({
      selectors: match[1].split(",").map(normalize),
      declarations,
    });
  }
  return rules;
}

function colorBase(color: string): string | null {
  const match = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(color.toLowerCase());
  return match?.[1] ?? null;
}

function declarationMap(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries).map(([name, value]) => [name, normalize(value)]));
}

function indexed(prefix: string, values: readonly string[]): Record<string, string> {
  return Object.fromEntries(values.map((value, index) => [`${prefix}${index}`, value]));
}

const ansi = [
  palette.ground.chrome,
  palette.feedback.error,
  palette.feedback.success,
  palette.feedback.warning,
  palette.feedback.info,
  palette.code.constant,
  palette.code.type,
  palette.contentTint.white,
  palette.contentTint.comment,
  palette.code.keyword,
  palette.code.entity,
  palette.code.string,
  palette.contentTint.blue,
  palette.contentTint.purple,
  palette.contentTint.cyan,
  palette.text.ink,
] as const;

const ansiForegrounds = [
  palette.text.ink,
  ...Array.from({ length: 15 }, () => palette.ground.chrome),
] as const;

// This registry is the bb adapter's role mapping. A CSS custom property that
// appears in the root .dark rule must be registered here, so adding a bb token
// cannot silently inherit an upstream color or borrow a legal color for the
// wrong role.
const darkExpected = declarationMap({
  "--canvas": palette.ground.content,
  "--ink": palette.text.ink,
  "--background": palette.ground.content,
  "--card": palette.ground.chrome,
  "--popover": palette.ground.chrome,
  "--secondary": palette.ground.raised,
  "--accent": palette.ground.raised,
  "--muted": palette.ground.selection,
  "--input": palette.control.edge,
  "--surface-recessed": roleValues["text.ink03"],
  "--surface-recessed-solid": palette.ground.recessed,
  "--surface-recessed-soft-solid": palette.ground.recessed,
  "--surface-raised": roleValues["text.ink08"],
  "--surface-raised-solid": palette.ground.raised,
  "--surface-scrim": roleValues["ground.chromeScrim"],
  "--agent-surface-background": palette.ground.recessed,
  "--agent-surface-border": roleValues["text.ink07"],
  "--state-hover": roleValues["text.ink08"],
  "--state-active": roleValues["text.ink20"],
  "--surface-selected": roleValues["text.ink12"],
  "--surface-selected-border": roleValues["text.ink25"],
  "--border-seam": roleValues["text.ink07"],
  "--border-seam-vertical": "var(--border-seam)",
  "--border": roleValues["text.ink12"],
  "--border-hairline": roleValues["text.ink17"],
  "--foreground": palette.text.ink,
  "--muted-foreground": roleValues["text.ink74"],
  "--readback-foreground": roleValues["text.ink55"],
  "--subtle-foreground": roleValues["text.ink30"],
  "--accent-foreground": palette.text.ink,
  "--secondary-foreground": palette.text.ink,
  "--primary": palette.accent,
  "--primary-foreground": palette.ground.chrome,
  "--timeline-accent": palette.accent,
  "--file-accent": palette.accent,
  "--ring": roleValues["text.ink25"],
  "--sidebar-ring": roleValues["text.ink25"],
  "--sidebar-search-match": roleValues["accent.match"],
  "--sidebar-search-match-border": roleValues["accent.matchBorder"],
  "--resource-source-shelf-card-hover-border": roleValues["text.ink25"],
  "--destructive": palette.feedback.error,
  "--destructive-foreground": palette.ground.chrome,
  "--destructive-text": palette.feedback.error,
  "--warning": palette.feedback.warning,
  "--warning-text": palette.feedback.warning,
  "--attention": palette.feedback.warning,
  "--success": palette.feedback.success,
  "--success-foreground": palette.feedback.success,
  "--diff-added": palette.feedback.success,
  "--diff-removed": palette.feedback.error,
  "--pr-merged": palette.feedback.debug,
  "--surface-destructive": roleValues["feedback.error08"],
  "--surface-destructive-border": roleValues["feedback.error30"],
  "--surface-attention": roleValues["feedback.warning12"],
  "--sidebar": palette.ground.chrome,
  "--sidebar-foreground": roleValues["text.ink74"],
  "--sidebar-accent": palette.ground.raised,
  "--sidebar-accent-foreground": palette.text.ink,
  "--sidebar-border": palette.control.paneDivider,
  "--pill-surface": `linear-gradient(to bottom, ${palette.ground.raised}, ${palette.ground.raised})`,
  "--pill-surface-border": roleValues["text.ink12"],
  "--pill-foreground": palette.text.ink,
  "--pill-icon": roleValues["text.ink74"],
  "--pill-surface-selected": `linear-gradient(to bottom, ${palette.ground.selection}, ${palette.ground.selection})`,
  "--pill-surface-selected-border": roleValues["text.ink25"],
  ...indexed("--ansi-", ansi),
  ...indexed("--ansi-bg-fg-", ansiForegrounds),
  "--diffs-addition-color-override": palette.feedback.success,
  "--diffs-deletion-color-override": palette.feedback.error,
  "--diffs-modified-color-override": palette.feedback.warning,
  "--diffs-bg-context-override": palette.ground.content,
  "--diffs-bg-context-gutter-override": palette.ground.chrome,
  "--diffs-bg-buffer-override": palette.ground.chrome,
  "--diffs-bg-separator-override": palette.ground.chrome,
  "--diffs-bg-addition-override": roleValues["feedback.success13"],
  "--diffs-bg-addition-emphasis-override": roleValues["feedback.success27"],
  "--diffs-bg-deletion-override": roleValues["feedback.error13"],
  "--diffs-bg-deletion-emphasis-override": roleValues["feedback.error27"],
  "--diffs-bg-hover-override": roleValues["text.ink08"],
  "--diffs-bg-selection-override": roleValues["ground.selection60"],
  "--diffs-bg-addition-number-override": palette.ground.chrome,
  "--diffs-bg-deletion-number-override": palette.ground.chrome,
  "--diffs-bg-selection-number-override": palette.ground.raised,
  "--diffs-fg-number-override": roleValues["text.ink55"],
  "--diffs-fg-number-addition-override": palette.feedback.success,
  "--diffs-fg-number-deletion-override": palette.feedback.error,
  "--diffs-fg-conflict-marker-override": palette.feedback.warning,
  "--trees-status-added-override": palette.feedback.success,
  "--trees-status-untracked-override": palette.feedback.success,
  "--trees-status-renamed-override": palette.feedback.success,
  "--trees-status-modified-override": palette.feedback.warning,
  "--trees-status-deleted-override": palette.feedback.error,
  "--trees-status-ignored-override": roleValues["text.ink30"],
  "--trees-input-bg-override": palette.ground.recessed,
  "--trees-accent-override": palette.accent,
  "--trees-indent-guide-bg-override": roleValues["text.ink17"],
  "--trees-fg-muted-override": roleValues["text.ink55"],
  "--trees-focus-ring-color-override": roleValues["text.ink25"],
  "--trees-file-icon-color": roleValues["text.ink55"],
  "--trees-file-icon-vermilion": roleValues["text.ink55"],
  "--trees-file-icon-cyan": roleValues["text.ink55"],
});

const requiredRules: Array<{
  selector: string;
  declarations: Record<string, string>;
}> = [
  {
    selector: ".dark #thread-detail-secondary-panel",
    declarations: { "--sidebar": palette.ground.content },
  },
  {
    selector: ".dark .rounded-xl.border.border-border-seam.bg-surface-recessed",
    declarations: {
      "background-color": "var(--agent-surface-background)",
      "border-color": "var(--agent-surface-border)",
    },
  },
  {
    selector: ".dark input.border-input",
    declarations: { "background-color": palette.ground.recessed },
  },
  {
    selector: ".dark textarea.border-input",
    declarations: { "background-color": palette.ground.recessed },
  },
  {
    selector: ".dark select.border-input",
    declarations: { "background-color": palette.ground.recessed },
  },
  {
    selector: '.dark [role="combobox"].border-input',
    declarations: { "background-color": palette.ground.recessed },
  },
  {
    selector: ".dark [data-promptbox]",
    declarations: { "background-color": palette.ground.recessed },
  },
  {
    selector: ".dark button.bg-primary",
    declarations: { "background-color": palette.control.primary, color: "var(--foreground)" },
  },
  {
    selector: ".dark button.bg-foreground",
    declarations: { "background-color": palette.control.primary, color: "var(--foreground)" },
  },
  {
    selector: ".dark button.bg-primary:hover",
    declarations: { "background-color": palette.ground.selection },
  },
  {
    selector: ".dark button.bg-foreground:hover",
    declarations: { "background-color": palette.ground.selection },
  },
  {
    selector: ".dark button.bg-secondary",
    declarations: {
      "background-color": palette.ground.recessed,
      border: "1px solid var(--input)",
    },
  },
  {
    selector: ".dark button.bg-secondary:hover",
    declarations: { "background-color": palette.ground.raised },
  },
  {
    selector: '.dark [data-promptbox-submit-action][aria-label="stop run"]',
    declarations: {
      "background-color": "var(--destructive)",
      "border-color": "transparent",
      color: "var(--foreground)",
    },
  },
  {
    // Doubled class: bb re-declares six of these on the single-class selector
    // from a chunk that loads after this sheet, so a tie loses.
    selector: ".dark .bb-code-highlight.bb-code-highlight",
    declarations: {
      "--sh-identifier": palette.text.ink,
      "--sh-property": palette.text.ink,
      "--sh-sign": palette.text.ink,
      "--sh-comment": roleValues["text.comment60"],
      "--sh-keyword": palette.code.keyword,
      "--sh-string": palette.code.string,
      "--sh-class": palette.code.type,
      "--sh-entity": palette.code.entity,
      "--sh-jsxliterals": palette.code.keyword,
    },
  },
  {
    selector: "diffs-container",
    declarations: {
      "--diffs-dark-bg": palette.ground.content,
      "--diffs-dark": palette.text.ink,
    },
  },
];

function assertExpected(
  label: string,
  actual: Map<string, string>,
  expected: Map<string, string>,
  violations: string[],
): void {
  for (const [name, value] of expected) {
    const got = actual.get(name);
    if (got === undefined) {
      violations.push(`${label} ${name}: MISSING (bb default leaks in)`);
    } else if (got !== value) {
      violations.push(`${label} ${name}: expected ${value}, got ${got}`);
    }
  }
}

function channels(hex: string): [number, number, number] {
  const core = hex.replace("#", "");
  return [0, 2, 4].map((offset) => parseInt(core.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function flatten(foreground: string, background: string): string {
  const core = foreground.replace("#", "");
  const alpha = core.length === 8 ? parseInt(core.slice(6, 8), 16) / 255 : 1;
  const front = channels(foreground);
  const back = channels(background);
  return `#${front
    .map((channel, index) => Math.round(alpha * channel + (1 - alpha) * back[index]))
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [red, green, blue] = channels(hex).map((channel) => srgbToLinear(channel / 255));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (high + 0.05) / (low + 0.05);
}

function requireContrast(
  label: string,
  foreground: string,
  background: string,
  minimum: number,
  violations: string[],
): void {
  const ratio = contrast(flatten(foreground, background), background);
  if (ratio < minimum) {
    violations.push(`${label}: ${ratio.toFixed(2)}:1 (needs ${minimum.toFixed(1)}:1)`);
  }
}

export function auditTheme(source: string): void {
  const clean = stripComments(source);
  const violations: string[] = [];
  const rules = parseRules(clean, violations);

  for (const match of clean.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const color = match[0].toLowerCase();
    const base = colorBase(color);
    const line = clean.slice(0, match.index).split("\n").length;
    if (base === null) {
      violations.push(`line ${line}: ${color} must use six RGB digits plus optional alpha`);
    } else if (!allowedBases.has(base)) {
      violations.push(`line ${line}: ${color} is off-contract`);
    }
  }

  const darkRules = rules.filter((rule) => rule.selectors.includes(".dark"));
  if (darkRules.length !== 1) {
    violations.push(`.dark root: expected one rule, found ${darkRules.length}`);
  }
  const dark = darkRules[0]?.declarations ?? new Map<string, string>();
  assertExpected(".dark", dark, darkExpected, violations);
  for (const name of dark.keys()) {
    if (name.startsWith("--") && !darkExpected.has(name)) {
      violations.push(`.dark ${name}: UNREGISTERED (add its role to the audit)`);
    }
  }

  for (const required of requiredRules) {
    const selector = normalize(required.selector);
    const matches = rules.filter((rule) => rule.selectors.includes(selector));
    if (matches.length !== 1) {
      violations.push(`${selector}: expected one rule, found ${matches.length}`);
      continue;
    }
    assertExpected(
      selector,
      matches[0].declarations,
      declarationMap(required.declarations),
      violations,
    );
  }

  const token = (name: string): string => dark.get(name) ?? "#000000";
  for (const [foreground, background] of [
    ["--foreground", "--background"],
    ["--muted-foreground", "--background"],
    ["--readback-foreground", "--background"],
    ["--sidebar-foreground", "--sidebar"],
    ["--primary-foreground", "--primary"],
    ["--destructive-foreground", "--destructive"],
  ] as const) {
    requireContrast(
      `${foreground} on ${background}`,
      token(foreground),
      token(background),
      4.5,
      violations,
    );
  }
  requireContrast(
    "primary button text",
    palette.text.ink,
    palette.control.primary,
    4.5,
    violations,
  );
  requireContrast(
    "secondary button text",
    palette.text.ink,
    palette.ground.recessed,
    4.5,
    violations,
  );
  for (const [index, background] of ansi.entries()) {
    requireContrast(
      `--ansi-bg-fg-${index} on --ansi-${index}`,
      ansiForegrounds[index],
      background,
      index === 8 ? 4 : 4.5,
      violations,
    );
  }
  requireContrast(
    "inline comment on recessed well",
    roleValues["text.comment60"],
    palette.ground.recessed,
    3.8,
    violations,
  );

  if (violations.length > 0) {
    throw new Error(
      `bb Monokai contract audit failed — ${violations.length} violation(s):\n  ${violations.join("\n  ")}`,
    );
  }
}

async function emit(path: string, output: string, check: boolean): Promise<void> {
  const current = await readFile(path, "utf8").catch(() => null);
  if (check) {
    if (current !== output) {
      throw new Error(`${path} is stale. Run bun run generate:theme.`);
    }
  } else if (current !== output) {
    await writeFile(path, output);
  }
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const css = renderTheme(await readFile(templatePath, "utf8"));
  auditTheme(css);
  await emit(themePath, css, check);

  const codeTheme = renderCodeTheme(readCodeThemeRules().rules);
  await emit(codeThemePath, `${JSON.stringify(codeTheme, null, 2)}\n`, check);

  console.log("bb Monokai generated and contract audit passed.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
