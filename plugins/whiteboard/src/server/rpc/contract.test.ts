import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "../../shared/contracts/engine.ts";
import { migrate } from "../lib/migrations.ts";
import { createReviewApi } from "../lib/review/api.ts";
import { LocalReviewData } from "../lib/review/local-data.ts";
import { ReviewStore } from "../lib/review/store.ts";
import { installDatabase } from "../lib/sqlite.ts";
import { runWithThread } from "../lib/thread-context.ts";
import { contract, registerRpc } from "./contract.ts";
import { runOperation } from "./operation.ts";

type Producer = Parameters<BbPluginApi["rpc"]["experimental_whileWatched"]>[1];

let host: ReturnType<typeof createFakePluginHost>;
let store: ReviewStore;
let data: LocalReviewData;
let engine: Engine;
let producers: Map<string, Producer>;
let reviewId: string;

const call = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input);

beforeEach(async () => {
  host = createFakePluginHost({ pluginId: "whiteboard" });
  migrate(host.bb);
  store = new ReviewStore(installDatabase(host.bb.storage.database()), {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });
  data = new LocalReviewData(store);
  engine = {
    api: createReviewApi({ store, data }),
    run: (context, fn) => runWithThread(context, () => fn(new AbortController().signal)),
    watchWorktrees: () => store.watchWorktrees(),
  } as Engine;
  // The installed fake host records no producers; keep them to drive watches.
  producers = new Map();
  const register = host.bb.rpc.experimental_whileWatched.bind(host.bb.rpc);
  vi.spyOn(host.bb.rpc, "experimental_whileWatched").mockImplementation((method, producer) => {
    producers.set(method, producer);
    register(method, producer);
  });
  registerRpc({ bb: host.bb, engine });
  ({ reviewId } = await store.execute({
    commandId: randomUUID(),
    operation: {
      type: "create",
      source: "pins",
      title: "Plan",
      pins: { repositoryId: "repo", base: "base-commit", head: "head-commit" },
    },
  }));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await data.close();
  await store.close();
  await host.harness.dispose();
});

describe("app methods", () => {
  it("read the catalog and the live session the panel follows", async () => {
    expect(await call("sessions", { mode: "textual" })).toEqual([
      expect.objectContaining({ reviewId, title: "Plan" }),
    ]);
    expect(await call("liveSession", { sessionId: reviewId })).toMatchObject({
      reviewId,
      version: 0,
      title: "Plan",
      activity: { workingCount: 0 },
      coverageRevision: 0,
    });
    expect(await call("history", { sessionId: reviewId })).toEqual([
      { version: 0, title: "Plan", createdAt: expect.any(String) },
    ]);
  });

  it("tag live reads so a session's changes refresh only its readers", () => {
    const live = { ...store.read(reviewId), activity: store.activity.read(reviewId) };

    expect(contract.sessions.tags?.({ mode: "structural" }, [])).toEqual(["catalog"]);
    expect(
      contract.liveSession.tags?.({ sessionId: reviewId }, { ...live, coverageRevision: 0 }),
    ).toEqual([`session:${reviewId}`, "live-session"]);
  });

  it("run Home's commands and answer what the catalog then shows", async () => {
    await call("command", {
      commandId: randomUUID(),
      operation: { type: "attention", reviewId, action: "dismiss" },
    });

    expect(await call("sessions", { mode: "structural" })).toEqual([
      expect.objectContaining({ reviewId, dismissedAt: expect.any(String) }),
    ]);
  });

  it("answer a resource as base64 with its content type, only within the session's repository", async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71]);
    const repo = store.registerRepository("/checkouts/repo");
    const other = store.registerRepository("/checkouts/other");
    const { reviewId } = await store.execute({
      commandId: randomUUID(),
      operation: {
        type: "create",
        source: "pins",
        title: "Pinned",
        pins: { repositoryId: repo.id, base: "base-commit", head: "head-commit" },
      },
    });
    store.putResource("image", repo.id, "image", "image/png", bytes);
    store.putResource("elsewhere", other.id, "image", "image/png", bytes);

    expect(await call("resource", { sessionId: reviewId, resourceId: "image" })).toEqual({
      contentType: "image/png",
      base64: Buffer.from(bytes).toString("base64"),
    });
    await expect(
      call("resource", { sessionId: reviewId, resourceId: "elsewhere" }),
    ).rejects.toMatchObject({ code: "not_found", message: "Resource is outside this repository." });
  });

  it("copy a selection with its session header and bb handoff", async () => {
    const copied = await call("copyContext", {
      sessionId: reviewId,
      selection: { target: { kind: "text", quote: "the quote" }, title: "Plan" },
    });

    expect(copied).toEqual({
      text: expect.stringContaining(`Session ID: ${reviewId}`),
      handoff: { quote: "the quote", sessionId: reviewId, version: 0, title: "Plan" },
    });
  });
});

