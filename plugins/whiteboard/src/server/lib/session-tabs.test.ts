import { randomUUID } from "node:crypto";
import { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WhiteboardSettings } from "../../shared/contracts/engine.ts";
import { MIGRATIONS } from "./migrations.ts";
import { createOpenPanel } from "./open-panel.ts";
import { createRealtime } from "./realtime.ts";
import { TAB_WRITE_ATTEMPTS, trackSessionTabs, upsertSessionTab } from "./session-tabs.ts";
import { desktopAvailable, runWithThread } from "./thread-context.ts";
import { createReviewApi } from "./vendor/review/src/review-api/http.ts";
import { ReviewStore } from "./vendor/review/src/review-api/store.ts";

// The real upstream store on node:sqlite, as upstream runs it. This keeps the
// event shapes honest (attention changes reach only catalog listeners)
// without waiting for the bb database adapter.
vi.mock("./sqlite.ts", () => ({ DatabaseSync: NodeDatabaseSync }));

const SESSION = "0b8f3c2d-5e6a-4f7b-8c9d-1e2f3a4b5c6d";
/** bb client-core's id for `plugin-panel` + `whiteboard:whiteboard:{"sessionId":SESSION}` + no environment. */
const SESSION_TAB_ID =
  "plugin-panel:whiteboard%3Awhiteboard%3A%7B%22sessionId%22%3A%220b8f3c2d-5e6a-4f7b-8c9d-1e2f3a4b5c6d%22%7D:none";
const OTHER_TAB = { id: "git-diff:git-diff:none", kind: "git-diff" };

type Tab = Record<string, unknown> & { id: string; kind: string };

/**
 * bb's tabs route: a revision per thread, 409 on a stale revision, strict
 * plugin-panel keys and a 1..1024 title (desktop-v0.44.0 server-contract thread-tabs.ts).
 */
function fakeThreadTabs(initial: Record<string, Tab[]> = {}) {
  const threads = new Map<string, { revision: number; tabs: Tab[] }>(
    Object.entries(initial).map(([id, tabs]) => [id, { revision: 1, tabs }]),
  );
  /** Writes another client lands just before ours, to force conflicts. */
  let interleaved = 0;
  const pluginPanelKeys = new Set([
    "actionId",
    "fileOpenerOwner",
    "id",
    "kind",
    "paramsJson",
    "pluginId",
    "title",
  ]);
  return {
    threads,
    interleave(count: number) {
      interleaved = count;
    },
    sdk: {
      threads: {
        tabs: {
          get: async ({ threadId }: { threadId: string }) => {
            const thread = threads.get(threadId);
            if (!thread)
              throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 });
            return structuredClone(thread);
          },
          update: async (args: { threadId: string; expectedRevision: number; tabs: Tab[] }) => {
            const thread = threads.get(args.threadId);
            if (!thread)
              throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 });
            for (const tab of args.tabs)
              if (
                tab.kind === "plugin-panel" &&
                (tab.fileOpenerOwner === null ||
                  typeof tab.title !== "string" ||
                  tab.title.length < 1 ||
                  tab.title.length > 1024 ||
                  Object.keys(tab).some((key) => !pluginPanelKeys.has(key)))
              )
                throw Object.assign(new Error("HTTP 400: invalid_request"), { status: 400 });
            if (interleaved > 0) {
              interleaved--;
              thread.revision++;
            }
            if (args.expectedRevision !== thread.revision)
              throw Object.assign(new Error("HTTP 409: Thread tabs changed on another client"), {
                status: 409,
                code: "thread_tabs_conflict",
              });
            thread.revision++;
            thread.tabs = structuredClone(args.tabs);
            return structuredClone(thread);
          },
        },
      },
    },
  };
}

const settings: WhiteboardSettings = {
  scratchpadEnabled: () => false,
  softwareMapEnabled: () => true,
  subscribe: () => () => {},
};

const stores: ReviewStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

function newStore() {
  const store = new ReviewStore(":memory:", {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });
  stores.push(store);
  return store;
}

async function createSession(store: ReviewStore, title: string) {
  const result = await store.execute({
    commandId: randomUUID(),
    operation: { type: "create", title, pins: { repositoryId: "repo", base: "a", head: "b" } },
  });
  return result.reviewId;
}

function command(store: ReviewStore, operation: Record<string, unknown>) {
  return store.execute({ commandId: randomUUID(), operation });
}

function setup(initial: Record<string, Tab[]> = {}) {
  const tabs = fakeThreadTabs(initial);
  const { bb, harness } = createFakePluginHost({ pluginId: "whiteboard", sdk: tabs.sdk });
  bb.storage.migrate(bb.storage.database(), [...MIGRATIONS]);
  const realtime = createRealtime(bb);
  const open = createOpenPanel({ bb, settings, realtime });
  return { bb, harness, tabs, realtime, open };
}

