// Timings as Waterfall shows them: hand-written spans, a HAR (log.entries
// with their phase timings) or Chrome trace events (ph "X", µs), read into
// one tree of spans in milliseconds from the first start, with a critical
// path and axis ticks. Pure; shared by the renderer and the markdown fallback.
import { objectFields, unitInfo, type Fields } from "./perf-units";
import type { Value } from "./types";

export type SpanTone = "neutral" | "good" | "warn" | "bad" | "info";

export type PhaseName = "blocked" | "dns" | "connect" | "ssl" | "send" | "wait" | "receive";

/** HAR phases in the order a request goes through them. */
export const PHASES: readonly PhaseName[] = ["blocked", "dns", "connect", "ssl", "send", "wait", "receive"];

export const PHASE_LABEL: Record<PhaseName, string> = {
  blocked: "Queued",
  dns: "DNS",
  connect: "Connect",
  ssl: "TLS",
  send: "Send",
  wait: "Waiting (TTFB)",
  receive: "Download",
};

export interface Phase {
  readonly name: PhaseName;
  /** ms from the waterfall's origin. */
  readonly start: number;
  readonly duration: number;
}

/** What a HAR entry says about its request. */
export interface RequestInfo {
  readonly method: string;
  readonly url: string;
  /** 0 or -1 when no response came. */
  readonly status: number;
  readonly statusText: string;
  readonly mime: string | null;
  /** Decoded body size in bytes. */
  readonly size: number | null;
  /** Bytes over the wire, headers included. */
  readonly transfer: number | null;
  readonly failure: string | null;
  readonly type: string | null;
}

export interface Span {
  readonly index: number;
  readonly name: string;
  /** ms from the origin. */
  readonly start: number;
  readonly end: number;
  readonly depth: number;
  readonly parent: number | null;
  readonly children: readonly number[];
  readonly tone: SpanTone | null;
  readonly detail: string | null;
  readonly request: RequestInfo | null;
  readonly phases: readonly Phase[];
  readonly failed: boolean;
  /** A thread of a trace: a row that groups its events, drawn quiet. */
  readonly track: boolean;
}

export interface Marker {
  readonly label: string;
  /** ms from the origin. */
  readonly at: number;
}

export interface Waterfall {
  readonly source: "spans" | "har" | "trace";
  /** Depth-first: each span followed by its descendants, siblings by start. */
  readonly spans: readonly Span[];
  /** The latest end, in ms from the first start. */
  readonly total: number;
  readonly markers: readonly Marker[];
  /** Indexes of the spans on the critical path, earliest first. */
  readonly critical: readonly number[];
  /** Busy time of the critical path's top-level spans (gaps between them excluded). */
  readonly criticalMs: number;
  /** Items that had no name or no usable times, left out. */
  readonly ignored: number;
}

export type WaterfallRead = { readonly ok: true; readonly waterfall: Waterfall } | { readonly ok: false; readonly error: string };

const USAGE = "Waterfall needs [{name, start, duration}], a HAR (Load a .har) or Chrome trace events";

