import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { type CodeThemeRule, readCodeThemeRules } from "./code-theme-rules";

function withAlpha(color: string, alpha: number): string {
  return `${color}${alpha.toString(16).padStart(2, "0")}`;
}

const palette = {
  ground: {
    chrome: "#181818",
    conversation: "#151515",
    content: "#181818",
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
  depth: {
    blue: "#3093f4",
    magenta: "#c860cf",
    gold: "#b28b11",
    teal: "#04a891",
    violet: "#8a6ae6",
  },
  contentTint: {
    comment: "#7c7865",
    white: "#adada9",
    blue: "#7cacfe",
    purple: "#bdb2fe",
    cyan: "#75f0ff",
  },
} as const satisfies Record<string, unknown>;

// One neutral ladder for the whole adapter. Solid fallbacks composite these
// same layers only where a surface must occlude unrelated scrolling content.
const layers = {
  subtle: withAlpha(palette.text.ink, 0x0a), // 4%: card / field
  control: withAlpha(palette.text.ink, 0x0f), // 6%: user surface / secondary
  hover: withAlpha(palette.text.ink, 0x14), // 8%: hover / inline code / seam
  selected: withAlpha(palette.text.ink, 0x24), // 14%: action / selection
  active: withAlpha(palette.text.ink, 0x33), // 20%: pressed / strong edge
  edge: withAlpha(palette.text.ink, 0x1f), // 12%: control / pane edge
} as const;

// Every rendered color is named by role here. The CSS template refers to these
// names, never to palette hexes, so a palette change starts and ends in code.
// Alpha variants derive from their base role; the byte is explicit because its
// opacity is part of the role.
const roleValues = {
  "ground.chrome": palette.ground.chrome,
  "ground.chromeScrim": withAlpha(palette.ground.chrome, 0xeb),
  "ground.conversation": palette.ground.conversation,
  "ground.conversationScrim": withAlpha(palette.ground.conversation, 0xeb),
  "ground.content": palette.ground.content,
  "solid.recessed": flatten(layers.subtle, palette.ground.conversation),
  "solid.raised": flatten(layers.control, palette.ground.content),
  "layer.subtle": layers.subtle,
  "layer.control": layers.control,
  "layer.hover": layers.hover,
  "layer.selected": layers.selected,
  "layer.active": layers.active,
  "layer.edge": layers.edge,
  "text.ink": palette.text.ink,
  "text.ink07": withAlpha(palette.text.ink, 0x11),
  "text.ink17": withAlpha(palette.text.ink, 0x2c),
  "text.ink25": withAlpha(palette.text.ink, 0x40),
  "text.ink30": withAlpha(palette.text.ink, 0x4d),
  "text.ink55": withAlpha(palette.text.ink, 0x8c),
  "text.ink74": withAlpha(palette.text.ink, 0xbd),
  "text.comment60": withAlpha(palette.text.comment, 0x99),
  "accent.base": palette.accent,
  "accent.hoverSurface": withAlpha(palette.accent, 0x26),
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
  "depth.blue": palette.depth.blue,
  "depth.magenta": palette.depth.magenta,
  "depth.gold": palette.depth.gold,
  "depth.teal": palette.depth.teal,
  "depth.violet": palette.depth.violet,
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
const palettePreviewPath = fileURLToPath(new URL("../docs/media/palette.svg", import.meta.url));

// Documentation is generated from the same registry as the shipped theme.
// SVG paints the real alpha colors over the content ground.
export function renderPalettePreview(): string {
  const rows = [
    [
      "Opaque grounds",
      [
        ["Conversation", "ground.conversation"],
        ["Chrome / code", "ground.content"],
        ["Popover", "solid.recessed"],
        ["Recessed solid", "solid.recessed"],
        ["Raised solid", "solid.raised"],
      ],
    ],
    [
      "Relative layers",
      [
        ["Card / field 4%", "layer.subtle"],
        ["User / control 6%", "layer.control"],
        ["Hover / code 8%", "layer.hover"],
        ["Selected 14%", "layer.selected"],
        ["Active 20%", "layer.active"],
      ],
    ],
    [
      "Accent and feedback",
      [
        ["Accent", "accent.base"],
        ["Success", "feedback.success"],
        ["Warning", "feedback.warning"],
        ["Danger", "feedback.error"],
        ["Ink", "text.ink"],
      ],
    ],
  ] as const;
  const swatches = rows
    .map(([title, entries], row) => {
      const top = 30 + row * 124;
      return (
        `<text class="heading" x="24" y="${top}">${title}</text>\n` +
        entries
          .map(([label, role], index) => {
            const x = 24 + index * 164;
            return `<rect x="${x}" y="${top + 14}" width="148" height="48" rx="6" fill="${roleValues[role]}"/>
<text class="label" x="${x}" y="${top + 83}">${label}</text>`;
          })
          .join("\n")
      );
    })
    .join("\n");
  return `<!-- GENERATED by scripts/generate-theme.ts. -->
<svg xmlns="http://www.w3.org/2000/svg" width="852" height="376" viewBox="0 0 852 376" role="img" aria-label="Monokai opaque grounds and relative alpha layers">
<style>.heading{font:600 13px system-ui;fill:${palette.text.ink}}.label{font:12px system-ui;fill:${roleValues["text.ink74"]}}</style>
<rect width="852" height="376" rx="10" fill="${palette.ground.content}"/>
${swatches}
</svg>\n`;
}

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
      "editorBracketHighlight.foreground1": roleValues["text.ink"],
      "editorBracketHighlight.foreground2": roleValues["depth.blue"],
      "editorBracketHighlight.foreground3": roleValues["depth.magenta"],
      "editorBracketHighlight.foreground4": roleValues["depth.gold"],
      "editorBracketHighlight.foreground5": roleValues["depth.teal"],
      "editorBracketHighlight.foreground6": roleValues["depth.violet"],
      "editorBracketHighlight.unexpectedBracket.foreground": roleValues["feedback.error"],
      "editorBracketPairGuide.background1": roleValues["text.ink07"],
      "editorBracketPairGuide.background2": roleValues["text.ink07"],
      "editorBracketPairGuide.background3": roleValues["text.ink07"],
      "editorBracketPairGuide.background4": roleValues["text.ink07"],
      "editorBracketPairGuide.background5": roleValues["text.ink07"],
      "editorBracketPairGuide.background6": roleValues["text.ink07"],
      "editorBracketPairGuide.activeBackground1": roleValues["text.ink17"],
      "editorBracketPairGuide.activeBackground2": roleValues["text.ink17"],
      "editorBracketPairGuide.activeBackground3": roleValues["text.ink17"],
      "editorBracketPairGuide.activeBackground4": roleValues["text.ink17"],
      "editorBracketPairGuide.activeBackground5": roleValues["text.ink17"],
      "editorBracketPairGuide.activeBackground6": roleValues["text.ink17"],
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

function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`${label}: missing item ${index}`);
  }
  return value;
}

