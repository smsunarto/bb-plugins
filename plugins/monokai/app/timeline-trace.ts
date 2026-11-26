import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

type RecordValue = Record<string, unknown>;

export interface TraceRowMeta {
  kind?: string;
  status?: string;
  workKind?: string;
  systemKind?: string;
  operationKind?: string;
}

const ROW_SELECTOR = "[data-timeline-row-id]";
const TRACE_ATTRS = [
  "data-monokai-trace-status",
  "data-monokai-trace-has-error",
  "data-monokai-trace-static",
] as const;

const record = (value: unknown): RecordValue | null =>
  typeof value === "object" && value !== null ? (value as RecordValue) : null;

const isMonokaiActive = (): boolean =>
  getComputedStyle(document.documentElement).getPropertyValue("--bb-monokai-active").trim() === "1";

const stringField = (obj: RecordValue, key: string): string | undefined => {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * Reads the host timeline row model from the element's React fiber boundary,
 * without depending on component names or hook positions (matching diff-header.ts).
 */
export function readTimelineRowMeta(element: Element): TraceRowMeta | null {
  const obj = element as unknown as RecordValue;
  const fiberKey = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
  let fiber = fiberKey ? record(obj[fiberKey]) : null;
  const propsKey = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
  const props = propsKey ? record(obj[propsKey]) : null;
  if (props && fiber?.memoizedProps !== props) {
    const alt = record(fiber?.alternate);
    if (alt?.memoizedProps === props) fiber = alt;
  }
  for (let depth = 0; fiber && depth < 16; depth++, fiber = record(fiber.return)) {
    const row = record(record(fiber.memoizedProps)?.row);
    const kind = row ? stringField(row, "kind") : undefined;
    if (!row || !kind) continue;
    return {
      kind,
      status: stringField(row, "status"),
      workKind: stringField(row, "workKind"),
      systemKind: stringField(row, "systemKind"),
      operationKind: stringField(row, "operationKind"),
    };
  }
  return null;
}

function isSummaryRow(meta: TraceRowMeta | null, rowId: string): boolean {
  if (meta?.kind === "bundle-summary" || meta?.kind === "step-summary") return true;
  return rowId.includes(":work-summary:") || rowId.includes(":step-summary:");
}

function isContainerSummary(meta: TraceRowMeta | null, rowId: string): boolean {
  return isSummaryRow(meta, rowId) || meta?.kind === "turn" || rowId.endsWith(":turn");
}

function headerShowsError(headerEl: Element): boolean {
  if (headerEl.querySelector(".text-destructive-text") !== null) return true;
  const statusSpans = headerEl.querySelectorAll(".font-mono.text-xs.text-subtle-foreground");
  for (const span of statusSpans) {
    const text = span.textContent?.trim().toLowerCase();
    if (text === "error" || text === "failed") return true;
  }
  return false;
}

function hasErrorFallback(rowEl: Element, headerEls: readonly Element[], rowId: string): boolean {
  if (rowId.includes(":error:") && !isSummaryRow(null, rowId)) return true;
  if (headerEls.some(headerShowsError)) return true;
  return rowEl.querySelector(":scope > .rounded-md .text-destructive") !== null;
}

function classifyRow(rowEl: Element): Map<Element, Map<string, string>> {
  const result = new Map<Element, Map<string, string>>();
  if (rowEl.closest("[data-bb-plugin-root]") !== null) return result;
  if (rowEl.querySelector(":scope > [data-message-column]") !== null) return result;

  const rowId = rowEl.getAttribute("data-timeline-row-id") ?? "";
  const meta = readTimelineRowMeta(rowEl);
  if (meta?.kind === "conversation") return result;

  const expandableBtn = rowEl.querySelector(
    ":scope > .rounded-md > .group\\/timeline-row > button[aria-expanded]",
  );
  const staticWrappers = expandableBtn
    ? []
    : Array.from(rowEl.querySelectorAll(":scope > .w-full.rounded-md"));
  const headerEls = expandableBtn ? [expandableBtn] : staticWrappers;
  if (headerEls.length === 0) return result;

  for (const wrapper of staticWrappers) {
    result.set(wrapper, new Map([["data-monokai-trace-static", ""]]));
  }

  const isError =
    meta?.status === "error" ||
    meta?.systemKind === "error" ||
    (!meta && hasErrorFallback(rowEl, headerEls, rowId));

  if (isError) {
    const attr = isContainerSummary(meta, rowId)
      ? "data-monokai-trace-has-error"
      : "data-monokai-trace-status";
    const value = attr === "data-monokai-trace-status" ? "error" : "";
    result.set(rowEl, new Map([[attr, value]]));
  }

  return result;
}

function clearElementAttrs(el: Element, attrs: Map<string, string>): void {
  for (const name of attrs.keys()) el.removeAttribute(name);
}

function applyRowTags(
  prev: Map<Element, Map<string, string>>,
  next: Map<Element, Map<string, string>>,
): void {
  for (const [el, prevAttrs] of prev) {
    const nextAttrs = next.get(el);
    if (!nextAttrs) {
      clearElementAttrs(el, prevAttrs);
      continue;
    }
    for (const name of prevAttrs.keys()) {
      if (!nextAttrs.has(name)) el.removeAttribute(name);
    }
  }
  for (const [el, nextAttrs] of next) {
    for (const [name, value] of nextAttrs) {
      if (el.getAttribute(name) !== value) el.setAttribute(name, value);
    }
  }
}

function collectRowsFromNode(node: Node, out: Set<Element>): boolean {
  if (!(node instanceof Element)) return false;
  const before = out.size;
  if (node.matches(ROW_SELECTOR)) out.add(node);
  for (const row of node.querySelectorAll(ROW_SELECTOR)) out.add(row);
  return out.size > before;
}

function collectRemovedRows(
  node: Node,
  tracked: Map<Element, unknown>,
  out: Set<Element>,
): boolean {
  if (!(node instanceof Element)) return false;
  if (tracked.has(node)) {
    out.add(node);
    return true;
  }
  let added = false;
  for (const row of node.querySelectorAll(ROW_SELECTOR)) {
    if (tracked.has(row)) {
      out.add(row);
      added = true;
    }
  }
  return added;
}

function isStylesheetNode(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  const tag = node.tagName;
  if (tag === "STYLE") return true;
  return tag === "LINK" && (node.getAttribute("rel") ?? "").toLowerCase().includes("stylesheet");
}

function isThemeMutation(mutation: MutationRecord): boolean {
  if (mutation.target === document.documentElement) {
    return mutation.type === "attributes";
  }
  if (mutation.type === "characterData") {
    return mutation.target.parentElement?.tagName === "STYLE";
  }
  if (mutation.type === "childList") {
    if (mutation.target instanceof Element && mutation.target.tagName === "STYLE") return true;
    for (const node of mutation.addedNodes) {
      if (isStylesheetNode(node)) return true;
    }
    for (const node of mutation.removedNodes) {
      if (isStylesheetNode(node)) return true;
    }
  }
  return false;
}

/**
 * Tags bb timeline rows with exact `data-monokai-trace-*` attributes ONLY for
 * state pure CSS cannot express (failed work/system error status, mixed-summary
 * error badges, and multi-intent static headers), strictly while bb Monokai is
 * active. Layout (rails, indents, static-row opacity) lives in pure CSS so
 * first paint has zero layout shift.
 */
export function mountTimelineTrace({ signal }: PluginContentScriptContext) {
  const rowTags = new Map<Element, Map<Element, Map<string, string>>>();
  const dirtyRows = new Set<Element>();
  let fullScanPending = true;
  let themeCheckPending = true;
  let wasActive = false;
  let bodyObserved = false;
  let frame: number | null = null;
  let disposed = false;

  const clearRow = (rowEl: Element) => {
    const prev = rowTags.get(rowEl);
    if (!prev) return;
    for (const [el, attrs] of prev) clearElementAttrs(el, attrs);
    rowTags.delete(rowEl);
  };

  const clearAll = () => {
    for (const prev of rowTags.values()) {
      for (const [el, attrs] of prev) clearElementAttrs(el, attrs);
    }
    rowTags.clear();
    dirtyRows.clear();
  };

  const reconcileRow = (rowEl: Element) => {
    if (!rowEl.isConnected || rowEl.closest("[data-timeline-row-list]") === null) {
      clearRow(rowEl);
      return;
    }
    const prev = rowTags.get(rowEl) ?? new Map<Element, Map<string, string>>();
    const next = classifyRow(rowEl);
    applyRowTags(prev, next);
    if (next.size > 0) rowTags.set(rowEl, next);
    else rowTags.delete(rowEl);
  };

  const schedule = () => {
    if (!disposed && frame === null) frame = requestAnimationFrame(flush);
  };

  const recordMutation = (mutation: MutationRecord): boolean => {
    if (mutation.type !== "childList") return false;
    let touched = false;
    const target = mutation.target;
    if (target instanceof Element) {
      // Ignore streamed prose updates inside message bodies.
      if (target.closest("[data-markdown-preview]") !== null) return false;
      const enclosingRow = target.closest(ROW_SELECTOR);
      if (enclosingRow !== null) {
        dirtyRows.add(enclosingRow);
        touched = true;
      }
    }
    for (const node of mutation.addedNodes) {
      if (collectRowsFromNode(node, dirtyRows)) touched = true;
    }
    for (const node of mutation.removedNodes) {
      if (collectRemovedRows(node, rowTags, dirtyRows)) touched = true;
    }
    return touched;
  };

  const bodyObserver = new MutationObserver((mutations) => {
    if (!wasActive || disposed) return;
    let touched = false;
    for (const mutation of mutations) {
      if (recordMutation(mutation)) touched = true;
    }
    if (touched) schedule();
  });

  const setBodyObserved = (shouldObserve: boolean) => {
    if (shouldObserve === bodyObserved) return;
    if (shouldObserve) {
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    } else {
      bodyObserver.disconnect();
    }
    bodyObserved = shouldObserve;
  };

  const flush = () => {
    frame = null;
    if (disposed) return;

    if (themeCheckPending || !wasActive) {
      themeCheckPending = false;
      const active = isMonokaiActive();
      if (!active) {
        setBodyObserved(false);
        if (wasActive || rowTags.size > 0) clearAll();
        else dirtyRows.clear();
        wasActive = false;
        fullScanPending = false;
        return;
      }
      if (!wasActive) {
        wasActive = true;
        fullScanPending = true;
        setBodyObserved(true);
      }
    }

    if (fullScanPending) {
      fullScanPending = false;
      dirtyRows.clear();
      const seen = new Set<Element>();
      for (const list of document.querySelectorAll("[data-timeline-row-list]")) {
        for (const row of list.querySelectorAll(ROW_SELECTOR)) {
          seen.add(row);
          reconcileRow(row);
        }
      }
      for (const row of rowTags.keys()) {
        if (!seen.has(row)) clearRow(row);
      }
      return;
    }

    for (const row of dirtyRows) reconcileRow(row);
    dirtyRows.clear();
  };

  const rootObserver = new MutationObserver((mutations) => {
    if (disposed) return;
    if (!mutations.some(isThemeMutation)) return;
    themeCheckPending = true;
    schedule();
  });

  flush();
  rootObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  rootObserver.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    setBodyObserved(false);
    rootObserver.disconnect();
    clearAll();
    for (const attr of TRACE_ATTRS) {
      for (const el of document.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
    }
  };

  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
