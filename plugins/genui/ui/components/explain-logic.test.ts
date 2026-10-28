import { describe, expect, it } from "vitest";
import type { UiNode, Value } from "../../core/types";
import {
  addMonths,
  detailFor,
  firstWeekday,
  initialMonth,
  mermaidNodeId,
  monthRange,
  monthWeeks,
  parseDay,
  parseDetails,
  parseEvents,
  parseListRows,
  parseMonth,
  parseSteps,
  weekday,
} from "./explain-logic";

const node = (type: UiNode["type"], props: Record<string, Value> = {}): UiNode => ({ kind: "node", type, key: type, props });

describe("mermaidNodeId", () => {
  const svg = "bb-mermaid-_r_2f_-1";
  it("reads the source id of flowchart, state, class and ER nodes, hyphens included", () => {
    expect(mermaidNodeId(`${svg}-flowchart-pedals-0`, svg, false)).toBe("pedals");
    expect(mermaidNodeId(`${svg}-flowchart-my-node-12`, svg, false)).toBe("my-node");
    expect(mermaidNodeId(`${svg}-state-Idle-1`, svg, false)).toBe("Idle");
    expect(mermaidNodeId(`${svg}-classId-Animal-2`, svg, false)).toBe("Animal");
    expect(mermaidNodeId(`${svg}-entity-CUSTOMER-0`, svg, false)).toBe("CUSTOMER");
  });

  it("reads subgraph ids whole, and nothing from other diagrams' ids", () => {
    expect(mermaidNodeId(`${svg}-grp`, svg, true)).toBe("grp");
    expect(mermaidNodeId(`${svg}-node_0`, svg, false)).toBeNull();
    expect(mermaidNodeId("other-flowchart-a-0", svg, false)).toBeNull();
    expect(mermaidNodeId(`${svg}-flowchart-a`, svg, false)).toBeNull();
  });
});

describe("parseDetails and detailFor", () => {
  it("keeps text and components per node, dropping empty entries", () => {
    const callout = node("Callout");
    const details = parseDetails({ a: "**Alpha**", b: [node("Text"), callout], c: "  ", d: null });
    expect(details?.map((detail) => detail.key)).toEqual(["a", "b"]);
    expect(details?.[0]!.parts).toEqual(["**Alpha**"]);
    expect(details?.[1]!.parts).toHaveLength(2);
    expect(parseDetails(callout)).toBeNull();
    expect(parseDetails(["a"])).toBeNull();
    expect(parseDetails(undefined)).toEqual([]);
  });

  it("matches by mermaid id first, then by visible label", () => {
    const details = parseDetails({ Wheels: "round", root: "the root", Frame: "steel" })!;
    expect(detailFor(details, "root", "Bike")?.key).toBe("root");
    expect(detailFor(details, null, "  wheels ")?.key).toBe("Wheels");
    expect(detailFor(details, "x", "Frame")?.key).toBe("Frame");
    expect(detailFor(details, "x", "Seat")).toBeNull();
  });
});

describe("parseSteps", () => {
  it("takes objects and bare strings, and counts what it cannot show", () => {
    const { steps, skipped } = parseSteps([
      { title: "Set up", body: "Install it", code: "npm i x\n\n", language: "bash" },
      "Then run it",
      { title: "" },
      42,
      null,
    ]);
    expect(steps).toEqual([
      { title: "Set up", body: "Install it", code: "npm i x", language: "bash" },
      { title: "", body: "Then run it", code: null, language: null },
      { title: "", body: "42", code: null, language: null },
    ]);
    expect(skipped).toBe(2);
  });
});

describe("parseListRows", () => {
  it("reads rows, single or listed actions, and drops rows without a title", () => {
    const send = { kind: "action", type: "send", text: "Open PR 12" } as const;
    const rows = parseListRows([
      "Plain",
      { title: "PR 12", detail: "2 checks", icon: "git-pull-request", value: 3, tone: "good", action: send },
      { title: "Badge", value: node("Badge"), tone: "nope", action: [send, { kind: "action", type: "bogus" }] },
      { detail: "no title" },
      { title: "Empty value", value: " " },
    ]);
    expect(rows.map((row) => row.title)).toEqual(["Plain", "PR 12", "Badge", "Empty value"]);
    expect(rows[1]).toMatchObject({ detail: "2 checks", icon: "git-pull-request", value: 3, tone: "good", actions: [send] });
    expect(rows[2]!.tone).toBe("neutral");
    expect(rows[2]!.actions).toEqual([send]);
    expect(rows[0]!.tone).toBeNull();
    expect(rows[3]!.value).toBeNull();
  });
});

