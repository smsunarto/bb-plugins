import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

type RecordValue = Record<string, unknown>;
type RailVariant = "inset" | "inset-text" | "flush" | "flush-text";
type GroupVariant = "icon" | "text";

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
  "data-monokai-trace-rail",
  "data-monokai-trace-group",
  "data-monokai-trace-reasoning",
  "data-monokai-trace-static",
] as const;

const record = (value: unknown): RecordValue | null =>
  typeof value === "object" && value !== null ? (value as RecordValue) : null;

const isMonokaiActive = (): boolean =>
  getComputedStyle(document.documentElement).getPropertyValue("--bb-monokai-active").trim() === "1";

/**
 * Reads the host timeline row model from the element's React fiber boundary,
 * without depending on component names or hook positions (matching diff-header.ts).
 */
export function readTimelineRowMeta(element: Element): TraceRowMeta | null {
  const fiberKey = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
  let fiber = fiberKey ? record((element as unknown as RecordValue)[fiberKey]) : null;
  const propsKey = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
  const props = propsKey ? record((element as unknown as RecordValue)[propsKey]) : null;
  if (props && fiber?.memoizedProps !== props) {
    const alt = record(fiber?.alternate);
    if (alt?.memoizedProps === props) fiber = alt;
  }
  for (let depth = 0; fiber && depth < 16; depth++, fiber = record(fiber.return)) {
    const row = record(record(fiber.memoizedProps)?.row);
    if (!row || typeof row.kind !== "string") continue;
    return {
      kind: row.kind,
      status: typeof row.status === "string" ? row.status : undefined,
      workKind: typeof row.workKind === "string" ? row.workKind : undefined,
      systemKind: typeof row.systemKind === "string" ? row.systemKind : undefined,
      operationKind: typeof row.operationKind === "string" ? row.operationKind : undefined,
    };
  }
  return null;
}

function isSummaryRow(meta: TraceRowMeta | null, rowId: string): boolean {
  if (meta?.kind === "bundle-summary" || meta?.kind === "step-summary") return true;
  return rowId.includes(":work-summary:") || rowId.includes(":step-summary:");
}

function ownsNestedGroupRail(meta: TraceRowMeta | null, rowId: string): boolean {
  if (meta) return meta.kind === "turn" || meta.workKind === "delegation";
  if (rowId.endsWith(":turn")) return true;
  return rowId.includes(":delegation:") && !rowId.includes(":child:");
}

function isReasoningRow(meta: TraceRowMeta | null, rowId: string): boolean {
  if (meta) return meta.operationKind === "reasoning";
  return rowId.includes(":op:reasoning:") && !isSummaryRow(meta, rowId);
}

function hasErrorFallback(rowEl: Element, headerEl: Element, rowId: string): boolean {
  if (rowId.includes(":error:") && !isSummaryRow(null, rowId)) return true;
  if (headerEl.querySelector(".text-destructive-text") !== null) return true;
  const statusSpans = headerEl.querySelectorAll(".font-mono.text-xs.text-subtle-foreground");
  for (const span of statusSpans) {
    const text = span.textContent?.trim().toLowerCase();
    if (text === "error" || text === "failed") return true;
  }
  return rowEl.querySelector(":scope > .rounded-md .text-destructive") !== null;
}

function hasLeadingIcon(headerEl: Element): boolean {
  return headerEl.querySelector("span.inline-flex > [data-icon-root]") !== null;
}

function classifyRow(rowEl: Element): Map<Element, Map<string, string>> {
  const result = new Map<Element, Map<string, string>>();
  if (rowEl.closest("[data-bb-plugin-root]") !== null) return result;
  if (rowEl.querySelector(":scope > [data-message-column]") !== null) return result;

  const rowId = rowEl.getAttribute("data-timeline-row-id") ?? "";
  const meta = readTimelineRowMeta(rowEl);
  if (meta?.kind === "conversation") return result;

  const rowAttrs = new Map<string, string>();
  const expandableBtn = rowEl.querySelector(
    ":scope > .rounded-md > .group\\/timeline-row > button[aria-expanded]",
  );
  const staticWrapper = expandableBtn ? null : rowEl.querySelector(":scope > .w-full.rounded-md");
  const headerEl = expandableBtn ?? staticWrapper;
  if (!headerEl) return result;

  const summary = isSummaryRow(meta, rowId);
  const isError =
    meta?.status === "error" ||
    meta?.systemKind === "error" ||
    (!meta && hasErrorFallback(rowEl, headerEl, rowId));

  if (isError) {
    if (summary || meta?.kind === "turn") {
      rowAttrs.set("data-monokai-trace-has-error", "");
    } else {
      rowAttrs.set("data-monokai-trace-status", "error");
    }
  }

  if (expandableBtn) {
    const leadingIcon = hasLeadingIcon(expandableBtn);
    if (ownsNestedGroupRail(meta, rowId)) {
      const groupVariant: GroupVariant = leadingIcon ? "icon" : "text";
      rowAttrs.set("data-monokai-trace-group", groupVariant);
    } else {
      const isInset = expandableBtn.classList.contains("px-2");
      const rail: RailVariant = isInset
        ? leadingIcon
          ? "inset"
          : "inset-text"
        : leadingIcon
          ? "flush"
          : "flush-text";
      rowAttrs.set("data-monokai-trace-rail", rail);
      if (isReasoningRow(meta, rowId)) rowAttrs.set("data-monokai-trace-reasoning", "");
    }
  } else if (staticWrapper) {
    result.set(staticWrapper, new Map([["data-monokai-trace-static", ""]]));
  }

  if (rowAttrs.size > 0) result.set(rowEl, rowAttrs);
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

/**
 * Tags bb timeline rows with exact `data-monokai-trace-*` attributes while
 * bb Monokai is active, replacing costly substring/tag selectors and enabling
 * error styling across every error row shape without `:has()`.
 *
 * Performs at most one whole-document query at mount (and on theme toggle);
 * subsequent DOM mutations reconcile only the affected timeline rows.
 */
export function mountTimelineTrace({ signal }: PluginContentScriptContext) {
  const rowTags = new Map<Element, Map<Element, Map<string, string>>>();
  const dirtyRows = new Set<Element>();
  let fullScanPending = true;
  let wasActive = false;
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

  const flush = () => {
    frame = null;
    if (disposed) return;
    const active = isMonokaiActive();
    if (!active) {
      if (wasActive || rowTags.size > 0) clearAll();
      wasActive = false;
      fullScanPending = false;
      return;
    }
    if (!wasActive || fullScanPending) {
      wasActive = true;
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
    let touched = false;
    for (const mutation of mutations) {
      if (recordMutation(mutation)) touched = true;
    }
    if (touched) schedule();
  });

  const rootObserver = new MutationObserver(() => {
    const active = isMonokaiActive();
    if (active !== wasActive) {
      fullScanPending = true;
      schedule();
    }
  });

  flush();
  bodyObserver.observe(document.body, { childList: true, subtree: true });
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
    bodyObserver.disconnect();
    rootObserver.disconnect();
    clearAll();
    for (const attr of TRACE_ATTRS) {
      for (const el of document.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
    }
  };

  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