function numeric(value: Value | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function label(value: Value | undefined): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function spanTone(value: Value | undefined): SpanTone | null {
  return value === "neutral" || value === "good" || value === "warn" || value === "bad" || value === "info" ? value : null;
}

/** A span before the tree is built: times in ms, its parent by index. */
interface Draft {
  name: string;
  start: number;
  end: number;
  parent: number | null;
  tone: SpanTone | null;
  detail: string | null;
  request: RequestInfo | null;
  phases: Phase[];
  failed: boolean;
  track: boolean;
}

function draft(name: string, start: number, end: number, rest: Partial<Draft> = {}): Draft {
  return { name, start, end, parent: null, tone: null, detail: null, request: null, phases: [], failed: false, track: false, ...rest };
}

/**
 * Orders drafts depth-first (siblings by start, then longest first), sets each
 * span's depth and children, shifts times so the earliest start is 0 (or
 * `origin`), and finds the critical path.
 */
function buildWaterfall(source: Waterfall["source"], drafts: readonly Draft[], markers: readonly Marker[], ignored: number, origin?: number): Waterfall {
  const zero = origin ?? (drafts.length === 0 ? 0 : Math.min(...drafts.map((item) => item.start)));
  const kids = drafts.map((): number[] => []);
  const roots: number[] = [];
  drafts.forEach((item, index) => {
    const parent = item.parent;
    if (parent !== null && parent !== index && parent >= 0 && parent < drafts.length) kids[parent].push(index);
    else roots.push(index);
  });
  const byStart = (a: number, b: number) => drafts[a].start - drafts[b].start || drafts[b].end - drafts[a].end || a - b;
  // The tree as visited: a span reached twice (a parent cycle) keeps its first place.
  const order: number[] = [];
  const depthOf = new Map<number, number>();
  const parentOf = new Map<number, number | null>();
  const childrenOf = new Map<number, number[]>();
  const visit = (index: number, depth: number, parent: number | null) => {
    if (depthOf.has(index)) return;
    depthOf.set(index, depth);
    parentOf.set(index, parent);
    childrenOf.set(index, []);
    if (parent !== null) childrenOf.get(parent)!.push(index);
    order.push(index);
    for (const child of [...kids[index]].sort(byStart)) visit(child, depth + 1, index);
  };
  // Tracks keep the order they were given in; other top-level spans go by start.
  const rootOrder = (a: number, b: number) => (drafts[a].track && drafts[b].track ? a - b : byStart(a, b));
  for (const root of [...roots].sort(rootOrder)) visit(root, 0, null);
  // A parent cycle leaves spans unreached: show them at the top level.
  drafts.forEach((_, index) => visit(index, 0, null));
  const position = new Map(order.map((original, at) => [original, at]));
  const spans: Span[] = order.map((original, at) => {
    const item = drafts[original];
    const parent = parentOf.get(original) ?? null;
    return {
      index: at,
      name: item.name,
      start: item.start - zero,
      end: item.end - zero,
      depth: depthOf.get(original) ?? 0,
      parent: parent === null ? null : position.get(parent)!,
      children: childrenOf.get(original)!.map((child) => position.get(child)!),
      tone: item.tone,
      detail: item.detail,
      request: item.request,
      phases: item.phases.map((phase) => ({ ...phase, start: phase.start - zero })),
      failed: item.failed,
      track: item.track,
    };
  });
  const total = spans.reduce((latest, span) => Math.max(latest, span.end), 0);
  const { path, busy } = criticalPath(spans, total);
  return {
    source,
    spans,
    total,
    markers: markers.map((marker) => ({ ...marker, at: marker.at - zero })).filter((marker) => marker.at >= 0),
    critical: path,
    criticalMs: busy,
    ignored,
  };
}

/**
 * The chain of spans that decides when everything ends: among siblings, the
 * one that ends last, preceded by the one that ended last before it started,
 * and so on back; then the same inside each span on the chain. Without
 * dependency data this is the best reading of "what was everything waiting
 * on": a request that starts the moment another finished likely waited for it.
 */
export function criticalPath(spans: readonly Span[], total: number): { path: number[]; busy: number } {
  const slack = total * 0.002;
  const chain = (candidates: readonly number[]): number[] => {
    if (candidates.length === 0) return [];
    let last = candidates[0];
    for (const index of candidates) if (spans[index].end > spans[last].end) last = index;
    const path = [last];
    for (let current = last; ; ) {
      let previous: number | null = null;
      for (const index of candidates) {
        if (path.includes(index) || spans[index].end > spans[current].start + slack) continue;
        if (previous === null || spans[index].end > spans[previous].end) previous = index;
      }
      if (previous === null) break;
      path.unshift(previous);
      current = previous;
    }
    return path;
  };
  const roots = spans.filter((span) => span.parent === null).map((span) => span.index);
  const top = chain(roots);
  const path: number[] = [];
  const descend = (index: number) => {
    path.push(index);
    for (const child of chain(spans[index].children)) descend(child);
  };
  for (const index of top) descend(index);
  // Busy time of the first level where the chain has more than one span (a
  // single root or thread spans everything; the work inside it is the path),
  // gaps between them excluded and overlaps counted once.
  let level = top;
  while (level.length === 1 && spans[level[0]].children.length > 0) level = chain(spans[level[0]].children);
  let busy = 0;
  let reached = Number.NEGATIVE_INFINITY;
  for (const index of level) {
    const { start, end } = spans[index];
    busy += Math.max(0, end - Math.max(start, reached));
    reached = Math.max(reached, end);
  }
  return { path, busy };
}

// ---------------------------------------------------------------------------
// Hand-written spans

function readSpanList(items: readonly Value[], unit: string | null): Waterfall {
  const info = unitInfo(unit ?? "ms");
  const scale = info.kind === "time" ? info.factor * 1000 : 1;
  const drafts: Draft[] = [];
  const ids = new Map<string, number>();
  const parentRefs: (string | null)[] = [];
  const depths: (number | null)[] = [];
  let ignored = 0;
  const add = (item: Value, parent: number | null) => {
    const fields = objectFields(item);
    if (fields === null) {
      ignored++;
      return;
    }
    const name = label(fields.name ?? fields.label ?? fields.title);
    const start = numeric(fields.start ?? fields.startTime ?? fields.offset);
    const duration = numeric(fields.duration ?? fields.dur ?? fields.time);
    const endValue = numeric(fields.end ?? fields.endTime);
    const end = duration !== null ? (start ?? 0) + duration : endValue;
    if (name === "" || start === null || end === null || end < start) {
      ignored++;
      return;
    }
    const index = drafts.length;
    drafts.push(
      draft(name, start * scale, end * scale, {
        parent,
        tone: spanTone(fields.tone),
        detail: label(fields.detail ?? fields.note) || null,
        failed: fields.tone === "bad" || fields.error === true || fields.status === "error",
      }),
    );
    const id = label(fields.id);
    if (id !== "" && !ids.has(id)) ids.set(id, index);
    if (!ids.has(name)) ids.set(name, index);
    parentRefs.push(parent === null ? label(fields.parent) || null : null);
    depths.push(parent === null ? numeric(fields.depth) : null);
    if (Array.isArray(fields.children)) for (const child of fields.children) add(child, index);
  };
  for (const item of items) add(item, null);
  // `parent` names another span (its id or name); `depth` nests under the nearest shallower span before it.
  const stack: { index: number; depth: number }[] = [];
  const anyDepth = depths.some((depth) => depth !== null);
  drafts.forEach((item, index) => {
    const ref = parentRefs[index];
    // Where some spans give a depth, a top-level span without one is at depth 0.
    const depth = depths[index] ?? (anyDepth && ref === null && item.parent === null ? 0 : null);
    if (ref !== null) {
      const parent = ids.get(ref);
      if (parent !== undefined && parent !== index) item.parent = parent;
    } else if (depth !== null && depth > 0 && item.parent === null) {
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
      if (stack.length > 0) item.parent = stack[stack.length - 1].index;
    }
    if (depth !== null) {
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
      stack.push({ index, depth });
    }
  });
  // Absolute times (epoch ms): measure from the first start. Relative ones keep their origin at 0.
  const first = drafts.length === 0 ? 0 : Math.min(...drafts.map((item) => item.start));
  const last = drafts.length === 0 ? 0 : Math.max(...drafts.map((item) => item.end));
  const origin = first < 0 || first > 10 * (last - first) ? first : 0;
  return buildWaterfall("spans", drafts, [], ignored, origin);
}

// ---------------------------------------------------------------------------
// HAR

/**
 * A request's row name, as DevTools' Name column: the last path segment and
 * the query, the host for a site root, and "(host)" after it for another host
 * than the page's.
 */
export function requestLabel(url: string, pageHost: string | null): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "data:") return `data:${parsed.pathname.split(/[;,]/)[0]}`;
    const segments = parsed.pathname.split("/");
    const last = segments.pop() || (segments.length > 1 ? `${segments.pop()}/` : "");
    if (last === "") return `${parsed.host}/${parsed.search}`;
    const name = `${last}${parsed.search}`;
    return parsed.host === pageHost ? name : `${name} (${parsed.host})`;
  } catch {
    return url;
  }
}