describe("calendar days", () => {
  it("parses only real calendar days, ignoring a trailing time", () => {
    expect(parseDay("2026-10-09")).toEqual({ year: 2026, month: 10, day: 9 });
    expect(parseDay("2026-10-09T23:30:00-08:00")).toEqual({ year: 2026, month: 10, day: 9 });
    expect(parseDay("2028-02-29")).not.toBeNull();
    expect(parseDay("2026-02-29")).toBeNull();
    expect(parseDay("2026-13-01")).toBeNull();
    expect(parseDay("10/09/2026")).toBeNull();
    expect(parseMonth("2026-10")).toEqual({ year: 2026, month: 10 });
    expect(parseMonth("2026-10-09")).toEqual({ year: 2026, month: 10 });
    expect(parseMonth("2026-0")).toBeNull();
  });

  it("finds weekdays without a timezone and lays a month out from any first weekday", () => {
    expect(weekday({ year: 2026, month: 10, day: 9 })).toBe(5);
    // October 2026 starts on a Thursday.
    const monday = monthWeeks({ year: 2026, month: 10 }, 1);
    expect(monday[0]).toEqual([null, null, null, 1, 2, 3, 4]);
    expect(monday.at(-1)).toEqual([26, 27, 28, 29, 30, 31, null]);
    const sunday = monthWeeks({ year: 2026, month: 10 }, 0);
    expect(sunday[0]).toEqual([null, null, null, null, 1, 2, 3]);
    expect(monthWeeks({ year: 2026, month: 2 }, 0)).toHaveLength(4);
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
  });

  it("falls back to region data where Intl has no week info (Firefox)", () => {
    const proto = Intl.Locale.prototype as unknown as Record<string, unknown>;
    const saved = ["getWeekInfo", "weekInfo"].map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const);
    for (const [name] of saved) delete proto[name];
    try {
      expect(firstWeekday("en-US")).toBe(0);
      expect(firstWeekday("ja")).toBe(0);
      expect(firstWeekday("fr")).toBe(1);
      expect(firstWeekday("ar-EG")).toBe(6);
    } finally {
      for (const [name, descriptor] of saved) if (descriptor !== undefined) Object.defineProperty(proto, name, descriptor);
    }
  });

  it("starts the week where the locale does", () => {
    expect(firstWeekday("en-US")).toBe(0);
    expect(firstWeekday("en")).toBe(0);
    expect(firstWeekday("en-GB")).toBe(1);
    expect(firstWeekday("de-DE")).toBe(1);
    expect(firstWeekday("ar-EG")).toBe(6);
    expect(firstWeekday("not a locale")).toBe(1);
  });
});

describe("calendar events", () => {
  const today = { year: 2026, month: 10, day: 9 };
  const { events, skipped } = parseEvents([
    { date: "2026-11-20", title: "Launch", tone: "good" },
    { date: "2026-09-02", title: "Kickoff" },
    { date: "2026-02-30", title: "Bad" },
    "2026-10-01",
  ]);

  it("keeps events with real dates in date order, accent by default", () => {
    expect(events.map((event) => event.key)).toEqual(["2026-09-02", "2026-11-20"]);
    expect(events[0]!.tone).toBe("info");
    expect(skipped).toBe(2);
  });

  it("spans the events' months, widened to a requested month", () => {
    expect(monthRange(events, null, today)).toEqual({ first: { year: 2026, month: 9 }, last: { year: 2026, month: 11 } });
    expect(monthRange(events, { year: 2027, month: 1 }, today).last).toEqual({ year: 2027, month: 1 });
    expect(monthRange([], null, today)).toEqual({ first: { year: 2026, month: 10 }, last: { year: 2026, month: 10 } });
  });

  it("opens on the requested month, else today's when it has events, else the next event's", () => {
    expect(initialMonth(events, { year: 2026, month: 9 }, today)).toEqual({ year: 2026, month: 9 });
    expect(initialMonth(events, null, today)).toMatchObject({ year: 2026, month: 11 });
    expect(initialMonth(events, null, { year: 2026, month: 9, day: 30 })).toMatchObject({ year: 2026, month: 9 });
    expect(initialMonth(events, null, { year: 2027, month: 3, day: 1 })).toMatchObject({ year: 2026, month: 11 });
  });
});
