import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCollapsedThreadsStore, withThreadCollapsed } from "../lib/collapsed-threads.ts";

interface CallArgs {
  pluginId: string;
  method: string;
  input: unknown;
  outputSchema: { parse(value: unknown): unknown };
  signal?: AbortSignal;
}

function storeOver(
  initial?: string[],
  options: Parameters<typeof createCollapsedThreadsStore>[1] = {},
) {
  let value = initial;
  let available = true;
  const writes: unknown[] = [];
  const calls: string[] = [];
  // Runs inside the next setPreference, after its value is stored.
  let afterNextWrite: ((stored: string[]) => void) | undefined;
  let hold: Promise<void> | undefined;
  const plugins = {
    async callRpc(args: CallArgs) {
      assert.equal(args.pluginId, "thread-list");
      calls.push(args.method);
      if (hold) await hold;
      if (!available) throw new Error("disabled");
      if (args.method === "listPreferences") {
        assert.equal(args.input, null);
        return args.outputSchema.parse({ preferences: value ? { collapsedThreads: value } : {} });
      }
      assert.equal(args.method, "setPreference");
      const input = args.input as { key: string; value: string[] };
      assert.equal(input.key, "collapsedThreads");
      writes.push(input);
      value = input.value;
      const race = afterNextWrite;
      afterNextWrite = undefined;
      race?.(input.value);
      return args.outputSchema.parse(input);
    },
  };
  return {
    store: createCollapsedThreadsStore(
      plugins as Parameters<typeof createCollapsedThreadsStore>[0],
      options,
    ),
    writes,
    calls,
    stored: () => value,
    externalWrite(next: string[]) {
      value = next;
    },
    raceNextWrite(race: (stored: string[]) => void) {
      afterNextWrite = race;
    },
    /** Holds every call until the returned release runs. */
    holdCalls() {
      let release!: () => void;
      hold = new Promise((resolve) => {
        release = () => {
          hold = undefined;
          resolve();
        };
      });
      return release;
    },
    disable() {
      available = false;
    },
  };
}

it("sets membership without disturbing other folds", () => {
  assert.deepEqual(withThreadCollapsed(["a", "b"], "c", true), ["a", "b", "c"]);
  assert.deepEqual(withThreadCollapsed(["a", "b", "c"], "b", false), ["a", "c"]);
  assert.deepEqual(withThreadCollapsed(["a", "b"], "b", true), ["a", "b"]);
  assert.deepEqual(withThreadCollapsed(["a"], "b", false), ["a"]);
});

describe("thread-list shared folds", () => {
  it("lists and writes persisted folds", async () => {
    const { store } = storeOver(["root"]);
    assert.deepEqual(await store.list(), ["root"]);
    assert.deepEqual(await store.set("other", true), ["root", "other"]);
    assert.deepEqual(await store.set("root", false), ["other"]);
    assert.deepEqual(await store.list(), ["other"]);
  });
  it("treats a missing key as empty and can save the first fold", async () => {
    const { store } = storeOver();
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(await store.set("root", true), ["root"]);
  });
  it("leaves a family that is already where the caller wants it", async () => {
    // Another sidebar folded it first; this window's fold must not reopen it.
    const { store, writes } = storeOver(["root"]);
    assert.deepEqual(await store.set("root", true), ["root"]);
    assert.deepEqual(await store.set("other", false), ["root"]);
    assert.deepEqual(writes, []);
  });
  it("re-reads external edits and serializes simultaneous local writes", async () => {
    const { store, externalWrite } = storeOver(["old"]);
    await store.list();
    externalWrite(["theirs"]);
    await Promise.all([store.set("mine", true), store.set("other", true)]);
    assert.deepEqual(await store.list(), ["theirs", "mine", "other"]);
  });
  it("keeps this session's last read while disabled and rejects unsaved writes", async () => {
    const { store, disable } = storeOver(["root"]);
    await store.list();
    disable();
    assert.deepEqual(await store.list(), ["root"]);
    await assert.rejects(store.read(), /disabled/);
    await assert.rejects(store.set("other", true), /disabled/);
    assert.deepEqual(await store.list(), ["root"]);
  });
  it("starts empty when thread-list is off from the first read", async () => {
    const { store, disable } = storeOver(["root"]);
    disable();
    assert.deepEqual(await store.list(), []);
  });
  it("puts a fold back when another sidebar's write overwrites it", async () => {
    // bb's sidebar read the list with this write, folded `theirs` on top of
    // what it read, and its write landed right after this one.
    const { store, writes, raceNextWrite, externalWrite } = storeOver(["old"]);
    raceNextWrite(() => externalWrite(["old", "theirs"]));
    assert.deepEqual(await store.set("mine", true), ["old", "theirs", "mine"]);
    assert.deepEqual(writes, [
      { key: "collapsedThreads", value: ["old", "mine"] },
      { key: "collapsedThreads", value: ["old", "theirs", "mine"] },
    ]);
  });
  it("reads once after a write that nothing raced", async () => {
    const { store, calls } = storeOver(["old"]);
    assert.deepEqual(await store.set("mine", true), ["old", "mine"]);
    assert.deepEqual(calls, ["listPreferences", "setPreference", "listPreferences"]);
  });
  it("stops rewriting after two attempts", async () => {
    const { store, writes, raceNextWrite, externalWrite } = storeOver([]);
    raceNextWrite(() => {
      externalWrite([]);
      raceNextWrite(() => externalWrite([]));
    });
    assert.deepEqual(await store.set("mine", true), []);
    assert.equal(writes.length, 2);
  });
  it("queues reads behind writes and reports each change once", async () => {
    const changes: (readonly string[])[] = [];
    const { store, holdCalls } = storeOver([], {
      onChange: (threadIds) => changes.push(threadIds),
    });
    await store.read();
    const release = holdCalls();
    const writing = store.set("mine", true);
    const reading = store.read();
    release();
    assert.deepEqual(await writing, ["mine"]);
    assert.deepEqual(await reading, ["mine"]);
    assert.deepEqual(changes, [["mine"]]);
  });
  it("leaves the first read as the baseline", async () => {
    const changes: (readonly string[])[] = [];
    const { store, externalWrite } = storeOver(["root"], {
      onChange: (threadIds) => changes.push(threadIds),
    });
    await store.read();
    assert.deepEqual(changes, []);
    externalWrite(["root", "theirs"]);
    await store.read();
    assert.deepEqual(changes, [["root", "theirs"]]);
  });
  it("gives up on a call that hangs once the store's lifetime ends", async () => {
    const lifetime = new AbortController();
    const { store, holdCalls } = storeOver(["root"], { signal: lifetime.signal });
    holdCalls();
    const reading = store.read();
    lifetime.abort(new Error("unloaded"));
    await assert.rejects(reading, /unloaded/);
    await assert.rejects(store.read(), /unloaded/);
  });
});
