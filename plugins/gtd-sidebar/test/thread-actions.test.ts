import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import {
  buildThreadActionPlan,
  getThreadActionGroups,
  type BuildThreadActionPlanOptions,
  type RowLifecycleState,
} from "../components/inbox/thread-actions.ts";
import { getCompactActions } from "../components/inbox/thread-action-menu.tsx";

const noop = () => {};

function lifecycle(kind: "active", canPark: boolean): RowLifecycleState;
function lifecycle(kind: "snoozed" | "settled"): RowLifecycleState;
function lifecycle(kind: RowLifecycleState["kind"], canPark = false): RowLifecycleState {
  switch (kind) {
    case "active":
      return { kind, canPark, snoozeUntilTomorrow: noop, settle: noop };
    case "snoozed":
      return { kind, wakeNow: noop };
    case "settled":
      return { kind, unsettle: noop };
  }
}

function plan(state: RowLifecycleState, overrides: Partial<BuildThreadActionPlanOptions> = {}) {
  return buildThreadActionPlan({
    lifecycle: state,
    split: { isAvailable: true, open: noop },
    isUnread: false,
    isPinned: false,
    setRead: noop,
    setPinned: noop,
    renameThread: noop,
    requestDelete: noop,
    ...overrides,
  });
}

function allLabels(result: ReturnType<typeof plan>): string[] {
  return getThreadActionGroups(result).flatMap(({ actions }) => actions.map(({ label }) => label));
}

const lifecycleCases: readonly {
  name: string;
  lifecycle: RowLifecycleState;
  splitAvailable: boolean;
  primaryLabels: readonly string[];
}[] = [
  {
    name: "active and parkable with split",
    lifecycle: lifecycle("active", true),
    splitAvailable: true,
    primaryLabels: ["Open in split", "Snooze until tomorrow", "Settle thread"],
  },
  {
    name: "active and not parkable with split",
    lifecycle: lifecycle("active", false),
    splitAvailable: true,
    primaryLabels: ["Open in split", "Settle thread"],
  },
  {
    name: "active and parkable without split",
    lifecycle: lifecycle("active", true),
    splitAvailable: false,
    primaryLabels: ["Snooze until tomorrow", "Settle thread"],
  },
  {
    name: "snoozed with split",
    lifecycle: lifecycle("snoozed"),
    splitAvailable: true,
    primaryLabels: ["Open in split", "Wake thread now"],
  },
  {
    name: "snoozed without split",
    lifecycle: lifecycle("snoozed"),
    splitAvailable: false,
    primaryLabels: ["Wake thread now"],
  },
  {
    name: "settled without split",
    lifecycle: lifecycle("settled"),
    splitAvailable: false,
    primaryLabels: ["Un-settle thread"],
  },
];

describe("buildThreadActionPlan", () => {
  for (const testCase of lifecycleCases) {
    test(`returns ordered actions for ${testCase.name}`, () => {
      const result = plan(testCase.lifecycle, {
        split: { isAvailable: testCase.splitAvailable, open: noop },
      });

      assert.deepEqual(
        result.primary.map(({ label }) => label),
        testCase.primaryLabels,
      );
      assert.deepEqual(
        getThreadActionGroups(result).map(({ id }) => id),
        ["primary", "organization", "destructive"],
      );
    });
  }

  // Settle is bb's archive, which bb offers on every thread, so a working
  // thread keeps it while losing snooze — and nothing lists Archive twice.
  test("offers settle on a thread that cannot park, and never a separate archive", () => {
    const result = plan(lifecycle("active", false));
    const labels = allLabels(result);
    assert.equal(labels.includes("Settle thread"), true);
    assert.equal(labels.includes("Snooze until tomorrow"), false);
    assert.equal(labels.includes("Archive"), false);
    assert.equal(allLabels(plan(lifecycle("snoozed"))).includes("Archive"), false);
  });

  const labelCases = [
    {
      name: "read and pinned",
      isUnread: false,
      isPinned: true,
      labels: ["Generate thread name", "Mark unread", "Unpin"],
    },
    {
      name: "unread and unpinned",
      isUnread: true,
      isPinned: false,
      labels: ["Generate thread name", "Mark read", "Pin"],
    },
  ] as const;

  for (const testCase of labelCases) {
    test(`labels organization actions for ${testCase.name}`, () => {
      const result = plan(lifecycle("active", false), {
        isUnread: testCase.isUnread,
        isPinned: testCase.isPinned,
      });

      assert.deepEqual(
        result.organization.map(({ label }) => label),
        testCase.labels,
      );
      assert.deepEqual(
        result.destructive.map(({ label }) => label),
        ["Delete"],
      );
    });
  }

  test("getCompactActions filters and orders actions for compact long press menu", () => {
    const activePlan = plan(lifecycle("active", true), {
      isPinned: false,
    });
    const compactActions = getCompactActions(activePlan);

    assert.deepEqual(
      compactActions.map((a) => ({ id: a.id, label: a.label })),
      [
        { id: "settle", label: "Settle" },
        { id: "snooze-tomorrow", label: "Snooze" },
        { id: "toggle-pin", label: "Pin" },
        { id: "request-delete", label: "Delete" },
      ],
    );
  });

  test("getCompactActions offers wake on a snoozed row", () => {
    const compactActions = getCompactActions(plan(lifecycle("snoozed")));
    assert.deepEqual(
      compactActions.map((a) => a.id),
      ["wake-now", "toggle-pin", "request-delete"],
    );
  });

  test("getCompactActions offers un-settle on a settled row", () => {
    const compactActions = getCompactActions(plan(lifecycle("settled")));
    assert.deepEqual(
      compactActions.map((a) => a.id),
      ["unsettle", "toggle-pin", "request-delete"],
    );
  });
});
