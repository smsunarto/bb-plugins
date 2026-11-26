import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { chromium } from "playwright";
import { scanSelectors, stripComments } from "./style-contract";
import {
  CARD_ATTR,
  PROMPT_STACK_BANNER_CSS,
} from "../plugins/t3-composer/src/prompt-stack-banner-style";

/**
 * Guard against prompt-stack banner style drift (BBP-135).
 *
 * 1. AST check: every visual plugin composer banner registers host chrome
 *    (`chrome: "card"` or omitted), never `chrome: "bare"`.
 * 2. CSS contract (`scanSelectors` + no per-card overrides): no theme or plugin
 *    stylesheet targets individual prompt-stack cards or uses utility/:has()/
 *    bare-span selectors in `PROMPT_STACK_BANNER_CSS`.
 * 3. Rendered Chromium check: mounts stacked core + plugin banners with
 *    `PROMPT_STACK_BANNER_CSS` and `bb-monokai.css` and asserts computed frame,
 *    hairline, disclosure dividers (including plugin-wrapped regions), nested
 *    inline forms, hover stability, icon/text insets, label/value styles, and
 *    zero icon glimmer/shimmer/pulse animation.
 */

/** Non-card or non-visual composer banners that legitimately use `chrome: "bare"`. */
const BARE_BANNER_ALLOWLIST = new Set<string>([
  "plugins/kitchen-sink/src/app/app.tsx:send-haptic",
  "plugins/devin/src/app/app.tsx:cloud-toggle",
]);

/** Single-card prompt-banner selectors that must never appear in plugin or theme CSS. */
const SINGLE_CARD_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  {
    name: "per-card prompt banner aria-label selector",
    pattern:
      /\[aria-label="(?:Thread context before sending|Child threads|Background agents|Background commands|To-do list|Workflow|Workflows|Model fallback|Machine status|Queued messages|Thread history|Plan|Goal)"\]/g,
  },
  {
    name: "single-plugin staging banner selector",
    pattern: /\[data-agentation-staging-banner\]/g,
  },
];

function trackedPluginFiles(): string[] {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "plugins"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(
      (file) =>
        Boolean(file) &&
        existsSync(file) &&
        !file.includes("/dist/") &&
        !file.includes("/node_modules/") &&
        !file.includes("/test/") &&
        !/\.(?:test|spec|stories|d)\.tsx?$/.test(file) &&
        /\.(?:tsx?|css)$/.test(file),
    );
}

function stringLiteralProp(obj: ts.ObjectLiteralExpression, name: string): string | null {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (key !== name) continue;
    if (
      ts.isStringLiteral(prop.initializer) ||
      ts.isNoSubstitutionTemplateLiteral(prop.initializer)
    ) {
      return prop.initializer.text;
    }
  }
  return null;
}