function readHar(log: Fields): Waterfall {
  const entries = Array.isArray(log.entries) ? log.entries : [];
  const drafts: Draft[] = [];
  let ignored = 0;
  let pageHost: string | null = null;
  const timed: { fields: Fields; started: number }[] = [];
  for (const entry of entries) {
    const fields = objectFields(entry);
    const started = fields === null ? Number.NaN : Date.parse(label(fields.startedDateTime));
    if (fields === null || Number.isNaN(started)) {
      ignored++;
      continue;
    }
    timed.push({ fields, started });
  }
  timed.sort((a, b) => a.started - b.started);
  for (const { fields, started } of timed) {
    const request = objectFields(fields.request) ?? {};
    const response = objectFields(fields.response) ?? {};
    const content = objectFields(response.content) ?? {};
    const timings = objectFields(fields.timings) ?? {};
    const url = label(request.url);
    if (pageHost === null) {
      try {
        pageHost = new URL(url).host;
      } catch {
        pageHost = null;
      }
    }
    const status = numeric(response.status) ?? 0;
    const failure = label(response._failureText ?? response._error) || null;
    const raw = (name: PhaseName): number => {
      const value = numeric(timings[name]);
      return value === null || value < 0 ? 0 : value;
    };
    // The HAR spec counts TLS inside connect (Chrome's export does); Playwright
    // records them apart. Whichever reading adds up to the entry's time wins.
    const time = numeric(fields.time);
    const sum = PHASES.reduce((total, name) => total + raw(name), 0);
    const ssl = raw("ssl");
    const sslInConnect = time !== null && ssl > 0 && Math.abs(sum - ssl - time) < Math.abs(sum - time);
    const phaseMs = (name: PhaseName): number => (name === "connect" && sslInConnect ? Math.max(0, raw(name) - ssl) : raw(name));
    const phases: Phase[] = [];
    let at = started;
    for (const name of PHASES) {
      const duration = phaseMs(name);
      if (duration > 0) phases.push({ name, start: at, duration });
      at += duration;
    }
    const duration = time !== null && time >= 0 ? time : at - started;
    const size = numeric(content.size);
    const transfer = numeric(response._transferSize);
    const failed = status <= 0 || status >= 400 || failure !== null;
    drafts.push(
      draft(requestLabel(url, pageHost), started, started + duration, {
        request: {
          method: label(request.method) || "GET",
          url,
          status,
          statusText: label(response.statusText),
          mime: label(content.mimeType) || null,
          size: size !== null && size >= 0 ? size : null,
          transfer: transfer !== null && transfer >= 0 ? transfer : null,
          failure,
          type: label(fields._resourceType) || null,
        },
        phases,
        failed,
        tone: failed ? "bad" : null,
      }),
    );
  }
  // The first page is the one the times count from and whose load events are marked.
  const page = Array.isArray(log.pages) ? objectFields(log.pages[0]) : null;
  const pageStart = page === null ? Number.NaN : Date.parse(label(page.startedDateTime));
  const origin = Number.isNaN(pageStart) ? undefined : Math.min(pageStart, ...drafts.map((item) => item.start));
  const markers: Marker[] = [];
  const pageTimings = objectFields(page?.pageTimings);
  if (!Number.isNaN(pageStart) && pageTimings !== null) {
    const contentLoad = numeric(pageTimings.onContentLoad);
    const load = numeric(pageTimings.onLoad);
    if (contentLoad !== null && contentLoad >= 0) markers.push({ label: "DOMContentLoaded", at: pageStart + contentLoad });
    if (load !== null && load >= 0) markers.push({ label: "Load", at: pageStart + load });
  }
  return buildWaterfall("har", drafts, markers, ignored, origin);
}

