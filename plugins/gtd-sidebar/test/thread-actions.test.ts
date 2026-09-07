import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import {
  buildThreadActionPlan,
  findThreadAction,
  type RowLifecycleState,
} from "../components/inbox/thread-actions.ts";

const noop = () => {};

const active = (canPark: boolean): RowLifecycleState => ({
  kind: "active",
  canPark,
  snoozeUntilTomorrow: noop,
  settle: noop,
});
const snoozed: RowLifecycleState = { kind: "snoozed", wakeNow: noop };
const settled: RowLifecycleState = { kind: "settled", unsettle: noop };

function plan(lifecycle: RowLifecycleState, isPinned = false) {
  return buildThreadActionPlan({ lifecycle, isPinned, setPinned: noop, requestDelete: noop });
}

describe("buildThreadActionPlan", () => {
  const cases: readonly { name: string; lifecycle: RowLifecycleState; ids: readonly string[] }[] = [
    {
      name: "a parkable working thread",
      lifecycle: active(true),
      ids: ["settle", "snooze-tomorrow", "toggle-pin", "request-delete"],
    },
    // Settle is bb's archive, which bb offers on every thread, so a thread
    // that cannot park keeps it while losing snooze.
    {
      name: "a working thread that cannot park",
      lifecycle: active(false),
      ids: ["settle", "toggle-pin", "request-delete"],
    },
    {
      name: "a snoozed thread",
      lifecycle: snoozed,
      ids: ["wake-now", "toggle-pin", "request-delete"],
    },
    {
      name: "a settled thread",
      lifecycle: settled,
      ids: ["unsettle", "toggle-pin", "request-delete"],
    },
  ];
  for (const testCase of cases) {
    test(`lists the menu for ${testCase.name}`, () => {
      assert.deepEqual(
        plan(testCase.lifecycle).map(({ id }) => id),
        testCase.ids,
      );
    });
  }

  test("uses the sheet's short labels and never lists Archive", () => {
    assert.deepEqual(
      plan(active(true)).map(({ label }) => label),
      ["Settle", "Snooze", "Pin", "Delete"],
    );
    assert.deepEqual(
      plan(snoozed).map(({ label }) => label),
      ["Wake now", "Pin", "Delete"],
    );
  });

  test("labels pin by the current state", () => {
    assert.equal(findThreadAction(plan(active(false), true), "toggle-pin")?.label, "Unpin");
    assert.equal(findThreadAction(plan(active(false), false), "toggle-pin")?.label, "Pin");
  });

  test("marks only delete destructive", () => {
    assert.deepEqual(
      plan(active(true))
        .filter(({ destructive }) => destructive)
        .map(({ id }) => id),
      ["request-delete"],
    );
  });

  test("finds no snooze on a thread that cannot park", () => {
    assert.equal(findThreadAction(plan(active(false)), "snooze-tomorrow"), undefined);
  });
});
