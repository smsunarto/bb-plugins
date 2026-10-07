import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readCodeThemeRules } from "../scripts/code-theme-rules";
import { auditTheme, renderCodeTheme, renderTheme, roleValues } from "../scripts/generate-theme";
import { convertRules } from "../scripts/sync-code-theme";

const templatePath = fileURLToPath(new URL("../scripts/bb-monokai.template.css", import.meta.url));
const themePath = fileURLToPath(new URL("../themes/bb-monokai.css", import.meta.url));
const codeThemePath = fileURLToPath(new URL("../themes/bb-monokai-code.json", import.meta.url));
const template = await readFile(templatePath, "utf8");
const theme = await readFile(themePath, "utf8");
const codeTheme = await readFile(codeThemePath, "utf8");
const codeThemeRules = readCodeThemeRules().rules;
const diffHeaderCss = await readFile(new URL("../app/diff-header.css", import.meta.url), "utf8");

// Each style rule with the at-rule preludes around it, outermost first. The
// theme has no braces inside strings, so brace depth is the nesting.
function styleRules(css: string): Array<{ selector: string; atRules: string[] }> {
  const rules: Array<{ selector: string; atRules: string[] }> = [];
  const open: string[] = [];
  for (const [, text = "", brace] of css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/([^{}]*)([{}])/g)) {
    if (brace === "{") {
      open.push(text.trim().replace(/\s+/g, " "));
      continue;
    }
    const selector = open.pop() ?? "";
    if (!selector.startsWith("@")) rules.push({ selector, atRules: [...open] });
  }
  return rules;
}

describe("bb Monokai surface palette", () => {
  test("assigns conversation, sidebar, user, and chrome grounds", () => {
    expect(theme).toContain("--background: #151515");
    expect(theme).toContain("--sidebar: #181818");
    expect(theme).toContain("--popover: #1d1d1d");
    expect(theme).toContain("--agent-surface-background: #e3e3dd0f");
    expect(theme).toContain(
      ".dark [data-promptbox] {\n  background-color: var(--agent-surface-background)",
    );
    expect(theme).toContain(
      ".dark code.bg-muted\\/70,\n.dark .bb-markdown-prose :not(pre) > code {\n  background-color: var(--accent);\n  color: #eed996;",
    );
    expect(theme).toContain(
      ".dark [data-message-column].group\\/message [data-markdown-preview],\n.dark .bb-markdown-prose,\n.dark .canvas-prose [data-markdown-preview] {\n  font-size: max(14px, var(--text-sm))",
    );
    expect(theme).toContain("--terminal-background: #181818");
  });

  test("pins annotated bb surfaces to their intended grounds", () => {
    expect(theme).toContain(
      ".dark .thread-scrollbar > .flex.min-h-full.min-w-0.flex-col {\n  background-color: #151515",
    );
    expect(theme).toContain(
      ".dark [data-promptbox] [data-promptbox-editor-scroll] {\n  background-color: transparent;\n  border-radius: 11px 11px 0 0",
    );
    expect(theme).toContain(
      '.dark [aria-label="Thread context before sending"] {\n  background-color: var(--agent-surface-background)',
    );
    expect(theme).toContain(
      '[aria-label="Thread context before sending"]\n  > .flex.items-center.gap-0\\.5.p-1 {\n  background-color: transparent',
    );
    expect(theme).toContain(
      ".dark [data-agentation-staging-banner] {\n  background-color: var(--agent-surface-background);\n  background-clip: padding-box;\n  border-color: var(--agent-surface-border)",
    );
  });

  test("styles conversation links with an alpha-derived accent hover surface", () => {
    expect(theme).toContain(
      ".dark [data-message-column] [data-markdown-preview] a.underline,\n.dark .bb-markdown-prose a {\n  color: var(--primary);\n  text-decoration-line: none;",
    );
    expect(theme).toContain(
      "@media (hover: hover) {\n  .dark [data-message-column] [data-markdown-preview] a.underline:hover,\n  .dark .bb-markdown-prose a:hover {\n    background-color: #88c0d026;",
    );
  });
});

