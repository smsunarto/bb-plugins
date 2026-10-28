import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  boardStatus,
  cardLate,
  firstColumn,
  formatDay,
  formatRange,
  fullDay,
  healthSummary,
  initials,
  isoDay,
  localDay,
  parseDay,
  priority,
  readBoard,
  readRoadmap,
  readStatus,
  relativeDue,
  roadmapScale,
} from "./tracking";
import type { Value } from "./types";

const fixture = (name: string): Value => JSON.parse(readFileSync(new URL(`../gallery/data/${name}`, import.meta.url), "utf8")) as Value;
/** Every date test runs on this day, never on the clock. */
const TODAY = parseDay("2026-10-10")!;

function ok<T>(read: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!read.ok) throw new Error(read.error);
  return read.value;
}

describe("days", () => {
  it("parses yyyy-mm-dd and ISO date-times by their date part", () => {
    expect(isoDay(parseDay("2026-10-10")!)).toBe("2026-10-10");
    expect(parseDay("2026-10-10T23:59:00-07:00")).toBe(TODAY);
    expect(parseDay("2026-2-3")).toBe(parseDay("2026-02-03"));
  });

  it("refuses impossible and non-date values", () => {
    expect(parseDay("2026-02-30")).toBeNull();
    expect(parseDay("10/10/2026")).toBeNull();
    expect(parseDay("")).toBeNull();
    expect(parseDay(20261010)).toBeNull();
    expect(parseDay(undefined)).toBeNull();
  });

  it("reads today from the wall clock's calendar day", () => {
    expect(localDay(new Date(2026, 9, 10, 23, 30))).toBe(TODAY);
    expect(localDay(new Date(2026, 9, 10, 0, 5))).toBe(TODAY);
  });

  it("formats days, adding the year only when it isn't this year's", () => {
    expect(formatDay(TODAY, TODAY)).toBe("Oct 10");
    expect(formatDay(parseDay("2027-01-04")!, TODAY)).toBe("Jan 4, 2027");
    expect(formatRange(TODAY, TODAY + 10, TODAY)).toBe("Oct 10 – Oct 20");
    expect(formatRange(TODAY, TODAY, TODAY)).toBe("Oct 10");
    expect(fullDay(TODAY)).toBe("Sat, Oct 10, 2026");
  });

  it("says due dates relative to today", () => {
    expect(relativeDue(TODAY, TODAY)).toEqual({ text: "due today", late: false });
    expect(relativeDue(TODAY + 1, TODAY)).toEqual({ text: "due tomorrow", late: false });
    expect(relativeDue(TODAY + 5, TODAY).text).toBe("in 5 days");
    expect(relativeDue(TODAY + 21, TODAY).text).toBe("in 3 weeks");
    expect(relativeDue(TODAY + 90, TODAY).text).toBe("in 3 months");
    expect(relativeDue(TODAY - 1, TODAY)).toEqual({ text: "1 day late", late: true });
    expect(relativeDue(TODAY - 3, TODAY)).toEqual({ text: "3 days late", late: true });
    expect(relativeDue(TODAY - 15, TODAY).text).toBe("2 weeks late");
  });

  it("crosses month and year ends without drifting", () => {
    expect(relativeDue(parseDay("2027-01-01")!, parseDay("2026-12-31")!).text).toBe("due tomorrow");
    expect(relativeDue(parseDay("2028-03-01")!, parseDay("2028-02-28")!).text).toBe("in 2 days");
  });
});

describe("initials", () => {
  it("takes the first and last word, or the first letter of a login", () => {
    expect(initials("Ana Lima")).toBe("AL");
    expect(initials("Luke Sandberg")).toBe("LS");
    expect(initials("lukesandberg")).toBe("L");
    expect(initials("ana.lima@example.com")).toBe("AL");
    expect(initials("Élodie van der Berg")).toBe("ÉB");
    expect(initials("—")).toBe("?");
  });
});

