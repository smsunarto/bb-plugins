import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { compile as compileTailwind } from "tailwindcss";
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
 *    theme or plugin stylesheet targets individual core OR plugin prompt-stack
 *    cards (by aria-label, core id, or plugin testid) or uses raw colors,
 *    utility anchors, `:has()`, or bare-`span` selectors in
 *    `PROMPT_STACK_BANNER_CSS`.
 * 3. Rendered Chromium contract across bb Monokai dark, default dark, and
 *    default light: renders the REAL React plugin banners (`NeedsYouBanner` idle
 *    and ask, `StripSummary`, `PrWatchBanner`, `TodoBanner`, `CloudBanner`),
 *    compiles real Tailwind v4 CSS for their classes alongside `controls.css`,
 *    `plugins/t3-composer/app.css`, `CAPTAIN_EMPTY_HIDE_CSS`, and real
 *    `bb-monokai.css` / BB `oklch`/`oklab` tokens, runs the bundled real
 *    `mountPromptStackBannerStyle` tagger over unstamped DOM, and asserts
 *    computed behavior (frame, hairlines, insets, label/value weight & color,
 *    zero icon/label shine sweep, `PluginAssetIcon` mask preservation, `10px`
 *    `text-2xs` badge preservation, lightening hover on all header toggles and
 *    small header controls, non-darkening body buttons, `:focus-visible` ring
 *    preservation under hover, touch sticky-hover safety, and zero loading
 *    height).
 */

/** Non-card or non-visual composer banners that legitimately use `chrome: "bare"`. */
const BARE_BANNER_ALLOWLIST = new Set<string>([
  "plugins/kitchen-sink/src/app/app.tsx:send-haptic",
  "plugins/devin/src/app/app.tsx:cloud-toggle",
]);

/** Files allowed to hide their own empty anchor frame via aria-label. */
const PLUGIN_CARD_SELECTOR_ALLOWLIST = new Set<string>([
  "plugins/captain/src/app/overview-default.ts",
]);