// ---------------------------------------------------------------------------
// Chrome trace events

/** Chrome's trace events: complete events (ph X, ts and dur in µs) and B/E pairs, one track per thread. */
function readTrace(events: readonly Value[]): Waterfall {
  const threadNames = new Map<string, string>();
  const tracks = new Map<string, Draft[]>();
  const open = new Map<string, { name: string; ts: number; fields: Fields }[]>();
  let ignored = 0;
  const push = (key: string, item: Draft) => {
    const list = tracks.get(key);
    if (list === undefined) tracks.set(key, [item]);
    else list.push(item);
  };
  const detailOf = (fields: Fields): string | null => {
    const args = objectFields(fields.args);
    const data = objectFields(args?.data);
    // Chrome's own categories ("devtools.timeline", "disabled-by-default-…") say nothing to a reader; a trace's own ("db", "http") do.
    const category = label(fields.cat);
    const parts = [/devtools\.timeline|disabled-by-default/.test(category) ? "" : category];
    if (data !== null) {
      const fn = label(data.functionName);
      const url = label(data.url);
      if (fn !== "") parts.push(fn);
      if (url !== "") parts.push(url);
    }
    const text = parts.filter((part) => part !== "").join(" · ");
    return text === "" ? null : text;
  };
  for (const event of events) {
    const fields = objectFields(event);
    if (fields === null) {
      ignored++;
      continue;
    }
    const key = `${label(fields.pid)}:${label(fields.tid)}`;
    const ph = label(fields.ph);
    const ts = numeric(fields.ts);
    if (ph === "M") {
      const args = objectFields(fields.args);
      if (fields.name === "thread_name" && args !== null) threadNames.set(key, label(args.name));
      continue;
    }
    if (ts === null) {
      if (ph === "X" || ph === "B" || ph === "E") ignored++;
      continue;
    }
    const name = label(fields.name) || "(unnamed)";
    if (ph === "X") {
      const dur = numeric(fields.dur) ?? 0;
      push(key, draft(name, ts / 1000, (ts + Math.max(0, dur)) / 1000, { detail: detailOf(fields) }));
    } else if (ph === "B") {
      const stack = open.get(key) ?? [];
      stack.push({ name, ts, fields });
      open.set(key, stack);
    } else if (ph === "E") {
      const begun = open.get(key)?.pop();
      if (begun === undefined) ignored++;
      else push(key, draft(begun.name, begun.ts / 1000, ts / 1000, { detail: detailOf(begun.fields) }));
    }
  }
  for (const stack of open.values()) ignored += stack.length;
  // The main thread first, then the busiest; a single thread needs no track row.
  const main = (key: string) => (/^(?:CrRendererMain|CrBrowserMain|main|main thread)$/i.test(threadNames.get(key) ?? "") ? 0 : 1);
  const ordered = [...tracks.entries()].sort((a, b) => main(a[0]) - main(b[0]) || b[1].length - a[1].length);
  const drafts: Draft[] = [];
  // Pool threads share a name: the second and later get "#2", "#3".
  const seen = new Map<string, number>();
  for (const [key, list] of ordered) {
    list.sort((a, b) => a.start - b.start || b.end - a.end);
    let trackIndex: number | null = null;
    if (ordered.length > 1) {
      trackIndex = drafts.length;
      const start = Math.min(...list.map((item) => item.start));
      const end = Math.max(...list.map((item) => item.end));
      const base = threadNames.get(key) || `Thread ${key}`;
      const nth = (seen.get(base) ?? 0) + 1;
      seen.set(base, nth);
      drafts.push(draft(nth === 1 ? base : `${base} #${nth}`, start, end, { track: true, detail: `${list.length} ${list.length === 1 ? "event" : "events"}` }));
    }
    // Nest by containment: an event inside the one still open is its child.
    const stack: number[] = [];
    for (const item of list) {
      while (stack.length > 0 && drafts[stack[stack.length - 1]].end <= item.start) stack.pop();
      while (stack.length > 0 && item.end > drafts[stack[stack.length - 1]].end + 1e-9) stack.pop();
      item.parent = stack.length > 0 ? stack[stack.length - 1] : trackIndex;
      stack.push(drafts.length);
      drafts.push(item);
    }
  }
  return buildWaterfall("trace", drafts, [], ignored);
}