describe("readBoard", () => {
  it("reads bb tasks list --json: workflow order, keys, priorities, sub-tasks", () => {
    const board = ok(readBoard(fixture("bb-tasks-orb.json")));
    expect(board.source).toBe("tasks");
    expect(board.columns.map((column) => [column.label, column.cards.length])).toEqual([
      ["Backlog", 13],
      ["In progress", 6],
      ["Done", 4],
    ]);
    expect(board.total).toBe(23);
    expect(board.truncated).toBe(false);
    const card = board.columns[0]!.cards.find((item) => item.key === "ORB-9")!;
    expect(card.priority).toBe("high");
    expect(card.parent).toMatch(/^ORB-\d+$/);
    expect(card.detail).not.toBeNull();
    expect(firstColumn(board)).toBe(1);
  });

  it("reads gh issue list --json: open and closed, #numbers, label colours", () => {
    const board = ok(readBoard(fixture("gh-issues-nextjs.json")));
    expect(board.source).toBe("issues");
    expect(board.columns.map((column) => column.label)).toEqual(["Open", "Closed"]);
    const first = board.columns[0]!.cards[0]!;
    expect(first.key).toBe("#99954");
    expect(first.url).toBe("https://github.com/vercel/next.js/issues/99954");
    expect(first.labels[0]).toEqual({ name: "Performance", color: "#5101e2" });
    expect(first.updated).toBe(Date.parse("2026-10-09T19:50:06Z"));
  });

  it("reads gh pr list --json: drafts apart, merged, authors as owners when unassigned", () => {
    const board = ok(readBoard(fixture("gh-prs-nextjs.json")));
    expect(board.source).toBe("pulls");
    expect(board.columns.map((column) => column.status)).toEqual(["draft", "open", "merged"]);
    expect(board.columns[0]!.cards[0]!.owners).toEqual(["Luke Sandberg"]);
    expect(board.columns.every((column) => column.cards.every((card) => card.closed === (column.status === "merged")))).toBe(true);
  });

  it("reads a written list: aliases, unknown statuses after the workflow, no status last", () => {
    const board = ok(
      readBoard([
        { title: "Ship it", status: "Done" },
        { title: "QA pass", status: "QA" },
        { title: "Write docs", status: "in-progress", owner: "Ana Lima", priority: "P1", labels: ["docs"] },
        { title: "Spike" },
        "Bare title",
        { title: "Review API", status: "review", assignee: { login: "octocat" } },
        { status: "todo" },
      ]),
    );
    expect(board.columns.map((column) => column.label)).toEqual(["In progress", "In review", "Done", "QA", "No status"]);
    expect(board.skipped).toBe(1);
    const docs = board.columns[0]!.cards[0]!;
    expect(docs).toMatchObject({ owners: ["Ana Lima"], priority: "high", labels: [{ name: "docs", color: null }] });
    expect(board.columns[1]!.cards[0]!.owners).toEqual(["octocat"]);
  });

  it("shows the columns asked for, in that order, empty ones included, and counts the rest", () => {
    const board = ok(
      readBoard(
        [
          { title: "A", status: "todo" },
          { title: "B", status: "done" },
          { title: "C", status: "blocked" },
        ],
        ["Done", "In progress", "Todo"],
      ),
    );
    expect(board.columns.map((column) => [column.label, column.cards.length])).toEqual([
      ["Done", 1],
      ["In progress", 0],
      ["Todo", 1],
    ]);
    expect(board.hidden).toBe(1);
  });

  it("keeps duplicate keys apart and marks late cards against the injected today", () => {
    const board = ok(
      readBoard([
        { id: "X-1", title: "One", status: "todo", due: "2026-10-09" },
        { id: "X-1", title: "Two", status: "done", due: "2026-10-01" },
        { id: "X-2", title: "Three", status: "todo", due: "2026-10-10" },
      ]),
    );
    const cards = board.columns.flatMap((column) => column.cards);
    expect(cards.map((card) => card.id)).toEqual(["X-1", "X-2", "X-1~1"]);
    expect(cards.map((card) => cardLate(card, TODAY))).toEqual([true, false, false]);
  });

  it("says what it needs for unusable input, and reads empty input as an empty board", () => {
    expect(readBoard(undefined).ok).toBe(false);
    expect(readBoard("nope").ok).toBe(false);
    expect(ok(readBoard([])).columns).toEqual([]);
    expect(ok(readBoard({ tasks: [], nextCursor: "abc" })).truncated).toBe(true);
  });

  it("normalises statuses and priorities", () => {
    expect(boardStatus("In Progress")).toBe("in_progress");
    expect(boardStatus("cancelled")).toBe("canceled");
    expect(boardStatus("Won't fix")).toBe("canceled");
    expect(boardStatus("   ")).toBe("no_status");
    expect(boardStatus("Ready for QA")).toBe("ready_for_qa");
    expect(priority(1)).toBe("urgent");
    expect(priority(0)).toBe("none");
    expect(priority("Critical")).toBe("urgent");
    expect(priority("whenever")).toBeNull();
  });
});

