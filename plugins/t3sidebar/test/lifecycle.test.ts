import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canPark,
  nextWakeDelayMs,
  resolveShelf,
  resolveSnoozePresets,
  snoozeWakeLabel,
  MAX_TIMEOUT_MS,
  type ThreadActivitySignals,
  type ThreadLifecycleRow,
} from "../lib/lifecycle.ts";

const quiet: ThreadActivitySignals = {
  hasPendingInteraction: false,
  isWorking: false,
  isUnread: false,
  latestAttentionAt: 0,
};

const row = (
  overrides: Partial<ThreadLifecycleRow> = {},
): ThreadLifecycleRow => ({
  threadId: "thr_1",
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  ...overrides,
});

describe("canPark", () => {
  it("refuses while the agent is blocked on the user", () => {
    assert.equal(canPark({ ...quiet, hasPendingInteraction: true }), false);
  });

  // The trap this whole feature has to avoid: bb has more kinds of live work
  // than a session status, and parking any of them hides running work.
  it("refuses while any work is running", () => {
    assert.equal(canPark({ ...quiet, isWorking: true }), false);
  });

  it("allows a quiet thread", () => {
    assert.equal(canPark(quiet), true);
  });
});

describe("resolveShelf", () => {
  it("keeps an unparked thread active", () => {
    assert.equal(resolveShelf(undefined, quiet, 1_000), "active");
  });

  it("settles a parked, quiet thread", () => {
    assert.equal(
      resolveShelf(row({ settledAt: 500 }), quiet, 1_000),
      "settled",
    );
  });

  it("brings a settled thread back when it starts working", () => {
    assert.equal(
      resolveShelf(
        row({ settledAt: 500 }),
        { ...quiet, isWorking: true },
        1_000,
      ),
      "active",
    );
  });

  it("brings a settled thread back when it asks a question", () => {
    assert.equal(
      resolveShelf(
        row({ settledAt: 500 }),
        { ...quiet, hasPendingInteraction: true },
        1_000,
      ),
      "active",
    );
  });

  it("un-settles on new attention after the settle", () => {
    assert.equal(
      resolveShelf(
        row({ settledAt: 500 }),
        { ...quiet, latestAttentionAt: 900 },
        1_000,
      ),
      "active",
    );
  });

  it("keeps a snoozed thread hidden until its wake time", () => {
    assert.equal(
      resolveShelf(row({ snoozedUntil: 2_000, snoozedAt: 500 }), quiet, 1_000),
      "snoozed",
    );
  });

  it("wakes a snoozed thread when the timer elapses", () => {
    assert.equal(
      resolveShelf(row({ snoozedUntil: 900, snoozedAt: 500 }), quiet, 1_000),
      "active",
    );
  });

  // "Something happened" wakes it early — otherwise snooze hides the exact
  // thing the user needed to see.
  it("wakes a snoozed thread early when it raises its hand", () => {
    assert.equal(
      resolveShelf(
        row({ snoozedUntil: 5_000, snoozedAt: 500 }),
        { ...quiet, hasPendingInteraction: true },
        1_000,
      ),
      "active",
    );
    assert.equal(
      resolveShelf(
        row({ snoozedUntil: 5_000, snoozedAt: 500 }),
        { ...quiet, latestAttentionAt: 800 },
        1_000,
      ),
      "active",
    );
  });

  it("does not wake on activity that predates the snooze", () => {
    assert.equal(
      resolveShelf(
        row({ snoozedUntil: 5_000, snoozedAt: 900 }),
        { ...quiet, latestAttentionAt: 800 },
        1_000,
      ),
      "snoozed",
    );
  });
});

describe("snoozeWakeLabel", () => {
  it("rounds minutes up so a hidden thread never reads 0m", () => {
    assert.equal(snoozeWakeLabel(1_000 + 1, 1_000), "1m");
    assert.equal(snoozeWakeLabel(1_000 + 90_000, 1_000), "2m");
  });

  it("switches to hours and days", () => {
    assert.equal(snoozeWakeLabel(1_000 + 2 * 3_600_000, 1_000), "2h");
    assert.equal(snoozeWakeLabel(1_000 + 50 * 3_600_000, 1_000), "3d");
  });

  it("reads 'now' once the wake time has passed", () => {
    assert.equal(snoozeWakeLabel(500, 1_000), "now");
  });
});

describe("resolveSnoozePresets", () => {
  it("offers this evening while it is still well before evening", () => {
    const presets = resolveSnoozePresets(new Date(2026, 0, 5, 9, 0, 0));
    assert.deepEqual(
      presets.map((preset) => preset.id),
      ["hour", "evening", "tomorrow", "next-week"],
    );
  });

  it("drops this evening once evening is near", () => {
    const presets = resolveSnoozePresets(new Date(2026, 0, 5, 17, 30, 0));
    assert.deepEqual(
      presets.map((preset) => preset.id),
      ["hour", "tomorrow", "next-week"],
    );
  });

  // Calendar arithmetic, not +24h: a fixed offset lands on the wrong local
  // day across a daylight-saving change.
  it("puts tomorrow at 9am on the next calendar day", () => {
    const presets = resolveSnoozePresets(new Date(2026, 0, 5, 23, 30, 0));
    const tomorrow = new Date(
      presets.find((preset) => preset.id === "tomorrow")!.snoozedUntil,
    );
    assert.equal(tomorrow.getDate(), 6);
    assert.equal(tomorrow.getHours(), 9);
  });

  it("puts next week on the coming Monday", () => {
    // 2026-01-05 is a Monday, so "next week" is the following Monday.
    const presets = resolveSnoozePresets(new Date(2026, 0, 5, 10, 0, 0));
    const nextWeek = new Date(
      presets.find((preset) => preset.id === "next-week")!.snoozedUntil,
    );
    assert.equal(nextWeek.getDay(), 1);
    assert.equal(nextWeek.getDate(), 12);
  });
});

describe("nextWakeDelayMs", () => {
  it("arms for the soonest upcoming wake", () => {
    assert.equal(nextWakeDelayMs([5_000, 3_000, 9_000], 1_000), 2_050);
  });

  it("ignores wakes that have already passed", () => {
    assert.equal(nextWakeDelayMs([500], 1_000), null);
    assert.equal(nextWakeDelayMs([], 1_000), null);
  });

  // A far-future wake overflows setTimeout's signed 32-bit delay and fires
  // immediately, turning one snooze into a tight re-arm loop.
  it("clamps a far-future wake to the maximum timeout", () => {
    assert.equal(nextWakeDelayMs([Number.MAX_SAFE_INTEGER], 0), MAX_TIMEOUT_MS);
  });
});