/** Single-card prompt-banner selectors that must never appear in plugin or theme code/CSS. */
const SINGLE_CARD_PATTERNS: readonly { name: string; pattern: RegExp; cssOnly?: boolean }[] = [
  {
    name: "per-card core prompt banner aria-label selector",
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
  {
    name: "per-card plugin banner aria-label selector",
    pattern:
      /section\[aria-label="(?!Thread details"|Recent")[^"]+"\]|\[aria-label="(?:captain|Captain|source-control|Source Control|kitchen-sink|Kitchen Sink|devin|Devin|Devin Cloud|agentation|Agentation|t3-composer|T3 Composer|Needs you[^"]*|PR watch[^"]*|rpiv-todo)"\]/g,
  },
  {
    name: "per-card plugin banner testid selector",
    pattern: /\[data-testid="(?:sc-pr-watch|sc-strip|captain-needs-you)"\]/g,
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

interface RenderedPluginMarkup {
  readonly captainIdleHtml: string;
  readonly captainAskHtml: string;
  readonly stripSummaryHtml: string;
  readonly prWatchHtml: string;
  readonly rpivTodoHtml: string;
  readonly devinStartingHtml: string;
}

/** Renders the real React plugin banners via the SDK test harness and returns their DOM HTML. */
async function renderRealPluginBanners(): Promise<RenderedPluginMarkup> {
  const captainAppPath = resolve("plugins/captain/src/app/app.tsx");
  const captainContractPath = resolve("plugins/captain/src/contract/rpc.ts");
  const scStripPath = resolve("plugins/source-control/src/app/composer-strip.tsx");
  const scContractPath = resolve("plugins/source-control/src/contract/rpc.ts");
  const scIdsPath = resolve("plugins/source-control/src/core/ids.ts");
  const scPrWatchPath = resolve("plugins/source-control/src/app/pr-watch-banner.tsx");
  const rpivPath = resolve("plugins/kitchen-sink/src/app/rpiv-todo/banner.tsx");
  const devinAppPath = resolve("plugins/devin/src/app/app.tsx");
  const devinQueryPath = resolve("plugins/devin/src/app/query.ts");

  const [
    { captainContract },
    { StripSummary },
    { sourceControlContract },
    { changeKeySchema },
    { PrWatchBanner },
    { TodoBanner },
    { queryClient: devinQueryClient },
  ] = await Promise.all([
    import(captainContractPath),
    import(scStripPath),
    import(scContractPath),
    import(scIdsPath),
    import(scPrWatchPath),
    import(rpivPath),
    import(devinQueryPath),
  ]);

  const captainApp = await loadPluginApp(() => import(captainAppPath));
  const captainBanner = captainApp.composerCustomizations.find((c) => c.id === "needs-you")!
    .banners![0]!;
  const devinApp = await loadPluginApp(() => import(devinAppPath));
  const devinBanner = devinApp.composerCustomizations.find((c) => c.id === "cloud-session")!
    .banners![0]!;

  try {
    // 1. Real Captain NeedsYouBanner (idle: All clear + Overview)
    const captainIdle = renderSlot(captainBanner as never, {} as never, {
      experimental_rpcContract: captainContract,
      composer: { scope: { kind: "thread", threadId: "thr_guard_cap_idle" } },
      experimental_panel: { openTab: () => true },
      rpc: {
        captains: () => ({ ids: ["thr_guard_cap_idle"] }),
        asks: () => ({ items: [] }),
        crew: () => ({ items: [] }),
      } as never,
    });
    await captainIdle.findByText("All clear");
    const captainIdleHtml = captainIdle.container.innerHTML;
    captainIdle.unmount();
    cleanup();

    // 2. Real Captain NeedsYouBanner (active ask with 2 tabs, More detail button, and Read plan)
    const now = Date.now();
    const ask1 = {
      kind: "ask",
      key: "ask:a1",
      id: "a1",
      askKind: "decision",
      text: "Approve unified banner plan",
      detail: [
        "Line 1 of plan detail.",
        "Line 2 of plan detail.",
        "Line 3 of plan detail.",
        "Line 4 of plan detail.",
      ].join("\n\n"),
      options: ["Approve", "Revise"],
      task: "BBP-135",
      since: now - 5 * 60_000,
      answer: null,
      snoozedUntil: null,
      skipOrder: null,
    };
    const ask2 = {
      ...ask1,
      key: "ask:a2",
      id: "a2",
      askKind: "improve",
      text: "Follow up on hover tokens",
    };
    // First render a Plan ask alone to capture the real Read plan button markup cleanly.
    const captainPlanAsk = renderSlot(captainBanner as never, {} as never, {
      experimental_rpcContract: captainContract,
      composer: { scope: { kind: "thread", threadId: "thr_guard_cap_plan" } },
      experimental_panel: { openTab: () => true },
      rpc: {
        captains: () => ({ ids: ["thr_guard_cap_plan"] }),
        asks: () => ({
          items: [
            {
              ...ask1,
              key: "ask:a3",
              id: "a3",
              askKind: "decision",
              text: "Approve the plan · Unify prompt banners",
              detail: "# Plan\n\nStep 1\nStep 2\nStep 3\nStep 4\nStep 5\nStep 6\nStep 7\nStep 8",
            },
          ],
        }),
        crew: () => ({ items: [] }),
      } as never,
    });
    const realReadPlan = await captainPlanAsk.findByRole("button", { name: "Read plan" });
    const realReadPlanHtml = realReadPlan.outerHTML;
    captainPlanAsk.unmount();
    cleanup();

    const captainAsk = renderSlot(captainBanner as never, {} as never, {
      experimental_rpcContract: captainContract,
      composer: { scope: { kind: "thread", threadId: "thr_guard_cap_ask" } },
      experimental_panel: { openTab: () => true },
      rpc: {
        captains: () => ({ ids: ["thr_guard_cap_ask"] }),
        asks: () => ({ items: [ask1, ask2] }),
        crew: () => ({ items: [] }),
      } as never,
    });
    await captainAsk.findByRole("tab", { name: /Approve unified banner plan/ });
    // Un-hide the real More button (hidden in jsdom because jsdom has 0 layout height)
    // so Chromium can render and hover the real More button and pill.
    const moreBtn = [...captainAsk.container.querySelectorAll("button[aria-expanded]")].find((b) =>
      /More|Less/.test(b.textContent ?? ""),
    );
    moreBtn?.removeAttribute("hidden");
    const answersHost = captainAsk.container.querySelector("[data-captain-answers]");
    if (answersHost) {
      answersHost.insertAdjacentHTML("beforeend", realReadPlanHtml);
    }
    const captainAskHtml = captainAsk.container.innerHTML;
    captainAsk.unmount();
    cleanup();

    // 3. Real Source Control StripSummary (Local branch + scott/bbp-135)
    const branch = "scott/bbp-135";
    const threadChange = {
      state: "checkout",
      placement: {
        hostId: "host-a",
        hostName: "dev-pc",
        path: "/work/bb-plugins",
        environmentId: "env_1",
      },
      readAsGit: false,
      branch,
      key: changeKeySchema.parse(`gh:smsunarto/bb-plugins:smsunarto:${branch}`),
      local: {
        read: {
          value: {
            provider: "gitbutler",
            path: "/work/bb-plugins",
            commonDir: "/work/bb-plugins/.git",
            checkedOut: null,
            github: { repo: { owner: "smsunarto", name: "bb-plugins" }, headOwner: "smsunarto" },
            uncommitted: [{ path: "src/a.ts", kind: "modified" }],
            moreUncommitted: 0,
            conflicted: [],
            stacks: [
              {
                key: branch,
                branches: [
                  {
                    name: branch,
                    head: "c0ffee1",
                    remote: null,
                    status: "unpushed",
                    push: "push",
                    ahead: 1,
                    behind: 0,
                    newUpstream: 0,
                    reviewId: null,
                    commits: [
                      {
                        id: "c0ffee1",
                        subject: "Fix banners",
                        createdAt: new Date(now - 60_000).toISOString(),
                        conflicted: false,
                      },
                    ],
                    moreCommits: 0,
                    upstreamCommits: [],
                  },
                ],
                assigned: [],
              },
            ],
            target: {
              ref: "origin/main",
              head: "a41c9e2ffff",
              behind: 0,
              base: { id: "a41c9e2aaaa", subject: "Base" },
              lastFetched: null,
            },
          },
          at: now - 5_000,
        },
        problem: null,
      },
      forge: { read: { value: null, at: now - 5_000 }, problem: null },
    };
    const strip = renderSlot(
      { component: StripSummary as never },
      {
        threadId: "thr_guard_strip",
        environment: { id: "env_1" },
        segments: [
          { key: "source-control/strip", pluginId: "source-control" },
          { key: "bb--git/changed-files", pluginId: "bb--git" },
        ],
      } as never,
      {
        pluginId: "source-control",
        experimental_rpcContract: sourceControlContract,
        rpc: {
          changeForThread: () => ({ thr_guard_strip: threadChange }),
        } as never,
      },
    );
    await strip.findByTestId("sc-strip");
    const stripSummaryHtml = strip.container.innerHTML;
    strip.unmount();
    cleanup();

    // 4. Real Source Control PrWatchBanner (expanded open PR with checks + Open on GitHub + Unwatch)
    const prWatch = renderSlot(
      { component: PrWatchBanner },
      {},
      {
        pluginId: "source-control",
        experimental_rpcContract: sourceControlContract,
        composer: { scope: { kind: "thread", threadId: "thr_guard_pr" } },
        rpc: {
          prWatches: () => ({
            thr_guard_pr: {
              watches: [
                {
                  ref: { owner: "acme", repo: "app", number: 262 },
                  account: "acme",
                  title: "Fix banners",
                  url: "https://github.com/acme/app/pull/262",
                  state: "open",
                  mergeState: "CLEAN",
                  ended: false,
                  polledAt: new Date(now - 10_000).toISOString(),
                  error: null,
                  checks: {
                    headRefOid: "abcdef1234567",
                    checks: [
                      {
                        id: "1",
                        name: "ci / test",
                        state: "success",
                        detailsUrl: "https://github.com/acme/app/runs/1",
                      },
                    ],
                  },
                },
              ],
            },
          }),
        } as never,
      },
    );
    const prToggle = await prWatch.findByRole("button", { name: /Checks passed/ });
    fireEvent.click(prToggle);
    await waitFor(() =>
      expect(prWatch.container.querySelector('section[aria-hidden="false"]') !== null).toBe(true),
    );
    const prWatchHtml = prWatch.container.innerHTML;
    prWatch.unmount();
    cleanup();

    // 5. Real Kitchen Sink TodoBanner: empty truncated must render 0 DOM nodes; loaded renders card.
    const rpivEmpty = renderSlot(
      { component: TodoBanner },
      {},
      {
        composer: { scope: { kind: "thread", threadId: "thr_guard_rpiv_empty" } },
        sdk: { subscribe: () => () => {} },
        rpc: { getRpivTodos: () => ({ items: [], truncated: true }) },
      },
    );
    await waitFor(() => expect(rpivEmpty.inspection.rpcCalls.length).toBeGreaterThan(0));
    await act(async () => {});
    expect(rpivEmpty.container.childNodes.length).toBe(0);
    expect(rpivEmpty.queryByText(/Loading task history/) === null).toBe(true);
    rpivEmpty.unmount();
    cleanup();

    const rpivLoaded = renderSlot(
      { component: TodoBanner },
      {},
      {
        composer: { scope: { kind: "thread", threadId: "thr_guard_rpiv_loaded" } },
        sdk: { subscribe: () => () => {} },
        rpc: {
          getRpivTodos: () => ({
            items: [
              { id: "1", text: "Done task", status: "completed" },
              { id: "2", text: "Fix banners", status: "in_progress" },
              { id: "3", text: "Next task", status: "pending" },
            ],
            truncated: false,
          }),
        },
      },
    );
    await rpivLoaded.findByRole("button", { name: /To-do list/ });
    const rpivTodoHtml = rpivLoaded.container.innerHTML;
    rpivLoaded.unmount();
    cleanup();

    // 6. Real Devin CloudBanner (starting state)
    devinQueryClient.clear();
    const devinStarting = renderSlot(
      devinBanner,
      {},
      {
        pluginId: "devin",
        composer: { scope: { kind: "thread", threadId: "thr_guard_devin_starting" } },
        sdk: { subscribe: () => () => {} },
        rpc: { cloudSession: () => ({ state: "starting" }) },
      },
    );
    await devinStarting.findByText("Starting");
    const devinStartingHtml = devinStarting.container.innerHTML;
    devinStarting.unmount();

    return {
      captainIdleHtml,
      captainAskHtml,
      stripSummaryHtml,
      prWatchHtml,
      rpivTodoHtml,
      devinStartingHtml,
    };
  } finally {
    cleanup();
  }
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
  return `${code.replace(/export\s*\{[^}]*\};?\s*$/, "")}\nwindow.__mountPromptStackBannerStyle = mountPromptStackBannerStyle;`;
}

async function compileRealTailwindCss(html: string): Promise<string> {
  const tokens = new Set<string>();
  for (const match of html.matchAll(/class="([^"]+)"/g)) {
    for (const token of match[1]!.split(/\s+/)) {
      if (token) tokens.add(token);
    }
  }
  // Note: intentionally omit `@custom-variant dark (&:is(.dark *))` to match real
  // BB plugin builds, where Tailwind `dark:` compiles to `@media (prefers-color-scheme: dark)`
  // instead of bb's `.dark` class. Running Chromium with the opposite OS colorScheme
  // catches any plugin that leaks `dark:` instead of using `@bb-plugins/ui`'s `.dark`-keyed class.
  const compiled = await compileTailwind(
    `@import "tailwindcss";
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-popover: var(--popover);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-subtle-foreground: var(--subtle-foreground);
  --color-accent: var(--accent);
  --color-state-hover: var(--state-hover);
  --color-state-active: var(--state-active);
  --color-destructive: var(--destructive);
  --color-destructive-text: var(--destructive-text);
  --color-warning: var(--warning);
  --color-warning-text: var(--warning-text);
  --color-success: var(--success);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-surface-recessed: var(--surface-recessed);
  --color-surface-raised: var(--surface-raised);
  --color-surface-raised-solid: var(--surface-raised-solid);
  --color-surface-selected: var(--surface-selected);
  --text-2xs: 0.625rem;
  --text-2xs--line-height: 0.875rem;
}`,
    {
      loadStylesheet: async (id) => {
        if (id === "tailwindcss") {
          return {
            path: resolve("node_modules/tailwindcss/index.css"),
            base: process.cwd(),
            content: readFileSync("node_modules/tailwindcss/index.css", "utf8"),
          };
        }
        throw new Error(`Unexpected stylesheet import: ${id}`);
      },
    },
  );
  return compiled.build([...tokens]);
}

function buildBodyMarkup(plugins: RenderedPluginMarkup): string {
  return `
      <div data-promptbox-shell="">
        <div class="grid gap-2">
          <!-- REAL Plugin: Captain All clear (chrome: card) -->
          <div data-bb-plugin-root="" data-bb-plugin="captain" class="contents">
            <section data-card-kind="captain-idle" aria-label="captain" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden">
              ${plugins.captainIdleHtml}
            </section>
          </div>

          <!-- REAL Plugin: Captain active ask with real tabs, More, and Read plan -->
          <div data-bb-plugin-root="" data-bb-plugin="captain" class="contents">
            <section data-card-kind="captain-ask" aria-label="captain" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden">
              ${plugins.captainAskHtml}
            </section>
          </div>

          <!-- Core: Plan (CollapsibleActiveStackCard with active div[role="group"] wash + .animate-shine label + dismiss X) -->
          <section data-card-kind="core-plan" aria-label="Plan" class="rounded-lg border border-border bg-surface-raised-solid">
            <div id="plan-header-group" role="group" aria-label="Plan controls" class="bg-background/70 shadow-xs ring-1 flex w-full items-stretch">
              <button id="plan-toggle" type="button" aria-expanded="false" aria-controls="plan-body"
                class="hover:bg-background/80 outline-none focus-visible:ring-3 flex min-h-8 min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground">
                <svg class="animate-shine-icon size-3.5 shrink-0 text-foreground" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>
                <span id="plan-label" class="animate-shine min-w-0 flex-1 font-medium text-foreground">Plan</span>
              </button>
              <button id="plan-dismiss-btn" type="button" aria-label="Dismiss plan" class="flex min-h-8 w-8 shrink-0 items-center justify-center">×</button>
            </div>
            <section id="plan-body" role="region" aria-hidden="true" class="border-t border-transparent"></section>
          </section>

          <!-- Core: ThreadTodoCard (with .animate-shine label) -->
          <section data-card-kind="core-todo" aria-label="To-do list" class="rounded-lg border border-border bg-surface-raised-solid">
            <div class="flex items-center">
              <button id="core-todo-toggle" type="button" aria-expanded="false" aria-controls="core-todo-body"
                class="bg-background/70 hover:bg-background/80 outline-none focus-visible:ring-3 flex min-h-8 w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground">
                <svg class="animate-shine-icon size-3.5 shrink-0 text-foreground" viewBox="0 0 24 24"><rect x="3" y="5" width="6" height="6"/></svg>
                <span id="core-todo-label" class="animate-shine min-w-0 flex-1 font-medium text-foreground">1/3 complete</span>
              </button>
            </div>
            <section id="core-todo-body" role="region" aria-hidden="true" class="border-t border-transparent"></section>
          </section>

          <!-- Core: Background agent (1-item non-interactive, real BB markup with text-2xs model badge) -->
          <section data-card-kind="core-bg-1" aria-label="Background agents" class="rounded-lg border border-border bg-surface-raised-solid">
            <div class="bg-background/70 shadow-xs ring-1 flex items-center">
              <div data-check-flat class="bg-background/70 flex min-h-8 w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground" aria-label="Background agent: Ship BBP-139 PR · Model sonnet">
                <svg class="animate-shine-icon size-3.5 shrink-0 text-foreground" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>
                <span class="flex min-w-0 flex-1 items-center gap-1">
                  <span class="shrink-0 text-muted-foreground">Running background agent:</span>
                  <span class="animate-shine min-w-0 font-medium text-foreground">Ship BBP-139 PR</span>
                  <span id="bg-model-badge" class="shrink-0 font-mono text-2xs text-muted-foreground">sonnet</span>
                </span>
                <span class="shrink-0 text-muted-foreground">25s</span>
              </div>
            </div>
          </section>

          <!-- Core: Background agents (2-item interactive toggle) -->
          <section data-card-kind="core-bg-2" aria-label="Background agents" class="rounded-lg border border-border bg-surface-raised-solid">
            <div class="bg-background/70 shadow-xs ring-1 flex items-center">
              <button id="bg-multi-toggle" type="button" aria-expanded="false" aria-controls="bg-multi-body"
                class="bg-background/70 hover:bg-background/80 outline-none focus-visible:ring-3 flex min-h-8 w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground">
                <svg class="animate-shine-icon size-3.5 shrink-0 text-foreground" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>
                <span class="flex min-w-0 flex-1 items-center gap-1">
                  <span class="shrink-0 font-medium text-foreground">Running 2 background agents</span>
                  <span class="text-muted-foreground">·</span>
                  <span class="animate-shine min-w-0 font-medium text-foreground">Ship BBP-139 PR</span>
                </span>
              </button>
            </div>
            <section id="bg-multi-body" role="region" aria-hidden="true" class="border-t border-transparent"></section>
          </section>

          <!-- Core + REAL Plugin: Thread context before sending with real StripSummary + bb--git wrapped disclosure -->
          <section data-card-kind="core-context-strip" aria-label="Thread context before sending" class="rounded-lg border border-border bg-surface-raised-solid" style="min-height: 35px;">
            <div class="flex items-center p-1 text-xs">
              <div data-bb-plugin="source-control" class="contents">
                ${plugins.stripSummaryHtml}
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

          <!-- Interactive Core: Active child threads (real BB core font-normal + .animate-shine + PluginAssetIcon + inline PendingInteractionShell + CollapseRow) -->
          <section data-card-kind="core-child-threads" aria-label="Child threads" class="rounded-lg border border-border bg-surface-raised-solid">
            <button id="child-threads-toggle" type="button" aria-expanded="true" aria-controls="child-threads-body"
              class="bg-background/70 hover:bg-background/80 outline-none focus-visible:ring-3 flex min-h-8 w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground">
              <svg class="animate-shine-icon size-3.5 shrink-0 text-foreground" viewBox="0 0 24 24"><path d="M4 4v7h12"/></svg>
              <span id="child-threads-label" class="animate-shine min-w-0 flex-1 font-normal text-foreground">Active child threads</span>
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
          <section data-card-kind="core-queue" aria-label="Queued messages" class="rounded-lg border border-border bg-surface-raised-solid">
            <header data-queued-messages-mode="collapsed">
              <button id="queue-toggle" type="button" aria-expanded="false" aria-controls="queue-list"
                class="hover:bg-state-hover outline-none focus-visible:ring-3 flex min-h-8 w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs text-foreground">
                <span class="font-normal">Queue</span>
              </button>
            </header>
            <div id="queue-list" data-queued-messages-scroll-frame=""></div>
          </section>

          <!-- REAL Plugin: Source Control PrWatchBanner -->
          <div data-bb-plugin-root="" data-bb-plugin="source-control" class="contents">
            <section data-card-kind="plugin-pr-watch" aria-label="source-control" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden">
              ${plugins.prWatchHtml}
            </section>
          </div>

          <!-- REAL Plugin: Kitchen Sink TodoBanner -->
          <div data-bb-plugin-root="" data-bb-plugin="kitchen-sink" class="contents">
            <section data-card-kind="plugin-rpiv-todo" aria-label="kitchen-sink" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden">
              ${plugins.rpivTodoHtml}
            </section>
          </div>

          <!-- REAL Plugin: Devin CloudBanner -->
          <div data-bb-plugin-root="" data-bb-plugin="devin" class="contents">
            <section data-card-kind="plugin-devin" aria-label="devin" class="rounded-lg border border-border bg-surface-raised-solid empty:hidden">
              ${plugins.devinStartingHtml}
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
  `;
}

function buildBannerFixtureHtml(
  theme: ThemeSpec,
  tailwindCss: string,
  controlsCss: string,
  pluginStylesheetsCss: string,
  bodyMarkup: string,
): string {
  return `<!doctype html>
    <html class="${theme.htmlClass}">
    <head>
      <style>
        ${tailwindCss}
        ${controlsCss}
        @layer components {
          .animate-shine, .animate-shine-icon {
            -webkit-mask-image: linear-gradient(90deg, rgba(0,0,0,.45), #000, rgba(0,0,0,.45));
            mask-image: linear-gradient(90deg, rgba(0,0,0,.45), #000, rgba(0,0,0,.45));
            will-change: transform;
          }
          .animate-shine { display: inline-block; -webkit-text-fill-color: var(--foreground); }
        }
        body { margin: 0; padding: 24px; background: var(--background); color: var(--foreground); font-family: system-ui, sans-serif; }
        /* Settle CSS hover transitions synchronously in headless Chromium without affecting CSS animations. */
        button, a, span { transition-duration: 0s !important; }
        ${theme.themeCss}
        ${pluginStylesheetsCss}
        ${CAPTAIN_EMPTY_HIDE_CSS}
      </style>
      <script>
        window.__compositeToLuma = function (baseCss, overCss) {
          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = baseCss;
          ctx.fillRect(0, 0, 1, 1);
          if (overCss) {
            ctx.fillStyle = overCss;
            ctx.fillRect(0, 0, 1, 1);
          }
          const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
      </script>
    </head>
    <body>${bodyMarkup}</body>
    </html>`;
}

async function assertHoverAndFocusContract(page: Page, themeName: string): Promise<void> {
  const interactiveHoverFills = new Set<string>();
  const interactiveSelectors = [
    "#plan-toggle",
    "#core-todo-toggle",
    "#bg-multi-toggle",
    "#git-toggle",
    "#child-threads-toggle",
    "#queue-toggle",
    '[data-card-kind="plugin-pr-watch"] button[aria-expanded]',
    '[data-card-kind="plugin-rpiv-todo"] button[aria-expanded]',
  ];

  for (const selector of interactiveSelectors) {
    await page.hover(selector);
    const hoverCheck = await page.evaluate(
      ({ sel, toggleAttr, cardAttr }) => {
        const compositeToLuma = (
          window as unknown as { __compositeToLuma: (b: string, o?: string) => number }
        ).__compositeToLuma;
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
  const sharedToggleHoverBg = [...interactiveHoverFills][0]!;

  // Small header controls (Captain Overview, Captain inactive ask tab, PrWatch Open on GitHub,
  // Unwatch) and PR watch check-details ACTION must all share the exact toggle hover fill,
  // use the same inset hairline Light hover edge, and stay borderless in Dark even under an
  // opposite OS colorScheme.
  const smallControls: readonly { name: string; selector: string; onPopover?: boolean }[] = [
    { name: "captain-overview", selector: '[data-card-kind="captain-idle"] button' },
    {
      name: "captain-inactive-tab",
      selector: '[data-card-kind="captain-ask"] button[role="tab"][aria-selected="false"]',
    },
    {
      name: "pr-watch-open-github",
      selector: '[data-card-kind="plugin-pr-watch"] a[aria-label*="GitHub"]',
    },
    {
      name: "pr-watch-unwatch",
      selector: '[data-card-kind="plugin-pr-watch"] button[aria-label^="Unwatch"]',
    },
    {
      name: "pr-watch-action",
      selector: '[data-card-kind="plugin-pr-watch"] a[aria-label^="Details for"]',
      onPopover: true,
    },
  ];
  for (const ctrl of smallControls) {
    await page.hover(ctrl.selector);
    const check = await page.evaluate(
      ({ sel, cardAttr, onPopover }) => {
        const compositeToLuma = (
          window as unknown as { __compositeToLuma: (b: string, o?: string) => number }
        ).__compositeToLuma;
        const el = document.querySelector(sel)!;
        const base = onPopover ? el.closest(".bg-popover")! : el.closest(`[${cardAttr}]`)!;
        const baseBg = getComputedStyle(base).backgroundColor;
        const cs = getComputedStyle(el);
        return {
          btnBg: cs.backgroundColor,
          btnShadow: cs.boxShadow,
          hasVisibleBorder: cs.borderTopWidth !== "0px" && cs.borderTopColor !== "rgba(0, 0, 0, 0)",
          restLuma: compositeToLuma(baseBg),
          hoverLuma: compositeToLuma(baseBg, cs.backgroundColor),
        };
      },
      { sel: ctrl.selector, cardAttr: CARD_ATTR, onPopover: Boolean(ctrl.onPopover) },
    );
    expect(check.btnBg, `${themeName}:${ctrl.name} must use shared toggle hover fill`).toBe(
      sharedToggleHoverBg,
    );
    if (ctrl.onPopover && themeName === "default-light") {
      expect(
        check.hoverLuma,
        `${themeName}:${ctrl.name} never darkens on popover`,
      ).toBeGreaterThanOrEqual(check.restLuma);
    } else {
      expect(
        check.hoverLuma,
        `${themeName}:${ctrl.name} must lighten (never darken) on hover`,
      ).toBeGreaterThan(check.restLuma);
    }
    if (themeName === "default-light") {
      expect(check.btnShadow, `${themeName}:${ctrl.name} light hover edge`).toContain("inset");
    } else {
      expect(check.btnShadow, `${themeName}:${ctrl.name} dark hover no shadow`).toBe("none");
      expect(check.hasVisibleBorder, `${themeName}:${ctrl.name} dark hover no border`).toBe(false);
    }
  }

  // Active Captain ask tab must keep its selected fill on hover in every theme (never darken
  // or get replaced by the inactive hover fill).
  const activeTabSel = '[data-card-kind="captain-ask"] button[role="tab"][aria-selected="true"]';
  const activeTabRest = await page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, shadow: cs.boxShadow };
  }, activeTabSel);
  await page.hover(activeTabSel);
  const activeTabHover = await page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, shadow: cs.boxShadow };
  }, activeTabSel);
  expect(activeTabHover.bg, `${themeName}:captain-active-tab keeps selected fill on hover`).toBe(
    activeTabRest.bg,
  );
  expect(
    activeTabHover.bg,
    `${themeName}:captain-active-tab distinct from inactive hover fill`,
  ).not.toBe(sharedToggleHoverBg);
  expect(activeTabHover.shadow, `${themeName}:captain-active-tab no hover shadow`).toBe("none");

  // Real Captain More pill and Read plan / Revise / Later / Other… buttons inside bg-popover:
  // never receive TOGGLE_ATTR, use the exact shared hover fill, never darken in Default Light,
  // lighten in Dark, and already-bordered controls (More pill `surface.edge`, Read plan / Revise /
  // Later `outline`) do NOT double their edge with an inset hover shadow in Light, while borderless
  // `Other…` (`ghost`) gets the Light inset edge and stays borderless in Dark.
  const captainMore = page
    .locator('[data-card-kind="captain-ask"] button[aria-expanded]')
    .filter({ hasText: /More|Less/ })
    .first();
  expect(
    await captainMore.getAttribute(TOGGLE_ATTR),
    `${themeName}:captain-more untagged`,
  ).toBeNull();
  const moreBeforeShadow = await captainMore.evaluate(
    (btn) => getComputedStyle(btn.querySelector("span")!).boxShadow,
  );
  await captainMore.hover();
  const moreCheck = await captainMore.evaluate((btn) => {
    const compositeToLuma = (
      window as unknown as { __compositeToLuma: (b: string, o?: string) => number }
    ).__compositeToLuma;
    const popover = btn.closest(".bg-popover")!;
    const pill = btn.querySelector("span")!;
    const baseBg = getComputedStyle(popover).backgroundColor;
    const pillCs = getComputedStyle(pill);
    return {
      buttonBg: getComputedStyle(btn).backgroundColor,
      pillBg: pillCs.backgroundColor,
      pillShadow: pillCs.boxShadow,
      restLuma: compositeToLuma(baseBg),
      pillHoverLuma: compositeToLuma(baseBg, pillCs.backgroundColor),
    };
  });
  expect(moreCheck.buttonBg, `${themeName}:captain-more wrapper transparent`).toBe(
    "rgba(0, 0, 0, 0)",
  );
  expect(moreCheck.pillBg, `${themeName}:captain-more pill uses shared hover fill`).toBe(
    sharedToggleHoverBg,
  );
  expect(moreCheck.pillShadow, `${themeName}:captain-more pill does not double edge`).toBe(
    moreBeforeShadow,
  );
  expect(moreCheck.pillShadow, `${themeName}:captain-more pill has no inset shadow`).not.toContain(
    "inset",
  );
  if (themeName === "default-light") {
    expect(
      moreCheck.pillHoverLuma,
      `${themeName}:captain-more pill never darkens`,
    ).toBeGreaterThanOrEqual(moreCheck.restLuma);
  } else {
    expect(
      moreCheck.pillHoverLuma,
      `${themeName}:captain-more pill lightens in dark`,
    ).toBeGreaterThan(moreCheck.restLuma);
  }

  const borderedAnswerControls = [
    {
      name: "captain-read-plan",
      locator: page
        .locator('[data-card-kind="captain-ask"] button[aria-expanded]')
        .filter({ hasText: /Read plan/ })
        .first(),
    },
    {
      name: "captain-revise",
      locator: page
        .locator('[data-card-kind="captain-ask"] [data-captain-answers] button')
        .filter({ hasText: /^Revise$/ })
        .first(),
    },
    {
      name: "captain-later",
      locator: page.locator('[data-card-kind="captain-ask"] button[aria-label="Later"]').first(),
    },
  ];
  for (const ctrl of borderedAnswerControls) {
    expect(
      await ctrl.locator.getAttribute(TOGGLE_ATTR),
      `${themeName}:${ctrl.name} untagged`,
    ).toBeNull();
    const beforeShadow = await ctrl.locator.evaluate((el) => getComputedStyle(el).boxShadow);
    await ctrl.locator.hover();
    const after = await ctrl.locator.evaluate((el) => {
      const compositeToLuma = (
        window as unknown as { __compositeToLuma: (b: string, o?: string) => number }
      ).__compositeToLuma;
      const popover = el.closest(".bg-popover")!;
      const baseBg = getComputedStyle(popover).backgroundColor;
      const cs = getComputedStyle(el);
      return {
        bg: cs.backgroundColor,
        shadow: cs.boxShadow,
        restLuma: compositeToLuma(baseBg),
        hoverLuma: compositeToLuma(baseBg, cs.backgroundColor),
      };
    });
    expect(after.bg, `${themeName}:${ctrl.name} uses shared hover fill`).toBe(sharedToggleHoverBg);
    expect(after.shadow, `${themeName}:${ctrl.name} shadow intact (no doubled edge)`).toBe(
      beforeShadow,
    );
    expect(after.shadow, `${themeName}:${ctrl.name} no inset shadow`).not.toContain("inset");
    if (themeName === "default-light") {
      expect(after.hoverLuma, `${themeName}:${ctrl.name} never darkens`).toBeGreaterThanOrEqual(
        after.restLuma,
      );
    } else {
      expect(after.hoverLuma, `${themeName}:${ctrl.name} lightens in dark`).toBeGreaterThan(
        after.restLuma,
      );
    }
  }

  const captainOther = page
    .locator('[data-card-kind="captain-ask"] button[aria-label="Other…"]')
    .first();
  await captainOther.hover();
  const otherAfter = await captainOther.evaluate((el) => {
    const compositeToLuma = (
      window as unknown as { __compositeToLuma: (b: string, o?: string) => number }
    ).__compositeToLuma;
    const popover = el.closest(".bg-popover")!;
    const baseBg = getComputedStyle(popover).backgroundColor;
    const cs = getComputedStyle(el);
    return {
      bg: cs.backgroundColor,
      shadow: cs.boxShadow,
      hasVisibleBorder: cs.borderTopWidth !== "0px" && cs.borderTopColor !== "rgba(0, 0, 0, 0)",
      restLuma: compositeToLuma(baseBg),
      hoverLuma: compositeToLuma(baseBg, cs.backgroundColor),
    };
  });
  expect(otherAfter.bg, `${themeName}:captain-other uses shared hover fill`).toBe(
    sharedToggleHoverBg,
  );
  if (themeName === "default-light") {
    expect(otherAfter.shadow, `${themeName}:captain-other light hover edge`).toContain("inset");
    expect(otherAfter.hoverLuma, `${themeName}:captain-other never darkens`).toBeGreaterThanOrEqual(
      otherAfter.restLuma,
    );
  } else {
    expect(otherAfter.shadow, `${themeName}:captain-other dark hover no shadow`).toBe("none");
    expect(otherAfter.hasVisibleBorder, `${themeName}:captain-other dark hover no border`).toBe(
      false,
    );
    expect(otherAfter.hoverLuma, `${themeName}:captain-other lightens in dark`).toBeGreaterThan(
      otherAfter.restLuma,
    );
  }

  // PromptStackCollapseRow must NOT receive TOGGLE_ATTR.
  expect(
    await page.locator("#collapse-row-btn").getAttribute(TOGGLE_ATTR),
    `${themeName}:collapse-row untagged`,
  ).toBeNull();

  // Keyboard :focus-visible ring must survive :hover on interactive banner toggles.
  await page.locator("#queue-toggle").focus();
  await page.keyboard.press("Tab");
  const focusBefore = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return null;
    return {
      isPrToggle: active.matches('[data-card-kind="plugin-pr-watch"] button[aria-expanded]'),
      matchesFocusVisible: active.matches(":focus-visible"),
      shadowBeforeHover: getComputedStyle(active).boxShadow,
    };
  });
  expect(focusBefore?.isPrToggle, `${themeName} Tab moved to real PrWatch toggle`).toBe(true);
  expect(focusBefore?.matchesFocusVisible, `${themeName} :focus-visible active`).toBe(true);
  expect(focusBefore?.shadowBeforeHover, `${themeName} focus ring visible`).not.toBe("none");
  await page.hover('[data-card-kind="plugin-pr-watch"] button[aria-expanded]');
  const focusAfter = await page.evaluate(() => {
    const el = document.querySelector('[data-card-kind="plugin-pr-watch"] button[aria-expanded]')!;
    return {
      bg: getComputedStyle(el).backgroundColor,
      shadow: getComputedStyle(el).boxShadow,
    };
  });
  expect(focusAfter.shadow, `${themeName} focus ring preserved under hover`).toBe(
    focusBefore!.shadowBeforeHover,
  );
  expect(focusAfter.bg, `${themeName} still lightens while focused+hovered`).not.toBe(
    "rgba(0, 0, 0, 0)",
  );

  // Hovering Plan's dismiss X button keeps Plan's div[role="group"] transparent (never darkens).
  await page.hover("#plan-dismiss-btn");
  const planGroupBg = await page.evaluate(
    () => getComputedStyle(document.querySelector("#plan-header-group")!).backgroundColor,
  );
  expect(planGroupBg, `${themeName} Plan header group stays flat on dismiss hover`).toBe(
    "rgba(0, 0, 0, 0)",
  );

  // Non-interactive rows stay 100% flat on hover.
  for (const flatSel of [
    '[data-card-kind="captain-idle"] [data-bb-plugin="captain"] > div',
    '[data-card-kind="core-bg-1"] [data-check-flat]',
    '[data-testid="sc-strip"]',
    '[data-card-kind="plugin-devin"] > div',
  ]) {
    const loc = page.locator(flatSel).first();
    const before = await loc.evaluate((el) => getComputedStyle(el).backgroundColor);
    await loc.hover();
    const after = await loc.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(after, `${themeName}:flat:${flatSel}`).toBe(before);
  }
}

