import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import {
  childrenByParentId,
  localDatetimeInputValue,
  initiativeForThread,
  initiativesByCoordinator,
  projectDescendantCount,
  projectHiddenThreadIds,
  railThreadRows,
  scheduleConfigLabel,
  subscriptionLabel,
  workspaceSummary,
  eventTargetsDoc,
  eventTargetsInitiative,
  resolveDocRead,
} from "../lib/initiative-ui.ts";
import type { Initiative } from "../lib/initiative-types.ts";
import type { InitiativeSubscription } from "../lib/initiative-subscriptions.ts";

function thread(id: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id,
    projectId: "one",
    title: id,
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

function initiative(
  id: string,
  coordinatorThreadId: string,
  overrides: Partial<Initiative> = {},
): Initiative {
  return {
    id,
    name: id,
    icon: "folder",
    description: "",
    coordinatorThreadId,
    workspaceProjectIds: [],
    primaryEnvironmentId: null,
    providerId: null,
    model: null,
    reasoningLevel: null,
    createdAt: 100,
    updatedAt: 100,
    archivedAt: null,
    ...overrides,
  };
}

// coordinator -> agent -> grandchild, a sibling agent, and an inbox thread.
const threads = [
  thread("coordinator"),
  thread("agent-a", { parentThreadId: "coordinator", createdAt: 200 }),
  thread("grandchild", { parentThreadId: "agent-a", createdAt: 300 }),
  thread("agent-b", { parentThreadId: "coordinator", createdAt: 250 }),
  thread("ordinary-inbox"),
];
const initiatives = [initiative("init-1", "coordinator")];
const byCoordinator = initiativesByCoordinator(initiatives);

describe("projectHiddenThreadIds", () => {
  it("hides the coordinator and every descendant, nothing else", () => {
    const hidden = projectHiddenThreadIds(threads, new Set(byCoordinator.keys()));
    assert.deepEqual([...hidden].sort(), ["agent-a", "agent-b", "coordinator", "grandchild"]);
    assert.equal(hidden.has("ordinary-inbox"), false);
  });
});

describe("railThreadRows", () => {
  it("renders every project thread exactly once, recursively nested", () => {
    const rows = railThreadRows(threads, "coordinator");
    // One navigation anchor per represented thread: the row set must equal
    // the hidden set exactly, with no duplicates.
    const rowIds = rows.map((row) => row.threadId);
    assert.equal(new Set(rowIds).size, rowIds.length);
    assert.deepEqual(
      [...rowIds].sort(),
      [...projectHiddenThreadIds(threads, new Set(byCoordinator.keys()))].sort(),
    );
    // Depth-first spawn order: agent-a (and its grandchild) before agent-b.
    assert.deepEqual(rows, [
      { threadId: "coordinator", depth: 0 },
      { threadId: "agent-a", depth: 1 },
      { threadId: "grandchild", depth: 2 },
      { threadId: "agent-b", depth: 1 },
    ]);
    assert.equal(projectDescendantCount(threads, "coordinator"), 3);
  });

  it("keeps grandchild visible even when its agent parent comes first", () => {
    const rows = railThreadRows(threads, "coordinator");
    const grandchild = rows.find((row) => row.threadId === "grandchild");
    assert.equal(grandchild?.depth, 2);
  });
});

describe("initiativeForThread", () => {
  it("resolves coordinator, child, and grandchild to the same initiative", () => {
    for (const id of ["coordinator", "agent-a", "grandchild", "agent-b"]) {
      assert.equal(initiativeForThread(threads, id, byCoordinator)?.id, "init-1");
    }
    assert.equal(initiativeForThread(threads, "ordinary-inbox", byCoordinator), null);
  });
});

describe("childrenByParentId", () => {
  it("orders siblings by spawn time", () => {
    const children = childrenByParentId(threads).get("coordinator")!;
    assert.deepEqual(
      children.map((child) => child.id),
      ["agent-a", "agent-b"],
    );
  });
});

describe("labels", () => {
  it("labels schedule configs", () => {
    assert.equal(
      scheduleConfigLabel({ schedule: "cron", expression: "0 * * * *", prompt: "x" }),
      "Every hour",
    );
    assert.equal(
      scheduleConfigLabel({ schedule: "once", runAt: Date.now() + 60_000, prompt: "x" }).startsWith(
        "Once · ",
      ),
      true,
    );
  });

  it("labels every subscription kind", () => {
    const base = {
      id: "s1",
      initiativeId: "init-1",
      label: "s1",
      prompt: null,
      configError: null,
      pollIntervalMs: null,
      enabled: true,
      nextRunAt: null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      cursor: null,
      retryAfterUntil: null,
      deliveryAttempts: 0,
      createdAt: 100,
      updatedAt: 100,
    };
    const cases: Array<[InitiativeSubscription, string]> = [
      [
        {
          ...base,
          kind: "schedule",
          config: { schedule: "cron", expression: "0 9 * * *", prompt: "standup" },
        },
        "Daily at 09:00",
      ],
      [
        { ...base, kind: "github-ci", config: { repo: "o/r", environmentId: "e1" } },
        "GitHub CI · o/r",
      ],
      [
        { ...base, kind: "github-pr", config: { repo: "o/r", pr: 7, environmentId: "e1" } },
        "PR #7 · o/r",
      ],
      [{ ...base, kind: "slack-channel", config: { channelId: "C123" } }, "Slack · C123"],
    ];
    for (const [subscription, expected] of cases) {
      assert.equal(subscriptionLabel(subscription), expected);
    }
  });

  it("surfaces a corrupt stored config instead of crashing", () => {
    const corrupt: InitiativeSubscription = {
      id: "s9",
      initiativeId: "init-1",
      kind: "slack-channel",
      label: "broken",
      prompt: null,
      config: null,
      configError: "channelId missing",
      enabled: true,
      pollIntervalMs: null,
      nextRunAt: null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      cursor: null,
      retryAfterUntil: null,
      deliveryAttempts: 0,
      createdAt: 100,
      updatedAt: 100,
    };
    assert.equal(subscriptionLabel(corrupt), "channelId missing");
  });

  it("round-trips datetime-local values in local time", () => {
    // toISOString() would write UTC into a local-time input and shift the
    // instant by the zone offset; the helper must keep wall time stable.
    const epoch = Date.UTC(2026, 8, 12, 17, 30, 0);
    const value = localDatetimeInputValue(epoch);
    assert.equal(new Date(value).getTime(), epoch);
    const parsed = new Date(value);
    assert.equal(value.startsWith(`${parsed.getFullYear()}-`), true);
  });

  it("summarizes workspaces", () => {
    const names = new Map([
      ["p1", "bb"],
      ["p2", "dotfiles"],
    ]);
    assert.equal(
      workspaceSummary(initiative("i", "c", { workspaceProjectIds: [] }), names),
      "From scratch",
    );
    assert.equal(
      workspaceSummary(initiative("i", "c", { workspaceProjectIds: ["p1", "p2"] }), names),
      "bb, dotfiles",
    );
  });
});

describe("resolveDocRead", () => {
  it("applies a fresh read into a clean editor", () => {
    assert.equal(resolveDocRead({ stale: false, dirty: false, deleted: false }), "apply");
  });

  it("keeps a draft the user typed while the read was in flight", () => {
    // The read started clean; the dirty flag is only true at resolve time.
    assert.equal(resolveDocRead({ stale: false, dirty: true, deleted: false }), "conflict");
  });

  it("ignores resolutions after the project or path moved on", () => {
    assert.equal(resolveDocRead({ stale: true, dirty: false, deleted: false }), "ignore");
    assert.equal(resolveDocRead({ stale: true, dirty: true, deleted: false }), "ignore");
  });

  it("ignores resolutions that land after the doc was deleted", () => {
    assert.equal(resolveDocRead({ stale: false, dirty: false, deleted: true }), "ignore");
  });

  it("lets an explicit user reload replace a dirty draft", () => {
    assert.equal(
      resolveDocRead({ stale: false, dirty: true, deleted: false, force: true }),
      "apply",
    );
  });
});

describe("realtime event targeting", () => {
  it("reloads for events naming this initiative", () => {
    assert.equal(eventTargetsInitiative({ initiativeId: "init_1" }, "init_1"), true);
  });

  it("skips events naming another initiative", () => {
    assert.equal(eventTargetsInitiative({ initiativeId: "init_2" }, "init_1"), false);
  });

  it("reloads for broadcasts that name no initiative", () => {
    assert.equal(eventTargetsInitiative({ initiativeId: null }, "init_1"), true);
    assert.equal(eventTargetsInitiative({}, "init_1"), true);
    assert.equal(eventTargetsInitiative(undefined, "init_1"), true);
  });

  it("skips doc events for other paths", () => {
    assert.equal(
      eventTargetsDoc({ initiativeId: "init_1", path: "notes/a.md" }, "notes/b.md"),
      false,
    );
    assert.equal(
      eventTargetsDoc({ initiativeId: "init_1", path: "notes/a.md" }, "notes/a.md"),
      true,
    );
    // Doc-less payloads (lifecycle changes) still reach the open editor.
    assert.equal(eventTargetsDoc({ initiativeId: "init_1" }, "notes/a.md"), true);
  });
});