/** Reads any input Waterfall takes; `unit` (ms default) applies to hand-written spans. */
export function readWaterfall(value: Value | undefined, unit: string | null): WaterfallRead {
  if (value === undefined || value === null) return { ok: false, error: USAGE };
  let waterfall: Waterfall | null = null;
  const fields = objectFields(value);
  if (fields !== null) {
    const log = objectFields(fields.log);
    const entries = fields.entries;
    if (log !== null && Array.isArray(log.entries)) waterfall = readHar(log);
    else if (Array.isArray(entries) && entries.some((entry) => objectFields(entry)?.startedDateTime !== undefined)) waterfall = readHar(fields);
    else if (Array.isArray(fields.traceEvents)) waterfall = readTrace(fields.traceEvents);
    else if (Array.isArray(fields.spans)) waterfall = readSpanList(fields.spans, unit);
  } else if (Array.isArray(value)) {
    const trace = value.some((item) => {
      const event = objectFields(item);
      return event !== null && typeof event.ph === "string" && event.ts !== undefined;
    });
    waterfall = trace ? readTrace(value) : readSpanList(value, unit);
  }
  if (waterfall === null) return { ok: false, error: USAGE };
  return { ok: true, waterfall };
}

/** The ancestors of a span, root first. */
export function ancestry(spans: readonly Span[], index: number): Span[] {
  const chain: Span[] = [];
  for (let parent = spans[index]?.parent ?? null; parent !== null && chain.length < spans.length; parent = spans[parent].parent) chain.unshift(spans[parent]);
  return chain;
}