async function assertThemeBannerContract(
  page: Page,
  theme: ThemeSpec,
  tailwindCss: string,
  controlsCss: string,
  pluginStylesheetsCss: string,
  bodyMarkup: string,
  taggerScript: string,
): Promise<void> {
  // Exercise the OPPOSITE OS color scheme (bb Dark on light OS, bb Light on dark OS)
  // so any plugin class relying on Tailwind's `dark:` (@media prefers-color-scheme)
  // instead of bb's `.dark` class fails immediately.
  await page.emulateMedia({ colorScheme: theme.htmlClass === "dark" ? "light" : "dark" });
  await page.setContent(
    buildBannerFixtureHtml(theme, tailwindCss, controlsCss, pluginStylesheetsCss, bodyMarkup),
  );

  // Pre-t3-composer behavioral checks on REAL plugin banners:
  // 1. Real Devin CloudBanner renders zero animated/pulsing elements even without t3-composer.
  const devinPreAnims = await page.evaluate(() => {
    const card = document.querySelector('[data-card-kind="plugin-devin"]')!;
    return [...card.querySelectorAll("*")]
      .map((el) => getComputedStyle(el).animationName)
      .filter((anim) => anim !== "none");
  });
  expect(
    devinPreAnims,
    `${theme.name}:real Devin banner zero pulse/glimmer without t3-composer`,
  ).toEqual([]);

  // 2. Real TodoBanner toggle lightens on hover in every theme (including Light) even without t3-composer.
  const rpivBtnSel = '[data-card-kind="plugin-rpiv-todo"] button[aria-expanded]';
  await page.hover(rpivBtnSel);
  const rpivPreHover = await page.evaluate((sel) => {
    const compositeToLuma = (
      window as unknown as { __compositeToLuma: (b: string, o?: string) => number }
    ).__compositeToLuma;
    const btn = document.querySelector(sel)!;
    const card = btn.closest("section")!;
    const cardBg = getComputedStyle(card).backgroundColor;
    const btnCs = getComputedStyle(btn);
    return {
      btnShadow: btnCs.boxShadow,
      restLuma: compositeToLuma(cardBg),
      hoverLuma: compositeToLuma(cardBg, btnCs.backgroundColor),
    };
  }, rpivBtnSel);
  expect(
    rpivPreHover.hoverLuma,
    `${theme.name}:real TodoBanner lightens on hover without t3-composer`,
  ).toBeGreaterThan(rpivPreHover.restLuma);
  if (theme.name === "default-light") {
    expect(
      rpivPreHover.btnShadow,
      `${theme.name}:real TodoBanner light hover edge without t3-composer`,
    ).toContain("inset");
  }
  await page.mouse.move(0, 0);

  // Mount the REAL t3-composer prompt-stack tagger + stylesheet.
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
    const findLabel = (card: Element, kind: string): Element | null => {
      switch (kind) {
        case "captain-idle":
          return card.querySelector("[data-bb-plugin='captain'] span[id]");
        case "captain-ask":
          return card.querySelector('button[role="tab"][aria-selected="true"] > span[title]');
        case "core-plan":
          return card.querySelector("#plan-label");
        case "core-todo":
          return card.querySelector("#core-todo-label");
        case "core-bg-1":
        case "core-bg-2":
          return card.querySelector("[data-t3-prompt-stack-label]");
        case "core-context-strip":
          return card.querySelector(
            '[data-testid="sc-strip"] > span:first-child > span:last-child',
          );
        case "core-child-threads":
          return card.querySelector("#child-threads-label");
        case "core-queue":
          return card.querySelector("#queue-toggle > span");
        case "plugin-pr-watch":
          return card.querySelector("button[aria-expanded] > span > span:first-child");
        case "plugin-rpiv-todo":
          return card.querySelector("button[aria-expanded] > span > span:first-child");
        case "plugin-devin":
          return (
            [...card.querySelectorAll("span")].find(
              (s) => s.textContent?.trim() === "Devin Cloud",
            ) ?? null
          );
        default:
          return null;
      }
    };

    const findValues = (card: Element, kind: string): Element[] => {
      switch (kind) {
        case "captain-ask":
          return [...card.querySelectorAll('[aria-live="polite"]')];
        case "core-bg-1":
        case "core-bg-2":
          return [...card.querySelectorAll("[data-t3-prompt-stack-value]:not(#bg-model-badge)")];
        case "core-context-strip":
          return [...card.querySelectorAll('[data-testid="sc-strip"] > span:nth-child(2) > span')];
        case "plugin-rpiv-todo":
          return [...card.querySelectorAll("button[aria-expanded] > span > span:nth-child(2)")];
        case "plugin-devin":
          return [...card.querySelectorAll("span")].filter((s) =>
            s.textContent?.includes("Starting a cloud session"),
          );
        default:
          return [];
      }
    };

    const cards = [...document.querySelectorAll(`[${cardAttr}]:not([data-check-loading-empty])`)];

    const cardMetrics = cards.map((card) => {
      const kind = card.getAttribute("data-card-kind") ?? card.getAttribute("aria-label") ?? "";
      const cs = getComputedStyle(card);
      const after = getComputedStyle(card, "::after");
      const rect = card.getBoundingClientRect();
      const icon =
        kind === "core-queue" || kind === "captain-ask"
          ? null
          : card.querySelector("svg, [data-icon]");
      const label = findLabel(card, kind);
      const values = findValues(card, kind);
      const ics = icon ? getComputedStyle(icon) : null;
      const lcs = label ? getComputedStyle(label) : null;
      // Walk from each banner's label (or Captain ask's tablist row) up to the card
      // and ensure every intermediate wrapper is transparent, borderless, and shadowless at rest.
      const restAncestorViolations: string[] = [];
      const walkStart =
        kind === "captain-ask"
          ? (card.querySelector('[role="tablist"]')?.parentElement ?? null)
          : label;
      for (let cur: Element | null = walkStart; cur && cur !== card; cur = cur.parentElement) {
        const acs = getComputedStyle(cur);
        if (acs.backgroundColor !== "rgba(0, 0, 0, 0)") {
          restAncestorViolations.push(`${cur.tagName.toLowerCase()} bg=${acs.backgroundColor}`);
        }
        if (
          acs.borderTopWidth !== "0px" ||
          acs.borderRightWidth !== "0px" ||
          acs.borderBottomWidth !== "0px" ||
          acs.borderLeftWidth !== "0px"
        ) {
          restAncestorViolations.push(
            `${cur.tagName.toLowerCase()} border=${acs.borderTopWidth}/${acs.borderRightWidth}/${acs.borderBottomWidth}/${acs.borderLeftWidth}`,
          );
        }
        if (acs.boxShadow !== "none") {
          restAncestorViolations.push(`${cur.tagName.toLowerCase()} shadow=${acs.boxShadow}`);
        }
      }
      return {
        kind,
        label: card.getAttribute("aria-label"),
        bg: cs.backgroundColor,
        borderTopWidth: cs.borderTopWidth,
        overflow: cs.overflow,
        radius: cs.borderTopLeftRadius,
        minHeight: cs.minHeight,
        height: Math.round(rect.height * 10) / 10,
        afterShadow: after.boxShadow,
        restAncestorViolations,
        iconLeft: icon
          ? Math.round((icon.getBoundingClientRect().left - rect.left) * 10) / 10
          : null,
        iconWidth: icon ? Math.round(icon.getBoundingClientRect().width * 10) / 10 : null,
        iconAnim: ics?.animationName ?? null,
        iconMask: ics?.maskImage ?? null,
        textLeft: label
          ? Math.round((label.getBoundingClientRect().left - rect.left) * 10) / 10
          : null,
        labelText: label?.textContent?.trim() ?? null,
        labelSize: lcs?.fontSize ?? null,
        labelWeight: lcs?.fontWeight ?? null,
        labelColor: lcs?.color ?? null,
        labelMask: lcs?.maskImage ?? null,
        labelAnim: lcs?.animationName ?? null,
        values: values.map((v) => {
          const vcs = getComputedStyle(v);
          return {
            text: v.textContent?.trim() ?? "",
            size: vcs.fontSize,
            weight: vcs.fontWeight,
            color: vcs.color,
            mask: vcs.maskImage,
            anim: vcs.animationName,
          };
        }),
      };
    });

    const loadingEmpty = [...document.querySelectorAll("[data-check-loading-empty]")].map((el) => ({
      name: el.getAttribute("data-check-loading-empty"),
      height: Math.round(el.getBoundingClientRect().height * 10) / 10,
    }));

    const gitBody = document.querySelector("#git-body")!;
    const childBody = document.querySelector("#child-threads-body")!;
    const prWatchBody = document.querySelector(
      '[data-card-kind="plugin-pr-watch"] section[aria-hidden="false"]',
    )!;
    const rpivBody = document.querySelector(
      '[data-card-kind="plugin-rpiv-todo"] section[aria-hidden="false"]',
    )!;
    const inlineForm = document.querySelector('section[data-presentation="inline"]')!;
    const childToggle = document.querySelector("#child-threads-toggle")!;
    const bgToggle = document.querySelector("#bg-multi-toggle")!;
    const planGroup = document.querySelector("#plan-header-group")!;
    const bgFlatRow = document.querySelector('[data-card-kind="core-bg-1"] [data-check-flat]')!;
    const modelBadge = document.querySelector("#bg-model-badge")!;
    const pluginAssetIcon = document.querySelector("#plugin-asset-icon")!;

    return {
      cardMetrics,
      loadingEmpty,
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
      modelBadgeFontSize: getComputedStyle(modelBadge).fontSize,
      pluginAssetIconMask: getComputedStyle(pluginAssetIcon).maskImage,
    };
  }, CARD_ATTR);

  expect(report.cardMetrics.length, theme.name).toBe(12);

  // Every visible card shares identical frame, surface fill, and ::after hairline.
  const shadows = new Set(report.cardMetrics.map((m) => m.afterShadow));
  expect(shadows.size, theme.name).toBe(1);
  expect([...shadows][0], theme.name).toContain("inset");
  const cardBgs = new Set(report.cardMetrics.map((m) => m.bg));
  expect(cardBgs.size, `${theme.name} card surface fill`).toBe(1);

  // Reference colors taken from core Plan (label) and core bg-1 (value).
  const expectedLabelColor = report.cardMetrics.find((m) => m.kind === "core-plan")?.labelColor;
  const expectedValueColor = report.cardMetrics.find((m) => m.kind === "core-bg-1")?.values[0]
    ?.color;
  if (!expectedLabelColor || !expectedValueColor) {
    throw new Error(`Missing reference colors for ${theme.name}`);
  }
  expect(expectedLabelColor, theme.name).not.toBe(expectedValueColor);

  const kindsWithValues = new Set([
    "captain-ask",
    "core-bg-1",
    "core-bg-2",
    "core-context-strip",
    "plugin-rpiv-todo",
    "plugin-devin",
  ]);
  for (const m of report.cardMetrics) {
    expect(m.borderTopWidth, `${theme.name}:${m.kind}`).toBe("0px");
    expect(m.overflow, `${theme.name}:${m.kind}`).toBe("hidden");
    expect(m.radius, `${theme.name}:${m.kind}`).toBe("8px");
    expect(m.minHeight, `${theme.name}:${m.kind}`).toBe("32px");
    expect(m.restAncestorViolations, `${theme.name}:${m.kind} flat rest ancestors`).toEqual([]);
    if (m.kind !== "core-queue" && m.kind !== "captain-ask") {
      expect(m.iconLeft, `${theme.name}:${m.kind} has icon`).not.toBeNull();
    }
    if (m.iconLeft !== null) {
      expect(m.iconAnim, `${theme.name}:${m.kind} icon anim`).toBe("none");
      expect(m.iconMask, `${theme.name}:${m.kind} icon mask`).toBe("none");
      expect(m.iconLeft, `${theme.name}:${m.kind} icon left`).toBe(12);
      expect(m.iconWidth, `${theme.name}:${m.kind} icon width`).toBe(14);
      expect(m.textLeft, `${theme.name}:${m.kind} label inset`).toBe(32);
    }
    expect(m.labelText, `${theme.name}:${m.kind} has label`).not.toBeNull();
    expect(m.labelSize, `${theme.name}:${m.kind} label size`).toBe("12px");
    expect(m.labelWeight, `${theme.name}:${m.kind} label weight`).toBe("500");
    expect(m.labelColor, `${theme.name}:${m.kind} label color`).toBe(expectedLabelColor);
    // No banner label ever sweeps with .animate-shine mask or pulses.
    expect(m.labelMask, `${theme.name}:${m.kind} label mask`).toBe("none");
    expect(m.labelAnim, `${theme.name}:${m.kind} label anim`).toBe("none");

    if (kindsWithValues.has(m.kind)) {
      expect(m.values.length, `${theme.name}:${m.kind} has values`).toBeGreaterThan(0);
    }
    for (const v of m.values) {
      expect(v.size, `${theme.name}:${m.kind}:val(${v.text})`).toBe("12px");
      expect(v.weight, `${theme.name}:${m.kind}:val(${v.text})`).toBe("400");
      expect(v.color, `${theme.name}:${m.kind}:val(${v.text})`).toBe(expectedValueColor);
      expect(v.mask, `${theme.name}:${m.kind}:val(${v.text}) mask`).toBe("none");
      expect(v.anim, `${theme.name}:${m.kind}:val(${v.text}) anim`).toBe("none");
    }
  }

  // Every loading / empty plugin banner renders zero height.
  expect(report.loadingEmpty.length).toBe(5);
  for (const item of report.loadingEmpty) {
    expect(item.height, `${theme.name}:loading-empty:${item.name}`).toBe(0);
  }

  const ctxCard = report.cardMetrics.find((m) => m.kind === "core-context-strip");
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

  test("no theme or plugin stylesheet targets individual core or plugin prompt-stack cards or breaks style-contract", () => {
    const violations: string[] = [];
    for (const file of trackedPluginFiles()) {
      const raw = readFileSync(file, "utf8");
      const source = stripComments(raw, file);
      const lines = raw.split("\n");
      for (const { name, pattern } of SINGLE_CARD_PATTERNS) {
        if (
          name === "per-card plugin banner aria-label selector" &&
          PLUGIN_CARD_SELECTOR_ALLOWLIST.has(file)
        ) {
          continue;
        }
        pattern.lastIndex = 0;
        for (const match of source.matchAll(pattern)) {
          const line = source.slice(0, match.index!).split("\n").length;
          violations.push(`${file}:${line} (${name}): ${lines[line - 1]?.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);

    // Shared prompt-stack banner CSS must pass BOTH scanFile and scanSelectors
    // and must not target individual plugin cards, :has(), or bare-span rules.
    const strippedBannerCss = stripComments(
      PROMPT_STACK_BANNER_CSS,
      "prompt-stack-banner-style.css",
    );
    expect(existsSync("plugins/t3-composer/src/child-threads-banner-style.ts")).toBe(false);
    expect(scanFile("prompt-stack-banner-style.css", PROMPT_STACK_BANNER_CSS)).toEqual([]);
    expect(scanSelectors("prompt-stack-banner-style.css", PROMPT_STACK_BANNER_CSS)).toEqual([]);
    for (const { name, pattern } of SINGLE_CARD_PATTERNS) {
      pattern.lastIndex = 0;
      expect(pattern.test(strippedBannerCss), `PROMPT_STACK_BANNER_CSS: ${name}`).toBe(false);
    }
    expect(strippedBannerCss).not.toMatch(/:has\(/);
    expect(strippedBannerCss).not.toMatch(/\bspan\b/);
    expect(strippedBannerCss).not.toMatch(/div\[role="group"\]|div\[aria-label\]/);

    // Only min-height: 32px !important (overriding inline style minHeight: 35) may use !important.
    const importants = strippedBannerCss.match(/[^;\n]*!important/g) ?? [];
    expect(importants.map((line) => line.trim())).toEqual(["min-height: 32px !important"]);

    // t3-composer/app.css must not carry duplicate utility-anchored banner card rules.
    const appCss = stripComments(readFileSync("plugins/t3-composer/app.css", "utf8"), "app.css");
    expect(appCss).not.toContain("section.rounded-lg.border-border");
    expect(appCss).not.toContain("section.rounded-b-none.border-border");
  });

  test("rendered real plugin and core banners share computed frame, hairlines, insets, steady typography, lightening hover, focus rings, and touch safety across all 3 themes", async () => {
    const plugins = await renderRealPluginBanners();
    const bodyMarkup = buildBodyMarkup(plugins);
    const tailwindCss = await compileRealTailwindCss(bodyMarkup);
    const controlsCss = readFileSync("packages/ui/src/controls.css", "utf8");
    const monokaiCss = readFileSync("plugins/monokai/themes/bb-monokai.css", "utf8");
    // Load every tracked runtime plugin stylesheet (including plugins/monokai/app/*.css)
    // so any stylesheet styling bb's DOM is exercised against the rendered prompt stack.
    const pluginStylesheets = trackedPluginFiles()
      .filter(
        (file) =>
          file.endsWith(".css") && !file.includes("/themes/") && !file.includes("/scripts/"),
      )
      .sort();
    expect(pluginStylesheets).toContain("plugins/monokai/app/project-control.css");
    const pluginStylesheetsCss = pluginStylesheets
      .map((file) => `/* ${file} */\n${readFileSync(file, "utf8")}`)
      .join("\n");
    const taggerScript = await bundlePromptStackTagger();

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
      const defaultDarkCss = `
        .dark {
          --canvas: oklch(0.195 0 0);
          --ink: oklch(0.81 0 0);
          --background: var(--canvas);
          --foreground: var(--ink);
          --muted: color-mix(in oklab, var(--ink) 8%, var(--canvas));
          --muted-foreground: oklch(0.78 0 0);
          --subtle-foreground: oklch(0.68 0 0);
          --border: color-mix(in oklch, var(--ink) 19.4%, var(--canvas));
          --input: color-mix(in oklch, var(--ink) 32.6%, var(--canvas));
          --popover: var(--canvas);
          --primary: oklch(0.82 0 0);
          --primary-foreground: oklch(0.2178 0 0);
          --ring: var(--primary);
          --surface-recessed: color-mix(in oklab, var(--ink) 6%, transparent);
          --surface-raised: color-mix(in oklab, var(--ink) 2.5%, transparent);
          --surface-raised-solid: color-mix(in oklab, var(--ink) 2.5%, var(--canvas));
          --surface-selected: color-mix(in oklab, var(--primary) 12%, transparent);
          --state-hover: color-mix(in oklab, var(--ink) 13.8%, transparent);
          --state-active: color-mix(in oklab, var(--ink) 22.5%, transparent);
        }
      `;
      const themes: readonly ThemeSpec[] = [
        {
          name: "bb-monokai-dark",
          htmlClass: "dark",
          themeCss: `${defaultDarkCss}\n${monokaiCss}`,
        },
        {
          name: "default-dark",
          htmlClass: "dark",
          themeCss: defaultDarkCss,
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
              --muted: color-mix(in oklab, var(--ink) 6%, var(--canvas));
              --muted-foreground: oklch(0.44 0 0);
              --subtle-foreground: oklch(0.5 0 0);
              --border: color-mix(in oklch, var(--ink) 14%, var(--canvas));
              --input: color-mix(in oklch, var(--ink) 29.5%, var(--canvas));
              --popover: var(--canvas);
              --primary: oklch(0.27 0 0);
              --primary-foreground: oklch(1 0 0);
              --ring: var(--primary);
              --surface-recessed: color-mix(in oklab, var(--ink) 6%, transparent);
              --surface-raised: color-mix(in oklab, var(--ink) 2.5%, transparent);
              --surface-raised-solid: color-mix(in oklab, var(--ink) 2.5%, var(--canvas));
              --surface-selected: color-mix(in oklab, var(--primary) 16%, transparent);
              --state-hover: color-mix(in oklab, var(--ink) 5.9%, transparent);
              --state-active: color-mix(in oklab, var(--ink) 11.8%, transparent);
            }
          `,
        },
      ];

      for (const theme of themes) {
        await assertThemeBannerContract(
          page,
          theme,
          tailwindCss,
          controlsCss,
          pluginStylesheetsCss,
          bodyMarkup,
          taggerScript,
        );
      }

      // Touch sticky-hover safety: under @media (hover: none), a tapped/sticky-hovered
      // core toggle must stay transparent (never re-exposing core's bg-background/70 wash).
      const touchCtx = await browser.newContext({
        viewport: { width: 420, height: 900 },
        hasTouch: true,
        isMobile: true,
      });
      const touchPage = await touchCtx.newPage();
      await touchPage.setContent(
        buildBannerFixtureHtml(
          themes[0]!,
          tailwindCss,
          controlsCss,
          pluginStylesheetsCss,
          bodyMarkup,
        ),
      );
      await touchPage.addScriptTag({ content: taggerScript });
      await touchPage.evaluate(() => {
        const mount = (
          window as unknown as {
            __mountPromptStackBannerStyle: (d: Document, s: AbortSignal) => () => void;
          }
        ).__mountPromptStackBannerStyle;
        mount(document, new AbortController().signal);
      });
      await touchPage.locator("#child-threads-toggle").tap();
      const stickyBg = await touchPage.evaluate(
        () => getComputedStyle(document.querySelector("#child-threads-toggle")!).backgroundColor,
      );
      expect(stickyBg, "touch sticky-hover must not re-expose core bg-background/70").toBe(
        "rgba(0, 0, 0, 0)",
      );
      await touchCtx.close();
    } finally {
      await browser.close();
    }
  }, 30_000);
});