describe("prompt-stack banner contract", () => {
  test("every visual plugin composer banner card uses host chrome (AST check)", () => {
    const violations: string[] = [];
    for (const file of trackedPluginFiles()) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      const text = readFileSync(file, "utf8");
      if (!text.includes("banners")) continue;
      const sf = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node) => {
        if (
          ts.isPropertyAssignment(node) &&
          ((ts.isIdentifier(node.name) && node.name.text === "banners") ||
            (ts.isStringLiteral(node.name) && node.name.text === "banners")) &&
          ts.isArrayLiteralExpression(node.initializer)
        ) {
          for (const el of node.initializer.elements) {
            if (!ts.isObjectLiteralExpression(el)) continue;
            const chrome = stringLiteralProp(el, "chrome");
            if (chrome !== "bare") continue;
            const id = stringLiteralProp(el, "id") ?? "<unknown>";
            const key = `${file}:${id}`;
            if (!BARE_BANNER_ALLOWLIST.has(key)) {
              violations.push(
                `${key} registers chrome: "bare"; use host chrome ("card" or omitted) so the banner shares bb's PromptStackCard chrome.`,
              );
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(violations).toEqual([]);
  });

  test("no theme or plugin stylesheet targets individual prompt-stack cards or uses utility/:has()/bare-span selectors", () => {
    const violations: string[] = [];
    for (const file of trackedPluginFiles()) {
      const raw = readFileSync(file, "utf8");
      const source = stripComments(raw, file);
      const lines = raw.split("\n");
      for (const { name, pattern } of SINGLE_CARD_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of source.matchAll(pattern)) {
          const line = source.slice(0, match.index!).split("\n").length;
          violations.push(`${file}:${line} (${name}): ${lines[line - 1]?.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);

    // Shared prompt-stack banner CSS must pass style-contract's selector scanner
    // and avoid :has() or bare-span structural rules.
    expect(existsSync("plugins/t3-composer/src/child-threads-banner-style.ts")).toBe(false);
    expect(scanSelectors("prompt-stack-banner-style.css", PROMPT_STACK_BANNER_CSS)).toEqual([]);
    expect(PROMPT_STACK_BANNER_CSS).not.toMatch(/:has\(/);
    expect(PROMPT_STACK_BANNER_CSS).not.toMatch(/\bspan\b/);
    expect(PROMPT_STACK_BANNER_CSS).not.toMatch(/div\[role="group"\]|div\[aria-label\]/);

    // t3-composer/app.css must not carry duplicate utility-anchored banner card rules.
    const appCss = stripComments(readFileSync("plugins/t3-composer/app.css", "utf8"), "app.css");
    expect(appCss).not.toContain("section.rounded-lg.border-border");
    expect(appCss).not.toContain("section.rounded-b-none.border-border");
  });

  test("rendered stacked banners share computed frame, hairlines, insets, typography, and zero icon animation in Chromium", async () => {
    const monokaiCss = readFileSync("plugins/monokai/themes/bb-monokai.css", "utf8");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
      await page.setContent(
        `<!doctype html>
          <html class="dark">
          <head>
            <style>
              :root, .dark {
                --t3-composer-ring-width: 1px;
                --t3-composer-hairline: var(--border);
              }
              *, *::before, *::after { box-sizing: border-box; }
              body { margin: 0; padding: 24px; background: var(--background); color: var(--foreground); font-family: system-ui, sans-serif; }
              .grid { display: grid; }
              .flex { display: flex; }
              .flex-col { flex-direction: column; }
              .flex-1 { flex: 1 1 0%; }
              .items-center { align-items: center; }
              .justify-between { justify-content: space-between; }
              .min-w-0 { min-width: 0; }
              .shrink-0 { flex-shrink: 0; }
              .w-full { width: 100%; }
              .min-h-8 { min-height: 32px; }
              .min-h-6 { min-height: 24px; }
              .gap-2 { gap: 8px; }
              .gap-1\\.5 { gap: 6px; }
              .p-1 { padding: 4px; }
              .px-1 { padding-inline: 4px; }
              .px-2 { padding-inline: 8px; }
              .px-3 { padding-inline: 12px; }
              .py-1 { padding-block: 4px; }
              .py-1\\.5 { padding-block: 6px; }
              .py-0 { padding-block: 0; }
              .size-3\\.5 { width: 14px; height: 14px; }
              .rounded-lg { border-radius: 8px; }
              .border { border-width: 1px; border-style: solid; }
              .border-0 { border-width: 0; }
              .border-t { border-top-width: 1px; border-top-style: solid; }
              .border-border { border-color: var(--border); }
              .border-transparent { border-color: transparent; }
              .bg-surface-raised-solid { background-color: var(--surface-raised-solid, var(--card)); }
              .bg-background\\/70 { background-color: color-mix(in oklab, var(--background) 70%, transparent); }
              .bg-popover { background-color: var(--popover); }
              .text-xs { font-size: 12px; line-height: 16px; }
              .font-medium { font-weight: 500; }
              .font-normal { font-weight: 400; }
              .text-foreground { color: var(--foreground); }
              .text-muted-foreground { color: var(--muted-foreground); }
              .contents { display: contents; }
              .empty\\:hidden:empty { display: none; }
              button { font: inherit; color: inherit; background: transparent; border: 0; text-align: left; }
              @keyframes pulse { 50% { opacity: .5; } }
              .animate-pulse { animation: pulse 2s cubic-bezier(.4,0,.6,1) infinite; }
              .animate-shine, .animate-shine-icon {
                -webkit-mask-image: linear-gradient(90deg, rgba(0,0,0,.45), #000, rgba(0,0,0,.45));
                mask-image: linear-gradient(90deg, rgba(0,0,0,.45), #000, rgba(0,0,0,.45));
                will-change: transform;
              }
              .animate-shine { display: inline-block; -webkit-text-fill-color: var(--foreground); }
              ${monokaiCss}
              ${PROMPT_STACK_BANNER_CSS}
            </style>
          </head>
          <body>
            <div data-promptbox-shell="">
              <div class="grid gap-2">
                <!-- Plugin: Captain (chrome: card) -->
                <div data-bb-plugin-root="" data-bb-plugin="captain" class="contents">
                  <section ${CARD_ATTR}="" aria-label="captain" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden">
                    <div data-bb-plugin="captain" class="flex min-h-8 w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground">
                      <svg data-check-icon class="size-3.5 shrink-0 text-foreground" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>
                      <span data-check-label class="min-w-0 flex-1 font-medium text-foreground">All clear</span>
                    </div>
                  </section>
                </div>

                <!-- Core + Plugin: Thread context before sending + bb--git wrapped disclosure -->
                <section ${CARD_ATTR}="" aria-label="Thread context before sending" class="rounded-lg border border-border bg-surface-raised-solid" style="min-height: 35px;">
                  <div class="flex items-center p-1 text-xs">
                    <span data-bb-plugin="source-control" class="flex min-h-6 min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-xs">
                      <span class="flex min-w-0 shrink-0 items-center gap-1.5 font-medium text-foreground">
                        <svg data-check-icon class="size-3.5 shrink-0 text-foreground" viewBox="0 0 24 24"><path d="M6 3v12"/></svg>
                        <span data-check-label>Local branch</span>
                      </span>
                      <span data-check-value class="min-w-0 text-muted-foreground">scott/bbp-135</span>
                    </span>
                  </div>
                  <div data-bb-plugin="bb--git" class="contents">
                    <section id="thread-prompt-banner-git-body" role="region" aria-hidden="true" class="border-t border-transparent"></section>
                  </div>
                </section>

                <!-- Core: Active child threads (running icon + nested inline PendingInteractionShell) -->
                <section ${CARD_ATTR}="" aria-label="Child threads" class="rounded-lg border border-border bg-surface-raised-solid">
                  <button id="thread-prompt-banner-child-threads-toggle" type="button" aria-expanded="true"
                    class="bg-background/70 flex min-h-8 w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground">
                    <svg data-check-icon class="animate-shine-icon size-3.5 shrink-0 text-foreground" viewBox="0 0 24 24"><path d="M4 4v7h12"/></svg>
                    <span class="animate-shine min-w-0 flex-1 font-medium text-foreground">Active child threads</span>
                  </button>
                  <section id="thread-prompt-banner-child-threads-body" role="region" aria-hidden="false" class="border-t border-border bg-popover">
                    <section aria-label="Confirm tool call" data-presentation="inline">Inline form</section>
                  </section>
                </section>

                <!-- Plugin: Source Control PR watch -->
                <div data-bb-plugin-root="" data-bb-plugin="source-control" class="contents">
                  <section ${CARD_ATTR}="" aria-label="source-control" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden">
                    <div class="flex flex-col text-xs">
                      <div class="flex min-h-8 min-w-0 items-center px-1 py-1">
                        <button type="button" class="flex min-h-6 min-w-0 flex-1 items-center gap-1.5 border-0 px-2 py-0 text-xs">
                          <svg data-check-icon class="size-3.5 shrink-0" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>
                          <span data-check-label class="font-medium text-foreground">Checks passed</span>
                          <span data-check-value class="text-muted-foreground">Fix banners #262</span>
                        </button>
                      </div>
                    </div>
                  </section>
                </div>

                <!-- Plugin: Kitchen Sink RPIV Todo (wrapped region disclosure) -->
                <div data-bb-plugin-root="" data-bb-plugin="kitchen-sink" class="contents">
                  <section ${CARD_ATTR}="" aria-label="kitchen-sink" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden">
                    <div class="rpiv-todo-card min-h-8">
                      <div class="flex items-center">
                        <button type="button" aria-expanded="true" class="flex min-h-8 w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground">
                          <svg data-check-icon class="size-3.5 shrink-0 text-foreground" viewBox="0 0 24 24"><rect x="3" y="5" width="6" height="6"/></svg>
                          <span class="flex min-w-0 flex-1 items-center gap-1.5">
                            <span data-check-label class="shrink-0 font-medium text-foreground">1/3 complete</span>
                            <span data-check-value class="text-muted-foreground">· Fix banners</span>
                          </span>
                        </button>
                      </div>
                      <section id="rpiv-body" aria-hidden="false" class="border-t border-border bg-popover"><div>Body</div></section>
                    </div>
                  </section>
                </div>

                <!-- Plugin: Devin Cloud (no pulsing status dot) -->
                <div data-bb-plugin-root="" data-bb-plugin="devin" class="contents">
                  <section ${CARD_ATTR}="" aria-label="devin" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden">
                    <div class="flex min-h-8 flex-col px-3 py-1.5 text-xs text-foreground">
                      <div class="flex items-center justify-between gap-2">
                        <div class="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                          <svg data-check-icon class="size-3.5 shrink-0 text-foreground" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>
                          <span data-check-label class="shrink-0 font-medium text-foreground">Devin Cloud</span>
                          <span data-check-value>Starting a cloud session…</span>
                        </div>
                        <span data-check-dot class="animate-pulse"></span>
                      </div>
                    </div>
                  </section>
                </div>
              </div>
            </div>
          </body>
          </html>`,
      );

      const report = await page.evaluate((cardAttr) => {
        const cards = [...document.querySelectorAll(`[${cardAttr}]`)];
        const cardMetrics = cards.map((card) => {
          const cs = getComputedStyle(card);
          const after = getComputedStyle(card, "::after");
          const rect = card.getBoundingClientRect();
          const icon = card.querySelector("[data-check-icon]");
          const label = card.querySelector("[data-check-label]");
          const value = card.querySelector("[data-check-value]");
          const ics = icon ? getComputedStyle(icon) : null;
          const lcs = label ? getComputedStyle(label) : null;
          const vcs = value ? getComputedStyle(value) : null;
          return {
            label: card.getAttribute("aria-label"),
            borderTopWidth: cs.borderTopWidth,
            overflow: cs.overflow,
            radius: cs.borderTopLeftRadius,
            minHeight: cs.minHeight,
            height: Math.round(rect.height * 10) / 10,
            afterShadow: after.boxShadow,
            iconLeft: icon
              ? Math.round((icon.getBoundingClientRect().left - rect.left) * 10) / 10
              : null,
            iconAnim: ics?.animationName ?? null,
            iconMask: ics?.maskImage ?? null,
            textLeft: label
              ? Math.round((label.getBoundingClientRect().left - rect.left) * 10) / 10
              : null,
            labelSize: lcs?.fontSize ?? null,
            labelWeight: lcs?.fontWeight ?? null,
            labelColor: lcs?.color ?? null,
            valWeight: vcs?.fontWeight ?? null,
            valColor: vcs?.color ?? null,
          };
        });

        const gitBody = document.querySelector("#thread-prompt-banner-git-body")!;
        const childBody = document.querySelector("#thread-prompt-banner-child-threads-body")!;
        const rpivBody = document.querySelector("#rpiv-body")!;
        const inlineForm = document.querySelector('section[data-presentation="inline"]')!;
        const childToggle = document.querySelector("#thread-prompt-banner-child-threads-toggle")!;
        const shineText = childToggle.querySelector(".animate-shine")!;
        const pulseDot = document.querySelector("[data-check-dot]")!;

        return {
          cardMetrics,
          gitBodyBorderTop: getComputedStyle(gitBody).borderTopWidth,
          childBodyBorderTop: getComputedStyle(childBody).borderTopWidth,
          childBodyBeforeBg: getComputedStyle(childBody, "::before").backgroundColor,
          rpivBodyBorderTop: getComputedStyle(rpivBody).borderTopWidth,
          rpivBodyBeforeBg: getComputedStyle(rpivBody, "::before").backgroundColor,
          inlineFormAfterContent: getComputedStyle(inlineForm, "::after").content,
          childToggleBgAtRest: getComputedStyle(childToggle).backgroundColor,
          shineTextMask: getComputedStyle(shineText).maskImage,
          pulseDotAnim: getComputedStyle(pulseDot).animationName,
        };
      }, CARD_ATTR);

      // Every top-level card shares identical frame, radius, overflow, and ::after hairline.
      const shadows = new Set(report.cardMetrics.map((m) => m.afterShadow));
      expect(shadows.size).toBe(1);
      expect([...shadows][0]).toContain("inset");

      for (const m of report.cardMetrics) {
        expect(m.borderTopWidth).toBe("0px");
        expect(m.overflow).toBe("hidden");
        expect(m.radius).toBe("8px");
        expect(m.minHeight).toBe("32px");
        // No banner icon may glimmer, shimmer, or animate in any state.
        expect(m.iconAnim).toBe("none");
        expect(m.iconMask).toBe("none");
        expect(m.iconLeft).toBe(12);
        if (m.textLeft !== null) {
          expect(m.textLeft).toBe(32);
          expect(m.labelSize).toBe("12px");
          expect(m.labelWeight).toBe("500");
        }
        if (m.valWeight !== null) {
          expect(m.valWeight).toBe("400");
        }
      }

      // Thread context with collapsed bb--git region must stay 32px tall (not 33px or 35px).
      const ctxCard = report.cardMetrics.find((m) => m.label === "Thread context before sending");
      expect(ctxCard?.height).toBe(32);
      expect(report.gitBodyBorderTop).toBe("0px");

      // Both direct core and plugin-wrapped expanded disclosure regions draw ::before hairline.
      expect(report.childBodyBorderTop).toBe("0px");
      expect(report.childBodyBeforeBg).not.toBe("rgba(0, 0, 0, 0)");
      expect(report.rpivBodyBorderTop).toBe("0px");
      expect(report.rpivBodyBeforeBg).not.toBe("rgba(0, 0, 0, 0)");

      // Inline PendingInteractionShell inside Child threads is never framed as a card.
      expect(report.inlineFormAfterContent).toBe("none");

      // Stable toggle ID clears active wash at rest; text shimmer stays intact while icon shimmer & dot pulse are blocked.
      expect(report.childToggleBgAtRest).toBe("rgba(0, 0, 0, 0)");
      expect(report.shineTextMask).not.toBe("none");
      expect(report.pulseDotAnim).toBe("none");
    } finally {
      await browser.close();
    }
  }, 30_000);
});
