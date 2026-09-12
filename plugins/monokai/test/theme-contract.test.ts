import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readCodeThemeRules } from "../scripts/code-theme-rules";
import { auditTheme, renderCodeTheme, renderTheme } from "../scripts/generate-theme";

const templatePath = fileURLToPath(new URL("../scripts/bb-monokai.template.css", import.meta.url));
const themePath = fileURLToPath(new URL("../themes/bb-monokai.css", import.meta.url));
const codeThemePath = fileURLToPath(new URL("../themes/bb-monokai-code.json", import.meta.url));
const template = await readFile(templatePath, "utf8");
const theme = await readFile(themePath, "utf8");
const codeTheme = await readFile(codeThemePath, "utf8");
const codeThemeRules = readCodeThemeRules().rules;

describe("bb Monokai contract audit", () => {
  test("unifies code grounds and keeps filenames in sans-serif recessed headers", () => {
    expect(theme).toContain("--diffs-header-font-family: var(--font-sans)");
    expect(theme).toContain("diffs-container {\n  --diffs-dark-bg: #181818;");
    expect(theme).toContain(
      ".dark .bb-code-highlight.bb-code-highlight {\n  background-color: #181818;",
    );
    expect(theme).not.toContain("--diffs-dark-bg: #1e1e1e");
    expect(theme).not.toContain("--diffs-bg-context-override: #1e1e1e");
    for (const role of ["context-gutter", "buffer", "addition-number", "deletion-number"]) {
      expect(theme).toContain(`--diffs-bg-${role}-override: #181818`);
    }
    expect(theme).toContain("--diffs-bg-separator-override: #262626");
    expect(theme).toContain(
      ".bg-background:has(> .flex > span > button[aria-expanded]) {\n  background-color: #1e1e1e;",
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

  test("keeps mobile composer placeholders at a readable regular weight", () => {
    expect(theme).toContain("@media (max-width: 767px)");
    expect(theme).toContain("p.is-editor-empty:first-child::before");
    expect(theme).toContain("font-weight: 400");
  });

  test("keeps compact composer selectors on bb's native layout", () => {
    const desktopBoundary = theme.indexOf(
      "/* Compact composers keep bb's native Project, Machine, and Permission mode",
    );
    const compactBehavior = theme.indexOf(
      "/* Narrow-pane rules otherwise hide the metadata row even while expanded. */",
    );
    const selector =
      '.dark [data-promptbox-shell] :is([data-promptbox-project-control], [aria-label="Environment"], [aria-label="Machine"], [aria-label="Branch"], [aria-label="Permission mode"]) {';

    expect(theme.slice(desktopBoundary, theme.indexOf(selector))).toContain(
      "@media (min-width: 768px)",
    );
    expect(theme.indexOf(selector)).toBeGreaterThan(desktopBoundary);
    expect(theme.indexOf(selector)).toBeLessThan(compactBehavior);
    expect(theme.split(selector)).toHaveLength(2);
  });

  test("lets a lone non-project machine summary fill the footer", () => {
    expect(theme).toContain(
      "> div:not(:has(> [data-option-display], > [data-promptbox-hide-branch-compact]))\n    > div:has(> [data-option-display]) {\n    grid-column: 1 / -1;\n    width: 100%;\n    max-width: none;",
    );
    expect(theme).toContain(
      "> div:not(:has(> [data-option-display], > [data-promptbox-hide-branch-compact]))\n    > div\n    > [data-option-display] {\n    flex: 1 1 auto;\n    max-width: none;",
    );
  });

  test("applies composer environment-control treatments to every surface", () => {
    // The same controls render as read-only chips in the follow-up composer
    // footer and as pickers in the new-thread composer. Each shared treatment
    // keeps both surfaces in one selector list so an adjustment cannot land
    // on one and miss the other.
    const centering = theme.match(
      /\.dark\s+:is\(\[data-follow-up-composer-footer\], \[data-promptbox-shell\]\)[\s\S]*?\{\s*margin-inline: auto;/,
    );
    expect(centering).not.toBeNull();
    for (const control of [
      "[data-option-display]",
      "[data-promptbox-project-control]",
      '[aria-label="Environment"]',
      '[aria-label="Machine"]',
      '[aria-label="Branch"]',
      "[data-promptbox-hide-branch-compact]",
    ]) {
      expect(centering?.[0]).toContain(control);
    }
    // The fade mask belongs on the label element only: masking the chip or
    // picker container would dissolve the icon, chevron, and background with
    // the text. Split rules on their closing brace and assert every
    // mask-bearing selector ends at a label element on both surfaces.
    const fadeSelectors = theme
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("}")
      .filter((block) => block.includes("mask-image"))
      .flatMap((block) => block.slice(0, block.indexOf("{")).split(","))
      .map((selector) => selector.trim());
    expect(fadeSelectors.length).toBeGreaterThan(0);
    expect(
      fadeSelectors.some((s) =>
        s.includes("[data-promptbox-hide-branch-compact] > span:last-of-type"),
      ),
    ).toBe(true);
    expect(
      fadeSelectors.some(
        (s) => s.includes('[aria-label="Branch"]') && s.includes("> span.truncate"),
      ),
    ).toBe(true);
    for (const selector of fadeSelectors) {
      expect(selector).toMatch(/span(?::last-of-type|\.truncate)$/);
    }
    // The picker's parenthetical label nests a second .truncate for the
    // branch name (BranchPicker's `Current (<name>)` shape) and that inner
    // span is what ellipsizes. `text-overflow: clip` must reach it via a
    // descendant combinator — a `> span.truncate` arm alone only covers the
    // outer label and the name keeps its ellipsis.
    const clipSelectors = theme
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("}")
      .filter((block) => /text-overflow:\s*clip/.test(block))
      .flatMap((block) => block.slice(0, block.indexOf("{")).split(","))
      .map((selector) => selector.trim());
    expect(clipSelectors).toContain(
      '.dark [data-promptbox-shell] [aria-label="Branch"] span.truncate',
    );
    expect(clipSelectors).toContain(
      ".dark [data-follow-up-composer-footer] [data-promptbox-hide-branch-compact] span.truncate",
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
    expect(template).toContain("0 0 0 1px {{text.ink12}}");
  });

  test("leaves compact mobile toasts on bb's native layout", () => {
    expect(theme).toContain(
      '@media (min-width: 768px) {\n  .dark [data-testid="app-layout-content-shell"] > main,',
    );
    expect(theme).not.toContain("On narrow screens, keep the full text column");
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
    const bareHoverRules = theme.split("\n").filter((line) => /^\.dark[^\n]*:hover/.test(line));
    expect(bareHoverRules).toEqual([]);
    expect(theme).toContain(
      "@media (hover: hover) {\n  .dark button.bg-primary:hover,\n  .dark button.bg-foreground:hover {",
    );
    expect(theme).toContain(
      '@media (hover: hover) {\n  .dark [data-testid="notification-row"]:hover {',
    );
  });

  test("joins diagram connectors at the phone code size", () => {
    expect(theme).toContain(
      "@media (max-width: 767px) and (pointer: coarse) {\n  .dark .bb-code-highlight.bb-code-highlight > :is(.language-diagram, .language-patch) {\n    line-height: 1.2;",
    );
  });

  test("keeps phone text fields at the 16px iOS zoom floor", () => {
    expect(theme).toContain(
      '@media (max-width: 767px) and (pointer: coarse) {\n  .dark [data-promptbox] [data-promptbox-editor-content] .ProseMirror,\n  .dark input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"]),\n  .dark textarea,\n  .dark select {\n    font-size: 16px;',
    );
  });

  test("the shipped theme follows the shared contract", () => {
    expect(() => auditTheme(theme)).not.toThrow();
  });

  test("paints each outer sidebar edge with one solid pane divider", () => {
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
    const changed = theme.replace("--background: #181818", "--background: #123456");
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

  test("rejects an illegible registered foreground/background pair", () => {
    const changed = theme.replace("--primary-foreground: #141414", "--primary-foreground: #e3e3dd");
    expect(() => auditTheme(changed)).toThrow("--primary-foreground on --primary:");
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
