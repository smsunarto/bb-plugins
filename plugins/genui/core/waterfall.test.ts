import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDataFile } from "./data";
import type { Value } from "./types";
import { ancestry, readWaterfall, requestLabel, type Waterfall } from "./waterfall";

function fixture(name: string): Value {
  const loaded = parseDataFile(name, readFileSync(new URL(`../gallery/data/${name}`, import.meta.url), "utf8"));
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.value;
}

function read(value: Value, unit: string | null = null): Waterfall {
  const result = readWaterfall(value, unit);
  if (!result.ok) throw new Error(result.error);
  return result.waterfall;
}

describe("hand-written spans", () => {
  it("nests by depth, orders depth-first and keeps start 0", () => {
    const waterfall = read([
      { name: "GET /checkout", start: 0, duration: 420 },
      { name: "auth", start: 5, duration: 30, depth: 1 },
      { name: "load cart", start: 40, end: 160, depth: 1 },
      { name: "SELECT items", start: 45, duration: 100, depth: 2, tone: "warn" },
      { name: "render", start: 170, duration: 240, depth: 1 },
    ]);
    expect(waterfall.spans.map((span) => [span.name, span.depth, span.parent, span.start, span.end])).toEqual([
      ["GET /checkout", 0, null, 0, 420],
      ["auth", 1, 0, 5, 35],
      ["load cart", 1, 0, 40, 160],
      ["SELECT items", 2, 2, 45, 145],
      ["render", 1, 0, 170, 410],
    ]);
    expect(waterfall.spans[0].children).toEqual([1, 2, 4]);
    expect(waterfall.spans[3].tone).toBe("warn");
    expect(waterfall.total).toBe(420);
    expect(ancestry(waterfall.spans, 3).map((span) => span.name)).toEqual(["GET /checkout", "load cart"]);
  });

  it("nests by parent name or id, in any order", () => {
    const waterfall = read([
      { name: "query", start: 10, duration: 5, parent: "db" },
      { name: "request", id: "r", start: 0, duration: 50 },
      { name: "db", start: 8, duration: 20, parent: "r" },
    ]);
    expect(waterfall.spans.map((span) => `${"  ".repeat(span.depth)}${span.name}`)).toEqual(["request", "  db", "    query"]);
  });

  it("takes seconds and converts to ms", () => {
    const waterfall = read([{ name: "build", start: 0, duration: 1.5 }, { name: "test", start: 1.5, end: 4 }], "s");
    expect(waterfall.spans.map((span) => [span.start, span.end])).toEqual([
      [0, 1500],
      [1500, 4000],
    ]);
  });

  it("measures epoch times from the first start", () => {
    const waterfall = read([{ name: "a", start: 1_700_000_000_000, duration: 20 }, { name: "b", start: 1_700_000_000_030, duration: 5 }]);
    expect(waterfall.spans.map((span) => span.start)).toEqual([0, 30]);
  });

  it("finds the critical path through sequential spans and inside them", () => {
    const waterfall = read([
      { name: "install", start: 0, duration: 100 },
      { name: "lint", start: 100, duration: 30 },
      { name: "build", start: 100, duration: 200 },
      { name: "compile", start: 110, duration: 150, depth: 1 },
      { name: "bundle", start: 260, duration: 40, depth: 1 },
      { name: "deploy", start: 300, duration: 50 },
    ]);
    const names = waterfall.critical.map((index) => waterfall.spans[index].name);
    expect(names).toEqual(["install", "build", "compile", "bundle", "deploy"]);
    expect(waterfall.criticalMs).toBe(350);
  });

  it("measures the critical path inside a single root", () => {
    const waterfall = read([
      { name: "request", start: 0, duration: 100 },
      { name: "auth", start: 2, duration: 10, depth: 1 },
      { name: "query", start: 15, duration: 50, depth: 1 },
      { name: "render", start: 70, duration: 25, depth: 1 },
    ]);
    expect(waterfall.critical.map((index) => waterfall.spans[index].name)).toEqual(["request", "auth", "query", "render"]);
    // The work on the path, not the root's whole 100 ms.
    expect(waterfall.criticalMs).toBe(85);
  });

  it("survives cycles, junk and an empty list", () => {
    const cyclic = read([
      { name: "a", start: 0, duration: 5, parent: "b" },
      { name: "b", start: 0, duration: 5, parent: "a" },
      "junk",
      { name: "no times" },
      { name: "backwards", start: 10, end: 5 },
    ]);
    expect(cyclic.spans).toHaveLength(2);
    expect(cyclic.ignored).toBe(3);
    expect(read([]).spans).toEqual([]);
    expect(read([]).total).toBe(0);
  });
});

