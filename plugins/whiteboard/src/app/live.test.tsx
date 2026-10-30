// @vitest-environment jsdom
import { experimental_PluginRpcCallError as PluginRpcCallError } from "@get-bb/plugin-sdk/app";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CATALOG_TAG, LIVE_SESSION_TAG, sessionTag } from "../shared/contracts/rpc.ts";
import { contract } from "../server/rpc/contract.ts";
import { fakeLiveRead } from "./live-test-utils.ts";
import { ACCEPT_RETRY_MS, FIRST_RETRY_MS, followLive, liveContract, useLiveRead } from "./live.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** An `accept` the test releases, so deliveries can land while one runs. */
function gatedAccept<T>() {
  const accepted: T[] = [];
  const releases: Array<() => void> = [];
  let running = 0;
  let overlap = 0;
  const accept = async (value: T) => {
    running++;
    overlap = Math.max(overlap, running);
    accepted.push(value);
    await new Promise<void>((resolve) => releases.push(resolve));
    running--;
  };
  return {
    accept,
    accepted,
    release: async () => {
      releases.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    },
    maxOverlap: () => overlap,
  };
}

describe("followLive", () => {
  it("delivers the current answer at once, one accept at a time, keeping only the newest", async () => {
    const live = fakeLiveRead<number>();
    live.push(1);
    const gate = gatedAccept<number>();
    followLive(live.read, new AbortController().signal, gate.accept, () => {});
    expect(gate.accepted).toEqual([1]);

    live.push(2);
    live.push(3);
    live.push(4);
    expect(gate.accepted).toEqual([1]);
    await gate.release();
    expect(gate.accepted).toEqual([1, 4]);
    await gate.release();
    expect(gate.accepted).toEqual([1, 4]);
    expect(gate.maxOverlap()).toBe(1);
  });

  it("reports each read failure once, then delivers the next answer", () => {
    const live = fakeLiveRead<number>();
    const accepted: number[] = [];
    const reported: unknown[] = [];
    followLive(
      live.read,
      new AbortController().signal,
      (value) => void accepted.push(value),
      (cause) => reported.push(cause),
    );
    const offline = new Error("Host offline");
    live.fail(offline);
    live.push(2);
    expect(reported).toEqual([offline]);
    expect(accepted).toEqual([2]);
  });

  it("reports a failure after the running accept and drops the answer it superseded", async () => {
    const live = fakeLiveRead<number>();
    live.push(1);
    const gate = gatedAccept<number>();
    const events: unknown[] = [];
    followLive(live.read, new AbortController().signal, gate.accept, (cause) => {
      events.push(cause);
    });
    live.push(2);
    const gone = new PluginRpcCallError({ code: "not_found", message: "Whiteboard not found." });
    live.fail(gone);
    expect(events).toEqual([]);
    await gate.release();
    expect(events).toEqual([gone]);
    expect(gate.accepted).toEqual([1]);
  });

  it("retries a failed accept after a second unless a newer answer arrived", async () => {
    vi.useFakeTimers();
    const live = fakeLiveRead<number>();
    const attempts: number[] = [];
    const reported: unknown[] = [];
    let failing = true;
    followLive(
      live.read,
      new AbortController().signal,
      async (value) => {
        attempts.push(value);
        if (failing) throw new Error("render failed");
      },
      (cause) => reported.push(cause),
    );
    live.push(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(reported).toHaveLength(1);
    failing = false;
    await vi.advanceTimersByTimeAsync(ACCEPT_RETRY_MS);
    expect(attempts).toEqual([1, 1]);

    failing = true;
    live.push(2);
    await vi.advanceTimersByTimeAsync(0);
    failing = false;
    live.push(3);
    await vi.advanceTimersByTimeAsync(ACCEPT_RETRY_MS);
    expect(attempts).toEqual([1, 1, 2, 3]);
  });

  it("stops at abort: no accept for a waiting answer, no report, no listener", async () => {
    const live = fakeLiveRead<number>();
    const gate = gatedAccept<number>();
    const reported: unknown[] = [];
    const abort = new AbortController();
    followLive(live.read, abort.signal, gate.accept, (cause) => reported.push(cause));
    live.push(1);
    live.push(2);
    abort.abort();
    await gate.release();
    live.push(3);
    live.fail(new Error("late"));
    expect(gate.accepted).toEqual([1]);
    expect(reported).toEqual([]);
    expect(live.followers()).toBe(0);
  });

  it("keeps delivering when the consumer's failure handler throws", () => {
    const live = fakeLiveRead<number>();
    const accepted: number[] = [];
    followLive(
      live.read,
      new AbortController().signal,
      (value) => void accepted.push(value),
      () => {
        throw new Error("handler bug");
      },
    );
    live.fail(new Error("offline"));
    live.push(1);
    expect(accepted).toEqual([1]);
  });
});

describe("the live reads' contract", () => {
  it("validates and tags each read as the server's contract does", () => {
    expect(liveContract.sessions.input).toBe(contract.sessions.input);
    expect(liveContract.liveSession.input).toBe(contract.liveSession.input);
    const answer = { reviewId: "canonical-id" } as never;
    const input = { sessionId: "canonical-id" };
    expect(liveContract.sessions.tags()).toEqual(contract.sessions.tags!({ mode: "textual" }, []));
    expect(liveContract.liveSession.tags(input, answer)).toEqual(
      contract.liveSession.tags!(input, answer),
    );
  });
});

/** What a follower saw, in order: `v<version>` per answer, `error <code>` per failure. */
let seen: string[] = [];

function SessionProbe({ sessionId }: { sessionId: string }) {
  const read = useLiveRead("liveSession", { sessionId });
  useEffect(() => {
    const abort = new AbortController();
    followLive(
      read,
      abort.signal,
      (snapshot) => void seen.push(`${snapshot.reviewId} v${snapshot.version}`),
      (cause) => void seen.push(`error ${cause instanceof PluginRpcCallError ? cause.code : ""}`),
    );
    return () => abort.abort();
  }, [read]);
  return null;
}

function CatalogProbe() {
  const read = useLiveRead("sessions", { mode: "textual" });
  useEffect(() => {
    const abort = new AbortController();
    followLive(
      read,
      abort.signal,
      (rows) => void seen.push(rows.map((row) => row.title).join(",")),
      () => {},
    );
    return () => abort.abort();
  }, [read]);
  return null;
}

/** The server's live session answers, one version per session, and its failures. */
function serverSessions() {
  const versions = new Map<string, number>([
    ["a", 0],
    ["b", 0],
  ]);
  let failure: PluginRpcCallError | undefined;
  return {
    versions,
    fail(error: PluginRpcCallError | undefined) {
      failure = error;
    },
    rpc: {
      liveSession: async (input: unknown) => {
        const { sessionId } = input as { sessionId: string };
        if (failure) throw failure;
        return { reviewId: sessionId, version: versions.get(sessionId) } as never;
      },
    },
  };
}

const liveSessionCalls = (slot: ReturnType<typeof renderSlot>) =>
  slot.inspection.rpcCalls.filter((call) => call.method === "liveSession");

describe("useLiveRead over the SDK's live reads", () => {
  it("answers first, then once per invalidation of the session's own tags", async () => {
    seen = [];
    const server = serverSessions();
    const slot = renderSlot({ component: SessionProbe }, { sessionId: "a" }, { rpc: server.rpc });
    await waitFor(() => expect(seen).toEqual(["a v0"]));

    server.versions.set("a", 1);
    await slot.behavior.experimental_invalidateRpc([sessionTag("a")]);
    await waitFor(() => expect(seen).toEqual(["a v0", "a v1"]));

    // Coverage moved: every live session re-reads.
    server.versions.set("a", 2);
    await slot.behavior.experimental_invalidateRpc([LIVE_SESSION_TAG]);
    await waitFor(() => expect(seen).toEqual(["a v0", "a v1", "a v2"]));

    const calls = liveSessionCalls(slot).length;
    await slot.behavior.experimental_invalidateRpc([sessionTag("b"), CATALOG_TAG]);
    expect(liveSessionCalls(slot)).toHaveLength(calls);
  });

  it("delivers nothing when a re-read answers the same snapshot", async () => {
    seen = [];
    const server = serverSessions();
    const slot = renderSlot({ component: SessionProbe }, { sessionId: "a" }, { rpc: server.rpc });
    await waitFor(() => expect(seen).toEqual(["a v0"]));
    await slot.behavior.experimental_invalidateRpc([sessionTag("a")]);
    await waitFor(() => expect(liveSessionCalls(slot)).toHaveLength(2));
    expect(seen).toEqual(["a v0"]);
  });

  it("follows the catalog's invalidations", async () => {
    seen = [];
    let titles = ["Plan"];
    const slot = renderSlot(
      { component: CatalogProbe },
      {},
      { rpc: { sessions: async () => titles.map((title) => ({ title })) as never } },
    );
    await waitFor(() => expect(seen).toEqual(["Plan"]));
    titles = ["Plan", "Review"];
    await slot.behavior.experimental_invalidateRpc([CATALOG_TAG]);
    await waitFor(() => expect(seen).toEqual(["Plan", "Plan,Review"]));
  });

  it("reports a terminal refusal once and stops reading", async () => {
    seen = [];
    const server = serverSessions();
    server.fail(new PluginRpcCallError({ code: "not_found", message: "Session not found." }));
    const slot = renderSlot({ component: SessionProbe }, { sessionId: "a" }, { rpc: server.rpc });
    await waitFor(() => expect(seen).toEqual(["error not_found"]));
    await slot.behavior.experimental_invalidateRpc([sessionTag("a"), LIVE_SESSION_TAG]);
    await slot.behavior.experimental_invalidateRpc(null);
    await new Promise((resolve) => setTimeout(resolve, FIRST_RETRY_MS + 200));
    expect(liveSessionCalls(slot)).toHaveLength(1);
    expect(seen).toEqual(["error not_found"]);
  });

  it("retries a failed read and re-delivers the answer once it recovers", async () => {
    seen = [];
    const server = serverSessions();
    const slot = renderSlot({ component: SessionProbe }, { sessionId: "a" }, { rpc: server.rpc });
    await waitFor(() => expect(seen).toEqual(["a v0"]));

    server.fail(new PluginRpcCallError({ code: "conflict", message: "Host offline." }));
    await slot.behavior.experimental_invalidateRpc([sessionTag("a")]);
    await waitFor(() => expect(seen).toEqual(["a v0", "error conflict"]));
    server.fail(undefined);
    // The same snapshot again: followers learn the read recovered.
    await waitFor(() => expect(seen).toEqual(["a v0", "error conflict", "a v0"]), {
      timeout: FIRST_RETRY_MS + 1000,
    });
    expect(liveSessionCalls(slot)).toHaveLength(3);
  });

  it("follows only the session it now shows after the input changes", async () => {
    seen = [];
    const server = serverSessions();
    const slot = renderSlot({ component: SessionProbe }, { sessionId: "a" }, { rpc: server.rpc });
    await waitFor(() => expect(seen).toEqual(["a v0"]));
    slot.lifecycle.rerender(<SessionProbe sessionId="b" />);
    await waitFor(() => expect(seen).toEqual(["a v0", "b v0"]));

    server.versions.set("a", 1);
    await slot.behavior.experimental_invalidateRpc([sessionTag("a")]);
    server.versions.set("b", 1);
    await slot.behavior.experimental_invalidateRpc([sessionTag("b")]);
    await waitFor(() => expect(seen).toEqual(["a v0", "b v0", "b v1"]));
  });
});