describe("readRoadmap", () => {
  const plan: Value = [
    { title: "Design", start: "2026-09-21", end: "2026-10-02", lane: "Product", status: "done" },
    { title: "Build", start: "2026-10-01", days: 20, lane: "Engineering", after: "Design", progress: 40 },
    { title: "Beta", milestone: "2026-10-23", lane: "Engineering" },
    { title: "Docs", start: "2026-09-28", end: "2026-10-08", lane: "Product", progress: 0.5 },
    { title: "Launch", start: "2026-10-28", end: "2026-10-28", milestone: true, after: "Beta" },
  ];

  it("lays out lanes in first-seen order with inclusive end days", () => {
    const roadmap = ok(readRoadmap(plan, TODAY));
    expect(roadmap.lanes.map((lane) => [lane.name, lane.items.map((item) => item.title)])).toEqual([
      ["Product", ["Design", "Docs"]],
      ["Engineering", ["Build", "Beta"]],
      ["", ["Launch"]],
    ]);
    const build = roadmap.items[1]!;
    expect(isoDay(build.end)).toBe("2026-10-20");
  });

  it("derives status, progress, lateness and dependency overlap", () => {
    const [design, build, beta, docs, launch] = ok(readRoadmap(plan, TODAY)).items;
    expect(design).toMatchObject({ status: "done", progress: 100, late: false });
    expect(build).toMatchObject({ status: "active", progress: 40, afterIndex: 0, overlap: true, late: false });
    expect(beta).toMatchObject({ milestone: true, status: "planned", progress: null });
    expect(docs).toMatchObject({ status: "planned", progress: 50, late: true });
    expect(launch).toMatchObject({ milestone: true, afterIndex: 2, overlap: false });
  });

  it("picks the axis scale from the span and aligns the axis to it", () => {
    expect(roadmapScale(14)).toBe("days");
    expect(roadmapScale(60)).toBe("weeks");
    expect(roadmapScale(365)).toBe("months");
    const weeks = ok(readRoadmap(plan, TODAY));
    expect(weeks.scale).toBe("weeks");
    expect(fullDay(weeks.from)).toMatch(/^Mon, Sep 21/);
    expect(weeks.ticks[0]!.label).toBe("Sep 21");
    expect(weeks.ticks.find((tick) => tick.major)?.label).toBe("Oct 5");
    const months = ok(
      readRoadmap(
        [
          { title: "H1", start: "2026-11-15", end: "2027-03-01" },
          { title: "H2", start: "2027-03-02", end: "2027-08-30" },
        ],
        TODAY,
      ),
    );
    expect(months.scale).toBe("months");
    expect(isoDay(months.from)).toBe("2026-10-01");
    expect(months.ticks.map((tick) => tick.label).slice(0, 4)).toEqual(["Oct 2026", "Nov", "Dec", "Jan 2027"]);
    const days = ok(readRoadmap([{ title: "Sprint", start: "2026-10-12", end: "2026-10-23" }], TODAY));
    expect(days.scale).toBe("days");
    expect(days.from).toBeLessThanOrEqual(TODAY);
  });

  it("leaves far-away today off the axis", () => {
    const roadmap = ok(readRoadmap([{ title: "Next year", start: "2027-06-01", end: "2027-06-30" }], TODAY));
    expect(roadmap.from).toBeGreaterThan(TODAY);
  });

  it("skips items without usable dates and says why", () => {
    const roadmap = ok(
      readRoadmap(
        [
          { title: "Fine", start: "2026-10-01", end: "2026-10-05" },
          { title: "Backwards", start: "2026-10-05", end: "2026-10-01" },
          { title: "Undated" },
          { start: "2026-10-01", end: "2026-10-02" },
        ],
        TODAY,
      ),
    );
    expect(roadmap.items.map((item) => item.title)).toEqual(["Fine"]);
    expect(roadmap.skipped.map((skip) => skip.title)).toEqual(["Backwards", "Undated", "Item 4"]);
    expect(readRoadmap([{ title: "Undated" }], TODAY)).toEqual({ ok: false, error: "No roadmap item has usable dates: Undated has no start date (yyyy-mm-dd)" });
    expect(ok(readRoadmap([], TODAY)).items).toEqual([]);
    expect(readRoadmap({ title: "x" }, TODAY).ok).toBe(false);
  });
});

describe("readStatus", () => {
  const items: Value = [
    { name: "Website", status: "on-track", progress: 80, owner: "Ana", due: "2026-10-20" },
    { name: "Payments", status: "off-track", progress: 35, due: "2026-10-07", note: "Blocked on **PSP** review" },
    { name: "Docs", status: "done", due: "2026-10-01" },
    { name: "Mobile", status: "At Risk", progress: "55%" },
    { name: "Support", status: "green" },
    { name: "Legal", status: "pending legal" },
  ];

  it("sorts worst first, unknown statuses after at-risk, finished last", () => {
    const report = ok(readStatus(items, TODAY));
    expect(report.items.map((item) => item.name)).toEqual(["Payments", "Mobile", "Legal", "Website", "Support", "Docs"]);
    expect(healthSummary(report)).toBe("2 on track · 1 at risk · 1 off track · 1 done · 1 other");
  });

  it("flags late items against the injected today, never finished ones", () => {
    const report = ok(readStatus(items, TODAY));
    const byName = Object.fromEntries(report.items.map((item) => [item.name, item]));
    expect(byName.Payments!.late).toBe(true);
    expect(byName.Docs!.late).toBe(false);
    expect(byName.Website!.late).toBe(false);
    expect(byName.Mobile!.progress).toBe(55);
    expect(byName.Legal).toMatchObject({ status: null, given: "pending legal" });
  });

  it("skips nameless rows and refuses non-lists", () => {
    expect(ok(readStatus([{ status: "done" }, "x"], TODAY)).skipped).toBe(2);
    expect(readStatus(undefined, TODAY).ok).toBe(false);
  });
});
