import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import {
  buildThreadActionPlan,
  findThreadAction,
  rowActionPlan,
  type RowCommand,
  type RowLifecycleState,
} from "../components/inbox/thread-actions.ts";
import {
  LONG_LIVED_FAMILY_REASON,
  LONG_LIVED_REASON,
  isLongLivedThread,
  rosterStayOpenReason,
  stayOpenReason,
} from "../lib/long-lived.ts";

const noop = () => {};

const active = (canPark: boolean, stayOpenReason: string | null = null): RowLifecycleState => ({
  kind: "active",
  canPark,
  stayOpenReason,
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

describe("threads that stay open", () => {
  // Captain threads list Settle and Snooze disabled, with the reason, whether
  // or not they could otherwise park.
  for (const canPark of [true, false]) {
    test(`disables Settle and Snooze with the reason (canPark ${canPark})`, () => {
      const plan = buildThreadActionPlan(active(canPark, LONG_LIVED_REASON));
      assert.deepEqual(
        plan.map(({ id, disabledReason }) => [id, disabledReason]),
        [
          ["settle", LONG_LIVED_REASON],
          ["snooze-tomorrow", LONG_LIVED_REASON],
        ],
      );
    });
  }

  test("dispatches nothing from a disabled Settle or Snooze", () => {
    const sent: RowCommand[] = [];
    const plan = rowActionPlan("active", "thr_captain", true, (c) => sent.push(c), "reason");
    for (const action of plan) action.execute();
    assert.deepEqual(sent, []);
  });

  // An already parked Captain can always come back.
  test("still wakes or un-settles a parked Captain", () => {
    const sent: RowCommand[] = [];
    const command = (c: RowCommand) => sent.push(c);
    findThreadAction(rowActionPlan("snoozed", "thr_c", false, command), "wake-now")!.execute();
    findThreadAction(rowActionPlan("settled", "thr_c", false, command), "unsettle")!.execute();
    assert.deepEqual(sent, [
      { kind: "restore", threadId: "thr_c", shelf: "snoozed" },
      { kind: "restore", threadId: "thr_c", shelf: "settled" },
    ]);
  });

  test("detects Captain threads by origin plugin only", () => {
    assert.equal(isLongLivedThread({ originPluginId: "captain" }), true);
    assert.equal(isLongLivedThread({ originPluginId: "scott-tasks" }), false);
    assert.equal(isLongLivedThread({ originPluginId: null }), false);
    assert.equal(isLongLivedThread({}), false);
  });

  const row = (id: string, parentThreadId: string | null, originPluginId: string | null) => ({
    id,
    parentThreadId,
    originPluginId,
    originKind: null,
    isArchived: false,
  });
  const roster = [
    row("lead", null, null),
    row("captain", "lead", "captain"),
    row("crew", "captain", "scott-tasks"),
    row("plain", null, null),
  ];

  test("blocks the Captain, and any family that holds one, but not its crew", () => {
    assert.equal(rosterStayOpenReason(roster, "captain"), LONG_LIVED_REASON);
    assert.equal(rosterStayOpenReason(roster, "lead"), LONG_LIVED_FAMILY_REASON);
    assert.equal(rosterStayOpenReason(roster, "crew"), null);
    assert.equal(rosterStayOpenReason(roster, "plain"), null);
    assert.equal(stayOpenReason([]), null);
  });
});
