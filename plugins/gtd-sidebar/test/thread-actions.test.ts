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

describe("buildThreadActionPlan", () => {
  const cases: readonly { name: string; lifecycle: RowLifecycleState; ids: readonly string[] }[] = [
    {
      name: "a parkable working thread",
      lifecycle: active(true),
      ids: ["settle", "snooze-tomorrow"],
    },
    // Settle is bb's archive, which bb offers on every thread, so a thread
    // that cannot park keeps it while losing snooze.
    {
      name: "a working thread that cannot park",
      lifecycle: active(false),
      ids: ["settle"],
    },
    { name: "a snoozed thread", lifecycle: snoozed, ids: ["wake-now"] },
    { name: "a settled thread", lifecycle: settled, ids: ["unsettle"] },
  ];
  for (const testCase of cases) {
    test(`lists the lifecycle moves for ${testCase.name}`, () => {
      assert.deepEqual(
        buildThreadActionPlan(testCase.lifecycle).map(({ id }) => id),
        testCase.ids,
      );
    });
  }

  // Pin, delete and the rest come from bb's thread action registry, so the
  // plan holds only what GTD adds and never names Archive.
  test("uses the sheet's labels and never lists Archive", () => {
    assert.deepEqual(
      buildThreadActionPlan(active(true)).map(({ label }) => label),
      ["Settle", "Snooze until tomorrow"],
    );
    assert.deepEqual(
      buildThreadActionPlan(snoozed).map(({ label }) => label),
      ["Wake now"],
    );
  });

  test("finds no snooze on a thread that cannot park", () => {
    assert.equal(
      findThreadAction(buildThreadActionPlan(active(false)), "snooze-tomorrow"),
      undefined,
    );
  });
});
