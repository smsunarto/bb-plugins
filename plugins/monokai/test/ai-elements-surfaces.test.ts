import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { installDom } from "@bb-plugins/testing";
import { mountTimelineTrace, readTimelineRowMeta } from "../app/timeline-trace.ts";

const themeCss = await readFile(new URL("../themes/bb-monokai.css", import.meta.url), "utf8");

// Minimal Tailwind v4 utilities present on the bb thread DOM fixtures so cascade
// resolution checks real layer/specificity interactions (mirrors hairline-cascade.test.ts).
const hostTailwind = `
@layer utilities {
  .border { border-width: 1px; }
  .border-border { border-color: var(--border); }
  .border-border-seam { border-color: var(--border-seam); }
  .rounded-md { border-radius: 6px; }
  .rounded-lg { border-radius: 8px; }
  .rounded-xl { border-radius: 12px; }
  .rounded-full { border-radius: 9999px; }
  .bg-card { background-color: var(--card); }
  .bg-background { background-color: var(--background); }
  .bg-surface-recessed { background-color: var(--surface-recessed); }
  .bg-surface-raised { background-color: var(--surface-raised); }
  .text-foreground { color: var(--foreground); }
  .text-muted-foreground { color: var(--muted-foreground); }
  .text-subtle-foreground { color: var(--subtle-foreground); }
  .text-timeline-accent { color: var(--timeline-accent); }
  .text-destructive { color: var(--destructive); }
  .text-destructive-text { color: var(--destructive-text); }
  .font-medium { font-weight: 500; }
  .opacity-40 { opacity: 0.4; }
  .opacity-70 { opacity: 0.7; }
  .opacity-75 { opacity: 0.75; }
  .size-5 { width: 20px; height: 20px; }
  .size-8 { width: 32px; height: 32px; }
  .size-3 { width: 12px; height: 12px; }
  .size-3\\.5 { width: 14px; height: 14px; }
  .gap-0\\.5 { gap: 2px; }
  .px-2 { padding-inline: 8px; }
  .py-1 { padding-block: 4px; }
  .pb-1 { padding-bottom: 4px; }
  .pt-0\\.5 { padding-top: 2px; }
  .space-y-1 > :not(:last-child) { margin-block-end: 4px; }
}
`;

interface ParsedRule {
  selector: string;
  atRules: string[];
  declarations: Map<string, string>;
  sheet: number;
  order: number;
}

interface MediaEnv {
  viewport: number;
  dppx: number;
  pointer: "fine" | "coarse";
  hover: boolean;
  hovered?: Element | null;
}

function parseCss(css: string, sheet: number): ParsedRule[] {
  const rules: ParsedRule[] = [];
  const open: string[] = [];
  let order = 0;
  for (const [, text = "", brace] of css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/([^{}]*)([{}])/g)) {
    if (brace === "{") {
      open.push(
        text
          .slice(text.lastIndexOf(";") + 1)
          .trim()
          .replace(/\s+/g, " "),
      );
      continue;
    }
    const header = open.pop() ?? "";
    if (header.startsWith("@") || open.some((a) => a.startsWith("@keyframes"))) continue;
    const declarations = new Map<string, string>();
    for (const [, prop, val] of text.matchAll(/([\w-]+)\s*:\s*([^;{}]+);/g)) {
      if (prop && val) declarations.set(prop.trim(), val.trim().replace(/\s+/g, " "));
    }
    for (const selector of splitSelectors(header)) {
      rules.push({ selector, atRules: [...open], declarations, sheet, order: order++ });
    }
  }
  return rules;
}