function rows(bb: BbPluginApi) {
  return bb.storage
    .database()
    .prepare("SELECT session_id, thread_id FROM session_threads ORDER BY rowid")
    .all();
}

/** Let the tracker's sweep finish: it runs on promise turns after a catalog event. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("open panel", () => {
  test("without a calling thread it refuses with upstream's text", async () => {
    const { open, harness } = setup({ t1: [] });
    await expect(open({ reviewId: SESSION, title: "Plan" })).rejects.toMatchObject({
      message: "The desktop is not connected.",
      status: 409,
    });
    expect(harness.inspection.sdk.calls).toEqual([]);
    expect(harness.inspection.realtimeSignals).toEqual([]);
  });

  test("appends the client's tab without fileOpenerOwner, records the thread and asks clients to focus", async () => {
    const { bb, open, tabs, harness } = setup({ t1: [OTHER_TAB] });

    const result = await runWithThread({ threadId: "t1", projectId: "p1" }, () =>
      open({ reviewId: SESSION, title: "Plan" }),
    );

    expect(result).toEqual({ softwareMapEnabled: true });
    expect(tabs.threads.get("t1")).toEqual({
      revision: 2,
      tabs: [
        OTHER_TAB,
        {
          id: SESSION_TAB_ID,
          kind: "plugin-panel",
          pluginId: "whiteboard",
          actionId: "whiteboard",
          title: "Plan",
          paramsJson: `{"sessionId":"${SESSION}"}`,
        },
      ],
    });
    expect(harness.inspection.sdk.callsTo("threads.tabs.update")).toEqual([
      [
        {
          threadId: "t1",
          expectedRevision: 1,
          tabs: [OTHER_TAB, expect.not.objectContaining({ fileOpenerOwner: expect.anything() })],
        },
      ],
    ]);
    expect(rows(bb)).toEqual([{ session_id: SESSION, thread_id: "t1" }]);
    expect(harness.inspection.realtimeSignals).toEqual([
      {
        channel: "whiteboard:open",
        payload: { threadId: "t1", sessionId: SESSION, title: "Plan", nonce: expect.any(String) },
      },
    ]);
    const nonce = (harness.inspection.realtimeSignals[0]!.payload as { nonce: string }).nonce;
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a repeat open writes nothing new; a new title retitles the same tab", async () => {
    const { bb, open, tabs, harness } = setup({ t1: [] });
    const openIn = (title: string) =>
      runWithThread({ threadId: "t1" }, () => open({ reviewId: SESSION, title }));

    await openIn("Plan");
    await openIn("Plan");
    expect(harness.inspection.sdk.callsTo("threads.tabs.update")).toHaveLength(1);

    await openIn("Plan v2");
    expect(tabs.threads.get("t1")!.tabs).toEqual([
      expect.objectContaining({ id: SESSION_TAB_ID, title: "Plan v2" }),
    ]);
    expect(harness.inspection.sdk.callsTo("threads.tabs.update")).toHaveLength(2);
    expect(rows(bb)).toEqual([{ session_id: SESSION, thread_id: "t1" }]);
    // Every open asks clients to focus, with a fresh nonce each time.
    const nonces = harness.inspection.realtimeSignals.map(
      (signal) => (signal.payload as { nonce: string }).nonce,
    );
    expect(new Set(nonces).size).toBe(3);
  });

  test("a stale revision re-reads and retries", async () => {
    const { open, tabs, harness } = setup({ t1: [OTHER_TAB] });
    tabs.interleave(2);

    await runWithThread({ threadId: "t1" }, () => open({ reviewId: SESSION, title: "Plan" }));

    expect(
      harness.inspection.sdk
        .callsTo("threads.tabs.update")
        .map(([args]) => (args as { expectedRevision: number }).expectedRevision),
    ).toEqual([1, 2, 3]);
    // Two foreign writes (revisions 2 and 3), then ours.
    expect(tabs.threads.get("t1")).toEqual({
      revision: 4,
      tabs: [OTHER_TAB, expect.objectContaining({ id: SESSION_TAB_ID })],
    });
  });

  test("gives up after three retries and records nothing", async () => {
    const { bb, open, tabs, harness } = setup({ t1: [] });
    tabs.interleave(TAB_WRITE_ATTEMPTS);

    await expect(
      runWithThread({ threadId: "t1" }, () => open({ reviewId: SESSION, title: "Plan" })),
    ).rejects.toMatchObject({ message: "HTTP 409: Thread tabs changed on another client" });
    expect(harness.inspection.sdk.callsTo("threads.tabs.update")).toHaveLength(4);
    expect(rows(bb)).toEqual([]);
    expect(harness.inspection.realtimeSignals).toEqual([]);
  });

  test("upstream create and open routes report opened, openError and the thread-less refusal", async () => {
    const { open, tabs } = setup({ t1: [] });
    const store = newStore();
    const api = createReviewApi(store, undefined, open, undefined, async () => ({
      desktopAvailable: desktopAvailable(),
      softwareMapEnabled: true,
    }));
    const post = async (path: string, body: unknown) =>
      await api.fetch(
        new Request(`http://whiteboard.local${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const create = (title: string) => ({
      commandId: randomUUID(),
      operation: { type: "create", title, pins: { repositoryId: "repo", base: "a", head: "b" } },
    });

    const fromThread = await runWithThread({ threadId: "t1" }, () =>
      post("/commands", create("Plan")),
    );
    const created = (await fromThread.json()) as { reviewId: string; opened: boolean };
    expect(created).toMatchObject({ opened: true, softwareMapEnabled: true });
    expect(tabs.threads.get("t1")!.tabs).toEqual([
      expect.objectContaining({
        kind: "plugin-panel",
        title: "Plan",
        paramsJson: `{"sessionId":"${created.reviewId}"}`,
      }),
    ]);

    const noThread = await post("/commands", create("Elsewhere"));
    const elsewhere = (await noThread.json()) as { reviewId: string; opened: boolean };
    expect(elsewhere).toMatchObject({ opened: false });

    tabs.interleave(TAB_WRITE_ATTEMPTS);
    const conflicted = await runWithThread({ threadId: "t1" }, () =>
      post("/commands", create("Busy")),
    );
    expect(await conflicted.json()).toMatchObject({
      opened: false,
      openError: "HTTP 409: Thread tabs changed on another client Retry with review_open.",
    });

    const reopen = await post(`/${created.reviewId}/open`, {});
    expect(reopen.status).toBe(409);
    expect(await reopen.json()).toMatchObject({ error: "The desktop is not connected." });

    // Upstream Desktop reports a failed open as a 409 carrying its reason
    // (desktop-server.ts openApiReview), not the generic 500.
    tabs.interleave(TAB_WRITE_ATTEMPTS);
    const busy = await runWithThread({ threadId: "t1" }, () =>
      post(`/${elsewhere.reviewId}/open`, {}),
    );
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "HTTP 409: Thread tabs changed on another client" });
  });

  test("a title longer than bb's tab limit is cut to fit, in the tab and the focus event", async () => {
    const { open, tabs, harness } = setup({ t1: [] });
    const long = "x".repeat(2000);

    await runWithThread({ threadId: "t1" }, () => open({ reviewId: SESSION, title: long }));

    const expected = `${"x".repeat(1023)}…`;
    expect(tabs.threads.get("t1")!.tabs).toEqual([
      expect.objectContaining({ id: SESSION_TAB_ID, title: expected }),
    ]);
    expect(harness.inspection.realtimeSignals).toEqual([
      {
        channel: "whiteboard:open",
        payload: { threadId: "t1", sessionId: SESSION, title: expected, nonce: expect.any(String) },
      },
    ]);
  });
});

describe("tab maintenance", () => {
  async function opened(threads: string[], title = "Plan") {
    const context = setup(Object.fromEntries(threads.map((id) => [id, [OTHER_TAB]])));
    const store = newStore();
    const sessionId = await createSession(store, title);
    for (const threadId of threads)
      await runWithThread({ threadId }, () => context.open({ reviewId: sessionId, title }));
    const stop = trackSessionTabs({ bb: context.bb, store });
    return { ...context, store, sessionId, stop };
  }
  const titles = (tabs: ReturnType<typeof fakeThreadTabs>, threadId: string) =>
    tabs.threads.get(threadId)!.tabs.map((tab) => tab.title ?? tab.kind);

  test("a rename retitles the tab in every recorded thread", async () => {
    const { store, sessionId, tabs } = await opened(["t1", "t2"]);

    await command(store, { type: "rename", reviewId: sessionId, title: "Renamed" });
    await settle();

    expect(titles(tabs, "t1")).toEqual(["git-diff", "Renamed"]);
    expect(titles(tabs, "t2")).toEqual(["git-diff", "Renamed"]);
  });

  test("a rename to a title over bb's limit retitles with the cut title", async () => {
    const { store, sessionId, tabs } = await opened(["t1"]);

    await command(store, { type: "rename", reviewId: sessionId, title: "y".repeat(1500) });
    await settle();

    expect(titles(tabs, "t1")).toEqual(["git-diff", `${"y".repeat(1023)}…`]);
  });

  test("a rename does not reopen a tab the user closed", async () => {
    const { bb, store, sessionId, tabs } = await opened(["t1"]);
    await upsertSessionTab(bb, "t1", "unrelated", "Other");
    const thread = tabs.threads.get("t1")!;
    thread.tabs = thread.tabs.filter((tab) => tab.kind !== "plugin-panel" || tab.title === "Other");

    await command(store, { type: "rename", reviewId: sessionId, title: "Renamed" });
    await settle();

    expect(titles(tabs, "t1")).toEqual(["git-diff", "Other"]);
    expect(rows(bb)).toEqual([{ session_id: sessionId, thread_id: "t1" }]);
  });

  test("a session opened after the tracker started still follows renames", async () => {
    const context = setup({ t1: [] });
    const store = newStore();
    const stop = trackSessionTabs({ bb: context.bb, store });
    const sessionId = await createSession(store, "Plan");
    await runWithThread({ threadId: "t1" }, () =>
      context.open({ reviewId: sessionId, title: "Plan" }),
    );

    await command(store, { type: "rename", reviewId: sessionId, title: "Renamed" });
    await settle();

    expect(titles(context.tabs, "t1")).toEqual(["Renamed"]);
    stop();
  });

  test("delete removes the tab and forgets the threads", async () => {
    const { bb, store, sessionId, tabs } = await opened(["t1", "t2"]);

    await command(store, { type: "delete", reviewId: sessionId });
    await settle();

    expect(titles(tabs, "t1")).toEqual(["git-diff"]);
    expect(titles(tabs, "t2")).toEqual(["git-diff"]);
    expect(rows(bb)).toEqual([]);
  });

  test("dismiss removes the tab; restore does not bring it back", async () => {
    const { bb, store, sessionId, tabs, harness } = await opened(["t1"]);

    await command(store, { type: "attention", reviewId: sessionId, action: "dismiss" });
    await settle();
    expect(titles(tabs, "t1")).toEqual(["git-diff"]);
    expect(rows(bb)).toEqual([]);

    const writes = harness.inspection.sdk.callsTo("threads.tabs.update").length;
    await command(store, { type: "attention", reviewId: sessionId, action: "restore" });
    await settle();
    expect(titles(tabs, "t1")).toEqual(["git-diff"]);
    expect(harness.inspection.sdk.callsTo("threads.tabs.update")).toHaveLength(writes);
  });

  test("an open after a dismissal keeps its tab until the next dismissal, as Desktop does", async () => {
    const { bb, store, sessionId, tabs, open } = await opened(["t1"]);
    await command(store, { type: "attention", reviewId: sessionId, action: "dismiss" });
    await settle();
    expect(titles(tabs, "t1")).toEqual(["git-diff"]);

    // The agent reopens the dismissed session; later edits must not close it.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await runWithThread({ threadId: "t1" }, () => open({ reviewId: sessionId, title: "Plan" }));
    await command(store, { type: "rename", reviewId: sessionId, title: "Renamed" });
    await settle();
    expect(titles(tabs, "t1")).toEqual(["git-diff", "Renamed"]);
    expect(rows(bb)).toEqual([{ session_id: sessionId, thread_id: "t1" }]);

    await new Promise((resolve) => setTimeout(resolve, 2));
    await command(store, { type: "attention", reviewId: sessionId, action: "dismiss" });
    await settle();
    expect(titles(tabs, "t1")).toEqual(["git-diff"]);
    expect(rows(bb)).toEqual([]);
  });

  test("a deleted thread is forgotten; a failed write is retried on the next change", async () => {
    const { bb, store, sessionId, tabs, harness } = await opened(["t1", "gone"]);
    tabs.threads.delete("gone");
    harness.inspection.sdk.stub("threads.tabs.update", async () => {
      throw new Error("bb unavailable");
    });

    await command(store, { type: "attention", reviewId: sessionId, action: "dismiss" });
    await settle();
    expect(rows(bb)).toEqual([{ session_id: sessionId, thread_id: "t1" }]);
    expect(harness.inspection.logEntries).toContainEqual({
      level: "warn",
      message: `whiteboard: could not close the tab of ${sessionId} in t1: Error: bb unavailable`,
    });

    harness.inspection.sdk.stub("threads.tabs.update", tabs.sdk.threads.tabs.update);
    await command(store, { type: "attention", reviewId: sessionId, action: "view" });
    await settle();
    expect(titles(tabs, "t1")).toEqual(["git-diff"]);
    expect(rows(bb)).toEqual([]);
  });

  test("after unsubscribe nothing follows the store", async () => {
    const { store, sessionId, tabs, stop, harness } = await opened(["t1"]);
    stop();
    const reads = harness.inspection.sdk.calls.length;

    await command(store, { type: "rename", reviewId: sessionId, title: "Renamed" });
    await settle();

    expect(titles(tabs, "t1")).toEqual(["git-diff", "Plan"]);
    expect(harness.inspection.sdk.calls).toHaveLength(reads);
  });
});