describe("bb Monokai contract audit", () => {
  test("keeps code bodies dark and gives headers and separators the requested surface", () => {
    expect(theme).toContain("--diffs-header-font-family: var(--font-sans)");
    expect(theme).toContain("diffs-container {\n  --diffs-dark-bg: #181818;");
    expect(theme).toContain(
      ".dark .bb-code-highlight.bb-code-highlight {\n  background-color: #181818;",
    );
    for (const role of ["context-gutter", "buffer", "addition-number", "deletion-number"]) {
      expect(theme).toContain(`--diffs-bg-${role}-override: #181818`);
    }
    expect(theme).toContain("--diffs-bg-separator-override: #e3e3dd0f");
    expect(theme).toContain(
      ".dark [data-monokai-diff-shell] {\n  background-color: var(--agent-surface-background);",
    );
    expect(theme).toContain(
      ".dark .smart-embed-header,\n.dark .last-turn-diff-heading {\n  background-color: var(--agent-surface-background);",
    );
    expect(theme).toContain(".font-mono {\n  font-family: var(--font-sans);");
    expect(theme).toContain(".dark .smart-embed-path,");
  });

  test("the shipped CSS is generated from the code-owned roles and template", () => {
    expect(theme).toBe(renderTheme(template));
  });

  test("defaults the full UI to Inter through the runtime font variable", () => {
    expect(theme).toContain(
      '--font-sans: var(--bb-monokai-ui-font, "Inter Variable", Inter, sans-serif)',
    );
    expect(theme).toContain('--font-mono: "Berkeley Mono", ui-monospace, Menlo, monospace');
  });

  test("antialiases dark text and keeps italic synthesis for Inter emphasis", () => {
    expect(theme).toContain(
      ".dark body {\n  -webkit-font-smoothing: antialiased;\n  -moz-osx-font-smoothing: grayscale;\n}",
    );
    expect(theme).not.toContain("font-synthesis:");
    expect(theme).toContain(
      ".dark [data-markdown-preview] :is(p, li),\n.dark .bb-markdown-prose :is(p, li) {\n  text-wrap: pretty;",
    );
  });

  test("keeps mobile composer placeholders at a readable regular weight", () => {
    expect(theme).toContain(
      "@media (max-width: 767px) {\n  .dark\n    [data-promptbox]\n    [data-promptbox-editor-content]\n    .ProseMirror\n    p.is-editor-empty:first-child::before {\n    font-weight: 400;\n  }\n}",
    );
  });

  test("styles bb's notification center without replacing responsive placement", () => {
    expect(theme).toContain('.dark [data-testid="notification-center"]');
    expect(theme).toContain(
      '.dark [data-testid="notification-row"][data-focused="true"] {\n  background: var(--surface-selected);\n}',
    );
    expect(theme).toContain(
      '@media (min-width: 768px) {\n  .dark [data-testid="notification-center"] {\n    overflow: hidden;\n    border-color: var(--border);\n    border-radius: 16px;',
    );
    expect(theme).toContain(
      '.dark [data-testid="notification-center"] > div:first-child,\n.dark [data-testid="notification-row"] {\n  border-color: var(--border-seam);\n}',
    );
  });

  test("gives toasts and the notification center one host edge and the host shadow", () => {
    expect(theme).toContain(
      '  .dark [data-testid="notification-center"] {\n    overflow: hidden;\n    border-color: var(--border);\n    border-radius: 16px;\n    background: var(--popover);\n    box-shadow: var(--shadow-md);\n  }',
    );
    expect(theme).toContain(
      "    border-color: var(--border);\n    color: var(--popover-foreground);\n    box-shadow: var(--shadow-md);\n  }",
    );
    expect(theme).not.toContain("0 0 0 1px var(--border),");
  });

  test("leaves Radix checkboxes to bb's checked fill", () => {
    const rules = theme.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules.match(/button\.border-input(?!:not\(\[role="checkbox"\]\))/g)).toBeNull();
    expect(theme).toContain(
      '.dark button.border-input:not([role="checkbox"]),\n.dark button.border.bg-card {\n  background-color: var(--control-background);',
    );
  });

  test("gives desktop and compact Send the same 14% filled-action layer", () => {
    expect(theme).toContain(
      ".dark button.bg-primary,\n.dark button.bg-foreground {\n  background-color: var(--control-primary);",
    );
    expect(theme).toContain(
      `.dark [data-promptbox-send-menu].bg-foreground {\n  --background: ${roleValues["layer.sendSegmentLift"]};\n  background-color: var(--control-primary);\n  color: var(--foreground);`,
    );
  });

  test("lifts a hovered desktop Send segment to compact Send's 20% hover", () => {
    const alpha = (hex: string) => Number.parseInt(hex.slice(7, 9), 16) / 255;
    // bb's segment hover is `!bg-background/15` over the wrapper's fill.
    const lift = 0.15 * alpha(roleValues["layer.sendSegmentLift"]);
    const hovered = 1 - (1 - alpha(roleValues["layer.selected"])) * (1 - lift);
    expect(hovered).toBeCloseTo(alpha(roleValues["layer.active"]), 2);
  });

  test("leaves compact mobile toasts on bb's native layout", () => {
    const toastRules = styleRules(theme).filter((rule) => rule.selector.includes("[data-sonner-"));
    expect(toastRules.length).toBeGreaterThan(0);
    expect(toastRules.filter((rule) => rule.atRules[0] !== "@media (min-width: 768px)")).toEqual(
      [],
    );
  });

  test("rejects an unknown template role", () => {
    expect(() => renderTheme(`${template}\n.x { color: {{text.foreign}}; }\n`)).toThrow(
      "Unknown theme role(s): text.foreign",
    );
  });

  test("rejects a rendered hex in the selector template", () => {
    expect(() => renderTheme(`${template}\n.x { color: #181818; }\n`)).toThrow(
      "Theme template contains rendered hex(es): #181818. Use symbolic roles.",
    );
  });

  test("gates every hover fill behind a hover-capable pointer", () => {
    const hoverRules = [theme, diffHeaderCss]
      .flatMap(styleRules)
      .filter((rule) => rule.selector.includes(":hover"));
    expect(hoverRules.length).toBeGreaterThan(0);
    expect(hoverRules.filter((rule) => !rule.atRules.includes("@media (hover: hover)"))).toEqual(
      [],
    );
    expect(theme).toContain(
      "@media (hover: hover) {\n  .dark button.bg-primary:hover,\n  .dark button.bg-foreground:hover {",
    );
    expect(theme).toContain(
      '@media (hover: hover) {\n  .dark [data-testid="notification-row"]:hover {',
    );
  });

  test("neutralizes diff fence tokens and highlights CSS fence properties", () => {
    expect(theme).toContain(
      "> :is(.language-diagram, .language-patch, .language-diff) {\n  --sh-identifier: var(--foreground)",
    );
    expect(theme).toContain(
      "> :is(.language-css, .language-scss, .language-less) {\n  --sh-property: #51dae9;\n  --sh-class: #a895fe;",
    );
  });

  test("joins diagram connectors at the phone code size", () => {
    expect(theme).toContain(
      "@media (max-width: 767px) and (pointer: coarse) {\n  .dark .bb-code-highlight.bb-code-highlight > :is(.language-diagram, .language-patch) {\n    line-height: 1.2;",
    );
  });

  test("sets agent replies and trace rows on the Codex rhythm", () => {
    const agent = ".dark [data-message-column].group\\/message [data-markdown-preview]";
    expect(theme).toContain(
      `${agent},\n.dark .bb-markdown-prose,\n.dark .canvas-prose [data-markdown-preview] {\n  --agent-md-space: calc(max(14px, var(--text-sm)) / 4);\n  font-weight: 430;`,
    );
    expect(theme).toContain(
      `${agent} h1,\n.dark .bb-markdown-prose h1 {\n  margin: calc(var(--agent-md-space) * 4) 0 8px;\n  font-size: calc(var(--agent-md-space) * 6);`,
    );
    expect(theme).toContain(
      `${agent} > p + p,\n.dark .bb-markdown-prose > p + p {\n  margin-top: calc(var(--agent-md-space) * 4);`,
    );
    expect(theme).toContain(`${agent} li,\n.dark .bb-markdown-prose li {\n  margin: 0 0 4px;`);
    expect(theme).toContain(
      `${agent} :is(strong, b),\n.dark .bb-markdown-prose :is(strong, b) {\n  font-weight: 700;`,
    );
    expect(theme).toContain('.dark [data-timeline-row-list="top-level"] {\n  gap: 28px;\n}');
    expect(theme).toContain('.dark [data-timeline-row-list="bundle"] {\n  gap: 8px;');
    expect(theme).toContain(
      ".dark [data-timeline-row-list] .rounded-md.text-muted-foreground.opacity-40 {\n  opacity: 1;",
    );
    // bb's 20px action row holds the absolutely positioned hover actions.
    // Collapsing it lets them spill over the next timeline item.
    expect(theme).not.toContain(".relative.w-full.h-5");
    expect(theme).toContain(
      ".dark [data-message-column] .absolute.top-0 > button.size-5 > [data-icon-root].size-3 {\n  width: 16px;\n  height: 16px;",
    );
    expect(theme).toContain('> span:empty::after {\n  content: "text";');
    expect(theme).toContain(
      "  button,\n.dark .bb-markdown-prose .bg-surface-recessed.my-2.rounded-md > .flex.justify-between:first-child button {\n  width: 36px;\n  height: 36px;",
    );
    expect(theme).toContain(
      'a.underline[href^="mailto:"]::before,\n.dark .bb-markdown-prose a[href^="mailto:"]::before {\n  mask-image: url(',
    );
    expect(theme).toContain(
      "a.underline code.bg-muted\\/70,\n.dark .bb-markdown-prose a :not(pre) > code {\n  color: inherit;",
    );
    expect(theme).toContain(
      ".dark [data-timeline-row-list] span.text-sm.leading-5 {\n  font-size: max(14px, var(--text-sm));\n  line-height: 21px;",
    );
  });

  test("keeps phone text fields at the 16px iOS zoom floor", () => {
    expect(theme).toContain(
      '@media (max-width: 767px) and (pointer: coarse) {\n  .dark [data-promptbox] [data-promptbox-editor-content] .ProseMirror,\n  .dark input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"]),\n  .dark textarea,\n  .dark select {\n    font-size: 16px;',
    );
  });

  test("mirrors the Diffs.com header shell with Monokai color roles", () => {
    expect(theme).toContain(
      ".dark [data-monokai-diff-panel] [data-monokai-diff-card] {\n  overflow: hidden;\n  border-color: var(--border);\n  border-radius: 10px;\n  background-color: #181818;",
    );
    expect(theme).toContain(
      ".dark [data-monokai-diff-panel] [data-monokai-diff-shell] {\n  margin-top: 0;\n  display: flex;\n  align-items: center;\n  border-top: 0;\n  border-radius: 0;\n  font-size: 13px;\n  line-height: 20px;\n  font-weight: 400;\n}",
    );
    expect(theme).toContain(
      ".dark [data-monokai-diff-panel] [data-monokai-diff-shell] button[aria-expanded] {\n  width: 24px;\n  height: 24px;\n  padding: 0;\n  border-radius: 8px;\n  background-color: transparent;\n  color: var(--muted-foreground);\n}",
    );
    // app/diff-header.css is the one owner of the shell's height and padding.
    expect(diffHeaderCss).toContain(
      "[data-monokai-diff-shell] {\n  min-height: 40px;\n  padding-block: 0;\n  padding-inline: 12px;\n}",
    );
    expect(theme).toContain(
      "[data-monokai-diff-shell]\n  button[aria-expanded]\n  + span\n  > button:not(.font-mono) {\n  width: 24px;",
    );
    expect(theme).not.toContain(
      "[data-monokai-diff-shell]\n  button[aria-expanded]\n  + span\n  > button {\n  width: 24px;",
    );
    expect(theme).toContain(
      "[data-monokai-diff-shell] > .flex > span:last-child > .text-xs {\n  display: flex;\n  align-items: center;\n  gap: 1ch;\n  font-family: var(--font-mono);\n  font-size: 13px;\n  line-height: 20px;\n  font-weight: 400;\n  font-variant-numeric: tabular-nums;",
    );
  });

  test("feeds Pierre's diff mix slots opaque targets", () => {
    // Change rows fall back to the opaque feedback colors. Selection targets
    // land on the 14% layer, #353534, after Pierre's 25% and 40% lab mixes.
    expect(theme).not.toContain("--diffs-bg-addition-override");
    expect(theme).not.toContain("--diffs-bg-deletion-override");
    expect(theme).toContain("--diffs-addition-color-override: #3fa266;");
    expect(theme).toContain("--diffs-deletion-color-override: #e34671;");
    expect(theme).toContain("--diffs-bg-addition-emphasis-override: #3fa26644;");
    expect(theme).toContain("--diffs-bg-deletion-emphasis-override: #e3467144;");
    expect(theme).toContain("--diffs-bg-hover-override: #e3e3dd;");
    expect(theme).toContain("--diffs-bg-selection-override: #9b9b97;");
    expect(theme).toContain("--diffs-bg-selection-number-override: #666664;");
  });

  test("hands bb's terminal font token the Berkeley stack", () => {
    expect(theme).toContain(
      '  --terminal-font-family: "BerkeleyMono Nerd Font Mono", "Berkeley Mono", monospace;\n',
    );
    expect(theme).toContain("  --font-terminal: var(--terminal-font-family);\n");
  });

  test("keeps one fade on timeline status decorations", () => {
    expect(theme).toContain(
      ".dark .group\\/timeline-row > button[aria-expanded] > span > .opacity-40,\n.dark .group\\/timeline-row > button[aria-expanded] .text-subtle-foreground.opacity-75 {\n  opacity: 1;\n}",
    );
  });

  test("keeps wrapped inline code chips padded and rounded on each line", () => {
    expect(theme).toContain(
      ".dark code.rounded.bg-muted\\/70 {\n  box-decoration-break: clone;\n  -webkit-box-decoration-break: clone;\n}",
    );
  });

  test("the shipped theme follows the shared contract", () => {
    expect(() => auditTheme(theme)).not.toThrow();
  });

  test("rejects flattening an in-flow surface or repainting composer layout", () => {
    expect(() =>
      auditTheme(
        theme.replace(
          "--agent-surface-background: #e3e3dd0f",
          "--agent-surface-background: #262626",
        ),
      ),
    ).toThrow("--agent-surface-background: expected #e3e3dd0f");
    expect(() =>
      auditTheme(
        theme.replace(
          "[data-promptbox-editor-scroll] {\n  background-color: transparent",
          "[data-promptbox-editor-scroll] {\n  background-color: var(--agent-surface-background)",
        ),
      ),
    ).toThrow("background-color: expected transparent");
  });

  test("derives occluding fallbacks and keeps sticky headers opaque", () => {
    // 4% ink over conversation; 6% ink over content, byte-rounded in sRGB.
    expect(theme).toContain("--surface-recessed-solid: #1d1d1d");
    expect(theme).toContain("--surface-raised-solid: #242424");
    expect(() =>
      auditTheme(
        theme.replace(
          "background-color: var(--surface-raised-solid)",
          "background-color: var(--agent-surface-background)",
        ),
      ),
    ).toThrow("background-color: expected var(--surface-raised-solid)");
  });

  test("paints each outer sidebar edge with one shared alpha edge", () => {
    expect(theme).toContain(
      '.dark [data-sidebar="panel"],\n.dark #thread-detail-secondary-panel > aside {\n  border-color: var(--sidebar-border);\n}',
    );
    expect(theme).toContain(
      '.dark #thread-detail-secondary-panel-handle[data-panel-resize-handle-enabled="true"] {\n  --border-seam: var(--sidebar-border);\n}',
    );
    expect(theme).toContain(
      '.dark\n  #thread-detail-secondary-panel-handle[data-panel-resize-handle-enabled="true"]\n  + #thread-detail-secondary-panel\n  > aside {\n  border-color: transparent;\n}',
    );
  });

  test("rejects an off-contract rendered color", () => {
    const changed = theme.replace("--background: #151515", "--background: #123456");
    expect(() => auditTheme(changed)).toThrow("#123456 is off-contract");
  });

  test("rejects a missing token that would leak a bb default", () => {
    const changed = theme.replace("  --trees-status-added-override: #3fa266;\n", "");
    expect(() => auditTheme(changed)).toThrow(
      "--trees-status-added-override: MISSING (bb default leaks in)",
    );
  });

  test("rejects a contract color assigned to the wrong role", () => {
    const changed = theme.replace(
      "--trees-status-modified-override: #f1b467",
      "--trees-status-modified-override: #3fa266",
    );
    expect(() => auditTheme(changed)).toThrow(
      "--trees-status-modified-override: expected #f1b467, got #3fa266",
    );
  });

  test("rejects an attribute selector that changes case", () => {
    // bb labels the button "Stop run". aria-label matching is case-sensitive.
    const changed = theme.replaceAll('aria-label="Stop run"', 'aria-label="stop run"');
    expect(() => auditTheme(changed)).toThrow(
      '.dark [data-promptbox-submit-action][aria-label="Stop run"]: expected one rule, found 0',
    );
  });

  test("rejects an illegible registered foreground/background pair", () => {
    const changed = theme.replace("--primary-foreground: #181818", "--primary-foreground: #e3e3dd");
    expect(() => auditTheme(changed)).toThrow("--primary-foreground on --primary:");
  });
});