function splitSelectors(group: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < group.length; i++) {
    const ch = group[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(group.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(group.slice(start).trim());
  return out.filter(Boolean);
}

function matchesMedia(atRule: string, env: MediaEnv): boolean {
  if (!atRule.startsWith("@media ")) return true;
  const query = atRule.slice("@media ".length);
  return query.split(",").some((branch) =>
    branch
      .trim()
      .split(/\s+and\s+/)
      .every((term) => {
        const t = term.trim().replace(/^\(|\)$/g, "");
        const minW = /^min-width:\s*(\d+)px$/.exec(t);
        if (minW) return env.viewport >= Number(minW[1]);
        const maxW = /^max-width:\s*(\d+)px$/.exec(t);
        if (maxW) return env.viewport <= Number(maxW[1]);
        const widthGt = /^width\s*>\s*(\d+)px$/.exec(t);
        if (widthGt) return env.viewport > Number(widthGt[1]);
        const minRes = /^min-resolution:\s*([\d.]+)dppx$/.exec(t);
        if (minRes) return env.dppx >= Number(minRes[1]);
        const resLt = /^resolution\s*<\s*([\d.]+)dppx$/.exec(t);
        if (resLt) return env.dppx < Number(resLt[1]);
        if (t === "hover: hover") return env.hover;
        if (t === "pointer: fine") return env.pointer === "fine";
        if (t === "pointer: coarse") return env.pointer === "coarse";
        if (t === "prefers-reduced-motion: reduce") return false;
        return true;
      }),
  );
}

function specificity(selector: string): [number, number, number] {
  let rest = selector.replace(/::[\w-]+/g, "");
  let ids = 0;
  let classes = 0;
  let types = 0;
  for (;;) {
    const match = /:(where|is|not)\(([^()]*)\)/.exec(rest);
    if (!match) break;
    const [, fn, inner = ""] = match;
    if (fn !== "where") {
      let best: [number, number, number] = [0, 0, 0];
      for (const branch of inner.split(",")) {
        const s = specificity(branch.trim());
        if (compareSpec(s, best) > 0) best = s;
      }
      ids += best[0];
      classes += best[1];
      types += best[2];
    }
    rest = `${rest.slice(0, match.index)} ${rest.slice(match.index + match[0].length)}`;
  }
  ids += (rest.match(/#[\w\\-]+/g) ?? []).length;
  classes += (rest.match(/\[[^\]]+\]|\.(?:\\.|[\w-])+|:(?!:)[a-zA-Z-]+/g) ?? []).length;
  const cleaned = rest
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/#(?:\\.|[\w-])+/g, " ")
    .replace(/\.(?:\\.|[\w-])+/g, " ")
    .replace(/:[a-zA-Z-]+/g, " ")
    .replace(/[>+~*]/g, " ");
  types += (cleaned.match(/\b[a-zA-Z][a-zA-Z0-9-]*\b/g) ?? []).length;
  return [ids, classes, types];
}

function compareSpec(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

const allRules = [...parseCss(hostTailwind, 0), ...parseCss(themeCss, 1)];

function matchesWithHover(el: Element, selector: string, hovered: Element | null): boolean {
  if (!selector.includes(":hover")) {
    try {
      return el.matches(selector);
    } catch {
      return false;
    }
  }
  if (!hovered) return false;
  // Temporarily mark the hovered ancestor chain so :hover selectors can be tested via el.matches.
  const marked: Element[] = [];
  for (let cur: Element | null = hovered; cur; cur = cur.parentElement) {
    cur.setAttribute("data-test-hover", "");
    marked.push(cur);
  }
  try {
    return el.matches(selector.replaceAll(":hover", "[data-test-hover]"));
  } catch {
    return false;
  } finally {
    for (const cur of marked) cur.removeAttribute("data-test-hover");
  }
}

function resolvedProp(
  el: Element,
  prop: string,
  env: MediaEnv,
  pseudo?: "::before" | "::after",
): string | undefined {
  let winner: {
    value: string;
    layered: boolean;
    spec: [number, number, number];
    sheet: number;
    order: number;
  } | null = null;
  for (const rule of allRules) {
    if (!rule.declarations.has(prop)) continue;
    if (!rule.atRules.every((at) => matchesMedia(at, env))) continue;
    const hasBefore = rule.selector.endsWith("::before");
    const hasAfter = rule.selector.endsWith("::after");
    if (pseudo === "::before" && !hasBefore) continue;
    if (pseudo === "::after" && !hasAfter) continue;
    if (!pseudo && (hasBefore || hasAfter)) continue;
    const baseSelector = pseudo ? rule.selector.slice(0, -pseudo.length) : rule.selector;
    if (!matchesWithHover(el, baseSelector, env.hovered ?? null)) continue;

    const layered = rule.atRules.some((a) => a.startsWith("@layer"));
    const spec = specificity(rule.selector);
    const candidate = {
      value: rule.declarations.get(prop)!,
      layered,
      spec,
      sheet: rule.sheet,
      order: rule.order,
    };
    if (!winner) {
      winner = candidate;
      continue;
    }
    // Unlayered (false=0) always beats layered (true=1); otherwise compare specificity, then sheet/source order.
    const layerDiff = Number(winner.layered) - Number(candidate.layered);
    if (layerDiff > 0) {
      winner = candidate;
    } else if (layerDiff === 0) {
      const specDiff = compareSpec(candidate.spec, winner.spec);
      if (
        specDiff > 0 ||
        (specDiff === 0 &&
          (candidate.sheet > winner.sheet ||
            (candidate.sheet === winner.sheet && candidate.order > winner.order)))
      ) {
        winner = candidate;
      }
    }
  }
  return winner?.value;
}

const DESKTOP: MediaEnv = { viewport: 1920, dppx: 2, pointer: "fine", hover: true };
const PHONE_3X: MediaEnv = { viewport: 393, dppx: 3, pointer: "coarse", hover: false };

function attachFiberRow(el: Element, row: Record<string, unknown>): void {
  const fiber = { memoizedProps: { row }, return: null };
  (el as unknown as Record<string, unknown>).__reactFiber$test = {
    memoizedProps: {},
    return: fiber,
  };
}

async function flushObserverAndFrame(frames: FrameRequestCallback[]): Promise<void> {
  // MutationObserver callbacks run as microtasks in happy-dom / browsers.
  await Promise.resolve();
  await Promise.resolve();
  const pending = frames.splice(0, frames.length);
  for (const cb of pending) cb(16);
}

describe("bb Monokai shadcn Base UI AI Elements surfaces", () => {
  test("timeline-trace tags error rows and multi-intent static headers, handles late-mount/re-render, defers rootObserver, and stays inert when inactive", async () => {
    installDom();
    const origRaf = globalThis.requestAnimationFrame;
    const origCancelRaf = globalThis.cancelAnimationFrame;
    const origGetComputedStyle = globalThis.getComputedStyle;
    const frames: FrameRequestCallback[] = [];
    let rafId = 0;
    let computedStyleCalls = 0;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      frames.push(cb);
      return ++rafId;
    };
    globalThis.cancelAnimationFrame = () => {
      frames.length = 0;
    };
    globalThis.getComputedStyle = ((el: Element, pseudo?: string | null) => {
      computedStyleCalls++;
      return origGetComputedStyle(el, pseudo);
    }) as typeof getComputedStyle;

    try {
      document.documentElement.className = "dark";
      document.documentElement.style.setProperty("--bb-monokai-active", "1");
      document.body.innerHTML = `
        <div data-timeline-row-list="top-level" id="tl-root">
          <div data-timeline-row-id="t:user:1">
            <div data-message-column=""></div>
          </div>
          <div data-timeline-row-id="t:error:1">
            <div class="rounded-md text-muted-foreground w-full">
              <div class="group/timeline-row">
                <button type="button" aria-expanded="true" class="px-2">
                  <span><span class="inline-flex"><span>Provider error</span></span></span>
                </button>
              </div>
              <div aria-hidden="false"><div class="overflow-hidden"><div class="px-2 pb-1 pt-0.5"></div></div></div>
            </div>
          </div>
          <div data-timeline-row-id="t:error:2">
            <div class="w-full rounded-md text-muted-foreground opacity-40">
              <span><span class="inline-flex"><span>Static provider error</span></span></span>
            </div>
          </div>
          <div data-timeline-row-id="t:turn-1:turn">
            <div class="rounded-md text-muted-foreground w-full">
              <div class="group/timeline-row">
                <button type="button" aria-expanded="true" class="px-2">
                  <span><span class="inline-flex"><span>Worked for 19ms</span></span></span>
                </button>
              </div>
              <div aria-hidden="false"><div class="overflow-hidden"><div class="px-2 pb-1 pt-0.5">
                <div data-timeline-row-list="bundle">
                  <div data-timeline-row-id="t:turn-1:work-summary:c1">
                    <div class="rounded-md text-muted-foreground w-full">
                      <div class="group/timeline-row">
                        <button type="button" aria-expanded="true" class="px-0">
                          <span><span class="inline-flex"><span>Explored 1 file</span></span></span>
                        </button>
                      </div>
                      <div aria-hidden="false"><div class="overflow-hidden"><div class="px-0 pb-1 pt-0.5"></div></div></div>
                    </div>
                  </div>
                  <div data-timeline-row-id="t:command:c-err">
                    <div class="rounded-md text-muted-foreground w-full">
                      <div class="group/timeline-row">
                        <button type="button" aria-expanded="true" class="px-0">
                          <span><span class="inline-flex opacity-40"><svg data-icon-root=""></svg><span>Ran pnpm seed</span></span></span>
                        </button>
                      </div>
                      <div aria-hidden="false"><div class="overflow-hidden"><div class="px-0 pb-1 pt-0.5"></div></div></div>
                    </div>
                  </div>
                  <div data-timeline-row-id="t:tool:t-err">
                    <div class="rounded-md text-muted-foreground w-full">
                      <div class="group/timeline-row">
                        <button type="button" aria-expanded="true" class="px-0">
                          <span><span class="inline-flex opacity-40"><svg data-icon-root=""></svg><span>Ran tool seed</span></span></span>
                        </button>
                      </div>
                      <div aria-hidden="false"><div class="overflow-hidden"><div class="px-0 pb-1 pt-0.5"></div></div></div>
                    </div>
                  </div>
                  <div data-timeline-row-id="t:multi-intent:1">
                    <div class="w-full rounded-md text-muted-foreground opacity-40" id="intent-1">
                      <span><span class="inline-flex"><svg data-icon-root=""></svg><span>Read a.ts</span></span></span>
                    </div>
                    <div class="w-full rounded-md text-muted-foreground opacity-40" id="intent-2">
                      <span><span class="inline-flex"><svg data-icon-root=""></svg><span>Read b.ts</span></span></span>
                    </div>
                  </div>
                </div>
              </div></div></div>
            </div>
          </div>
          <div data-bb-plugin-root="">
            <div data-timeline-row-id="t:command:inside-plugin">
              <div class="rounded-md w-full"><div class="group/timeline-row"><button aria-expanded="true" class="px-0"></button></div></div>
            </div>
          </div>
        </div>
      `;

      const cmdErr = document.querySelector('[data-timeline-row-id="t:command:c-err"]')!;
      attachFiberRow(cmdErr, { kind: "work", workKind: "command", status: "error" });
      const toolErr = document.querySelector('[data-timeline-row-id="t:tool:t-err"]')!;
      attachFiberRow(toolErr, { kind: "work", workKind: "tool", status: "error" });
      const provErr = document.querySelector('[data-timeline-row-id="t:error:1"]')!;
      attachFiberRow(provErr, { kind: "system", systemKind: "error", status: "error" });
      const staticErr = document.querySelector('[data-timeline-row-id="t:error:2"]')!;
      attachFiberRow(staticErr, { kind: "system", systemKind: "error", status: "error" });
      const summary = document.querySelector('[data-timeline-row-id="t:turn-1:work-summary:c1"]')!;
      attachFiberRow(summary, { kind: "step-summary", status: "error" });
      const multiIntent = document.querySelector('[data-timeline-row-id="t:multi-intent:1"]')!;
      attachFiberRow(multiIntent, { kind: "work", workKind: "command", status: "error" });

      expect(readTimelineRowMeta(cmdErr)).toEqual({
        kind: "work",
        workKind: "command",
        status: "error",
        systemKind: undefined,
        operationKind: undefined,
      });

      const ac = new AbortController();
      const dispose = mountTimelineTrace({
        pluginId: "monokai",
        generation: 1,
        signal: ac.signal,
      });

      // Conversation rows and plugin roots are untouched; layout rails are pure CSS (no rail/group/reasoning tags).
      expect(document.querySelector('[data-timeline-row-id="t:user:1"]')!.attributes.length).toBe(
        1,
      );
      expect(
        document
          .querySelector('[data-timeline-row-id="t:command:inside-plugin"]')!
          .hasAttribute("data-monokai-trace-status"),
      ).toBe(false);
      expect(document.querySelectorAll("[data-monokai-trace-rail]").length).toBe(0);
      expect(document.querySelectorAll("[data-monokai-trace-group]").length).toBe(0);

      // Every error row shape receives data-monokai-trace-status="error", while
      // summaries receive data-monokai-trace-has-error.
      expect(cmdErr.getAttribute("data-monokai-trace-status")).toBe("error");
      expect(summary.hasAttribute("data-monokai-trace-status")).toBe(false);
      expect(summary.hasAttribute("data-monokai-trace-has-error")).toBe(true);
      expect(toolErr.getAttribute("data-monokai-trace-status")).toBe("error");
      expect(provErr.getAttribute("data-monokai-trace-status")).toBe("error");
      expect(staticErr.getAttribute("data-monokai-trace-status")).toBe("error");

      // Multi-intent static row tags EVERY sibling TimelineStaticRowHeader, not only the first.
      expect(multiIntent.getAttribute("data-monokai-trace-status")).toBe("error");
      expect(document.getElementById("intent-1")!.hasAttribute("data-monokai-trace-static")).toBe(
        true,
      );
      expect(document.getElementById("intent-2")!.hasAttribute("data-monokai-trace-static")).toBe(
        true,
      );

      // Late-mount via bodyObserver: appending a new failed row & multi-intent row tags them on rAF.
      const tlRoot = document.getElementById("tl-root")!;
      const lateRow = document.createElement("div");
      lateRow.setAttribute("data-timeline-row-id", "t:command:late");
      lateRow.innerHTML = `
        <div class="rounded-md text-muted-foreground w-full">
          <div class="group/timeline-row"><button type="button" aria-expanded="false" class="px-2"><span>Late cmd</span></button></div>
        </div>
      `;
      attachFiberRow(lateRow, { kind: "work", workKind: "command", status: "completed" });
      tlRoot.appendChild(lateRow);
      await flushObserverAndFrame(frames);
      expect(lateRow.hasAttribute("data-monokai-trace-status")).toBe(false);

      // Re-render: row transitions completed -> error, then error -> completed on DOM update.
      attachFiberRow(lateRow, { kind: "work", workKind: "command", status: "error" });
      lateRow.querySelector("button")!.appendChild(document.createElement("span"));
      await flushObserverAndFrame(frames);
      expect(lateRow.getAttribute("data-monokai-trace-status")).toBe("error");

      attachFiberRow(lateRow, { kind: "work", workKind: "command", status: "completed" });
      lateRow.querySelector("button")!.lastElementChild!.remove();
      await flushObserverAndFrame(frames);
      expect(lateRow.hasAttribute("data-monokai-trace-status")).toBe(false);

      // rootObserver ignores irrelevant <head> mutations (e.g. <meta>, <title>) with zero getComputedStyle calls.
      computedStyleCalls = 0;
      const metaEl = document.createElement("meta");
      metaEl.setAttribute("name", "viewport");
      document.head.appendChild(metaEl);
      await Promise.resolve();
      await Promise.resolve();
      expect(computedStyleCalls).toBe(0);
      expect(frames.length).toBe(0);

      // rootObserver defers and coalesces a burst of theme mutations into ONE rAF getComputedStyle check
      // (zero synchronous getComputedStyle inside MutationObserver) and clears all tags when inactive.
      computedStyleCalls = 0;
      document.documentElement.style.removeProperty("--bb-monokai-active");
      const styleA = document.createElement("style");
      styleA.textContent = ".x{}";
      const styleB = document.createElement("style");
      styleB.textContent = ".y{}";
      document.head.append(styleA, styleB);
      await Promise.resolve();
      await Promise.resolve();
      expect(computedStyleCalls).toBe(0);
      expect(frames.length).toBe(1);
      await flushObserverAndFrame(frames);
      expect(computedStyleCalls).toBe(1);
      expect(document.querySelectorAll("[data-monokai-trace-status]").length).toBe(0);
      expect(document.querySelectorAll("[data-monokai-trace-has-error]").length).toBe(0);
      expect(document.querySelectorAll("[data-monokai-trace-static]").length).toBe(0);

      // While inactive, appending new error rows schedules ZERO frames and leaves ZERO tags.
      const inactiveRow = document.createElement("div");
      inactiveRow.setAttribute("data-timeline-row-id", "t:command:while-inactive");
      inactiveRow.innerHTML = `
        <div class="rounded-md text-muted-foreground w-full">
          <div class="group/timeline-row"><button type="button" aria-expanded="false" class="px-2"><span>Inactive</span></button></div>
        </div>
      `;
      attachFiberRow(inactiveRow, { kind: "work", workKind: "command", status: "error" });
      tlRoot.appendChild(inactiveRow);
      await Promise.resolve();
      await Promise.resolve();
      expect(frames.length).toBe(0);
      expect(inactiveRow.hasAttribute("data-monokai-trace-status")).toBe(false);

      // Toggling Monokai back on re-scans and tags rows mounted while inactive.
      document.documentElement.style.setProperty("--bb-monokai-active", "1");
      await flushObserverAndFrame(frames);
      expect(inactiveRow.getAttribute("data-monokai-trace-status")).toBe("error");
      expect(cmdErr.getAttribute("data-monokai-trace-status")).toBe("error");

      // Disposal removes every attribute added by the content script.
      dispose();
      expect(document.querySelectorAll("[data-monokai-trace-status]").length).toBe(0);
      expect(document.querySelectorAll("[data-monokai-trace-has-error]").length).toBe(0);
      expect(document.querySelectorAll("[data-monokai-trace-static]").length).toBe(0);
    } finally {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCancelRaf;
      globalThis.getComputedStyle = origGetComputedStyle;
      document.body.innerHTML = "";
      document.head.innerHTML = "";
      document.documentElement.className = "";
      document.documentElement.style.removeProperty("--bb-monokai-active");
    }
  });

  test("resolves computed styles across all shadcn Base UI thread surfaces on desktop, phone 3x, and default theme", () => {
    installDom();
    try {
      document.documentElement.className = "dark";
      document.body.innerHTML = `
        <div data-timeline-row-list="top-level">
          <div data-timeline-row-id="t:user:1">
            <div data-message-column="">
              <div class="group/message ml-auto flex w-fit max-w-[70%] flex-col items-end">
                <div class="max-w-full rounded-xl border border-border-seam bg-surface-recessed px-4 py-2.5 text-sm leading-relaxed text-foreground">
                  <div data-markdown-preview="">
                    <div class="my-2 overflow-hidden rounded-md border border-border bg-surface-recessed" id="user-code">
                      <div class="flex items-center justify-between pl-3 pr-1.5 pt-1.5">
                        <span class="font-mono text-xs uppercase text-muted-foreground">bash</span>
                        <div class="flex items-center gap-0.5"><button type="button" aria-label="Wrap lines"></button><button type="button" aria-label="Copy code"></button></div>
                      </div>
                      <pre class="bb-code-highlight"><code>echo hi</code></pre>
                    </div>
                  </div>
                </div>
                <button type="button" id="user-chip" class="inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground">spec.md</button>
                <div class="relative w-full h-5">
                  <div class="absolute top-0 right-[13px] flex w-max items-center gap-2" id="action-outer">
                    <div class="flex max-w-full items-center gap-2 overflow-hidden" id="action-inner">
                      <button type="button" class="size-5" aria-label="Copy message" id="copy-msg-btn">
                        <svg data-icon-root="" class="size-3"><path d="M0 0"/></svg>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div data-timeline-row-id="t:assistant:1">
            <div data-message-column="" class="group/message w-full">
              <div data-markdown-preview="">
                <div class="my-2 overflow-hidden rounded-md border border-border bg-surface-recessed" id="asst-code">
                  <div class="flex items-center justify-between pl-3 pr-1.5 pt-1.5" id="asst-code-header">
                    <span class="font-mono text-xs uppercase text-muted-foreground" id="asst-code-title">typescript</span>
                    <div class="flex items-center gap-0.5" id="asst-code-actions">
                      <button type="button" id="asst-wrap-btn" aria-label="Wrap lines"><svg></svg></button>
                      <button type="button" id="asst-copy-btn" aria-label="Copy code"><svg></svg></button>
                    </div>
                  </div>
                  <pre class="bb-code-highlight"><code>const x = 1;</code></pre>
                </div>
                <div data-bb-plugin-root="">
                  <button type="button" id="plugin-chip" class="inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-xs">plugin</button>
                </div>
              </div>
            </div>
          </div>

          <div data-timeline-row-id="t:cmd:ok">
            <div class="rounded-md text-muted-foreground w-full">
              <div class="group/timeline-row">
                <button type="button" aria-expanded="true" id="ok-cmd-btn" class="px-2">
                  <span><span class="inline-flex gap-1.5 opacity-40">
                    <svg data-icon-root="" class="size-3.5"></svg>
                    <span class="text-sm leading-5">
                      <span class="shrink-0 whitespace-pre text-muted-foreground" id="ok-verb">Ran</span>
                      <span class="min-w-0 truncate whitespace-pre font-medium text-foreground opacity-70" id="ok-arg">pnpm build</span>
                      <span role="link" class="min-w-0 truncate font-medium text-timeline-accent" id="file-link">src/app.ts</span>
                      <span class="shrink-0 tabular-nums" id="ok-dur">420ms</span>
                    </span>
                  </span></span>
                  <svg data-icon-root="" class="size-3" id="ok-chevron"></svg>
                </button>
              </div>
              <div aria-hidden="false"><div class="overflow-hidden"><div class="px-2 pb-1 pt-0.5" id="ok-rail-inner">
                <div class="overflow-hidden rounded-lg border border-border bg-card" id="ok-card">
                  <div class="px-4 py-3 font-mono text-xs leading-tight text-foreground opacity-70" id="ok-out">done</div>
                </div>
              </div></div></div>
            </div>
          </div>

          <div data-timeline-row-id="t:turn-1:turn">
            <div class="rounded-md text-muted-foreground w-full">
              <div class="group/timeline-row">
                <button type="button" aria-expanded="true" id="turn-btn" class="px-2"><span>Worked for 14ms</span></button>
              </div>
              <div aria-hidden="false"><div class="overflow-hidden"><div class="px-2 pb-1 pt-0.5" id="turn-rail-inner">
                <div class="relative my-1 pl-3 pr-2 before:bg-border-seam" id="turn-nested-group">
                  <div data-timeline-row-list="bundle">
                    <div data-timeline-row-id="t:cmd:flush-open">
                      <div class="rounded-md text-muted-foreground w-full">
                        <div class="group/timeline-row">
                          <button type="button" aria-expanded="true" class="px-0"></button>
                        </div>
                        <div aria-hidden="false"><div class="overflow-hidden"><div class="px-0 pb-1 pt-0.5" id="flush-rail-inner"></div></div></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div></div></div>
            </div>
          </div>

          <div data-timeline-row-id="t:cmd:collapsed">
            <div class="rounded-md text-muted-foreground w-full">
              <div class="group/timeline-row">
                <button type="button" aria-expanded="false" class="px-0"></button>
              </div>
              <div aria-hidden="true"><div class="overflow-hidden"><div class="px-0 pb-1 pt-0.5" id="collapsed-rail-inner"></div></div></div>
            </div>
          </div>

          <div data-timeline-row-id="t:error:exp" data-monokai-trace-status="error">
            <div class="rounded-md text-muted-foreground w-full">
              <div class="group/timeline-row">
                <button type="button" aria-expanded="true" id="err-exp-btn" class="px-2">
                  <span><span class="inline-flex gap-1.5 opacity-40" id="err-exp-inner">
                    <span class="text-sm leading-5"><span class="text-muted-foreground" id="err-exp-title">Provider error</span></span>
                  </span></span>
                  <svg data-icon-root="" class="size-3" id="err-exp-chevron"></svg>
                </button>
              </div>
              <div aria-hidden="false"><div class="overflow-hidden"><div class="px-2 pb-1 pt-0.5" id="err-rail-inner">
                <div class="overflow-hidden rounded-lg border border-border bg-card" id="err-card">
                  <div class="px-4 py-3 font-mono text-xs leading-tight text-foreground opacity-70">
                    <div data-detail-scroll-area="base" class="text-muted-foreground" id="err-scroll">at seed.ts:27</div>
                  </div>
                  <pre class="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-tight text-subtle-foreground opacity-70" id="err-pre">TypeError: boom</pre>
                </div>
              </div></div></div>
            </div>
          </div>

          <div data-timeline-row-id="t:step-summary:mixed" data-monokai-trace-has-error="">
            <div class="rounded-md text-muted-foreground w-full">
              <div class="group/timeline-row">
                <button type="button" aria-expanded="true" id="mixed-sum-btn" class="px-2">
                  <span><span class="inline-flex"><span class="text-subtle-foreground">Ran 2 commands</span><span class="font-mono text-xs text-subtle-foreground" id="mixed-sum-badge">1 error</span></span></span>
                </button>
              </div>
              <div aria-hidden="false"><div class="overflow-hidden"><div class="px-2 pb-1 pt-0.5">
                <div data-timeline-row-id="t:cmd:nested-ok">
                  <div class="rounded-md text-muted-foreground w-full">
                    <div class="group/timeline-row">
                      <button type="button" aria-expanded="false" id="nested-ok-btn" class="px-0"><span>Ran bun test</span></button>
                    </div>
                  </div>
                </div>
              </div></div></div>
            </div>
          </div>

          <div data-timeline-row-id="t:static:pure">
            <div class="w-full rounded-md text-muted-foreground opacity-40" id="pure-static-wrap">
              <span class="text-muted-foreground">Fetched page</span>
            </div>
          </div>

          <div data-timeline-row-id="t:error:static" data-monokai-trace-status="error">
            <div class="w-full rounded-md text-muted-foreground opacity-40" data-monokai-trace-static="" id="err-static-wrap">
              <span class="text-muted-foreground" id="err-static-text">Connection lost</span>
            </div>
            <div class="w-full rounded-md text-muted-foreground opacity-40" data-monokai-trace-static="" id="err-static-wrap-2">
              <span class="text-muted-foreground">Second intent failed</span>
            </div>
          </div>

          <div data-timeline-row-id="t:file-edit:err" data-monokai-trace-status="error">
            <div class="rounded-md text-muted-foreground w-full">
              <div class="group/timeline-row"></div>
              <div aria-hidden="false"><div class="overflow-hidden"><div class="px-0 pb-1 pt-0.5">
                <pre id="danger-ecb" class="whitespace-pre-wrap break-words rounded-md px-2 py-1.5 font-mono text-xs leading-tight text-destructive">patch failed</pre>
              </div></div></div>
            </div>
          </div>

          <div data-timeline-row-id="t:plan:1">
            <ul class="space-y-1" data-testid="plan-steps-body" id="plan-list">
              <li class="px-2 py-1 flex min-w-0 items-center gap-2 text-xs" id="plan-active">Active step</li>
              <li class="flex min-w-0 items-center gap-2 text-xs" id="plan-next">Next step</li>
            </ul>
          </div>

          <div data-testid="thread-unread-divider" id="unread">
            <span>New</span><span class="h-px flex-1" id="unread-rule"></span>
          </div>
        </div>
        <div class="mt-4">
          <div class="rounded-md text-muted-foreground w-full">
            <div class="group/timeline-row">
              <button type="button" aria-expanded="true" id="working-btn" class="px-2 min-h-7 items-center">
                <span><span class="inline-flex gap-1.5">
                  <span class="text-sm leading-5" id="working-label"><span class="text-subtle-foreground" id="working-text">Thinking…</span></span>
                </span></span>
                <svg data-icon-root="" class="size-3" id="working-chevron"></svg>
              </button>
            </div>
            <div aria-hidden="false"><div class="overflow-hidden"><div class="px-2 pb-1 pt-0.5" id="working-rail-inner">
              <div class="max-h-80 overflow-auto whitespace-pre-wrap break-words ms-1.5 border-l border-border-seam pl-3 text-sm leading-relaxed text-muted-foreground" id="working-reasoning-detail">Streaming reasoning details</div>
            </div></div></div>
          </div>
        </div>
        <button type="button" aria-label="Scroll to latest event" id="scroll-btn" class="size-8 rounded-full border border-border bg-background"></button>
      `;

      // 1. User Bubble: shared 6% user surface (--agent-surface-background) per CONTRACT.md, borderless 24px pill.
      const bubble = document.querySelector(
        ".rounded-xl.border.border-border-seam.bg-surface-recessed",
      )!;
      expect(resolvedProp(bubble, "border-radius", DESKTOP)).toBe("24px");
      expect(resolvedProp(bubble, "border-color", DESKTOP)).toBe("transparent");
      expect(resolvedProp(bubble, "background-color", DESKTOP)).toBe(
        "var(--agent-surface-background)",
      );
      expect(resolvedProp(bubble, "padding", DESKTOP)).toBe("10px 14px");

      // 2. CodeBlock (both assistant & user messages) + non-overlapping 44x44 phone buttons.
      const asstCode = document.getElementById("asst-code")!;
      const userCode = document.getElementById("user-code")!;
      expect(resolvedProp(asstCode, "border-radius", DESKTOP)).toBe("16px");
      expect(resolvedProp(userCode, "border-radius", DESKTOP)).toBe("16px");
      expect(resolvedProp(asstCode, "border-color", DESKTOP)).toBe("var(--border)");
      const asstHeader = document.getElementById("asst-code-header")!;
      expect(resolvedProp(asstHeader, "background-color", DESKTOP)).toBe("transparent");
      expect(resolvedProp(asstHeader, "border-bottom-width", DESKTOP)).toBe("0");
      expect(
        resolvedProp(document.getElementById("asst-code-title")!, "font-family", DESKTOP),
      ).toBe("var(--font-sans)");
      const wrapBtn = document.getElementById("asst-wrap-btn")!;
      expect(resolvedProp(wrapBtn, "width", DESKTOP)).toBe("28px");
      expect(resolvedProp(wrapBtn, "width", PHONE_3X)).toBe("44px");
      expect(resolvedProp(wrapBtn, "height", PHONE_3X)).toBe("44px");
      expect(resolvedProp(wrapBtn, "inset", PHONE_3X, "::after")).toBeUndefined();
      expect(resolvedProp(document.getElementById("asst-code-actions")!, "gap", PHONE_3X)).toBe(
        "4px",
      );

      // 3. MessageActionBar: matches real nested child row without shifting outer .absolute.top-0.
      const actionOuter = document.getElementById("action-outer")!;
      const actionInner = document.getElementById("action-inner")!;
      const copyMsgBtn = document.getElementById("copy-msg-btn")!;
      expect(resolvedProp(actionOuter, "margin-left", DESKTOP)).toBeUndefined();
      expect(resolvedProp(actionOuter, "margin-right", DESKTOP)).toBeUndefined();
      expect(resolvedProp(actionInner, "margin", DESKTOP)).toBe("-3px");
      expect(resolvedProp(actionInner, "padding", DESKTOP)).toBe("3px");
      expect(resolvedProp(copyMsgBtn, "border-radius", DESKTOP, "::before")).toBe("8px");
      expect(resolvedProp(copyMsgBtn, "inset", DESKTOP, "::before")).toBe("-3px");
      expect(resolvedProp(copyMsgBtn.querySelector("svg")!, "width", DESKTOP)).toBe("14px");

      // 4. ScrollToBottomButton: 36px desktop, 44px phone, and keeps inset hairline ring at 3x DPR.
      const scrollBtn = document.getElementById("scroll-btn")!;
      expect(resolvedProp(scrollBtn, "width", DESKTOP)).toBe("36px");
      expect(resolvedProp(scrollBtn, "width", PHONE_3X)).toBe("44px");
      expect(resolvedProp(scrollBtn, "height", PHONE_3X)).toBe("44px");
      expect(resolvedProp(scrollBtn, "box-shadow", PHONE_3X)).toContain(
        "inset 0 0 0 var(--hairline-ring-width) var(--border)",
      );
      expect(resolvedProp(scrollBtn, "box-shadow", PHONE_3X)).toContain("var(--shadow-sm)");

      // 5. Trace triggers: unboxed, hover brightens verb & arg, preserves file link accent, 44px phone hit target, no transition override.
      const okBtn = document.getElementById("ok-cmd-btn")!;
      expect(resolvedProp(okBtn, "width", DESKTOP)).toBe("fit-content");
      expect(resolvedProp(okBtn, "transition", DESKTOP)).toBeUndefined();
      expect(resolvedProp(okBtn, "min-height", PHONE_3X)).toBe("44px");
      expect(
        resolvedProp(document.getElementById("ok-verb")!, "color", { ...DESKTOP, hovered: okBtn }),
      ).toBe("inherit");
      expect(
        resolvedProp(document.getElementById("ok-arg")!, "color", { ...DESKTOP, hovered: okBtn }),
      ).toBe("inherit");
      expect(resolvedProp(okBtn, "color", { ...DESKTOP, hovered: okBtn })).toBe(
        "var(--foreground)",
      );
      expect(resolvedProp(document.getElementById("file-link")!, "color", DESKTOP)).toBe(
        "var(--timeline-accent)",
      );
      expect(resolvedProp(document.getElementById("ok-dur")!, "color", DESKTOP)).toBe(
        "var(--readback-foreground)",
      );
      expect(resolvedProp(document.getElementById("ok-chevron")!, "opacity", DESKTOP)).toBe("1");
      expect(resolvedProp(document.getElementById("ok-chevron")!, "color", DESKTOP)).toBe(
        "var(--readback-foreground)",
      );

      // 6. Pure-CSS trace rails & static opacity (zero script tags needed on first paint):
      // px-2 -> 15px, px-0 -> 7px, :turn & TimelineWorkingIndicator -> 9px, collapsed -> none.
      expect(
        resolvedProp(document.getElementById("ok-rail-inner")!, "margin-inline-start", DESKTOP),
      ).toBe("15px");
      expect(
        resolvedProp(document.getElementById("flush-rail-inner")!, "margin-inline-start", DESKTOP),
      ).toBe("7px");
      expect(
        resolvedProp(document.getElementById("turn-rail-inner")!, "margin-inline-start", DESKTOP),
      ).toBe("9px");
      expect(
        resolvedProp(document.getElementById("turn-nested-group")!, "display", DESKTOP, "::before"),
      ).toBe("none");
      expect(resolvedProp(document.getElementById("pure-static-wrap")!, "opacity", DESKTOP)).toBe(
        "1",
      );
      expect(
        resolvedProp(
          document.getElementById("collapsed-rail-inner")!,
          "border-inline-start",
          DESKTOP,
        ),
      ).toBeUndefined();

      // 6b. TimelineWorkingIndicator (rendered outside [data-timeline-row-list]):
      // gets fit-content trigger, chevron, subtle-foreground, hover, 44px phone target, 9px rail, and stripped inner reasoning border.
      const workingBtn = document.getElementById("working-btn")!;
      expect(resolvedProp(workingBtn, "width", DESKTOP)).toBe("fit-content");
      expect(resolvedProp(workingBtn, "color", DESKTOP)).toBe("var(--muted-foreground)");
      expect(resolvedProp(workingBtn, "color", { ...DESKTOP, hovered: workingBtn })).toBe(
        "var(--foreground)",
      );
      expect(resolvedProp(workingBtn, "min-height", PHONE_3X)).toBe("44px");
      expect(resolvedProp(document.getElementById("working-text")!, "color", DESKTOP)).toBe(
        "inherit",
      );
      expect(resolvedProp(document.getElementById("working-label")!, "font-size", DESKTOP)).toBe(
        "var(--agent-fluid-size)",
      );
      expect(resolvedProp(document.getElementById("working-chevron")!, "opacity", DESKTOP)).toBe(
        "1",
      );
      expect(
        resolvedProp(document.getElementById("working-chevron")!, "color", {
          ...DESKTOP,
          hovered: workingBtn,
        }),
      ).toBe("var(--foreground)");
      expect(
        resolvedProp(
          document.getElementById("working-rail-inner")!,
          "margin-inline-start",
          DESKTOP,
        ),
      ).toBe("9px");
      expect(
        resolvedProp(
          document.getElementById("working-reasoning-detail")!,
          "border-inline-start-width",
          DESKTOP,
        ),
      ).toBe("0");

      // 7. Failures: expandable error, multi-intent static error, danger EventCodeBlock all crisp full-opacity red; hover stays red; mixed summaries highlight their error badge without bleeding into passing children!
      const errBtn = document.getElementById("err-exp-btn")!;
      expect(resolvedProp(errBtn, "color", DESKTOP)).toBe("var(--destructive-text)");
      expect(resolvedProp(document.getElementById("err-exp-inner")!, "opacity", DESKTOP)).toBe("1");
      expect(resolvedProp(errBtn, "color", { ...DESKTOP, hovered: errBtn })).toBe(
        "var(--destructive-text)",
      );
      expect(
        resolvedProp(document.getElementById("err-exp-chevron")!, "color", {
          ...DESKTOP,
          hovered: errBtn,
        }),
      ).toBe("var(--destructive-text)");
      expect(
        resolvedProp(
          document.getElementById("err-rail-inner")!,
          "border-inline-start-color",
          DESKTOP,
        ),
      ).toBe("var(--surface-destructive-border)");
      expect(resolvedProp(document.getElementById("err-card")!, "background-color", DESKTOP)).toBe(
        "var(--surface-destructive)",
      );
      expect(resolvedProp(document.getElementById("err-scroll")!, "color", DESKTOP)).toBe(
        "var(--destructive-text)",
      );
      expect(resolvedProp(document.getElementById("err-pre")!, "color", DESKTOP)).toBe(
        "var(--destructive-text)",
      );
      expect(resolvedProp(document.getElementById("err-pre")!, "opacity", DESKTOP)).toBe("1");
      expect(resolvedProp(document.getElementById("mixed-sum-badge")!, "color", DESKTOP)).toBe(
        "var(--destructive-text)",
      );
      expect(resolvedProp(document.getElementById("nested-ok-btn")!, "color", DESKTOP)).toBe(
        "var(--muted-foreground)",
      );
      expect(resolvedProp(document.getElementById("err-static-wrap")!, "color", DESKTOP)).toBe(
        "var(--destructive-text)",
      );
      expect(resolvedProp(document.getElementById("err-static-wrap-2")!, "color", DESKTOP)).toBe(
        "var(--destructive-text)",
      );
      expect(resolvedProp(document.getElementById("err-static-wrap")!, "opacity", DESKTOP)).toBe(
        "1",
      );
      expect(resolvedProp(document.getElementById("danger-ecb")!, "color", DESKTOP)).toBe(
        "var(--destructive-text)",
      );
      expect(
        resolvedProp(document.getElementById("danger-ecb")!, "background-color", DESKTOP),
      ).toBe("var(--surface-destructive)");

      // 8. PlanStepsWorkRowBody: resets space-y-1 margin, preserves active step padding.
      const planActive = document.getElementById("plan-active")!;
      expect(resolvedProp(planActive, "margin-block", DESKTOP)).toBe("0");
      expect(resolvedProp(planActive, "padding", DESKTOP)).toBeUndefined();
      expect(resolvedProp(planActive, "padding-inline", DESKTOP)).toBe("8px");

      // 9. Attachment touch target & plugin root isolation.
      const userChip = document.getElementById("user-chip")!;
      const pluginChip = document.getElementById("plugin-chip")!;
      expect(resolvedProp(userChip, "min-height", PHONE_3X)).toBe("44px");
      expect(resolvedProp(pluginChip, "min-height", PHONE_3X)).toBeUndefined();
      expect(resolvedProp(pluginChip, "background-color", DESKTOP)).toBeUndefined();

      // 10. Checkpoint symmetric hairline rules use registered accent.match (#88c0d044).
      expect(
        resolvedProp(document.getElementById("unread")!, "background-color", DESKTOP, "::before"),
      ).toBe("#88c0d044");
      expect(
        resolvedProp(document.getElementById("unread-rule")!, "background-color", DESKTOP),
      ).toBe("#88c0d044");

      // 11. Light / non-.dark document: zero Monokai rules apply to thread surfaces.
      document.documentElement.className = "";
      expect(resolvedProp(bubble, "border-radius", DESKTOP)).toBe("12px");
      expect(resolvedProp(asstCode, "border-radius", DESKTOP)).toBe("6px");
      expect(resolvedProp(okBtn, "width", DESKTOP)).toBeUndefined();
    } finally {
      document.body.innerHTML = "";
      document.documentElement.className = "";
    }
  });
});