function parseRules(source: string, violations: string[]): CssRule[] {
  const rules: CssRule[] = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of source.matchAll(rulePattern)) {
    const selectors = requiredAt(match, 1, "CSS rule");
    const body = requiredAt(match, 2, normalize(selectors));
    const declarations = new Map<string, string>();
    const declarationPattern = /([\w-]+)\s*:\s*([^;{}]+);/g;
    for (const declaration of body.matchAll(declarationPattern)) {
      const name = requiredAt(declaration, 1, `${normalize(selectors)} declaration`).trim();
      if (declarations.has(name)) {
        violations.push(`${normalize(selectors)}: duplicate ${name}`);
      }
      declarations.set(
        name,
        normalize(requiredAt(declaration, 2, `${normalize(selectors)} ${name}`)),
      );
    }
    rules.push({
      selectors: selectors.split(",").map(normalize),
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
  "--bb-monokai-active": "1",
  "--bb-monokai-code-entity": palette.code.entity,
  "--canvas": palette.ground.conversation,
  "--ink": palette.text.ink,
  "--background": palette.ground.conversation,
  "--card": roleValues["layer.subtle"],
  "--popover": roleValues["solid.recessed"],
  "--secondary": roleValues["layer.control"],
  "--accent": roleValues["layer.hover"],
  "--muted": roleValues["layer.selected"],
  "--input": roleValues["layer.edge"],
  "--control-background": roleValues["layer.subtle"],
  "--control-primary": roleValues["layer.selected"],
  "--control-primary-hover": roleValues["layer.active"],
  "--surface-recessed": roleValues["layer.subtle"],
  "--surface-recessed-solid": roleValues["solid.recessed"],
  "--surface-recessed-soft-solid": roleValues["solid.recessed"],
  "--surface-raised": roleValues["layer.control"],
  "--surface-raised-solid": roleValues["solid.raised"],
  "--surface-scrim": roleValues["ground.conversationScrim"],
  "--agent-surface-background": roleValues["layer.control"],
  "--agent-surface-border": roleValues["layer.hover"],
  "--state-hover": roleValues["layer.hover"],
  "--state-active": roleValues["layer.active"],
  "--surface-selected": roleValues["layer.selected"],
  "--surface-selected-border": roleValues["layer.active"],
  "--border-seam": roleValues["layer.subtle"],
  "--border-seam-vertical": "var(--border-seam)",
  "--border": roleValues["layer.edge"],
  "--border-hairline": roleValues["layer.hover"],
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
  "--resource-source-shelf-card-hover-border": roleValues["layer.active"],
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
  "--terminal-background": palette.ground.chrome,
  "--terminal-font-family": '"BerkeleyMono Nerd Font Mono", "Berkeley Mono", monospace',
  "--terminal-font-size": "13",
  "--terminal-line-height": "1.4",
  "--sidebar": palette.ground.content,
  "--sidebar-foreground": roleValues["text.ink74"],
  "--sidebar-accent": roleValues["layer.hover"],
  "--sidebar-accent-foreground": palette.text.ink,
  "--sidebar-border": roleValues["layer.edge"],
  "--pill-surface": `linear-gradient(to bottom, ${roleValues["layer.control"]}, ${roleValues["layer.control"]})`,
  "--pill-surface-border": roleValues["layer.edge"],
  "--pill-foreground": palette.text.ink,
  "--pill-icon": roleValues["text.ink74"],
  "--pill-surface-selected": `linear-gradient(to bottom, ${roleValues["layer.selected"]}, ${roleValues["layer.selected"]})`,
  "--pill-surface-selected-border": roleValues["layer.active"],
  ...indexed("--ansi-", ansi),
  ...indexed("--ansi-bg-fg-", ansiForegrounds),
  "--diffs-addition-color-override": palette.feedback.success,
  "--diffs-deletion-color-override": palette.feedback.error,
  "--diffs-modified-color-override": palette.feedback.warning,
  "--diffs-bg-context-override": palette.ground.content,
  "--diffs-bg-context-gutter-override": palette.ground.content,
  "--diffs-bg-buffer-override": palette.ground.content,
  "--diffs-bg-separator-override": roleValues["layer.control"],
  "--diffs-bg-addition-override": roleValues["feedback.success13"],
  "--diffs-bg-addition-emphasis-override": roleValues["feedback.success27"],
  "--diffs-bg-deletion-override": roleValues["feedback.error13"],
  "--diffs-bg-deletion-emphasis-override": roleValues["feedback.error27"],
  "--diffs-bg-hover-override": roleValues["layer.hover"],
  "--diffs-bg-selection-override": roleValues["layer.selected"],
  "--diffs-bg-addition-number-override": palette.ground.content,
  "--diffs-bg-deletion-number-override": palette.ground.content,
  "--diffs-bg-selection-number-override": roleValues["layer.selected"],
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
  "--trees-input-bg-override": roleValues["layer.subtle"],
  "--trees-accent-override": palette.accent,
  "--trees-indent-guide-bg-override": roleValues["layer.edge"],
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
    selector: ".dark .bg-popover",
    declarations: { "--state-active": "var(--state-hover)" },
  },
  {
    selector: '.dark [role="menu"]',
    declarations: { "--state-active": "var(--state-hover)" },
  },
  {
    selector: ".dark .smart-embed",
    declarations: { "background-clip": "padding-box", "box-shadow": "none" },
  },
  {
    selector: '.dark .bg-popover > .border-b:has(input[aria-label="Search models"])',
    declarations: { "background-color": "var(--control-background)", "border-bottom-width": "0" },
  },
  {
    selector: '.dark .bg-popover > .border-b input[aria-label="Search models"]',
    declarations: { "background-color": "transparent" },
  },
  {
    selector: ".dark .last-turn-diff-chevron",
    declarations: { display: "flex" },
  },
  {
    selector: '.dark [data-sidebar="panel"]',
    declarations: { "border-color": "var(--sidebar-border)" },
  },
  {
    selector: ".dark #thread-detail-secondary-panel > aside",
    declarations: { "border-color": "var(--sidebar-border)" },
  },
  {
    selector:
      '.dark #thread-detail-secondary-panel-handle[data-panel-resize-handle-enabled="true"]',
    declarations: { "--border-seam": "var(--sidebar-border)" },
  },
  {
    selector:
      '.dark #thread-detail-secondary-panel-handle[data-panel-resize-handle-enabled="true"] + #thread-detail-secondary-panel > aside',
    declarations: { "border-color": "transparent" },
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
    declarations: { "background-color": "var(--control-background)" },
  },
  {
    selector: ".dark textarea.border-input",
    declarations: { "background-color": "var(--control-background)" },
  },
  {
    selector: ".dark select.border-input",
    declarations: { "background-color": "var(--control-background)" },
  },
  {
    selector: '.dark [role="combobox"].border-input',
    declarations: { "background-color": "var(--control-background)" },
  },
  {
    selector: ".dark [data-promptbox]",
    declarations: {
      "background-color": "var(--agent-surface-background)",
      "background-clip": "padding-box",
    },
  },
  {
    selector: ".dark [data-promptbox] [data-promptbox-editor-scroll]",
    declarations: {
      "background-color": "transparent",
      "border-radius": "11px 11px 0 0",
    },
  },
  {
    selector: '.dark [aria-label="Thread context before sending"]',
    declarations: { "background-color": "var(--agent-surface-background)" },
  },
  {
    selector:
      '.dark [aria-label="Thread context before sending"] > .flex.items-center.gap-0\\.5.p-1',
    declarations: { "background-color": "transparent" },
  },
  {
    selector: ".dark [data-agentation-staging-banner]",
    declarations: {
      "background-color": "var(--agent-surface-background)",
      "border-color": "var(--agent-surface-border)",
    },
  },
  {
    selector: ".dark [data-agentation-staging-banner] > ul",
    declarations: { "border-color": "var(--agent-surface-border)" },
  },
  {
    selector:
      '.dark body:has(a[aria-current="page"][href^="/settings"]) main main .bg-card:not(button):not(input):not(textarea):not(select):not(.bg-transparent)',
    declarations: {
      "background-color": "var(--card)",
      "border-width": "0",
    },
  },
  {
    selector:
      '.dark body:has(a[aria-current="page"][href^="/settings"]) main main li.rounded-md.border.border-border:not(.bg-transparent)',
    declarations: {
      "background-color": "var(--card)",
      "border-width": "0",
    },
  },
  {
    selector: ".dark .thread-scrollbar > .flex.min-h-full.min-w-0.flex-col",
    declarations: { "background-color": palette.ground.conversation },
  },
  {
    selector:
      ".dark #thread-detail-secondary-panel .rounded-lg.bg-background:has(> .flex > span > button[aria-expanded])",
    declarations: { "background-color": "var(--agent-surface-background)" },
  },
  {
    selector:
      ".dark #thread-detail-secondary-panel .sticky.rounded-lg.bg-background:has(> .flex > span > button[aria-expanded])",
    declarations: { "background-color": "var(--surface-raised-solid)" },
  },
  {
    selector: ".dark [data-message-column] [data-markdown-preview] a.underline",
    declarations: {
      color: "var(--primary)",
      "text-decoration-line": "none",
      "border-radius": "0.375rem",
      padding: "0.0625rem 0.25rem",
      "margin-inline": "-0.25rem",
      "box-decoration-break": "clone",
      "-webkit-box-decoration-break": "clone",
    },
  },
  {
    selector: ".dark code.bg-muted\\/70",
    declarations: { "background-color": "var(--accent)" },
  },
  {
    selector: ".dark [data-message-column] [data-markdown-preview] a.underline:hover",
    declarations: { "background-color": roleValues["accent.hoverSurface"] },
  },
  {
    selector: ".dark button.bg-primary",
    declarations: { "background-color": "var(--control-primary)", color: "var(--foreground)" },
  },
  {
    selector: ".dark button.bg-foreground",
    declarations: { "background-color": "var(--control-primary)", color: "var(--foreground)" },
  },
  {
    selector: ".dark button.bg-primary:hover",
    declarations: { "background-color": "var(--control-primary-hover)" },
  },
  {
    selector: ".dark button.bg-foreground:hover",
    declarations: { "background-color": "var(--control-primary-hover)" },
  },
  {
    selector: ".dark button.bg-secondary",
    declarations: {
      "background-color": "var(--secondary)",
      border: "1px solid var(--input)",
    },
  },
  {
    selector: ".dark button.bg-secondary:hover",
    declarations: { "background-color": "var(--state-hover)" },
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
      "background-color": palette.ground.content,
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
  {
    selector: ".dark .canvas-prose",
    declarations: {
      // Headings are display-size text, not code. The syntax entity green is
      // tuned for dense tokens and reads as neon at 1.5rem, so prose headings
      // take the strongest ink and leave links as the only colored prose.
      "--canvas-prose-heading": palette.text.ink,
      "--canvas-prose-strong": palette.code.type,
      "--canvas-prose-link": palette.code.type,
      "--canvas-prose-link-hover": palette.contentTint.cyan,
      "--canvas-prose-marker": palette.contentTint.comment,
      "--canvas-prose-quote-rule": palette.code.keyword,
      "--canvas-prose-rule": "var(--border-hairline)",
      "--canvas-prose-code-well": "var(--accent)",
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
  return [
    parseInt(core.slice(0, 2), 16),
    parseInt(core.slice(2, 4), 16),
    parseInt(core.slice(4, 6), 16),
  ];
}

function flatten(foreground: string, background: string): string {
  const core = foreground.replace("#", "");
  const alpha = core.length === 8 ? parseInt(core.slice(6, 8), 16) / 255 : 1;
  const [frontRed, frontGreen, frontBlue] = channels(foreground);
  const [backRed, backGreen, backBlue] = channels(background);
  return `#${[
    Math.round(alpha * frontRed + (1 - alpha) * backRed),
    Math.round(alpha * frontGreen + (1 - alpha) * backGreen),
    Math.round(alpha * frontBlue + (1 - alpha) * backBlue),
  ]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [red, green, blue] = channels(hex);
  return (
    0.2126 * srgbToLinear(red / 255) +
    0.7152 * srgbToLinear(green / 255) +
    0.0722 * srgbToLinear(blue / 255)
  );
}

function contrast(a: string, b: string): number {
  const left = luminance(a);
  const right = luminance(b);
  const high = Math.max(left, right);
  const low = Math.min(left, right);
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
      requiredAt(matches, 0, selector).declarations,
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
    flatten(layers.selected, flatten(layers.control, roleValues["solid.raised"])),
    4.5,
    violations,
  );
  requireContrast(
    "secondary button text",
    palette.text.ink,
    roleValues["solid.recessed"],
    4.5,
    violations,
  );
  for (const [index, background] of ansi.entries()) {
    requireContrast(
      `--ansi-bg-fg-${index} on --ansi-${index}`,
      requiredAt(ansiForegrounds, index, "ANSI foreground"),
      background,
      index === 8 ? 4 : 4.5,
      violations,
    );
  }
  requireContrast(
    "inline comment on recessed well",
    roleValues["text.comment60"],
    roleValues["solid.recessed"],
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
  await emit(palettePreviewPath, renderPalettePreview(), check);

  const codeTheme = renderCodeTheme(readCodeThemeRules().rules);
  await emit(codeThemePath, `${JSON.stringify(codeTheme, null, 2)}\n`, check);

  console.log("bb Monokai generated and contract audit passed.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
