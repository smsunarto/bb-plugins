import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  HOUR_MS,
  decideCompletion,
  hiddenCompletedIds,
  isCompleted,
  normalizeCompletionSettings,
  type CompletionRecord,
  type CompletionThread,
} from "../../bots/lib/completion";
import { mainConversationId, ownersByThread } from "../../bots/lib/completion-server";

const now = 100 * DAY_MS;
const settings = {
  autoComplete: true,
  autoCompleteAfterHours: 24,
  autoArchive: false,
  autoArchiveAfterDays: 7,
};
function row(
  id: string,
  idleHours: number,
  extra: Partial<CompletionThread> = {},
): CompletionThread {
  const at = now - idleHours * HOUR_MS;
  return {
    id,
    parentThreadId: null,
    createdAt: at - HOUR_MS,
    updatedAt: at,
    latestAttentionAt: at,
    pinned: false,
    busy: false,
    ...extra,
  };
}
const records = (entries: Array<[string, number | null, number?]>) =>
  new Map<string, CompletionRecord>(
    entries.map(([threadId, completedAt, reopenedAt]) => [
      threadId,
      { threadId, completedAt, reopenedAt: reopenedAt ?? null },
    ]),
  );

describe("auto-complete", () => {
  it("completes bot conversations idle for 24h but never the main conversation", () => {
    const threads = [row("main", 72), row("old", 25), row("fresh", 23)];
    expect(
      decideCompletion({ threads, records: new Map(), mainId: "main", now, settings }).complete,
    ).toEqual(["old"]);
  });

  it("keeps pinned, working, and waiting conversations", () => {
    const threads = [
      row("main", 1),
      row("pinned", 48, { pinned: true }),
      row("busy", 48, { busy: true }),
    ];
    expect(
      decideCompletion({ threads, records: new Map(), mainId: "main", now, settings }).complete,
    ).toEqual([]);
  });

  it("completes a parent only once its whole subtree qualifies", () => {
    const threads = [
      row("main", 1),
      row("parent", 48),
      row("child", 2, { parentThreadId: "parent" }),
      row("idle-child", 48, { parentThreadId: "parent" }),
    ];
    expect(
      decideCompletion({ threads, records: new Map(), mainId: "main", now, settings }).complete,
    ).toEqual(["idle-child"]);
    const later = decideCompletion({
      threads: threads.map((t) =>
        t.id === "child" ? row("child", 30, { parentThreadId: "parent" }) : t,
      ),
      records: new Map(),
      mainId: "main",
      now,
      settings,
    });
    expect(later.complete.sort()).toEqual(["child", "idle-child", "parent"]);
  });

  it("restarts the idle clock when a conversation is explicitly reopened", () => {
    const threads = [row("main", 1), row("reopened", 48)];
    const reopened = records([["reopened", null, now - 2 * HOUR_MS]]);
    expect(
      decideCompletion({ threads, records: reopened, mainId: "main", now, settings }).complete,
    ).toEqual([]);
  });

  it("does nothing when disabled", () => {
    expect(
      decideCompletion({
        threads: [row("main", 1), row("old", 48)],
        records: new Map(),
        mainId: "main",
        now,
        settings: { ...settings, autoComplete: false },
      }).complete,
    ).toEqual([]);
  });
});

describe("completion visibility", () => {
  it("reopens on newer attention or live work", () => {
    const record = { threadId: "x", completedAt: now - HOUR_MS, reopenedAt: null };
    expect(isCompleted(record, { latestAttentionAt: now - 2 * HOUR_MS, busy: false })).toBe(true);
    expect(isCompleted(record, { latestAttentionAt: now, busy: false })).toBe(false);
    expect(isCompleted(record, { latestAttentionAt: now - 2 * HOUR_MS, busy: true })).toBe(false);
  });

  it("hides completed trees but keeps ancestors of anything still shown", () => {
    const threads = [
      row("a", 48),
      row("a1", 48, { parentThreadId: "a" }),
      row("b", 48),
      row("b1", 1, { parentThreadId: "b" }),
    ];
    const done = records([
      ["a", now - HOUR_MS],
      ["a1", now - HOUR_MS],
      ["b", now - HOUR_MS],
    ]);
    expect([...hiddenCompletedIds(threads, done)].sort()).toEqual(["a", "a1"]);
    expect([...hiddenCompletedIds(threads, done, (t) => t.id === "a1")].sort()).toEqual([]);
  });

  it("picks the first ordered root that is not completed as main", () => {
    const threads = [row("first", 48), row("second", 48), row("third", 48)];
    expect(
      mainConversationId(
        threads,
        ["first", "second", "third"],
        records([["first", now - HOUR_MS]]),
      ),
    ).toBe("second");
  });

  it("inherits ownership through the parent chain", () => {
    const owners = ownersByThread(
      [
        { id: "root", parentThreadId: null },
        { id: "child", parentThreadId: "root" },
        { id: "loose", parentThreadId: null },
      ],
      (id) => (id === "root" ? "bot" : null),
    );
    expect([...owners]).toEqual([
      ["root", "bot"],
      ["child", "bot"],
    ]);
  });

  it("stops inheriting at a conversation set to No bot", () => {
    const owners = ownersByThread(
      [
        { id: "root", parentThreadId: null },
        { id: "detached", parentThreadId: "root" },
        { id: "grandchild", parentThreadId: "detached" },
      ],
      (id) => (id === "root" ? "bot" : null),
      (id) => id === "detached",
    );
    expect([...owners]).toEqual([["root", "bot"]]);
  });
});

describe("auto-archive", () => {
  const archiveSettings = { ...settings, autoComplete: false, autoArchive: true };
  it("archives top-most fully completed subtrees after the configured days", () => {
    const threads = [
      row("main", 1),
      row("parent", 300),
      row("child", 300, { parentThreadId: "parent" }),
      row("recent", 30),
    ];
    const done = records([
      ["parent", now - 8 * DAY_MS],
      ["child", now - 8 * DAY_MS],
      ["recent", now - DAY_MS],
    ]);
    expect(
      decideCompletion({ threads, records: done, mainId: "main", now, settings: archiveSettings })
        .archive,
    ).toEqual(["parent"]);
  });

  it("never archives main, pinned, or a subtree with an open child", () => {
    const threads = [
      row("main", 300),
      row("pinned", 300, { pinned: true }),
      row("parent", 300),
      row("open", 1, { parentThreadId: "parent" }),
    ];
    const done = records([
      ["main", now - 9 * DAY_MS],
      ["pinned", now - 9 * DAY_MS],
      ["parent", now - 9 * DAY_MS],
    ]);
    expect(
      decideCompletion({ threads, records: done, mainId: "main", now, settings: archiveSettings })
        .archive,
    ).toEqual([]);
  });

  it("archives as soon as a conversation auto-completes when set to 0 days", () => {
    const threads = [row("main", 1), row("old", 48)];
    const decision = decideCompletion({
      threads,
      records: new Map(),
      mainId: "main",
      now,
      settings: { ...settings, autoArchive: true, autoArchiveAfterDays: 0 },
    });
    expect(decision).toEqual({ complete: ["old"], archive: ["old"] });
  });

  it("clamps invalid settings to safe defaults", () => {
    expect(
      normalizeCompletionSettings({
        autoCompleteAfterHours: 0,
        autoArchiveAfterDays: -1,
        autoArchive: "yes",
      }),
    ).toEqual({
      autoComplete: true,
      autoCompleteAfterHours: 72,
      autoArchive: false,
      autoArchiveAfterDays: 7,
    });
  });
});