describe("bb Monokai selector cost", () => {
  test("ships no :has() selectors", () => {
    // Blink re-checks a :has() subject when DOM beneath it changes, so every
    // rule made streamed timeline tokens restyle part of the page. Anchor on a
    // bb hook, or tag the element from a content script that already finds it
    // (app/diff-header.ts, app/terminal-appearance.ts).
    for (const css of [theme, diffHeaderCss])
      expect(css.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^\n]*:has\([^\n]*/g)).toBeNull();
  });
});

describe("bb Monokai code theme", () => {
  test("the shipped JSON is generated from the vendored rules and the palette", () => {
    expect(codeTheme).toBe(`${JSON.stringify(renderCodeTheme(codeThemeRules), null, 2)}\n`);
  });

  test("it carries the shape bb parses and hands to Shiki", () => {
    const parsed = JSON.parse(codeTheme) as ReturnType<typeof renderCodeTheme>;
    expect(parsed.name.length).toBeGreaterThan(0);
    expect(parsed.type).toBe("dark");
    // Without these two Shiki falls back to a scopeless token rule, and this
    // theme has none — the code surface would render on bb's default ground.
    expect(parsed.colors["editor.background"]).toBe("#181818");
    expect(parsed.colors["editor.foreground"]).toBe("#e3e3dd");
    expect(
      Array.from(
        { length: 6 },
        (_, index) => parsed.colors[`editorBracketHighlight.foreground${index + 1}`],
      ),
    ).toEqual(["#e3e3dd", "#3093f4", "#c860cf", "#b28b11", "#04a891", "#8a6ae6"]);
    expect(
      Array.from(
        { length: 6 },
        (_, index) => parsed.colors[`editorBracketPairGuide.background${index + 1}`],
      ),
    ).toEqual(Array.from({ length: 6 }, () => "#e3e3dd11"));
    expect(
      Array.from(
        { length: 6 },
        (_, index) => parsed.colors[`editorBracketPairGuide.activeBackground${index + 1}`],
      ),
    ).toEqual(Array.from({ length: 6 }, () => "#e3e3dd2c"));
    expect(parsed.tokenColors.length).toBeGreaterThan(0);
  });

  test("it maps Monaco CSS tokens onto the matching TextMate roles", () => {
    const parsed = JSON.parse(codeTheme) as ReturnType<typeof renderCodeTheme>;
    const foregroundByScope = new Map(
      parsed.tokenColors.flatMap((rule) => {
        const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
        return scopes.map((scope) => [scope, rule.settings.foreground] as const);
      }),
    );

    expect(foregroundByScope.get("tag")).toBe("#fe5d86");
    expect(foregroundByScope.get("attribute.name")).toBe("#51dae9");
    expect(foregroundByScope.get("attribute.value")).toBe("#f7d05c");
    expect(foregroundByScope.get("attribute.value.number")).toBe("#a895fe");
    expect(foregroundByScope.get("attribute.value.number.css")).toBe("#a895fe");
    expect(foregroundByScope.get("attribute.value.hex.scss")).toBe("#a895fe");
    expect(foregroundByScope.get("attribute.value.unit.less")).toBe("#a895fe");
    expect(foregroundByScope.get("number.ts")).toBe("#a895fe");
    expect(foregroundByScope.get("number.hex.js")).toBe("#a895fe");
    expect(foregroundByScope.get("regexp.ts")).toBe("#f7d05c");
    expect(foregroundByScope.get("regexp.escape.control.js")).toBe("#a895fe");
    expect(foregroundByScope.get("string.escape.ts")).toBe("#a895fe");
    expect(foregroundByScope.get("identifier.ts")).toBe("#e3e3dd");
    expect(foregroundByScope.get("type.identifier.ts")).toBe("#e3e3dd");
    expect(foregroundByScope.get("delimiter")).toBe("#e3e3dd");
  });

  test("vendors editor colors as palette roles", () => {
    expect(
      convertRules([
        { scope: "markup.heading, entity.name.section", settings: { foreground: "#9DDD54" } },
        { scope: ["comment"], settings: { foreground: "#BEB89999", fontStyle: "italic" } },
      ]),
    ).toEqual([
      { scope: ["markup.heading", "entity.name.section"], foreground: "code.entity" },
      { scope: ["comment"], foreground: "text.comment60", fontStyle: "italic" },
    ]);
  });

  test("stops the sync on an editor color with no token role", () => {
    expect(() => convertRules([{ scope: "keyword", settings: { foreground: "#88C0D0" } }])).toThrow(
      "#88C0D0 on keyword has no role. Amend CONTRACT.md and the palette before syncing.",
    );
  });

  test("rejects a chrome-only role on a token", () => {
    expect(() => renderCodeTheme([{ scope: ["keyword"], foreground: "accent.base" }])).toThrow(
      "keyword: accent.base is not a token role",
    );
  });

  test("rejects an unregistered role on a token", () => {
    expect(() => renderCodeTheme([{ scope: ["keyword"], background: "code.foreign" }])).toThrow(
      "keyword: code.foreign is not a token role",
    );
  });

  test("rejects a rule that styles nothing", () => {
    expect(() => renderCodeTheme([{ scope: ["keyword"] }])).toThrow(
      "keyword: a rule with no settings",
    );
  });

  test("rejects a rule that scopes nothing", () => {
    expect(() => renderCodeTheme([{ scope: [], foreground: "code.keyword" }])).toThrow(
      "a rule carries no scope",
    );
  });
});
