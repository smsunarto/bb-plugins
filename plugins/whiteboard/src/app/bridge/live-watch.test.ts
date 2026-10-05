import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ApiRequest,
  type ApiResponse,
  WATCH_HEARTBEAT_MS,
} from "../../shared/contracts/api-tunnel.ts";
import { ReviewApiClient } from "../../shared/vendor/review-protocol/src/index.ts";
import {
  SAFETY_REFETCH_MS,
  changeMatches,
  type LiveHub,
  createLiveHub,
  diffLine,
  watchResponse,
  watchSubscriptions,
} from "./live-watch.ts";
import { createTunnel } from "./tunnel.ts";

const json = (value: unknown, status = 200): ApiResponse => ({
  status,
  contentType: status === 200 ? "application/x-ndjson" : "application/json",
  encoding: "utf8",
  body: `${JSON.stringify(value)}\n`,
});

/** A fake `api` RPC whose watch answer is whatever `state` holds at call time. */
function fakeRpc(initial: unknown) {
  const box = { state: initial, status: 200 };
  const calls: ApiRequest[] = [];
  const api = vi.fn(async (request: ApiRequest) => {
    calls.push(request);
    return box.status === 200 ? json(box.state) : json({ error: "Gone." }, box.status);
  });
  const interest = vi.fn(async () => ({}));
  return { box, calls, rpc: { api, interest } };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const decoder = new TextDecoder();

async function nextLine(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const { value, done } = await reader.read();
  return done ? "<done>" : decoder.decode(value);
}

/** Let queued microtasks and the fake RPC settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function open(path: string, initial: unknown, shared?: LiveHub) {
  const fake = fakeRpc(initial);
  const hub = shared ?? createLiveHub(fake.rpc);
  const abort = new AbortController();
  const response = await watchResponse({
    rpc: fake.rpc,
    threadId: "thread-1",
    path,
    signal: abort.signal,
    hub,
  });
  return { ...fake, hub, abort, response, reader: response.body!.getReader() };
}

const subscriptionsPath = (items: unknown[]) =>
  `/watch?subscriptions=${encodeURIComponent(JSON.stringify(items))}`;

describe("watchSubscriptions", () => {
  it("reads the three watch route shapes", () => {
    expect(watchSubscriptions("/watch")).toEqual([{ reviewId: null }]);
    expect(watchSubscriptions("/abc/watch")).toEqual([{ reviewId: "abc" }]);
    const subscriptions = encodeURIComponent(
      JSON.stringify([{ reviewId: "a" }, { reviewId: null }]),
    );
    expect(watchSubscriptions(`/watch?subscriptions=${subscriptions}`)).toEqual([
      { reviewId: "a" },
      { reviewId: null },
    ]);
    expect(watchSubscriptions("/watch?subscriptions=nope")).toEqual([]);
  });
});

describe("changeMatches", () => {
  const session = [{ reviewId: "a" }];
  const catalog = [{ reviewId: null }];
  it("matches review and activity by session id", () => {
    expect(changeMatches(session, { kind: "review", reviewId: "a" })).toBe(true);
    expect(changeMatches(session, { kind: "activity", reviewId: "b" })).toBe(false);
  });
  it("matches catalog changes only for catalog subscriptions", () => {
    expect(changeMatches(catalog, { kind: "catalog" })).toBe(true);
    expect(changeMatches(session, { kind: "catalog" })).toBe(false);
  });
  it("matches coverage and worktree changes for any session subscription", () => {
    expect(changeMatches(session, { kind: "coverage" })).toBe(true);
    expect(changeMatches(session, { kind: "worktree", repositoryId: "repo-1" })).toBe(true);
    expect(changeMatches(catalog, { kind: "worktree", repositoryId: "repo-1" })).toBe(false);
  });
});

describe("diffLine", () => {
  it("drops an unchanged line and nulls unchanged subscription entries", () => {
    expect(diffLine(undefined, "[1]\n")).toBe("[1]\n");
    expect(diffLine("[1]\n", "[1]\n")).toBeUndefined();
    expect(diffLine('[{"value":1},{"value":2}]\n', '[{"value":1},{"value":3}]\n')).toBe(
      '[null,{"value":3}]\n',
    );
    expect(diffLine('[{"value":1}]\n', '[{"value":1}]\n')).toBeUndefined();
    expect(diffLine('{"a":1}\n', '{"a":2}\n')).toBe('{"a":2}\n');
  });
});

describe("watchResponse", () => {
  it("sends the first read as line one, then one line per matching invalidation", async () => {
    const stream = await open("/a/watch", { version: 1 });
    expect(await nextLine(stream.reader)).toBe('{"version":1}\n');
    expect(stream.calls).toEqual([{ method: "GET", path: "/a/watch", threadId: "thread-1" }]);

    stream.box.state = { version: 2 };
    stream.hub.invalidate({ kind: "review", reviewId: "a" });
    expect(await nextLine(stream.reader)).toBe('{"version":2}\n');

    stream.box.state = { version: 3 };
    stream.hub.invalidate({ kind: "activity", reviewId: "a" });
    expect(await nextLine(stream.reader)).toBe('{"version":3}\n');
    expect(stream.calls).toHaveLength(3);
    stream.abort.abort();
  });

  it("ignores invalidations for other sessions", async () => {
    const stream = await open("/a/watch", { version: 1 });
    await nextLine(stream.reader);
    stream.hub.invalidate({ kind: "review", reviewId: "b" });
    stream.hub.invalidate({ kind: "catalog" });
    await settle();
    expect(stream.calls).toHaveLength(1);
    stream.abort.abort();
  });

  it("coalesces invalidations from one task into one read", async () => {
    const stream = await open("/a/watch", { version: 1 });
    await nextLine(stream.reader);
    stream.box.state = { version: 2 };
    stream.hub.invalidate({ kind: "review", reviewId: "a" });
    stream.hub.invalidate({ kind: "activity", reviewId: "a" });
    stream.hub.invalidate({ kind: "worktree", repositoryId: "repo-1" });
    expect(await nextLine(stream.reader)).toBe('{"version":2}\n');
    await settle();
    expect(stream.calls).toHaveLength(2);
    stream.abort.abort();
  });

  it("collapses invalidations during an in-flight read into one follow-up read", async () => {
    const stream = await open("/a/watch", { version: 1 });
    await nextLine(stream.reader);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    stream.rpc.api.mockImplementationOnce(async (request) => {
      stream.calls.push(request);
      await gate;
      return json({ version: 2 });
    });
    stream.hub.invalidate({ kind: "review", reviewId: "a" });
    await settle(); // the read is now in flight
    stream.box.state = { version: 3 };
    stream.hub.invalidate({ kind: "review", reviewId: "a" });
    stream.hub.invalidate({ kind: "review", reviewId: "a" });
    release();
    expect(await nextLine(stream.reader)).toBe('{"version":2}\n');
    expect(await nextLine(stream.reader)).toBe('{"version":3}\n');
    await settle();
    expect(stream.calls).toHaveLength(3);
    stream.abort.abort();
  });

  it("refetches once when realtime reconnects", async () => {
    const stream = await open("/watch", [{ reviewId: "a" }]);
    await nextLine(stream.reader);
    stream.box.state = [{ reviewId: "a" }, { reviewId: "b" }];
    stream.hub.reconnected();
    expect(await nextLine(stream.reader)).toBe('[{"reviewId":"a"},{"reviewId":"b"}]\n');
    expect(stream.calls).toHaveLength(2);
    stream.abort.abort();
  });

  it("sends nothing when a refetch reads the same snapshot", async () => {
    const stream = await open("/a/watch", { version: 1 });
    await nextLine(stream.reader);
    stream.hub.invalidate({ kind: "coverage" });
    await settle();
    expect(stream.calls).toHaveLength(2);
    stream.box.state = { version: 2 };
    stream.hub.invalidate({ kind: "coverage" });
    // The unchanged read produced no line, so the next line is the change.
    expect(await nextLine(stream.reader)).toBe('{"version":2}\n');
    stream.abort.abort();
  });

  it("re-reads only the subscriptions an invalidation matches", async () => {
    const catalog = { reviewId: null, mode: "textual" };
    const review = { reviewId: "a", mode: "textual" };
    const state: Record<string, unknown> = { catalog: ["a"], a: { version: 1 } };
    const calls: ApiRequest[] = [];
    // The server answers one entry per subscription the path asks for.
    const rpc = {
      api: vi.fn(async (request: ApiRequest) => {
        calls.push(request);
        const items = watchSubscriptions(request.path);
        return json(items.map((item) => ({ value: state[item.reviewId ?? "catalog"] })));
      }),
      interest: vi.fn(async () => ({})),
    };
    const hub = createLiveHub(rpc);
    const abort = new AbortController();
    const path = subscriptionsPath([catalog, review]);
    const response = await watchResponse({ rpc, path, signal: abort.signal, hub });
    const reader = response.body!.getReader();
    expect(await nextLine(reader)).toBe('[{"value":["a"]},{"value":{"version":1}}]\n');

    state.catalog = ["a", "b"];
    hub.invalidate({ kind: "catalog" });
    expect(await nextLine(reader)).toBe('[{"value":["a","b"]},null]\n');
    expect(calls.map((call) => call.path)).toEqual([path, subscriptionsPath([catalog])]);

    state.a = { version: 2 };
    hub.invalidate({ kind: "review", reviewId: "a" });
    expect(await nextLine(reader)).toBe('[null,{"value":{"version":2}}]\n');
    expect(calls.at(-1)?.path).toBe(subscriptionsPath([review]));

    hub.reconnected();
    await settle();
    expect(calls.at(-1)?.path).toBe(path);
    abort.abort();
  });

  it("re-reads in full every 5 minutes in case a change was never published", async () => {
    vi.useFakeTimers();
    const stream = await open("/a/watch", { version: 1 });
    await nextLine(stream.reader);
    stream.box.state = { version: 2 };

    vi.advanceTimersByTime(SAFETY_REFETCH_MS);

    expect(SAFETY_REFETCH_MS).toBe(300_000);
    expect(await nextLine(stream.reader)).toBe('{"version":2}\n');
    expect(stream.calls).toHaveLength(2);
    stream.abort.abort();
  });

  it("returns a non-200 first read as is", async () => {
    const fake = fakeRpc(null);
    fake.box.status = 404;
    const response = await watchResponse({
      rpc: fake.rpc,
      path: "/gone/watch",
      hub: createLiveHub(fake.rpc),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Gone." });
  });

  it("errors the stream when a refetch fails", async () => {
    const stream = await open("/a/watch", { version: 1 });
    await nextLine(stream.reader);
    stream.box.status = 404;
    stream.hub.invalidate({ kind: "review", reviewId: "a" });
    await expect(stream.reader.read()).rejects.toThrow("Gone.");
    stream.hub.invalidate({ kind: "review", reviewId: "a" });
    await settle();
    expect(stream.calls).toHaveLength(2);
  });

  it("closes on abort and stops listening", async () => {
    const stream = await open("/a/watch", { version: 1 });
    await nextLine(stream.reader);
    stream.abort.abort();
    expect(await nextLine(stream.reader)).toBe("<done>");
    stream.hub.invalidate({ kind: "review", reviewId: "a" });
    stream.hub.reconnected();
    await settle();
    expect(stream.calls).toHaveLength(1);
  });

  it("stops listening when the reader cancels", async () => {
    const stream = await open("/a/watch", { version: 1 });
    await nextLine(stream.reader);
    await stream.reader.cancel();
    stream.hub.invalidate({ kind: "review", reviewId: "a" });
    await settle();
    expect(stream.calls).toHaveLength(1);
  });
});

describe("ReviewApiClient.follow over the tunnel", () => {
  it("delivers one snapshot per invalidation and refetches on reconnect", async () => {
    const fake = fakeRpc(null);
    // follow() subscribes with `?subscriptions=`; answer one result per subscription.
    fake.rpc.api.mockImplementation(async (request: ApiRequest) => {
      fake.calls.push(request);
      return json([{ value: fake.box.state }]);
    });
    fake.box.state = [{ reviewId: "a" }];
    const hub = createLiveHub(fake.rpc);
    const request = createTunnel({ rpc: fake.rpc, hub });
    const client = new ReviewApiClient({ serverUrl: "http://127.0.0.1:1", token: "" }, request);
    const seen: unknown[] = [];
    const abort = new AbortController();
    void client.follow(
      null,
      abort.signal,
      (snapshot) => void seen.push(snapshot),
      () => {},
      "textual",
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(fake.calls[0]?.path).toBe(
      `/watch?subscriptions=${encodeURIComponent(JSON.stringify([{ reviewId: null, mode: "textual" }]))}`,
    );

    fake.box.state = [{ reviewId: "a" }, { reviewId: "b" }];
    hub.invalidate({ kind: "catalog" });
    await vi.waitFor(() => expect(seen).toHaveLength(2));

    fake.box.state = [];
    hub.reconnected();
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    expect(seen).toEqual([[{ reviewId: "a" }], [{ reviewId: "a" }, { reviewId: "b" }], []]);
    abort.abort();
  });
});

describe("the hub's interest heartbeat", () => {
  it("renews once per beat for the whole mount, without reading any snapshot", async () => {
    vi.useFakeTimers();
    const interest = vi.fn(async () => ({}));
    const hub = createLiveHub({ interest });
    const first = await open("/a/watch", { version: 1 }, hub);
    const second = await open("/watch", [], hub);

    vi.advanceTimersByTime(60_000);

    expect(WATCH_HEARTBEAT_MS).toBe(30_000);
    expect(interest).toHaveBeenCalledTimes(2);
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);

    first.abort.abort();
    second.abort.abort();
    vi.advanceTimersByTime(60_000);
    expect(interest).toHaveBeenCalledTimes(2);
  });

  it("renews nothing while the document is hidden, and once when it shows again", async () => {
    vi.useFakeTimers();
    const document = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    vi.stubGlobal("document", document);
    const stream = await open("/a/watch", { version: 1 });

    vi.advanceTimersByTime(SAFETY_REFETCH_MS);
    expect(stream.rpc.interest).toHaveBeenCalledTimes(0);
    expect(stream.calls).toHaveLength(1);

    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stream.rpc.interest).toHaveBeenCalledTimes(1);
    stream.abort.abort();
  });
});
