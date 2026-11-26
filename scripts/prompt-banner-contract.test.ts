import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { chromium, type Page } from "playwright";
import { installDom } from "@bb-plugins/testing";
import { scanFile, scanSelectors, stripComments } from "./style-contract";
import { CAPTAIN_EMPTY_HIDE_CSS } from "../plugins/captain/src/app/overview-default";
// workaround:t3-composer/prompt-stack-banner-chrome
import {
  CARD_ATTR,
  PROMPT_STACK_BANNER_CSS,
  TOGGLE_ATTR,
} from "../plugins/t3-composer/src/prompt-stack-banner-style";

installDom();
const { act, cleanup, fireEvent, waitFor } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

/**
 * Guard against prompt-stack banner style drift (BBP-135).
 *
 * 1. AST check: every visual plugin composer banner registers host chrome
 *    (`chrome: "card"` or omitted), never `chrome: "bare"` (including `as const` /
 *    `satisfies` expressions).
 * 2. CSS contract (`scanFile` + `scanSelectors` + no per-card overrides): no
 *    theme or plugin stylesheet targets individual prompt-stack cards or uses
 *    raw colors, utility anchors, hardcoded core IDs, `:has()`, or bare-`span`
 *    selectors in `PROMPT_STACK_BANNER_CSS`.
 * 3. Real plugin component checks: mounts real `TodoBanner`, `CloudBanner`, and
 *    `PrWatchBanner` via `@get-bb/plugin-sdk/testing/app` to guard empty/loading
 *    suppression, zero icon pulse/glimmer, `hover:bg-state-hover`, and 14px icon
 *    + disclosure divider markup.
 * 4. Rendered Chromium check across bb Monokai dark, default dark, and default
 *    light: loads real `plugins/t3-composer/app.css`, real `CAPTAIN_EMPTY_HIDE_CSS`,
 *    and real `oklch`/`oklab` tokens, bundles and executes the real
 *    `mountPromptStackBannerStyle` tagger over unstamped core+plugin DOM, and
 *    verifies frame, hairlines, flat Plan/Background rows, Active child threads /
 *    Queue label weights, 10px `text-2xs` badge preservation, `PluginAssetIcon`
 *    mask preservation, Canvas-2D-measured lightening hover across all 3 themes,
 *    `:focus-visible` ring preservation under hover, and exclusion of body buttons
 *    (`Captain` More / Read plan, `PromptStackCollapseRow`).
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
    name: "per-card core prompt-banner id selector",
    pattern: /#thread-(?:prompt-banner|todo-card|background-commands-card)-[a-z0-9-]+/g,
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

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function stringLiteralProp(obj: ts.ObjectLiteralExpression, name: string): string | null {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (key !== name) continue;
    const init = unwrapExpression(prop.initializer);
    if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
      return init.text;
    }
  }
  return null;
}

interface ThemeSpec {
  readonly name: string;
  readonly htmlClass: string;
  readonly themeCss: string;
}

async function bundlePromptStackTagger(): Promise<string> {
  const entry = resolve("plugins/t3-composer/src/prompt-stack-banner-style.ts");
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
  });
  if (!result.success) {
    throw new Error(
      `Failed to bundle prompt-stack-banner-style.ts: ${result.logs.map((l) => l.message).join("; ")}`,
    );
  }
  const code = await result.outputs[0]!.text();
  // Strip ESM export syntax so the bundle can be evaluated directly as a script
  // that exposes `window.__mountPromptStackBannerStyle`.
  return `${code.replace(/export\s*\{[^}]*\};?\s*$/, "")}\nwindow.__mountPromptStackBannerStyle = mountPromptStackBannerStyle;`;
}

function buildBannerFixtureHtml(theme: ThemeSpec, t3AppCss: string): string {
  // Unstamped DOM shaped like real BB core + plugin markup. All data-t3-prompt-stack-*
  // attributes and PROMPT_STACK_BANNER_CSS are injected live by the real tagger.
  return `<!doctype html>
    <html class="${theme.htmlClass}">
    <head>
      <style>
        @layer base {
          *, *::before, *::after { box-sizing: border-box; }
          body { margin: 0; padding: 24px; background: var(--background); color: var(--foreground); font-family: system-ui, sans-serif; }
          button { font: inherit; color: inherit; background: transparent; border: 0; text-align: left; }
        }
        @layer utilities {
          .grid { display: grid; }
          .flex { display: flex; }
          .flex-col { flex-direction: column; }
          .flex-1 { flex: 1 1 0%; }
          .items-center { align-items: center; }
          .items-stretch { align-items: stretch; }
          .justify-between { justify-content: space-between; }
          .justify-center { justify-content: center; }
          .min-w-0 { min-width: 0; }
          .shrink-0 { flex-shrink: 0; }
          .w-full { width: 100%; }
          .w-8 { width: 32px; }
          .min-h-8 { min-height: 32px; }
          .min-h-6 { min-height: 24px; }
          .gap-2 { gap: 8px; }
          .gap-1\\.5 { gap: 6px; }
          .gap-1 { gap: 4px; }
          .p-1 { padding: 4px; }
          .px-1 { padding-inline: 4px; }
          .px-2 { padding-inline: 8px; }
          .px-3 { padding-inline: 12px; }
          .py-1 { padding-block: 4px; }
          .py-1\\.5 { padding-block: 6px; }
          .py-0 { padding-block: 0; }
          .size-3\\.5 { width: 14px; height: 14px; }
          .rounded-lg { border-radius: 8px; }
          .rounded-md { border-radius: 6px; }
          .border { border-width: 1px; border-style: solid; }
          .border-0 { border-width: 0; }
          .border-t { border-top-width: 1px; border-top-style: solid; }
          .border-border { border-color: var(--border); }
          .border-transparent { border-color: transparent; }
          .bg-surface-raised-solid { background-color: var(--surface-raised-solid, var(--card)); }
          .bg-background\\/70 { background-color: color-mix(in oklab, var(--background) 70%, transparent); }
          .hover\\:bg-background\\/80:hover { background-color: color-mix(in oklab, var(--background) 80%, transparent); }
          .hover\\:bg-state-hover:hover { background-color: var(--state-hover); }
          .bg-popover { background-color: var(--popover); }
          .shadow-xs { box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05); }
          .ring-1 { box-shadow: inset 0 0 0 1px var(--border); }
          .outline-none { outline: none; }
          .focus-visible\\:ring-3:focus-visible { box-shadow: 0 0 0 3px var(--ring); }
          .text-xs { font-size: 12px; line-height: 16px; }
          .text-2xs { font-size: 10px; line-height: 14px; }
          .font-mono { font-family: ui-monospace, monospace; }
          .font-medium { font-weight: 500; }
          .font-normal { font-weight: 400; }
          .text-foreground { color: var(--foreground); }
          .text-muted-foreground { color: var(--muted-foreground); }
          .contents { display: contents; }
          .empty\\:hidden:empty { display: none; }
          @keyframes pulse { 50% { opacity: .5; } }
          .animate-pulse { animation: pulse 2s cubic-bezier(.4,0,.6,1) infinite; }
          .animate-shine, .animate-shine-icon {
            -webkit-mask-image: linear-gradient(90deg, rgba(0,0,0,.45), #000, rgba(0,0,0,.45));
            mask-image: linear-gradient(90deg, rgba(0,0,0,.45), #000, rgba(0,0,0,.45));
            will-change: transform;
          }
          .animate-shine { display: inline-block; -webkit-text-fill-color: var(--foreground); }
        }
        .captain-read-plan { box-shadow: 0 1px 2px 0 var(--border), inset 0 0 0 1px var(--border); }
        ${theme.themeCss}
        ${t3AppCss}
        ${CAPTAIN_EMPTY_HIDE_CSS}
      </style>
    </head>
    <body>
      <div data-promptbox-shell="">
        <div class="grid gap-2">
          <!-- Non-interactive Plugin: Captain All clear (chrome: card) -->
          <div data-bb-plugin-root="" data-bb-plugin="captain" class="contents">
            <section aria-label="captain" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden">
              <span hidden data-captain-overview-anchor=""></span>
              <div data-check-flat data-bb-plugin="captain" class="flex min-h-8 w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground">
                <svg data-check-icon class="size-3.5 shrink-0 text-foreground" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>
                <span data-check-label class="min-w-0 flex-1 font-medium text-foreground">All clear</span>
              </div>
            </section>
          </div>

          <!-- Plugin: Captain active ask with More and Read plan body buttons (must NOT get banner toggle hover) -->
          <div data-bb-plugin-root="" data-bb-plugin="captain" class="contents">
            <section data-check-skip-uniform aria-label="captain" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden">
              <span hidden data-captain-overview-anchor=""></span>
              <div data-bb-plugin="captain" role="toolbar" class="flex min-w-0 flex-col bg-popover px-3 py-2 text-xs text-foreground">
                <div>
                  <div data-detail-box="">Long ask detail</div>
                  <button id="captain-more-btn" type="button" aria-expanded="false" class="flex w-full justify-center">More</button>
                </div>
                <div data-captain-answer-row="">
                  <div data-captain-answers="">
                    <button id="captain-read-plan-btn" type="button" aria-expanded="false" class="captain-read-plan px-2 py-1 rounded-md">Read plan</button>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <!-- Core: Plan (CollapsibleActiveStackCard with active div[role="group"] wash + dismiss X) -->
          <section aria-label="Plan" class="rounded-lg border border-border bg-surface-raised-solid">
            <div id="plan-header-group" role="group" aria-label="Plan controls" class="bg-background/70 shadow-xs ring-1 flex w-full items-stretch">
              <button id="plan-toggle" type="button" aria-expanded="false" aria-controls="plan-body"
                class="hover:bg-background/80 outline-none focus-visible:ring-3 flex min-h-8 min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground">
                <svg data-check-icon class="animate-shine-icon size-3.5 shrink-0 text-foreground" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>
                <span data-check-label class="animate-shine min-w-0 flex-1 font-medium text-foreground">Plan</span>
              </button>
              <button id="plan-dismiss-btn" type="button" aria-label="Dismiss plan" class="flex min-h-8 w-8 shrink-0 items-center justify-center">×</button>
            </div>
            <section id="plan-body" role="region" aria-hidden="true" class="border-t border-transparent"></section>
          </section>

          <!-- Core: Background agent (1-item non-interactive, real BB markup with text-2xs model badge) -->
          <section aria-label="Background agents" class="rounded-lg border border-border bg-surface-raised-solid">
            <div class="bg-background/70 shadow-xs ring-1 flex items-center">
              <div data-check-flat class="bg-background/70 flex min-h-8 w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground" aria-label="Background agent: Ship BBP-139 PR · Model sonnet">
                <svg data-check-icon class="animate-shine-icon size-3.5 shrink-0 text-foreground" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>
                <span class="flex min-w-0 flex-1 items-center gap-1">
                  <span data-check-label class="shrink-0 text-muted-foreground">Running background agent:</span>
                  <span data-check-value data-check-no-shine class="animate-shine min-w-0 font-medium text-foreground">Ship BBP-139 PR</span>
                  <span id="bg-model-badge" data-check-no-shine class="shrink-0 font-mono text-2xs text-muted-foreground">sonnet</span>
                </span>
                <span class="shrink-0 text-muted-foreground">25s</span>
              </div>
            </div>
          </section>

          <!-- Core: Background agents (2-item interactive toggle) -->
          <section aria-label="Background agents" class="rounded-lg border border-border bg-surface-raised-solid">
            <div class="bg-background/70 shadow-xs ring-1 flex items-center">
              <button id="bg-multi-toggle" type="button" aria-expanded="false" aria-controls="bg-multi-body"
                class="bg-background/70 hover:bg-background/80 outline-none focus-visible:ring-3 flex min-h-8 w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground">
                <svg data-check-icon class="animate-shine-icon size-3.5 shrink-0 text-foreground" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>
                <span class="flex min-w-0 flex-1 items-center gap-1">
                  <span data-check-label class="shrink-0 font-medium text-foreground">Running 2 background agents</span>
                  <span data-check-value data-check-no-shine class="text-muted-foreground">·</span>
                  <span data-check-value data-check-no-shine class="animate-shine min-w-0 font-medium text-foreground">Ship BBP-139 PR</span>
                </span>
              </button>
            </div>
            <section id="bg-multi-body" role="region" aria-hidden="true" class="border-t border-transparent"></section>
          </section>

          <!-- Core + Plugin: Thread context before sending + bb--git wrapped disclosure -->
          <section aria-label="Thread context before sending" class="rounded-lg border border-border bg-surface-raised-solid" style="min-height: 35px;">
            <div class="flex items-center p-1 text-xs">
              <div data-bb-plugin="source-control" class="contents">
                <span data-check-flat data-testid="sc-strip" class="flex min-h-6 min-w-0 items-center gap-1.5 px-2 py-1 text-xs">
                  <span class="flex min-w-0 shrink-0 items-center gap-1.5 font-medium text-foreground">
                    <svg data-check-icon class="size-3.5 shrink-0 text-foreground" viewBox="0 0 24 24"><path d="M6 3v12"/></svg>
                    <span data-check-label>Local branch</span>
                  </span>
                  <span data-check-value class="min-w-0 text-muted-foreground">scott/bbp-135</span>
                </span>
              </div>
              <div data-bb-plugin="bb--git" class="contents">
                <button id="git-toggle" type="button" aria-expanded="false" aria-controls="git-body"
                  class="hover:bg-state-hover outline-none focus-visible:ring-3 flex min-h-6 flex-1 items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
                  <svg class="size-3.5 shrink-0" viewBox="0 0 24 24"><path d="M4 4h16"/></svg>
                  <span data-promptbox-hide-compact="">Untracked · <span id="git-diff-add">+5</span></span>
                </button>
              </div>
            </div>
            <div data-bb-plugin="bb--git" class="contents">
              <section id="git-body" role="region" aria-hidden="true" class="border-t border-transparent"></section>
            </div>
          </section>

          <!-- Interactive Core: Active child threads (real BB core font-normal + PluginAssetIcon + inline PendingInteractionShell + CollapseRow) -->
          <section aria-label="Child threads" class="rounded-lg border border-border bg-surface-raised-solid">
            <button id="child-threads-toggle" type="button" aria-expanded="true" aria-controls="child-threads-body"
              class="bg-background/70 hover:bg-background/80 outline-none focus-visible:ring-3 flex min-h-8 w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground">
              <svg data-check-icon class="animate-shine-icon size-3.5 shrink-0 text-foreground" viewBox="0 0 24 24"><path d="M4 4v7h12"/></svg>
              <span data-check-label class="animate-shine min-w-0 flex-1 font-normal text-foreground">Active child threads</span>
              <span><span>1</span></span>
            </button>
            <section id="child-threads-body" role="region" aria-hidden="false" class="border-t border-border bg-popover">
              <section aria-label="Confirm tool call" data-presentation="inline">Inline form</section>
              <span id="plugin-asset-icon" class="animate-shine-icon" data-plugin-icon-asset="custom.svg"
                style="display:inline-block;width:14px;height:14px;background-color:currentColor;-webkit-mask-image:url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22/>');mask-image:url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22/>');"></span>
              <button id="collapse-row-btn" type="button" aria-expanded="true" aria-controls="child-threads-body" class="hover:bg-state-hover flex min-h-6 w-full justify-center">Collapse</button>
            </section>
          </section>

          <!-- Interactive Core: Queued messages (real BB core <header> + font-normal Queue) -->
          <section aria-label="Queued messages" class="rounded-lg border border-border bg-surface-raised-solid">
            <header data-queued-messages-mode="collapsed">
              <button id="queue-toggle" type="button" aria-expanded="false" aria-controls="queue-list"
                class="hover:bg-state-hover outline-none focus-visible:ring-3 flex min-h-8 w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground">
                <span data-check-label class="font-normal">Queue</span>
              </button>
            </header>
            <div id="queue-list" data-queued-messages-scroll-frame=""></div>
          </section>

          <!-- Interactive Plugin: Source Control PR watch -->
          <div data-bb-plugin-root="" data-bb-plugin="source-control" class="contents">
            <section aria-label="source-control" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden">
              <div data-bb-plugin="source-control" data-testid="sc-pr-watch" class="flex flex-col text-xs">
                <div data-state="open">
                  <div class="flex min-h-8 min-w-0 items-center px-1 py-1">
                    <button id="pr-watch-toggle" type="button" aria-expanded="true" aria-controls="pr-watch-body"
                      class="hover:bg-state-hover outline-none focus-visible:ring-3 flex min-h-6 min-w-0 flex-1 items-center gap-1.5 border-0 px-2 py-0 text-xs">
                      <svg data-check-icon width="14" height="14" class="shrink-0" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6"/></svg>
                      <span data-check-label class="font-medium text-foreground">Checks passed</span>
                      <span data-check-value class="text-muted-foreground">Fix banners #262</span>
                    </button>
                  </div>
                  <section id="pr-watch-body" aria-hidden="false" class="border-t border-border bg-popover"><div>Checks</div></section>
                </div>
              </div>
            </section>
          </div>

          <!-- Interactive Plugin: Kitchen Sink RPIV Todo -->
          <div data-bb-plugin-root="" data-bb-plugin="kitchen-sink" class="contents">
            <section aria-label="kitchen-sink" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden">
              <div class="rpiv-todo-card min-h-8">
                <div class="flex items-center">
                  <button id="rpiv-toggle" type="button" aria-expanded="true" aria-controls="rpiv-body"
                    class="hover:bg-state-hover outline-none focus-visible:ring-3 flex min-h-8 w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground">
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

          <!-- Non-interactive Plugin: Devin Cloud -->
          <div data-bb-plugin-root="" data-bb-plugin="devin" class="contents">
            <section aria-label="devin" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden">
              <div data-check-flat class="flex min-h-8 flex-col px-3 py-1.5 text-xs text-foreground">
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

          <!-- Loading / empty plugin banners: must render zero height until they have content -->
          <div data-bb-plugin-root="" data-bb-plugin="captain" class="contents">
            <section data-check-loading-empty="captain-loading" aria-label="captain" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden"><span hidden data-captain-overview-anchor=""></span></section>
          </div>
          <div data-bb-plugin-root="" data-bb-plugin="captain" class="contents">
            <section data-check-loading-empty="captain-cleared" aria-label="captain" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden"><span hidden data-captain-overview-anchor=""></span><div data-bb-plugin="captain"></div></section>
          </div>
          <div data-bb-plugin-root="" data-bb-plugin="kitchen-sink" class="contents">
            <section data-check-loading-empty="kitchen-sink-loading" aria-label="kitchen-sink" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden"></section>
          </div>
          <div data-bb-plugin-root="" data-bb-plugin="source-control" class="contents">
            <section data-check-loading-empty="source-control-loading" aria-label="source-control" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden"></section>
          </div>
          <div data-bb-plugin-root="" data-bb-plugin="devin" class="contents">
            <section data-check-loading-empty="devin-loading" aria-label="devin" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden"></section>
          </div>
        </div>
      </div>
    </body>
    </html>`;
}

async function assertHoverAndFocusContract(page: Page, themeName: string): Promise<void> {
  const interactiveHoverFills = new Set<string>();
  const interactiveSelectors = [
    "#plan-toggle",
    "#bg-multi-toggle",
    "#git-toggle",
    "#child-threads-toggle",
    "#queue-toggle",
    "#pr-watch-toggle",
    "#rpiv-toggle",
  ];

  for (const selector of interactiveSelectors) {
    await page.hover(selector);
    const hoverCheck = await page.evaluate(
      ({ sel, toggleAttr, cardAttr }) => {
        // Resolve any CSS Color 4 syntax (oklab, oklch, color(srgb), rgb) via Canvas 2D.
        const compositeToLuma = (baseCss: string, overCss?: string) => {
          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = baseCss;
          ctx.fillRect(0, 0, 1, 1);
          if (overCss) {
            ctx.fillStyle = overCss;
            ctx.fillRect(0, 0, 1, 1);
          }
          const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        const btn = document.querySelector(sel)!;
        const card = btn.closest(`[${cardAttr}]`)!;
        const cardBg = getComputedStyle(card).backgroundColor;
        const btnBg = getComputedStyle(btn).backgroundColor;
        return {
          hasToggleAttr: btn.hasAttribute(toggleAttr),
          btnBg,
          btnShadow: getComputedStyle(btn).boxShadow,
          restLuma: compositeToLuma(cardBg),
          hoverLuma: compositeToLuma(cardBg, btnBg),
        };
      },
      { sel: selector, toggleAttr: TOGGLE_ATTR, cardAttr: CARD_ATTR },
    );
    expect(hoverCheck.hasToggleAttr, `${themeName}:${selector} tagged`).toBe(true);
    interactiveHoverFills.add(hoverCheck.btnBg);
    expect(hoverCheck.hoverLuma, `${themeName}:${selector} must lighten on hover`).toBeGreaterThan(
      hoverCheck.restLuma,
    );
    if (themeName === "default-light") {
      expect(hoverCheck.btnShadow, `${themeName}:${selector} light hover edge`).toContain("inset");
    }
  }
  expect(interactiveHoverFills.size, `${themeName} shared hover fill`).toBe(1);

  // Focusing an interactive toggle via keyboard and then hovering it must NEVER wipe its :focus-visible ring.
  await page.locator("#pr-watch-toggle").focus();
  // Trigger :focus-visible by moving keyboard focus onto #rpiv-toggle via Tab.
  await page.keyboard.press("Tab");
  const focusCheck = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return null;
    return {
      id: active.id,
      matchesFocusVisible: active.matches(":focus-visible"),
      shadowBeforeHover: getComputedStyle(active).boxShadow,
    };
  });
  expect(focusCheck?.id, `${themeName} Tab moved to #rpiv-toggle`).toBe("rpiv-toggle");
  expect(focusCheck?.matchesFocusVisible, `${themeName} :focus-visible active`).toBe(true);
  expect(focusCheck?.shadowBeforeHover, `${themeName} focus ring visible`).not.toBe("none");
  await page.hover("#rpiv-toggle");
  const shadowDuringHover = await page.evaluate(() => {
    const el = document.querySelector("#rpiv-toggle")!;
    return {
      bg: getComputedStyle(el).backgroundColor,
      shadow: getComputedStyle(el).boxShadow,
    };
  });
  expect(shadowDuringHover.shadow, `${themeName} focus ring preserved under hover`).toBe(
    focusCheck!.shadowBeforeHover,
  );
  expect(shadowDuringHover.bg, `${themeName} still lightens while focused+hovered`).not.toBe(
    "rgba(0, 0, 0, 0)",
  );

  // Hovering Plan's dismiss X button must keep Plan's div[role="group"] transparent (never darken).
  await page.hover("#plan-dismiss-btn");
  const planGroupBg = await page.evaluate(
    () => getComputedStyle(document.querySelector("#plan-header-group")!).backgroundColor,
  );
  expect(planGroupBg, `${themeName} Plan header group stays flat on dismiss hover`).toBe(
    "rgba(0, 0, 0, 0)",
  );

  // Captain More / Read plan and PromptStackCollapseRow must NOT receive TOGGLE_ATTR
  // and hovering Read plan must preserve its outline shadow.
  for (const bodyBtnId of ["captain-more-btn", "captain-read-plan-btn", "collapse-row-btn"]) {
    const before = await page.evaluate(
      ({ id, toggleAttr }) => {
        const el = document.getElementById(id)!;
        return {
          hasToggle: el.hasAttribute(toggleAttr),
          bg: getComputedStyle(el).backgroundColor,
          shadow: getComputedStyle(el).boxShadow,
        };
      },
      { id: bodyBtnId, toggleAttr: TOGGLE_ATTR },
    );
    expect(before.hasToggle, `${themeName}:${bodyBtnId} excluded from TOGGLE_ATTR`).toBe(false);
    await page.hover(`#${bodyBtnId}`);
    const after = await page.evaluate((id) => {
      const el = document.getElementById(id)!;
      return {
        bg: getComputedStyle(el).backgroundColor,
        shadow: getComputedStyle(el).boxShadow,
      };
    }, bodyBtnId);
    if (bodyBtnId === "captain-more-btn") {
      expect(after.bg, `${themeName}:captain-more no banner band`).toBe(before.bg);
    }
    if (bodyBtnId === "captain-read-plan-btn") {
      expect(after.shadow, `${themeName}:captain-read-plan shadow intact`).toBe(before.shadow);
      expect(after.shadow, `${themeName}:captain-read-plan has outline shadow`).not.toBe("none");
    }
  }

  // Non-interactive rows stay 100% flat on hover.
  const flatLocators = page.locator("[data-check-flat]");
  const flatCount = await flatLocators.count();
  expect(flatCount).toBe(4);
  for (let i = 0; i < flatCount; i++) {
    const loc = flatLocators.nth(i);
    const before = await loc.evaluate((el) => getComputedStyle(el).backgroundColor);
    await loc.hover();
    const after = await loc.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(after, `${themeName}:flat[${i}]`).toBe(before);
  }
}

async function assertThemeBannerContract(
  page: Page,
  theme: ThemeSpec,
  t3AppCss: string,
  taggerScript: string,
): Promise<void> {
  await page.setContent(buildBannerFixtureHtml(theme, t3AppCss));
  await page.addScriptTag({ content: taggerScript });
  await page.evaluate(() => {
    const mount = (
      window as unknown as {
        __mountPromptStackBannerStyle: (d: Document, s: AbortSignal) => () => void;
      }
    ).__mountPromptStackBannerStyle;
    mount(document, new AbortController().signal);
  });

  const report = await page.evaluate((cardAttr) => {
    const cards = [
      ...document.querySelectorAll(
        `[${cardAttr}]:not([data-check-loading-empty]):not([data-check-skip-uniform])`,
      ),
    ];
    const cardMetrics = cards.map((card) => {
      const cs = getComputedStyle(card);
      const after = getComputedStyle(card, "::after");
      const rect = card.getBoundingClientRect();
      const icon = card.querySelector("[data-check-icon]");
      const label = card.querySelector("[data-check-label]");
      const values = [...card.querySelectorAll("[data-check-value]")];
      const ics = icon ? getComputedStyle(icon) : null;
      const lcs = label ? getComputedStyle(label) : null;
      return {
        label: card.getAttribute("aria-label"),
        bg: cs.backgroundColor,
        borderTopWidth: cs.borderTopWidth,
        overflow: cs.overflow,
        radius: cs.borderTopLeftRadius,
        minHeight: cs.minHeight,
        height: Math.round(rect.height * 10) / 10,
        afterShadow: after.boxShadow,
        iconLeft: icon
          ? Math.round((icon.getBoundingClientRect().left - rect.left) * 10) / 10
          : null,
        iconWidth: icon ? Math.round(icon.getBoundingClientRect().width * 10) / 10 : null,
        iconAnim: ics?.animationName ?? null,
        iconMask: ics?.maskImage ?? null,
        textLeft: label
          ? Math.round((label.getBoundingClientRect().left - rect.left) * 10) / 10
          : null,
        labelSize: lcs?.fontSize ?? null,
        labelWeight: lcs?.fontWeight ?? null,
        labelColor: lcs?.color ?? null,
        values: values.map((v) => {
          const vcs = getComputedStyle(v);
          return { size: vcs.fontSize, weight: vcs.fontWeight, color: vcs.color };
        }),
      };
    });

    const loadingEmpty = [...document.querySelectorAll("[data-check-loading-empty]")].map((el) => ({
      name: el.getAttribute("data-check-loading-empty"),
      height: Math.round(el.getBoundingClientRect().height * 10) / 10,
    }));

    const noShineEls = [...document.querySelectorAll("[data-check-no-shine]")].map((el) => {
      const cs = getComputedStyle(el);
      return {
        text: el.textContent,
        mask: cs.maskImage,
        anim: cs.animationName,
      };
    });

    const gitBody = document.querySelector("#git-body")!;
    const childBody = document.querySelector("#child-threads-body")!;
    const prWatchBody = document.querySelector("#pr-watch-body")!;
    const rpivBody = document.querySelector("#rpiv-body")!;
    const inlineForm = document.querySelector('section[data-presentation="inline"]')!;
    const childToggle = document.querySelector("#child-threads-toggle")!;
    const bgToggle = document.querySelector("#bg-multi-toggle")!;
    const planGroup = document.querySelector("#plan-header-group")!;
    const bgFlatRow = document.querySelector(
      'section[aria-label="Background agents"] [data-check-flat]',
    )!;
    const shineText = childToggle.querySelector(".animate-shine")!;
    const pulseDot = document.querySelector("[data-check-dot]")!;
    const modelBadge = document.querySelector("#bg-model-badge")!;
    const pluginAssetIcon = document.querySelector("#plugin-asset-icon")!;

    return {
      cardMetrics,
      loadingEmpty,
      noShineEls,
      gitBodyBorderTop: getComputedStyle(gitBody).borderTopWidth,
      childBodyBorderTop: getComputedStyle(childBody).borderTopWidth,
      childBodyBeforeBg: getComputedStyle(childBody, "::before").backgroundColor,
      prWatchBodyBorderTop: getComputedStyle(prWatchBody).borderTopWidth,
      prWatchBodyBeforeBg: getComputedStyle(prWatchBody, "::before").backgroundColor,
      rpivBodyBorderTop: getComputedStyle(rpivBody).borderTopWidth,
      rpivBodyBeforeBg: getComputedStyle(rpivBody, "::before").backgroundColor,
      inlineFormAfterContent: getComputedStyle(inlineForm, "::after").content,
      childToggleBgAtRest: getComputedStyle(childToggle).backgroundColor,
      bgToggleBgAtRest: getComputedStyle(bgToggle).backgroundColor,
      planGroupBgAtRest: getComputedStyle(planGroup).backgroundColor,
      planGroupShadowAtRest: getComputedStyle(planGroup).boxShadow,
      bgFlatRowBgAtRest: getComputedStyle(bgFlatRow).backgroundColor,
      shineTextMask: getComputedStyle(shineText).maskImage,
      pulseDotAnim: getComputedStyle(pulseDot).animationName,
      modelBadgeFontSize: getComputedStyle(modelBadge).fontSize,
      pluginAssetIconMask: getComputedStyle(pluginAssetIcon).maskImage,
    };
  }, CARD_ATTR);

  expect(report.cardMetrics.length, theme.name).toBe(10);

  // Every visible card shares identical frame, surface fill, and ::after hairline.
  const shadows = new Set(report.cardMetrics.map((m) => m.afterShadow));
  expect(shadows.size, theme.name).toBe(1);
  expect([...shadows][0], theme.name).toContain("inset");
  const cardBgs = new Set(report.cardMetrics.map((m) => m.bg));
  expect(cardBgs.size, `${theme.name} card surface fill`).toBe(1);

  const expectedLabelColor = report.cardMetrics.find((m) => m.label === "captain")?.labelColor;
  const expectedValueColor = report.cardMetrics.find(
    (m) => m.label === "Thread context before sending",
  )?.values[0]?.color;
  if (!expectedLabelColor || !expectedValueColor) {
    throw new Error(`Missing reference colors for ${theme.name}`);
  }
  expect(expectedLabelColor, theme.name).not.toBe(expectedValueColor);

  for (const m of report.cardMetrics) {
    expect(m.borderTopWidth, `${theme.name}:${m.label}`).toBe("0px");
    expect(m.overflow, `${theme.name}:${m.label}`).toBe("hidden");
    expect(m.radius, `${theme.name}:${m.label}`).toBe("8px");
    expect(m.minHeight, `${theme.name}:${m.label}`).toBe("32px");
    if (m.iconLeft !== null) {
      expect(m.iconAnim, `${theme.name}:${m.label}`).toBe("none");
      expect(m.iconMask, `${theme.name}:${m.label}`).toBe("none");
      expect(m.iconLeft, `${theme.name}:${m.label}`).toBe(12);
      expect(m.iconWidth, `${theme.name}:${m.label}`).toBe(14);
      expect(m.textLeft, `${theme.name}:${m.label}`).toBe(32);
    }
    if (m.labelSize !== null) {
      expect(m.labelSize, `${theme.name}:${m.label}`).toBe("12px");
      expect(m.labelWeight, `${theme.name}:${m.label}`).toBe("500");
      expect(m.labelColor, `${theme.name}:${m.label}`).toBe(expectedLabelColor);
    }
    for (const v of m.values) {
      expect(v.size, `${theme.name}:${m.label}`).toBe("12px");
      expect(v.weight, `${theme.name}:${m.label}`).toBe("400");
      expect(v.color, `${theme.name}:${m.label}`).toBe(expectedValueColor);
    }
  }

  for (const item of report.noShineEls) {
    expect(item.mask, `${theme.name}:no-shine:${item.text}`).toBe("none");
    expect(item.anim, `${theme.name}:no-shine:${item.text}`).toBe("none");
  }
  expect(report.noShineEls.length).toBeGreaterThanOrEqual(4);

  // Every loading / empty plugin banner renders zero height.
  expect(report.loadingEmpty.length).toBe(5);
  for (const item of report.loadingEmpty) {
    expect(item.height, `${theme.name}:loading-empty:${item.name}`).toBe(0);
  }

  const ctxCard = report.cardMetrics.find((m) => m.label === "Thread context before sending");
  expect(ctxCard?.height, theme.name).toBe(32);
  expect(report.gitBodyBorderTop, theme.name).toBe("0px");
  expect(report.childBodyBorderTop, theme.name).toBe("0px");
  expect(report.childBodyBeforeBg, theme.name).not.toBe("rgba(0, 0, 0, 0)");
  expect(report.prWatchBodyBorderTop, theme.name).toBe("0px");
  expect(report.prWatchBodyBeforeBg, theme.name).not.toBe("rgba(0, 0, 0, 0)");
  expect(report.rpivBodyBorderTop, theme.name).toBe("0px");
  expect(report.rpivBodyBeforeBg, theme.name).not.toBe("rgba(0, 0, 0, 0)");
  expect(report.inlineFormAfterContent, theme.name).toBe("none");
  expect(report.childToggleBgAtRest, theme.name).toBe("rgba(0, 0, 0, 0)");
  expect(report.bgToggleBgAtRest, theme.name).toBe("rgba(0, 0, 0, 0)");
  expect(report.planGroupBgAtRest, theme.name).toBe("rgba(0, 0, 0, 0)");
  expect(report.planGroupShadowAtRest, theme.name).toBe("none");
  expect(report.bgFlatRowBgAtRest, theme.name).toBe("rgba(0, 0, 0, 0)");
  expect(report.shineTextMask, theme.name).not.toBe("none");
  expect(report.pulseDotAnim, theme.name).toBe("none");
  expect(report.modelBadgeFontSize, `${theme.name} text-2xs model badge kept at 10px`).toBe("10px");
  expect(report.pluginAssetIconMask, `${theme.name} PluginAssetIcon mask preserved`).not.toBe(
    "none",
  );

  await assertHoverAndFocusContract(page, theme.name);
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

  test("no theme or plugin stylesheet targets individual prompt-stack cards or breaks style-contract", () => {
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

    // Shared prompt-stack banner CSS must pass BOTH scanFile and scanSelectors
    // (no raw colors / color-mix, no utility selectors), and avoid :has() or bare-span rules.
    expect(existsSync("plugins/t3-composer/src/child-threads-banner-style.ts")).toBe(false);
    expect(scanFile("prompt-stack-banner-style.css", PROMPT_STACK_BANNER_CSS)).toEqual([]);
    expect(scanSelectors("prompt-stack-banner-style.css", PROMPT_STACK_BANNER_CSS)).toEqual([]);
    expect(PROMPT_STACK_BANNER_CSS).not.toMatch(/:has\(/);
    expect(PROMPT_STACK_BANNER_CSS).not.toMatch(/\bspan\b/);
    expect(PROMPT_STACK_BANNER_CSS).not.toMatch(/div\[role="group"\]|div\[aria-label\]/);

    // Only min-height: 32px !important (overriding inline style minHeight: 35) may use !important.
    const importants = PROMPT_STACK_BANNER_CSS.match(/[^;\n]*!important/g) ?? [];
    expect(importants.map((line) => line.trim())).toEqual(["min-height: 32px !important"]);

    // t3-composer/app.css must not carry duplicate utility-anchored banner card rules.
    const appCss = stripComments(readFileSync("plugins/t3-composer/app.css", "utf8"), "app.css");
    expect(appCss).not.toContain("section.rounded-lg.border-border");
    expect(appCss).not.toContain("section.rounded-b-none.border-border");
  });

  test("real plugin banners enforce no loading popup, no pulsing icons, lightening hover, and 14px check icons", async () => {
    const { TodoBanner } = await import("../plugins/kitchen-sink/src/app/rpiv-todo/banner.tsx");
    const { queryClient: devinQueryClient } = await import("../plugins/devin/src/app/query.ts");
    const { PrWatchBanner } = await import("../plugins/source-control/src/app/pr-watch-banner.tsx");

    try {
      // 1. Real rpiv-todo banner: must render nothing while paging empty truncated history.
      const rpivEmpty = renderSlot(
        { component: TodoBanner },
        {},
        {
          composer: { scope: { kind: "thread", threadId: "guard-rpiv-empty" } },
          sdk: { subscribe: () => () => {} },
          rpc: { getRpivTodos: () => ({ items: [], truncated: true }) },
        },
      );
      await waitFor(() => expect(rpivEmpty.inspection.rpcCalls.length).toBeGreaterThan(0));
      await act(async () => {});
      expect(rpivEmpty.container.childNodes.length).toBe(0);
      expect(rpivEmpty.queryByText(/Loading task history/) === null).toBe(true);
      rpivEmpty.unmount();

      // Real rpiv-todo banner with tasks: uses hover:bg-state-hover (never dark hover:bg-background/80).
      const rpivLoaded = renderSlot(
        { component: TodoBanner },
        {},
        {
          composer: { scope: { kind: "thread", threadId: "guard-rpiv-loaded" } },
          sdk: { subscribe: () => () => {} },
          rpc: {
            getRpivTodos: () => ({
              items: [{ id: "1", text: "Guard task", status: "in_progress" }],
              truncated: false,
            }),
          },
        },
      );
      const rpivBtn = await rpivLoaded.findByRole("button", { name: /To-do list/ });
      expect(rpivBtn.className).toContain("hover:bg-state-hover");
      expect(rpivBtn.className).not.toContain("hover:bg-background/");
      rpivLoaded.unmount();

      // 2. Real Devin Cloud banner: zero pulsing or glimmering icons in starting state,
      //    and zero DOM while loading or hidden.
      devinQueryClient.clear();
      const devinAppModule = resolve("plugins/devin/src/app/app.tsx");
      const devinApp = await loadPluginApp(() => import(devinAppModule));
      const devinBanner = devinApp.composerCustomizations.find((c) => c.id === "cloud-session")
        ?.banners?.[0];
      expect(devinBanner !== undefined).toBe(true);
      const devinStarting = renderSlot(
        devinBanner!,
        {},
        {
          pluginId: "devin",
          composer: { scope: { kind: "thread", threadId: "guard-devin-starting" } },
          sdk: { subscribe: () => () => {} },
          rpc: { cloudSession: () => ({ state: "starting" }) },
        },
      );
      await devinStarting.findByText("Starting");
      expect(devinStarting.container.querySelectorAll(".animate-pulse").length).toBe(0);
      expect(devinStarting.container.querySelectorAll(".animate-shine-icon").length).toBe(0);
      devinStarting.unmount();

      // 3. Real PrWatchBanner: 14x14 CheckIcon in header, zero pulsing icons, and
      //    expanded <section aria-hidden="false"> disclosure body.
      const prWatch = renderSlot(
        { component: PrWatchBanner },
        {},
        {
          pluginId: "source-control",
          composer: { scope: { kind: "thread", threadId: "guard-pr-watch" } },
          rpc: {
            prWatches: () => ({
              "guard-pr-watch": {
                watches: [
                  {
                    ref: { owner: "acme", repo: "app", number: 262 },
                    title: "Fix banners",
                    url: "https://github.com/acme/app/pull/262",
                    state: "open",
                    mergeState: "CLEAN",
                    ended: false,
                    polledAt: new Date().toISOString(),
                    error: null,
                    checks: {
                      headRefOid: "abcdef1234567",
                      checks: [{ id: "1", name: "ci", state: "success", detailsUrl: null }],
                    },
                  },
                ],
              },
            }),
          },
        },
      );
      const prToggle = await prWatch.findByRole("button", { name: /Checks passed/ });
      const headerSvg = prToggle.querySelector("svg");
      expect(headerSvg?.getAttribute("width")).toBe("14");
      expect(headerSvg?.getAttribute("height")).toBe("14");
      expect(prWatch.container.querySelectorAll(".animate-pulse").length).toBe(0);
      expect(prWatch.container.querySelectorAll(".animate-shine-icon").length).toBe(0);
      fireEvent.click(prToggle);
      const expandedBody = prWatch.container.querySelector('section[aria-hidden="false"]');
      expect(expandedBody !== null).toBe(true);
      prWatch.unmount();
    } finally {
      cleanup();
    }
  });

  test("rendered stacked banners share computed frame, hairlines, insets, typography, lightening hover, focus rings, and zero icon animation across all 3 themes", async () => {
    const monokaiCss = readFileSync("plugins/monokai/themes/bb-monokai.css", "utf8");
    const t3AppCss = readFileSync("plugins/t3-composer/app.css", "utf8");
    const taggerScript = await bundlePromptStackTagger();

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
      // Use real BB oklch / oklab color-mix tokens for Default Dark and Default Light.
      const themes: readonly ThemeSpec[] = [
        {
          name: "bb-monokai-dark",
          htmlClass: "dark",
          themeCss: monokaiCss,
        },
        {
          name: "default-dark",
          htmlClass: "dark",
          themeCss: `
            .dark {
              --canvas: oklch(0.195 0 0);
              --ink: oklch(0.81 0 0);
              --background: var(--canvas);
              --foreground: var(--ink);
              --muted-foreground: oklch(0.78 0 0);
              --border: color-mix(in oklch, var(--ink) 19.4%, var(--canvas));
              --popover: var(--canvas);
              --ring: oklch(0.82 0 0);
              --surface-raised-solid: color-mix(in oklab, var(--ink) 2.5%, var(--canvas));
              --state-hover: color-mix(in oklab, var(--ink) 13.8%, transparent);
            }
          `,
        },
        {
          name: "default-light",
          htmlClass: "",
          themeCss: `
            :root {
              --canvas: oklch(1 0 0);
              --ink: oklch(0.3211 0 0);
              --background: var(--canvas);
              --foreground: var(--ink);
              --muted-foreground: oklch(0.44 0 0);
              --border: color-mix(in oklch, var(--ink) 14%, var(--canvas));
              --popover: var(--canvas);
              --ring: oklch(0.27 0 0);
              --surface-raised-solid: color-mix(in oklab, var(--ink) 2.5%, var(--canvas));
              --state-hover: color-mix(in oklab, var(--ink) 5.9%, transparent);
            }
          `,
        },
      ];

      for (const theme of themes) {
        await assertThemeBannerContract(page, theme, t3AppCss, taggerScript);
      }
    } finally {
      await browser.close();
    }
  }, 30_000);
});