describe("HAR", () => {
  it("reads a Playwright-recorded HAR with phases, sizes and the blocked request", () => {
    const waterfall = read(fixture("python-org.har"));
    expect(waterfall.source).toBe("har");
    expect(waterfall.spans).toHaveLength(29);
    const document = waterfall.spans[0];
    expect(document.name).toBe("www.python.org/");
    // Times count from the page's start, a moment before its first request.
    expect(document.start).toBeGreaterThanOrEqual(0);
    expect(document.start).toBeLessThan(10);
    expect(document.request).toMatchObject({ method: "GET", status: 200, mime: "text/html; charset=utf-8" });
    // TLS is drawn beside connect, not inside it.
    expect(document.phases.map((phase) => phase.name)).toEqual(["dns", "connect", "ssl", "wait", "receive"]);
    const phaseSum = document.phases.reduce((sum, phase) => sum + phase.duration, 0);
    expect(phaseSum).toBeCloseTo(document.end - document.start, 0);
    const blocked = waterfall.spans.find((span) => span.request?.status === -1)!;
    expect(blocked.failed).toBe(true);
    expect(blocked.request?.failure).toBe("net::ERR_BLOCKED_BY_CLIENT.Inspector");
    expect(blocked.name).toBe("script.file-downloads.outbound-links.js (analytics.python.org)");
    expect(waterfall.spans.map((item) => item.name)).toContain("supernav-python-about/");
    expect(waterfall.markers.map((marker) => marker.label)).toEqual(["DOMContentLoaded", "Load"]);
    expect(waterfall.critical.length).toBeGreaterThan(0);
    // The chain ends with the request that finished last.
    expect(waterfall.spans[waterfall.critical[waterfall.critical.length - 1]].end).toBe(waterfall.total);
  });

  it("names requests by file, as DevTools does, with the host when it isn't the page's", () => {
    expect(requestLabel("https://www.python.org/static/a.css?x=1", "www.python.org")).toBe("a.css?x=1");
    expect(requestLabel("https://www.python.org/box/about/", "www.python.org")).toBe("about/");
    expect(requestLabel("https://ajax.googleapis.com/lib.js", "www.python.org")).toBe("lib.js (ajax.googleapis.com)");
    expect(requestLabel("https://a.test/", "a.test")).toBe("a.test/");
    expect(requestLabel("not a url", null)).toBe("not a url");
  });

  it("marks 4xx/5xx responses failed and skips entries without a start", () => {
    const waterfall = read({
      log: {
        entries: [
          { startedDateTime: "2026-10-10T00:00:00.000Z", time: 50, request: { method: "GET", url: "https://a.test/" }, response: { status: 200, content: { size: 10 } }, timings: { send: 1, wait: 40, receive: 9 } },
          { startedDateTime: "2026-10-10T00:00:00.060Z", time: 20, request: { method: "POST", url: "https://a.test/api" }, response: { status: 503, content: { size: -1 } }, timings: { wait: 20 } },
          { request: { url: "https://a.test/x" } },
        ],
      },
    });
    expect(waterfall.spans.map((span) => [span.name, span.start, span.failed, span.request?.size])).toEqual([
      ["a.test/", 0, false, 10],
      ["api", 60, true, null],
    ]);
    expect(waterfall.ignored).toBe(1);
  });
});

describe("Chrome trace events", () => {
  it("reads a recorded trace into one track per thread, nested by containment", () => {
    const waterfall = read(fixture("python-org-trace.json"));
    expect(waterfall.source).toBe("trace");
    const tracks = waterfall.spans.filter((span) => span.track);
    expect(tracks[0].name).toBe("CrRendererMain");
    expect(tracks.every((track) => track.depth === 0)).toBe(true);
    // FunctionCall ran inside EventDispatch: the trace's own nesting.
    const call = waterfall.spans.find((span) => span.name === "FunctionCall")!;
    expect(waterfall.spans[call.parent!].name).toBe("EventDispatch");
    for (const span of waterfall.spans) {
      if (span.parent === null) continue;
      const parent = waterfall.spans[span.parent];
      expect(span.start).toBeGreaterThanOrEqual(parent.start);
      expect(span.end).toBeLessThanOrEqual(parent.end + 1e-6);
    }
  });

  it("converts µs to ms and pairs B/E events", () => {
    const waterfall = read([
      { name: "task", ph: "B", ts: 1000, pid: 1, tid: 1 },
      { name: "inner", ph: "X", ts: 1500, dur: 2000, pid: 1, tid: 1 },
      { name: "task", ph: "E", ts: 5000, pid: 1, tid: 1 },
      { name: "orphan end", ph: "E", ts: 6000, pid: 1, tid: 1 },
    ]);
    expect(waterfall.spans.map((span) => [span.name, span.depth, span.start, span.end])).toEqual([
      ["task", 0, 0, 4],
      ["inner", 1, 0.5, 2.5],
    ]);
    expect(waterfall.ignored).toBe(1);
  });
});

describe("unusable input", () => {
  it("says what it needs", () => {
    expect(readWaterfall("text", null)).toMatchObject({ ok: false });
    expect(readWaterfall({ nope: 1 }, null)).toMatchObject({ ok: false });
  });
});