describe("failures", () => {
  it("a deleted session is not_found, not a crash", async () => {
    await expect(call("liveSession", { sessionId: "gone" })).rejects.toMatchObject({
      code: "not_found",
      message: "Review or version not found.",
    });
  });

  it("a scratchpad that is turned off is a conflict saying so", async () => {
    await expect(call("liveSession", { sessionId: "scratchpad" })).rejects.toMatchObject({
      code: "conflict",
      message: "The scratchpad is off. Turn it on in the Whiteboard plugin settings in bb.",
    });
  });

  it("strict inputs never reach an operation", async () => {
    const history = vi.spyOn(engine.api, "history");

    await expect(call("history", { sessionId: reviewId, reviewId })).rejects.toThrow(
      "rpc input validation failed",
    );
    await expect(call("sessions", {})).rejects.toThrow("rpc input validation failed");
    expect(history).not.toHaveBeenCalled();
  });

  it("an unexpected failure reaches the app by kind only", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(engine.api, "stack").mockRejectedValue(new TypeError("/private/path broke"));

    await expect(call("stack", { sessionId: reviewId })).rejects.toMatchObject({
      code: "handler_error",
      message:
        "Whiteboard operation failed (TypeError). The bb server logged the cause in server-stdio.log, in the bb server's logs folder.",
    });
  });
});

describe("answers", () => {
  it("leave out fields an operation left undefined, as JSON would", async () => {
    const answer = await runOperation({ bb: host.bb, engine }, "probe", undefined, async () => ({
      kept: 1,
      dropped: undefined,
    }));

    expect(answer).toEqual({ kept: 1 });
    expect(Object.keys(answer)).toEqual(["kept"]);
  });
});

describe("watched live reads", () => {
  it("hold worktree refresh while any read is watched, across distinct inputs", async () => {
    vi.useFakeTimers();
    const refresh = vi.spyOn(store, "refreshWorktrees");
    const refreshes = async () => {
      refresh.mockClear();
      await vi.advanceTimersByTimeAsync(3_000);
      return refresh.mock.calls.length;
    };
    const catalog = new AbortController();
    const session = new AbortController();

    expect(await refreshes()).toBe(0);
    await producers.get("sessions")!({ input: { mode: "structural" } }, catalog.signal);
    await producers.get("liveSession")!({ input: { sessionId: reviewId } }, session.signal);
    expect(await refreshes()).toBe(3);

    // One reader leaving keeps the other's refresh running.
    catalog.abort();
    expect(await refreshes()).toBe(3);

    session.abort();
    expect(await refreshes()).toBe(0);
  });

  it("ignore a watch whose input the method would refuse", async () => {
    vi.useFakeTimers();
    const refresh = vi.spyOn(store, "refreshWorktrees");

    await producers.get("liveSession")!({ input: { reviewId } }, new AbortController().signal);
    await producers.get("sessions")!({ key: "k" }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(refresh).not.toHaveBeenCalled();
  });
});
