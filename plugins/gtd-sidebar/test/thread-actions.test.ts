import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import {
  buildThreadActionPlan,
  getThreadActionGroups,
  type BuildThreadActionPlanOptions,
  type RowLifecycleState,
} from "../components/inbox/thread-actions.ts";

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
    archive: noop,
    requestDelete: noop,
    ...overrides,
  });
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
    primaryLabels: ["Open in split"],
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

  const labelCases = [
    {
      name: "read and pinned",
      isUnread: false,
      isPinned: true,
      labels: ["Mark unread", "Unpin"],
    },
    {
      name: "unread and unpinned",
      isUnread: true,
      isPinned: false,
      labels: ["Mark read", "Pin"],
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
        ["Archive", "Delete"],
      );
    });
  }
});
