import assert from "node:assert/strict";
import test from "node:test";

import {
  createCoalescingQueue,
  createKeyedRequestCache,
  createReconciledCursor,
  createSerialTaskQueue,
  deleteLocalAnnotation,
  isCurrentRouteRequest,
  recordPushAcknowledgement,
  recordSnapshotAcknowledgement,
  shouldRequeueOperation,
  stableAnnotationSignature,
  toolbarTextFieldIsBusy,
  upsertLocalAnnotation,
} from "../lib/toolbar-sync.ts";

function field(
  overrides: Partial<Parameters<typeof toolbarTextFieldIsBusy>[0]> = {},
): Parameters<typeof toolbarTextFieldIsBusy>[0] {
  return {
    value: "",
    focused: false,
    width: 240,
    height: 64,
    settingsField: false,
    ...overrides,
  };
}

test("saved settings text does not block toolbar reconciliation", () => {
  assert.equal(
    toolbarTextFieldIsBusy(field({ value: "https://example.test/hook", settingsField: true })),
    false,
  );
});

test("active settings text is protected until it loses focus", () => {
  assert.equal(
    toolbarTextFieldIsBusy(
      field({
        value: "https://example.test/hook",
        focused: true,
        settingsField: true,
      }),
    ),
    true,
  );
});

test("annotation text and caret remain protected", () => {
  assert.equal(toolbarTextFieldIsBusy(field({ value: "draft" })), true);
  assert.equal(toolbarTextFieldIsBusy(field({ focused: true })), true);
  assert.equal(
    toolbarTextFieldIsBusy(field({ value: "hidden draft", width: 0, height: 0 })),
    false,
  );
});

test("only reconciled server snapshots advance the cursor", () => {
  const cursor = createReconciledCursor(10);

  cursor.observe(12, false);
  assert.equal(cursor.value(), 10, "a write acknowledgement is not a snapshot");
  assert.equal(cursor.hasNewer(11), true);

  cursor.observe(11, true);
  cursor.observe(9, true);
  assert.equal(cursor.value(), 11, "a cursor never moves backwards");

  cursor.reset();
  assert.equal(cursor.value(), 0);
});

test("concurrent session opens share one request and failures can retry", async () => {
  const sessions = createKeyedRequestCache<string, string>();
  let opens = 0;
  let release!: (id: string) => void;
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  const open = () => {
    opens += 1;
    return pending;
  };

  const first = sessions.getOrCreate("/a", open);
  const duplicate = sessions.getOrCreate("/a", open);
  assert.strictEqual(first, duplicate);
  await Promise.resolve();
  assert.equal(opens, 1);

  release("session-a");
  assert.equal(await first, "session-a");
  assert.equal(sessions.get("/a"), "session-a");
  assert.equal(await sessions.getOrCreate("/a", open), "session-a");
  assert.equal(opens, 1);

  sessions.forget("/a");
  assert.equal(
    await sessions.getOrCreate("/a", async () => {
      opens += 1;
      return "session-a-reopened";
    }),
    "session-a-reopened",
  );
  assert.equal(opens, 2);

  await assert.rejects(
    sessions.getOrCreate("/failed", async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  assert.equal(await sessions.getOrCreate("/failed", async () => "session-retry"), "session-retry");
});

test("route revisions reject an obsolete A request after A to B to A", () => {
  assert.equal(isCurrentRouteRequest("/a", 1, "/a", 3), false);
  assert.equal(isCurrentRouteRequest("/b", 2, "/a", 3), false);
  assert.equal(isCurrentRouteRequest("/a", 3, "/a", 3), true);
});

test("clear waits for an extracted write instead of racing it", async () => {
  const mutations = createSerialTaskQueue();
  const order: string[] = [];
  let releaseWrite!: () => void;
  const writeBlocked = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });

  const write = mutations.run(async () => {
    order.push("write:start");
    await writeBlocked;
    order.push("write:end");
  });
  const clear = mutations.run(async () => {
    order.push("clear");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["write:start"]);
  releaseWrite();
  await Promise.all([write, clear]);
  assert.deepEqual(order, ["write:start", "write:end", "clear"]);
});

test("clear invalidates failed older work and newer intent wins retries", () => {
  assert.equal(
    shouldRequeueOperation(1, 2, null),
    false,
    "an operation from before Clear must not return",
  );
  assert.equal(
    shouldRequeueOperation(3, 0, 4),
    false,
    "a failed edit must not overwrite a newer edit or delete",
  );
  assert.equal(shouldRequeueOperation(5, 2, 4), true, "the latest operation after Clear may retry");
  assert.equal(
    shouldRequeueOperation(5, 2, 5),
    true,
    "an extracted latest operation remains eligible to retry",
  );
});

test("a failed clear can force the unchanged server snapshot to be read", () => {
  const cursor = createReconciledCursor(12);
  assert.equal(cursor.hasNewer(12), false);
  cursor.reset();
  assert.equal(cursor.hasNewer(12), true);
});

test("the annotation signature detects edits but ignores key order", () => {
  const before = [{ id: "a", comment: "before", position: { x: 1, y: 2 } }];
  const reordered = [{ position: { y: 2, x: 1 }, comment: "before", id: "a" }];
  const edited = [{ id: "a", comment: "after", position: { x: 1, y: 2 } }];

  assert.equal(stableAnnotationSignature(before), stableAnnotationSignature(reordered));
  assert.notEqual(stableAnnotationSignature(before), stableAnnotationSignature(edited));
});

test("the annotation signature treats store defaults as local defaults", () => {
  const local = [{ id: "a", comment: "feedback" }];
  const stored = [
    {
      id: "a",
      comment: "feedback",
      status: "pending",
      kind: "feedback",
      thread: [],
    },
  ];

  assert.equal(stableAnnotationSignature(local), stableAnnotationSignature(stored));
});

test("Agentation callback deltas update the local projection immediately", () => {
  const before = [
    { id: "a", comment: "old" },
    { id: "b", comment: "keep" },
  ];
  const updated = upsertLocalAnnotation(before, {
    id: "a",
    comment: "new",
  });
  const added = upsertLocalAnnotation(updated, {
    id: "c",
    comment: "add",
  });

  assert.deepEqual(added, [
    { id: "a", comment: "new" },
    { id: "b", comment: "keep" },
    { id: "c", comment: "add" },
  ]);
  assert.deepEqual(deleteLocalAnnotation(added, "a"), [
    { id: "b", comment: "keep" },
    { id: "c", comment: "add" },
  ]);
});

test("a successful delete stays acknowledged until reconcile consumes it", () => {
  assert.deepEqual(
    [...recordPushAcknowledgement(new Set(["existing"]), ["added"], ["deleted"])],
    ["existing", "added", "deleted"],
  );
});

test("a complete snapshot acknowledges annotations from another window", () => {
  assert.deepEqual(
    [...recordSnapshotAcknowledgement(new Set(["remote", "local"]))],
    ["remote", "local"],
  );
});

test("refresh requests are serialized and coalesced", async () => {
  let runs = 0;
  let drains = 0;

  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let releaseFirst!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const queue = createCoalescingQueue(
    async () => {
      runs += 1;
      if (runs === 1) {
        markStarted();
        await blocked;
      }
    },
    () => {
      drains += 1;
    },
  );

  const cycle = queue.request();
  await started;
  assert.strictEqual(queue.request(), cycle);

  releaseFirst();
  await cycle;

  assert.equal(runs, 2);
  assert.equal(drains, 1);
});
