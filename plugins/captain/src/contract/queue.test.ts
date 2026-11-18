import { describe, expect, test } from "vitest";
import { nextWake, orderQueue, type AskKind, type QueueItem } from "./queue.ts";

const ask = (id: string, askKind: AskKind, since: number, extra: Partial<QueueItem> = {}) =>
  ({
    kind: "ask",
    key: `ask:${id}`,
    id,
    askKind,
    text: id,
    detail: "",
    options: [],
    task: null,
    since,
    answer: null,
    snoozedUntil: null,
    skipOrder: null,
    ...extra,
  }) as QueueItem;
const blocked = (id: string, since: number): QueueItem => ({
  kind: "blocked",
  key: `blocked:${id}`,
  threadId: "thr_crew",
  title: id,
  interactionKind: "plugin",
  task: null,
  role: null,
  since,
  snoozedUntil: null,
  skipOrder: null,
});
const health = (id: string, since: number): QueueItem => ({
  kind: "health",
  key: `health:${id}`,
  title: id,
  detail: null,
  task: null,
  since,
  action: null,
  snoozedUntil: null,
  skipOrder: null,
});
const keys = (items: QueueItem[]) => items.map((item) => item.key);

describe("the Needs you order", () => {
  test("health, then blocked crew, then access, ship, decision and improve asks; oldest first in each", () => {
    const items = [
      ask("a1", "improve", 1),
      ask("a2", "decision", 5),
      ask("a3", "decision", 2),
      ask("a4", "ship", 9),
      ask("a5", "access", 9),
      blocked("int_1", 9),
      health("captain", 9),
    ];
    expect(keys(orderQueue(items, 100))).toEqual([
      "health:captain",
      "blocked:int_1",
      "ask:a5",
      "ask:a4",
      "ask:a3",
      "ask:a2",
      "ask:a1",
    ]);
  });

  test("Skip moves an item behind every other, in the order items were skipped", () => {
    const items = [
      health("captain", 1),
      { ...ask("a1", "access", 1), skipOrder: 50 },
      { ...health("report", 2), skipOrder: 40 },
      ask("a2", "improve", 3),
    ] as QueueItem[];
    expect(keys(orderQueue(items, 100))).toEqual([
      "health:captain",
      "ask:a2",
      "health:report",
      "ask:a1",
    ]);
  });

  test("Later hides an item until its hour ends, and the banner wakes then", () => {
    const items = [{ ...ask("a1", "decision", 1), snoozedUntil: 500 }, ask("a2", "decision", 2)];
    expect(keys(orderQueue(items, 100))).toEqual(["ask:a2"]);
    expect(nextWake(items, 100)).toBe(500);
    expect(keys(orderQueue(items, 500))).toEqual(["ask:a1", "ask:a2"]);
    expect(nextWake(items, 500)).toBeNull();
  });

  test("an answer still sending stays in the queue, behind the items that need an answer", () => {
    const items = [ask("a1", "access", 1, { answer: "Grant" }), ask("a2", "improve", 2)];
    expect(keys(orderQueue(items, 100))).toEqual(["ask:a2", "ask:a1"]);
  });
});
