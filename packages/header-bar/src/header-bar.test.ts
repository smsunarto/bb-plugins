import { afterEach, describe, expect, test } from "bun:test";
import {
  clearHeaderBarSegments,
  getResolvedHeaderBar,
  resetHeaderBarRegistry,
  setHeaderBarSegments,
  subscribeHeaderBar,
  type HeaderBarSegment,
} from "./header-bar.ts";

afterEach(() => {
  resetHeaderBarRegistry();
});

function seg(
  overrides: Partial<HeaderBarSegment> & Pick<HeaderBarSegment, "owner" | "slot" | "priority">,
): HeaderBarSegment {
  return {
    label: `${overrides.owner}:${overrides.slot}`,
    ...overrides,
  };
}

describe("@bb-plugins/header-bar registry", () => {
  test("returns an empty, referentially stable snapshot when nothing is published", () => {
    const first = getResolvedHeaderBar("thr_empty");
    const second = getResolvedHeaderBar("thr_empty");
    expect(first.isEmpty).toBe(true);
    expect(first.left).toEqual([]);
    expect(first.right).toEqual([]);
    expect(first).toBe(second);
  });

  test("resolves left and right slots in fixed Vim statusbar order", () => {
    setHeaderBarSegments("thr_1", "tasks:1", "scott-tasks", [
      seg({ owner: "scott-tasks", slot: "meta", priority: 10, label: "Dec 1" }),
      seg({
        owner: "scott-tasks",
        slot: "task",
        priority: 10,
        keyText: "BBP-42",
        label: "Fix row",
      }),
    ]);
    setHeaderBarSegments("thr_1", "captain:1", "captain", [
      seg({ owner: "captain", slot: "action", priority: 10, label: "Overview" }),
      seg({ owner: "captain", slot: "threads", priority: 10, label: "3 crew" }),
      seg({ owner: "captain", slot: "lineage", priority: 10, label: "Plugins" }),
    ]);

    const resolved = getResolvedHeaderBar("thr_1");
    expect(resolved.isEmpty).toBe(false);
    expect(resolved.left.map((s) => s.slot)).toEqual(["lineage", "task"]);
    expect(resolved.right.map((s) => s.slot)).toEqual(["meta", "threads", "action"]);
    expect(getResolvedHeaderBar("thr_1")).toBe(resolved);
  });

  test("higher precedence (lower priority number) wins competing slots", () => {
    setHeaderBarSegments("thr_crew", "ks:1", "kitchen-sink", [
      seg({ owner: "kitchen-sink", slot: "lineage", priority: 20, label: "Parent" }),
      seg({ owner: "kitchen-sink", slot: "threads", priority: 30, label: "3 subthreads" }),
    ]);
    setHeaderBarSegments("thr_crew", "tasks:1", "scott-tasks", [
      seg({ owner: "scott-tasks", slot: "task", priority: 10, label: "BBP-1" }),
      seg({ owner: "scott-tasks", slot: "threads", priority: 20, label: "2 threads" }),
    ]);
    setHeaderBarSegments("thr_crew", "captain:1", "captain", [
      seg({ owner: "captain", slot: "lineage", priority: 10, label: "Plugins" }),
      seg({ owner: "captain", slot: "threads", priority: 10, label: "3 crew" }),
    ]);

    const resolved = getResolvedHeaderBar("thr_crew");
    expect(resolved.slots.lineage?.owner).toBe("captain");
    expect(resolved.slots.task?.owner).toBe("scott-tasks");
    expect(resolved.slots.threads?.owner).toBe("captain");

    // Removing Captain falls back cleanly to kitchen-sink lineage + scott-tasks threads.
    clearHeaderBarSegments("thr_crew", "captain:1");
    const fallback = getResolvedHeaderBar("thr_crew");
    expect(fallback.slots.lineage?.owner).toBe("kitchen-sink");
    expect(fallback.slots.threads?.owner).toBe("scott-tasks");
  });

  test("isolates multiple threads and notifies only the affected thread's subscribers", () => {
    let callsA = 0;
    let callsB = 0;
    const unsubA = subscribeHeaderBar("thr_a", () => {
      callsA += 1;
    });
    const unsubB = subscribeHeaderBar("thr_b", () => {
      callsB += 1;
    });

    setHeaderBarSegments("thr_a", "tasks:a", "scott-tasks", [
      seg({ owner: "scott-tasks", slot: "task", priority: 10, label: "Task A" }),
    ]);

    expect(callsA).toBe(1);
    expect(callsB).toBe(0);
    expect(getResolvedHeaderBar("thr_a").slots.task?.label).toBe("Task A");
    expect(getResolvedHeaderBar("thr_b").isEmpty).toBe(true);

    unsubA();
    unsubB();
  });

  test("keeps split-pane instances independent when one instance clears", () => {
    setHeaderBarSegments("thr_split", "tasks:pane1", "scott-tasks", [
      seg({ owner: "scott-tasks", slot: "task", priority: 10, label: "Shared Task" }),
    ]);
    setHeaderBarSegments("thr_split", "tasks:pane2", "scott-tasks", [
      seg({ owner: "scott-tasks", slot: "task", priority: 10, label: "Shared Task" }),
    ]);

    clearHeaderBarSegments("thr_split", "tasks:pane1");
    expect(getResolvedHeaderBar("thr_split").slots.task?.label).toBe("Shared Task");

    clearHeaderBarSegments("thr_split", "tasks:pane2");
    expect(getResolvedHeaderBar("thr_split").isEmpty).toBe(true);
  });

  test("skips cache invalidation and notifications when setHeaderBarSegments receives structurally equal segments", () => {
    let notifications = 0;
    const unsub = subscribeHeaderBar("thr_eq", () => {
      notifications += 1;
    });

    const onClick = () => {};
    const onSelect = () => {};
    const makeSegments = (): HeaderBarSegment[] => [
      seg({
        owner: "scott-tasks",
        slot: "task",
        priority: 10,
        keyText: "BBP-99",
        label: "Stable task",
        glyph: { kind: "task-status", status: "in_progress" },
        tagGlyph: { kind: "task-priority", priority: "high" },
        onClick,
        secondaryMenu: {
          triggerLabel: "+1",
          ariaLabel: "More tasks",
          glyph: { kind: "icon", name: "List", tone: "muted" },
          items: [
            {
              id: "t2",
              label: "Other",
              glyph: { kind: "dot", tone: "accent", pulse: false },
              onSelect,
            },
          ],
        },
      }),
    ];

    setHeaderBarSegments("thr_eq", "tasks:1", "scott-tasks", makeSegments());
    const firstSnapshot = getResolvedHeaderBar("thr_eq");
    expect(notifications).toBe(1);

    // Identical structure in fresh arrays/objects: no cache clear, no notification.
    setHeaderBarSegments("thr_eq", "tasks:1", "scott-tasks", makeSegments());
    expect(notifications).toBe(1);
    expect(getResolvedHeaderBar("thr_eq")).toBe(firstSnapshot);

    // Changing a nested field invalidates and notifies.
    const changed = makeSegments();
    changed[0] = { ...changed[0]!, label: "Renamed task" };
    setHeaderBarSegments("thr_eq", "tasks:1", "scott-tasks", changed);
    expect(notifications).toBe(2);
    expect(getResolvedHeaderBar("thr_eq")).not.toBe(firstSnapshot);
    expect(getResolvedHeaderBar("thr_eq").slots.task?.label).toBe("Renamed task");

    unsub();
  });
});
