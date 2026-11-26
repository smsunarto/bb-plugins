import { FRAME_BORDER_CSS } from "../app/frame-border.ts";
import { SEARCH_FIELDS_CSS } from "../app/search-fields.ts";
import { NEW_TAB_LAUNCHER_CSS } from "../app/new-tab-launcher.ts";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CodeThemeRuleFile,
  codeThemeRulesPath,
  readCodeThemeRules,
} from "../scripts/code-theme-rules";
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
function styleRules(css: string): Array<{ selector: string; atRules: string[]; body: string }> {
  const rules: Array<{ selector: string; atRules: string[]; body: string }> = [];
  const open: string[] = [];
  for (const [, text = "", brace] of css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/([^{}]*)([{}])/g)) {
    if (brace === "{") {
      open.push(text.trim().replace(/\s+/g, " "));
      continue;
    }
    const selector = open.pop() ?? "";
    if (!selector.startsWith("@")) rules.push({ selector, atRules: [...open], body: text });
  }
  return rules;
}

describe("bb Monokai surface palette", () => {
  test("assigns the Capy shell grounds and keeps the Monokai terminal ground", () => {
    expect(theme).toContain("--background: #121213");
    expect(theme).toContain("--sidebar: #09090a");
    expect(theme).toContain("--popover: #1b1b1c");
    expect(theme).toContain("--agent-surface-background: #ebebec0f");
    expect(theme).toContain(
      ".dark [data-promptbox] {\n  background-color: var(--agent-surface-background)",
    );
    expect(theme).toContain(
      ".dark code.bg-muted\\/70,\n.dark .bb-markdown-prose :not(pre) > code {\n  background-color: var(--accent);\n  color: #eed996;",
    );
    expect(theme).toContain(
      ".dark [data-message-column].group\\/message [data-markdown-preview],\n.dark .bb-markdown-prose,\n.dark .canvas-prose [data-markdown-preview] {\n  font-size: var(--agent-fluid-size)",
    );
    expect(theme).toContain("--terminal-background: #181818");
  });

  test("names remote machines with hues outside the feedback families", () => {
    expect(theme).toContain(
      "--machine-1: #2987f8; /* 5.61:1 */\n  --machine-2: #07c3de; /* 9.35:1 */\n  --machine-3: #6dfee5; /* 16.07:1 */\n  --machine-4: #fd7ec8; /* 8.53:1 */\n  --machine-5: #aaa0fb; /* 8.65:1 */\n  --machine-6: #fec4ff; /* 13.79:1 */",
    );
  });

  test("pins annotated bb surfaces to their intended grounds", () => {
    expect(theme).toContain(
      ".dark .thread-scrollbar > .flex.min-h-full.min-w-0.flex-col {\n  background-color: #121213",
    );
    expect(theme).toContain(
      ".dark [data-promptbox] [data-promptbox-editor-scroll] {\n  background-color: transparent;\n  border-radius: 11px 11px 0 0",
    );
  });

  test("styles conversation links as accent text with T3's dotted hover underline", () => {
    expect(theme).toContain(
      ".dark [data-message-column] [data-markdown-preview] a.underline,\n.dark .bb-markdown-prose a {\n  color: var(--primary);\n  text-decoration-line: none;\n}",
    );
    expect(theme).toContain(
      "@media (hover: hover) {\n  .dark [data-message-column] [data-markdown-preview] a.underline:hover,\n  .dark .bb-markdown-prose a:hover {\n    background-image: radial-gradient(circle, currentcolor 0.75px, transparent 1px);",
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
    expect(theme).toContain("--diffs-bg-separator-override: #ebebec0f");
    expect(theme).toContain(
      ".dark [data-monokai-diff-shell] {\n  background-color: var(--agent-surface-background);",
    );
    expect(theme).toContain(
      ".dark .smart-embed-header {\n  background-color: var(--agent-surface-background);",
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
      ".dark [data-markdown-preview] :is(p, li),\n.dark .bb-markdown-prose :is(p, li) {\n  text-wrap-style: pretty;",
    );
  });

  test("hides composer placeholders while preserving the editable text", () => {
    expect(theme).toContain(
      ".dark [data-promptbox] [data-promptbox-editor-content]::before,\n.dark\n  [data-promptbox]\n  [data-promptbox-editor-content]\n  .ProseMirror\n  p.is-editor-empty:first-child::before {\n  content: none !important;\n}",
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
      "  border-color: var(--border);\n  color: var(--popover-foreground);\n  box-shadow: var(--shadow-md);\n}",
    );
    expect(theme).not.toContain("0 0 0 1px var(--border),");
  });

  test("draws every focus ring and outline inside its control, except compact selection controls", () => {
    expect(theme).toContain(
      ".dark :focus-visible {\n  --tw-ring-inset: inset;\n  --tw-ring-offset-width: 0px;\n  outline-offset: -2px;\n}",
    );
    expect(theme).toContain(
      '.dark button[role="radio"][data-state="checked"]:focus-visible,\n' +
        '.dark button[role="radio"][data-state="unchecked"]:focus-visible,\n' +
        '.dark button[role="checkbox"][data-state="checked"]:focus-visible,\n' +
        '.dark button[role="checkbox"][data-state="unchecked"]:focus-visible,\n' +
        '.dark button[role="checkbox"][data-state="indeterminate"]:focus-visible,\n' +
        '.dark button[role="switch"][data-state="checked"]:focus-visible,\n' +
        '.dark button[role="switch"][data-state="unchecked"]:focus-visible {\n' +
        "  outline: 2px solid var(--muted-foreground);\n" +
        "  outline-offset: 2px;\n" +
        "  --tw-ring-shadow: 0 0 transparent;\n}",
    );
  });

  test("leaves Radix checkboxes and compact radios to bb's checked fill while keeping outline ToggleGroups", () => {
    const rules = theme.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(
      rules.match(
        /button\.border-input(?!:not\(\[role="checkbox"\], \[role="radio"\]\[data-state="checked"\], \[role="radio"\]\[data-state="unchecked"\]\))/g,
      ),
    ).toBeNull();
    expect(theme).toContain(
      '.dark button.border-input:not([role="checkbox"], [role="radio"][data-state="checked"], [role="radio"][data-state="unchecked"]),\n.dark button.border.bg-card,\n.dark [data-bb-control="field"],\n.dark button[data-bb-control="outline"] {\n  background-color: var(--control-background);',
    );
  });

  test("gives shared @bb-plugins/ui controls the fills of bb's controls of the same role", () => {
    for (const role of ["field", "outline", "primary", "secondary"])
      expect(theme).toContain(`[data-bb-control="${role}"]`);
    expect(theme).toContain('.dark button[data-bb-control="outline"][data-state="open"] {');
    expect(theme).toContain(
      '.dark button.bg-secondary,\n.dark button[data-bb-control="secondary"] {',
    );
  });

  test("gives desktop and compact Send the same 14% filled-action layer", () => {
    expect(theme).toContain(
      '.dark button.bg-primary,\n.dark button.bg-foreground,\n.dark button[data-bb-control="primary"] {\n  background-color: var(--control-primary);',
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

  test("shares toast surfaces across widths while keeping placement desktop-only", () => {
    const toastRules = styleRules(theme).filter((rule) => rule.selector.includes("[data-sonner-"));
    const surfaces = toastRules.filter((rule) => rule.selector.includes(".bb-app-toast"));
    expect(surfaces.length).toBeGreaterThan(0);
    expect(surfaces.every((rule) => !rule.atRules.includes("@media (min-width: 768px)"))).toBe(
      true,
    );
    const placement = toastRules.filter(
      (rule) =>
        rule.atRules.includes("@supports (position-anchor: --bb-monokai-conversation)") ||
        rule.selector === ".dark [data-sonner-toast]" ||
        rule.selector === '.dark [data-sonner-toast][data-mounted="false"]',
    );
    expect(placement.length).toBeGreaterThan(0);
    expect(placement.every((rule) => rule.atRules.includes("@media (min-width: 768px)"))).toBe(
      true,
    );
  });

  test("leaves bb's scroll floor container unpadded", () => {
    // bb sizes the timeline's scroll floor to its container's full height, so
    // block padding there adds scroll past the stream and lifts the composer.
    const floorContainer = styleRules(theme).filter(
      (rule) =>
        rule.selector.endsWith(" .thread-scrollbar > div") &&
        /padding(-top|-bottom|-block)?:|border(-top|-bottom|-block)?(-width)?:/.test(rule.body),
    );
    expect(floorContainer).toEqual([]);
  });

  test("draws full-box hairlines as rings WebKit cannot drop at 3x", () => {
    const rules = styleRules(theme);
    // WebKit rounds a one-device-pixel border's outer and inner edges apart, so a
    // side on a half device pixel paints at zero width. Full-box hairlines are
    // inset rings; only boxes a ring cannot replace keep the border width.
    const fullBox = rules.filter((rule) => /^\s*border: var\(--hairline-width\)/m.test(rule.body));
    expect(fullBox.map((rule) => rule.selector).sort()).toEqual([
      ".dark img[data-markdown-image], .dark button.cursor-zoom-in.border", // an img covers an inset ring
    ]);
    expect(theme).not.toMatch(/inset 0 0 0 var\(--hairline-width\)/);
    expect(theme).toContain("--hairline-ring-width: var(--monokai-device-pixel, 1px);");
    const ringWidths = rules.filter((rule) => rule.body.includes("--hairline-ring-width:"));
    expect(ringWidths.map((rule) => [rule.atRules.join(" "), rule.body.trim()])).toContainEqual([
      "@media (min-resolution: 2.5dppx)",
      "--hairline-ring-width: var(--monokai-device-pixel, calc(1px / 3));\n    --hairline-rings: 1;",
    ]);
    const neutral = rules.find(
      (rule) =>
        rule.selector.includes(".border:is(") &&
        rule.atRules.includes("@media (min-resolution: 2.5dppx)"),
    );
    expect(neutral?.atRules).toContain("@layer utilities");
    expect(neutral?.body).toContain("border-width: 0;");
    expect(neutral?.body).toContain("inset 0 0 0 var(--hairline-ring-width) var(--monokai-edge)");
    expect(neutral?.body).toContain("var(--tw-shadow, 0 0 transparent)");
    expect(neutral?.selector).toContain('[class*=":border-"]');
    // A radio's primary circle and the shadcn checkbox, whose checked fill
    // swaps its edge to the foreground, are rings too; @bb-plugins/ui opts in
    // through --hairline-rings.
    expect(neutral?.selector).toContain(".border-primary.rounded-full");
    expect(neutral?.selector).toContain(
      '.border-input[class~="data-[state=checked]:border-foreground"]',
    );
    expect(theme).toMatch(
      /\[class~="data-\[state=checked\]:border-foreground"\]\[data-state="checked"\] \{\s*--monokai-edge: var\(--foreground\);/,
    );
  });

  test("gives compact drawers shadcn's Maia card without taking over host motion", () => {
    const blocks = Array.from(
      theme
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .matchAll(/([^{}]*\[data-(?:persistent-drawer|vaul)-[^{}]*)\{([^{}]*)\}/g),
      ([, selector = "", body = ""]) => ({ selector: selector.trim(), body }),
    );
    const declarations = blocks.map((block) => block.body).join("\n");
    expect(declarations).toContain("background-color: rgb(0 0 0 / 0.8);");
    expect(declarations).toContain("backdrop-filter: blur(4px);");
    // The card is a ::before inside the panel so bb's closed translateY(100%) hides it fully.
    const card = blocks.find((block) =>
      block.selector.includes("[data-persistent-drawer-content]::before"),
    );
    // Rising to the safe-area inset keeps the card's corners inside a phone's rounded screen.
    expect(card?.body).toContain("inset: 8px 8px var(--monokai-drawer-bottom);");
    expect(declarations).toContain(
      "--monokai-drawer-bottom: max(8px, var(--bb-safe-area-bottom, env(safe-area-inset-bottom)));",
    );
    expect(card?.body).toContain("border-radius: calc(var(--radius, 0.5rem) + 16px);");
    // The ring is an ::after above the content, so pickers' flush bg-popover cannot cover it.
    const ring = blocks.find((block) =>
      block.selector.includes("[data-persistent-drawer-content]::after"),
    );
    expect(ring?.body).toContain("inset: 8px 8px var(--monokai-drawer-bottom);");
    expect(ring?.body).toContain(
      "box-shadow: inset 0 0 0 var(--hairline-ring-width) var(--border);",
    );
    expect(ring?.body).toContain("z-index: 1;");
    expect(declarations).toContain("width: 100px;\n  height: 6px;");
    expect(
      blocks.filter(
        (block) =>
          /^\s*(transform|transition|max-height|will-change):/m.test(block.body) ||
          (!block.selector.includes("handle") && /^\s*margin/m.test(block.body)),
      ),
    ).toEqual([]);
  });

  test("draws hairlines a whole pixel at 1x, one at 2x, and two at 3x", () => {
    // A 0.5px box draws at half strength or not at all at 1x, and a one-device-
    // pixel border vanishes on a half device pixel at 3x.
    const widths = styleRules(theme)
      .filter((rule) => rule.selector === "html.dark" && rule.body.includes("--hairline-width:"))
      .map((rule) => [rule.atRules.join(" "), rule.body.trim()]);
    expect(widths).toEqual([
      ["@media (resolution < 1.5dppx)", "--hairline-width: 1px;"],
      ["@media (min-resolution: 2.5dppx)", "--hairline-width: calc(2px / 3);"],
    ]);
    expect(theme).toContain("--hairline-width: 0.5px;");
  });

  test("gives the framed macOS window Capy's flat sidebar and inset page", () => {
    const rules = styleRules(theme);
    const body = (selector: string) => rules.find((rule) => rule.selector === selector)?.body;
    // bb's own 8px frame lip stays, so the page sits off the window's edges.
    expect(theme).not.toMatch(/--bb-window-frame(-leading)?-lip:/);
    expect(body('.dark [data-framed] [data-sidebar="collapsible-body"]')).toContain(
      "border-color: transparent;",
    );
    // The mask keeps the title-bar band whole and rounds the page below it;
    // the SVG's rx is the 12px page radius.
    const inset = body('.dark [data-framed] [data-sidebar="inset"]');
    expect(inset).toContain("padding-inline: 0;");
    expect(inset).toContain("padding-bottom: 0;");
    expect(inset).toContain("linear-gradient(black, black)");
    expect(inset).toContain("rx='12'");
    expect(inset).toContain(
      "100% var(--bb-window-title-bar-height, 0px),\n    100% calc(100% - var(--bb-window-title-bar-height, 0px));",
    );
    expect(inset).toContain("mask-position: top, bottom;");
    expect(inset).toContain("clip-path: none;");
    expect(body('.dark [data-framed] [data-sidebar="inset-edge"]')).toBe("\n  display: none;\n");
    expect(body('.dark [data-framed] [data-sidebar="inset"]::after')).toContain("display: none;");
    expect(
      body('.dark [data-framed] [data-sidebar="inset"] aside[data-surface-tone="sidebar"]::before'),
    ).toBe("\n  top: var(--bb-window-title-bar-height);\n");
    // Neither sidebar edge glows; the right divider is the page's hairline.
    expect(body('.dark [data-testid="app-sidebar-resize-handle"]::before')).toBe(
      "\n  display: none;\n",
    );
    expect(body(".dark #thread-detail-secondary-panel-handle > span + span")).toBe(
      "\n  width: var(--hairline-width);\n  background-color: var(--sidebar-border);\n",
    );
  });

  test("insets the unframed desktop page without a frame border and draws the new-thread backdrop", () => {
    const inset = styleRules(theme).filter(({ selector }) =>
      selector.includes('[data-testid="app-layout-root"]:not([data-framed])'),
    );
    expect(inset.length).toBeGreaterThan(0);
    for (const rule of inset) expect(rule.atRules).toEqual(["@media (min-width: 768px)"]);
    expect(theme).toContain(
      '.dark [data-testid="app-layout-root"]:not([data-framed]) {\n    padding: 8px;\n    background-color: var(--sidebar);',
    );
    expect(theme).toContain(
      '.dark [data-testid="app-layout-root"]:not([data-framed]) > [data-sidebar="inset"] {\n    overflow: clip;\n    border-radius: 12px;',
    );
    // No main-frame border overlay on unframed desktop pages.
    expect(
      inset.filter(({ selector }) => selector.includes("[data-app-content-shell]::after")),
    ).toEqual([]);
    // Desktop hides both shell halftone pseudos with no dead zone above 767px
    // so only #root-compose-main-panel draws them.
    expect(theme).toContain(
      "@media (width > 767px) {\n  .dark[data-monokai-home] [data-app-content-shell]::before,\n  .dark[data-monokai-home] [data-app-content-shell]::after {\n    display: none;",
    );
    // The halftone starts below the macOS title bar, which bb tints translucent.
    expect(theme).toContain(
      "[data-app-content-shell]::after {\n  position: absolute;\n  inset: var(--bb-window-frame-top, 0px) 0 0;",
    );
    // Phones paint it from the content shell, which spans the status bar's
    // safe area; wider layouts keep it on the panel.
    expect(theme).toContain(
      "@media (max-width: 767px) {\n  .dark[data-monokai-home] [data-app-content-shell] {\n    isolation: isolate;",
    );
    expect(theme).toContain(
      ".dark #root-compose-main-panel::before,\n  .dark #root-compose-main-panel::after {\n    display: none;",
    );
    // The halftone is a still image: no animation or transition rides on it.
    const halftone = theme.slice(theme.indexOf(".dark #root-compose-main-panel::before,"));
    expect(
      halftone.slice(0, halftone.indexOf("\n}\n\n.dark #root-compose-main-panel::after")),
    ).not.toMatch(/animation|transition/);
  });

  test("moves the outer sidebars on Capy's timing, desktop only", () => {
    const motion = styleRules(theme).filter(
      ({ selector, body }) =>
        /\b(?:transition|animation)(?:-[\w-]+)?:/.test(body) &&
        (selector.includes('[data-side="left"]') ||
          selector.includes('[id^="thread-detail-timeline-panel"]') ||
          selector.includes('[id^="thread-detail-secondary-panel"]')),
    );
    expect(motion.length).toBeGreaterThan(0);
    for (const rule of motion) expect(rule.atRules[0]).toStartWith("@media (min-width: 768px)");
    const quint = "cubic-bezier(0.23, 1, 0.32, 1)";
    // Opening runs 200ms, closing 150ms; the closed panel hides only after its slide.
    expect(theme).toContain(
      `[data-state="expanded"] > [data-sidebar="gap"] {\n    transition: width 200ms ${quint};`,
    );
    expect(theme).toContain(
      `[data-state="collapsed"] > [data-sidebar="gap"] {\n    transition: width 150ms ${quint};`,
    );
    expect(theme).toContain(`width 150ms ${quint},\n      visibility 0s linear 150ms;`);
    // The off-canvas sidebar fades its contents as it closes.
    expect(theme).toContain(
      '[data-collapsible="offcanvas"]\n    > [data-sidebar="panel"]\n    > [data-sidebar="sidebar"] {\n    opacity: 0;\n    translate: -16px 0;',
    );
    // The right panel takes its width at once; only its contents fade in, over its
    // own ground, so the lighter page never shows through.
    expect(theme).toContain(
      '.dark [id^="thread-detail-timeline-panel"],\n  .dark [id^="thread-detail-secondary-panel"] {\n    transition-duration: 0ms;',
    );
    // The fade follows bb's own duration, so it stays still when bb suppresses motion.
    expect(theme).toContain("calc(var(--panel-collapse-duration, 220ms) * 15 / 22)");
    expect(theme).toContain(
      '> aside[aria-hidden="true"] > div {\n    opacity: 0;\n    translate: 4px 0;\n    transition: none;',
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
      '@media (hover: hover) {\n  .dark button.bg-primary:hover,\n  .dark button.bg-foreground:hover,\n  .dark button[data-bb-control="primary"]:hover {',
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

  test("sets agent replies on T3 Code's markdown geometry and trace rows on the Codex rhythm", () => {
    const agent = ".dark [data-message-column].group\\/message [data-markdown-preview]";
    expect(theme).toContain(
      `${agent},\n.dark .bb-markdown-prose,\n.dark .canvas-prose [data-markdown-preview] {\n  --agent-md-rem: calc(var(--agent-fluid-size) / 0.875);\n  --md-table-start-offset: 0px;\n  font-weight: 400;\n  line-height: 1.625;`,
    );
    expect(theme).toContain(
      `${agent} :is(p, ul, ol, blockquote, hr):not([data-bb-plugin-root] *),\n.dark .bb-markdown-prose :is(p, ul, ol, blockquote, hr) {\n  margin: calc(var(--agent-md-rem) * 0.65) 0;`,
    );
    expect(theme).toContain(
      `${agent} h1:not([data-bb-plugin-root] *),\n.dark .bb-markdown-prose h1 {\n  font-size: calc(var(--agent-md-rem) * 1.25);`,
    );
    expect(theme).toContain(
      `${agent} li + li:not([data-bb-plugin-root] *),\n.dark .bb-markdown-prose li + li {\n  margin-top: calc(var(--agent-md-rem) * 0.25);`,
    );
    expect(theme).toContain(
      `${agent} :is(strong, b):not([data-bb-plugin-root] *),\n.dark .bb-markdown-prose :is(strong, b) {\n  font-weight: 600;`,
    );
    // T3 renders single newlines as CommonMark soft breaks, not line breaks.
    expect(theme).not.toMatch(
      /\[data-markdown-preview\][^{]*\bp\b[^{]*\{[^}]*white-space: pre-line/,
    );
    // Plugin cards mounted in a reply keep their own spacing, and the
    // block-margin rule must not outrank the first- and last-child resets.
    expect(theme).toContain(`${agent} > :first-child${":not([data-bb-plugin-root] *)"},`);
    // TipTap wraps list items and cells in paragraphs; the adapter resets them.
    expect(theme).toContain(
      ".dark .bb-markdown-prose :is(li, th, td) > p,\n.dark .bb-markdown-prose li > div > p {\n  margin: 0;",
    );
    expect(theme).toContain('.dark [data-timeline-row-list="top-level"] {\n  gap: 8px;\n}');
    expect(theme).toContain('.dark [data-timeline-row-list="bundle"] {\n  gap: 0;');
    // bb's 20px action row holds the absolutely positioned hover actions.
    // Collapsing it lets them spill over the next timeline item.
    expect(theme).not.toContain(".relative.w-full.h-5");
    // bb counts inline actions from its 20px boxes, so the ghost fill is drawn
    // outside them instead of resizing the buttons.
    expect(theme).not.toContain("padding-inline: 7px");
    expect(theme).toContain('> span:empty::after {\n  content: "text";');
    expect(theme).not.toContain('a.underline[href^="mailto:"]::before');
    expect(theme).toContain(
      "a.underline code.bg-muted\\/70,\n.dark .bb-markdown-prose a :not(pre) > code {\n  color: inherit;",
    );
    expect(theme).toContain(
      ".dark [data-timeline-row-list] span.text-sm.leading-5,\n.dark .group\\/timeline-row span.text-sm.leading-5 {\n  font-size: var(--agent-fluid-size);\n  line-height: 1.5;",
    );
    expect(theme).toContain(
      ".dark [data-timeline-row-list] span.inline-flex.gap-1\\.5 > [data-icon-root].size-3\\.5,\n.dark .group\\/timeline-row span.inline-flex.gap-1\\.5 > [data-icon-root].size-3\\.5 {\n  width: 16px;\n  height: 16px;\n  color: inherit;",
    );
    expect(theme).toContain(
      ".dark [data-timeline-row-list] span.inline-flex.gap-1\\.5 > svg[data-icon-root].size-3\\.5 path,",
    );
    expect(theme).toContain(
      ".dark [data-timeline-row-list] span.inline-flex.gap-1\\.5 > svg[data-icon-root].size-3\\.5 ellipse,",
    );
    expect(theme).toContain(
      ".dark .group\\/timeline-row span.inline-flex.gap-1\\.5 > span[data-icon-root].size-3\\.5 > svg ellipse,",
    );
    expect(theme).toContain(
      ".dark .group\\/timeline-row span.inline-flex.gap-1\\.5 > span[data-icon-root].size-3\\.5 > svg polygon {\n  stroke-width: 1.75;",
    );
    expect(theme).not.toContain("--agent-surface-border");
    expect(theme).toContain(
      ".dark .review-canvas-root[data-review-theme] .review-document {\n  --wb-text: calc(var(--agent-fluid-size) * 15 / 14);\n}",
    );
    expect(theme).toContain(
      "@media (max-width: 767px) and (pointer: coarse) {\n  .dark .review-canvas-root[data-review-theme] .review-document {\n    --wb-text: 15px;",
    );
  });

  test("guards AI Elements thread rules against scope, theme, and selector-cost regressions", () => {
    const rules = styleRules(theme).filter(
      (rule) => !rule.atRules.some((at) => at.startsWith("@keyframes")),
    );
    const traceRules = rules.filter((rule) =>
      /data-monokai-trace-|data-timeline-row-list|group\\\/timeline-row|Scroll to latest event|thread-unread-divider|plan-steps-body/.test(
        rule.selector,
      ),
    );
    expect(traceRules.length).toBeGreaterThan(20);
    // Every individual comma-separated selector in every trace rule must be .dark-scoped,
    // avoid bare tag-bucketed `> div`/`> span`/` pre`, and add zero universal-bucket `*` selectors.
    for (const rule of traceRules) {
      for (const branch of rule.selector.split(",")) {
        const trimmed = branch.trim();
        expect(trimmed).toContain(".dark");
        expect(trimmed).not.toMatch(/\*\s*$/);
      }
      expect(rule.selector).not.toMatch(/>\s*(?:div|span)\s*(?:,|$)/);
      expect(rule.selector).not.toMatch(/\bpre\s*(?:,|$)/);
      // No tool-card inset border rings (normalize multi-line box-shadow).
      // Only the 3x DPR circular ScrollToBottomButton keeps an inset hairline ring.
      const normalizedBody = rule.body.replace(/\s+/g, " ");
      if (!rule.selector.includes('button[aria-label="Scroll to latest event"]')) {
        expect(normalizedBody).not.toContain("box-shadow: inset 0 0 0 var(--hairline-ring-width)");
      }
    }
    // Prompt-stack banner and composer guards run over ALL rules in the shipped theme.
    const allowedComposerSelectors = new Set([
      ".dark [data-promptbox]",
      ".dark [data-promptbox] [data-promptbox-editor-scroll]",
      ".dark [data-follow-up-composer]",
      '#root-compose-main-panel [data-testid="root-compose-compact-composer"], #root-compose-main-panel .\\@container\\/page > div > [data-promptbox-shell]',
      "#root-compose-main-panel [data-promptbox-typeahead-menu]",
      ".dark [data-follow-up-composer] [data-promptbox]:not([data-promptbox-compact]) [data-promptbox-editor-scroll]",
      ".dark [data-follow-up-composer-expanded]",
      ".dark [data-follow-up-composer]:not([data-follow-up-composer-expanded]) [data-follow-up-composer-footer]",
      ".dark [data-follow-up-composer]:not([data-follow-up-composer-expanded]) [data-promptbox]:not([data-promptbox-voice-active]) [data-promptbox-editor-scroll]",
      ".dark [data-promptbox] [data-promptbox-editor-content]::before, .dark [data-promptbox] [data-promptbox-editor-content] .ProseMirror p.is-editor-empty:first-child::before",
      '.dark button[aria-label="Environment"][data-promptbox-shrinkable-control] svg[data-icon="Folder"]',
      '.dark button[aria-label="Environment"][data-promptbox-shrinkable-control] svg[data-icon="Folder"] > *',
      ".dark [data-promptbox-send-menu].bg-foreground",
      '.dark [data-promptbox-submit-action][aria-label="Stop run"]',
      '.dark [data-promptbox-submit-action][aria-label="Stop run"]:hover',
      ":where(.dark) [data-promptbox]",
      ".dark [data-promptbox] [data-promptbox-editor-content] .ProseMirror",
    ]);
    for (const rule of rules) {
      const normalizedSelector = rule.selector.replace(/\s+/g, " ");
      expect(normalizedSelector).not.toContain('section[aria-label="To-do list"]');
      expect(normalizedSelector).not.toContain("#thread-todo-card-");
      expect(normalizedSelector).not.toContain('[aria-label="Thread context before sending"]');
      expect(normalizedSelector).not.toContain("[data-agentation-staging-banner]");
      if (normalizedSelector.includes("[data-queued-message-row]")) {
        expect(normalizedSelector).toBe(
          '.dark [data-queued-message-row] button[aria-label^="Reorder queued message"]:disabled',
        );
      }
      if (/\[data-(?:promptbox|follow-up-composer)[\w-]*/.test(normalizedSelector)) {
        expect(allowedComposerSelectors.has(normalizedSelector)).toBe(true);
      }
    }
    // Keep total `*=` substring selectors at or below the pre-BBP-133 baseline (37).
    const substringCount = (theme.replace(/\/\*[\s\S]*?\*\//g, "").match(/\*=/g) ?? []).length;
    expect(substringCount).toBeLessThanOrEqual(37);
  });

  test("collapses empty phone sidebar top reserve rows while keeping header slots at chrome-row height", () => {
    const compactRules = styleRules(theme).filter((rule) =>
      rule.atRules.includes("@media (max-width: 767px)"),
    );
    const reserveRow = compactRules.find(
      (rule) => rule.selector === '.dark [data-testid$="sidebar-top-reserve-row"]',
    );
    expect(reserveRow?.body).toContain("height: auto;");
    expect(reserveRow?.body).toContain("min-height: 0;");

    const headerSlot = compactRules.find(
      (rule) =>
        rule.selector ===
        '.dark [data-testid$="sidebar-top-reserve-row"] [data-sidebar-header-slot]',
    );
    expect(headerSlot?.body).toContain("min-height: var(--bb-app-chrome-row-height);");

    const desktopReserveRows = styleRules(theme).filter(
      (rule) =>
        !rule.atRules.includes("@media (max-width: 767px)") &&
        rule.selector === '.dark [data-testid$="sidebar-top-reserve-row"]',
    );
    expect(desktopReserveRows).toHaveLength(0);
  });

  test("keeps phone text fields at the 16px iOS zoom floor", () => {
    expect(theme).toContain(
      '@media (max-width: 767px) and (pointer: coarse) {\n  .dark .bb-markdown-prose[contenteditable="true"],\n  .dark input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"]),\n  .dark textarea,\n  .dark select {\n    font-size: 16px;',
    );
    const phoneRules = styleRules(theme).filter((rule) =>
      rule.atRules.includes("@media (max-width: 767px) and (pointer: coarse)"),
    );
    expect(
      phoneRules.find((rule) => rule.selector === ":where(.dark) [data-promptbox]")?.body,
    ).toContain("--bb-composer-editor-base-font-size: 16px;");
    expect(
      phoneRules.find(
        (rule) =>
          rule.selector === ".dark [data-promptbox] [data-promptbox-editor-content] .ProseMirror",
      )?.body,
    ).toContain(
      "font-size: calc(var(--bb-composer-editor-base-font-size) * var(--bb-ios-font-scale, 1));",
    );
  });

  test("uses BB's scaled height for the collapsed follow-up editor", () => {
    const compactEditor = styleRules(theme).find(
      (rule) =>
        rule.atRules.includes(
          "@container follow-up-composer style(--follow-up-composer-container-compact: true)",
        ) && rule.selector.endsWith("[data-promptbox-editor-scroll]"),
    );
    expect(compactEditor?.body).toContain(
      "min-height: var(--compact-editor-height, 3rem) !important;",
    );
    expect(compactEditor?.body).toContain(
      "max-height: var(--compact-editor-height, 3rem) !important;",
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

  test("keeps timeline status decorations at full opacity on trace toggles", () => {
    expect(theme).toContain(
      ".dark .group\\/timeline-row > button[aria-expanded] .text-subtle-foreground.opacity-75 {\n  opacity: 1;\n}",
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
          "--agent-surface-background: #ebebec0f",
          "--agent-surface-background: #262626",
        ),
      ),
    ).toThrow("--agent-surface-background: expected #ebebec0f");
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
    // 4% and 6% shell ink over the panel, byte-rounded in sRGB.
    expect(theme).toContain("--surface-recessed-solid: #1b1b1c");
    expect(theme).toContain("--surface-raised-solid: #1f1f20");
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
    const changed = theme.replace("--background: #121213", "--background: #123456");
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

  test("holds machine globes to the 3:1 non-text floor on the sidebar", () => {
    const changed = theme.replace("--machine-1: #2987f8", "--machine-1: #e3e3dd1f");
    expect(() => auditTheme(changed)).toThrow("--machine-1 on --sidebar: 1.28:1 (needs 3.0:1)");
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

  test("allows only the direct child search label exception in injected CSS", () => {
    expect(FRAME_BORDER_CSS).not.toContain(":has(");
    expect(NEW_TAB_LAUNCHER_CSS).not.toContain(":has(");
    const exception =
      'label:has(> input[aria-label^="Search"]:not([data-bb-control], [data-t3-model-search]))';
    expect(SEARCH_FIELDS_CSS).toContain(exception);
    expect(SEARCH_FIELDS_CSS.replaceAll(exception, "")).not.toContain(":has(");
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

  test("it maps Monaco tokens onto the matching TextMate roles", () => {
    const parsed = JSON.parse(codeTheme) as ReturnType<typeof renderCodeTheme>;
    const foregroundByScope = new Map(
      parsed.tokenColors.flatMap((rule) => {
        const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
        return scopes.map((scope) => [scope, rule.settings.foreground] as const);
      }),
    );

    expect(foregroundByScope.get("type.yaml")).toBe("#9ddd54");
    expect(foregroundByScope.get("keyword.yaml")).toBe("#a895fe");
    expect(foregroundByScope.get("comment.yaml")).toBe("#7c7865");
    expect(foregroundByScope.get("comment")).toBe("#beb89999");
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

  test("checks an explicit source outside the checkout without changing vendored rules", async () => {
    const source = await mkdtemp(join(tmpdir(), "monokai-source-"));
    const original = await readFile(codeThemeRulesPath, "utf8");
    const script = fileURLToPath(new URL("../scripts/sync-code-theme.ts", import.meta.url));
    try {
      const { rules } = JSON.parse(original) as CodeThemeRuleFile;
      const tokenColors = rules.map(({ scope, foreground, background, fontStyle }) => ({
        scope,
        settings: {
          foreground: foreground ? roleValues[foreground as keyof typeof roleValues] : undefined,
          background: background ? roleValues[background as keyof typeof roleValues] : undefined,
          fontStyle,
        },
      }));
      await mkdir(join(source, "themes"));
      await writeFile(
        join(source, "themes/generated-textmate.json"),
        JSON.stringify({ tokenColors }),
      );
      await writeFile(join(source, "themes/Cursor Monokai-color-theme.json"), '{"tokenColors":[]}');
      const checked = spawnSync(process.execPath, [script, "--source", source, "--check"], {
        encoding: "utf8",
      });
      expect(checked.stderr).toBe("");
      expect(checked.status).toBe(0);
      const missing = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("--source <editor-theme-directory>");
      const unknown = spawnSync(process.execPath, [script, "--source", source, "--typo"], {
        encoding: "utf8",
      });
      expect(unknown.status).not.toBe(0);
      expect(await readFile(codeThemeRulesPath, "utf8")).toBe(original);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
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
