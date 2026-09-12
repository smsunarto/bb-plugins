import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COLLAPSED_THREADS_KEY,
  createCollapsedThreadsStore,
  toggleThreadId,
} from "../lib/collapsed-threads.ts";
import { collapsedThreadsMatch } from "../hooks/use-collapsed-threads.ts";

/** bb's uiPreferences area, reduced to the one key and its revision check. */
function fakeUiPreferences(initial: readonly string[]) {
  const state = { revision: 1, value: [...initial] };
  const writes: { key: string; expectedRevision: number; value: readonly string[] }[] = [];
  const preferences = {
    /** Bumps the revision as if bb's own sidebar had written in between. */
    bump(value: readonly string[]) {
      state.revision += 1;
      state.value = [...value];
    },
    writes,
    async list() {
      return {
        preferences: {
          [COLLAPSED_THREADS_KEY]: { revision: state.revision, value: [...state.value] },
        },
      };
    },
    async set(args: { key: string; expectedRevision: number; value: string[] }) {
      writes.push(args);
      if (args.expectedRevision !== state.revision) {
        throw new Error(`revision ${args.expectedRevision} is stale`);
      }
      state.revision += 1;
      state.value = [...args.value];
      return { key: args.key, revision: state.revision, value: [...state.value] };
    },
  };
  return preferences;
}

function storeOver(initial: readonly string[]) {
  const preferences = fakeUiPreferences(initial);
  // The fake carries `bump` and `writes`; the store only sees list and set.
  const store = createCollapsedThreadsStore(
    preferences as unknown as Parameters<typeof createCollapsedThreadsStore>[0],
  );
  return { preferences, store };
}

describe("toggleThreadId", () => {
  it("adds a missing id and removes a present one, keeping the rest in order", () => {
    assert.deepEqual(toggleThreadId(["a", "b"], "c"), ["a", "b", "c"]);
    assert.deepEqual(toggleThreadId(["a", "b", "c"], "b"), ["a", "c"]);
  });
});

describe("collapsedThreadsMatch", () => {
  it("matches the same ids in any order and nothing else", () => {
    assert.equal(collapsedThreadsMatch(new Set(["a", "b"]), ["b", "a"]), true);
    assert.equal(collapsedThreadsMatch(new Set(["a", "b"]), ["a"]), false);
    assert.equal(collapsedThreadsMatch(new Set(["a"]), ["a", "b"]), false);
    assert.equal(collapsedThreadsMatch(new Set(), []), true);
  });
});

describe("createCollapsedThreadsStore", () => {
  it("lists bb's sidebar.collapsedThreads value", async () => {
    const { store } = storeOver(["root"]);
    assert.deepEqual(await store.list(), ["root"]);
  });

  it("writes a toggle against the revision it read", async () => {
    const { preferences, store } = storeOver(["root"]);
    assert.deepEqual(await store.toggle("other"), ["root", "other"]);
    assert.deepEqual(await store.toggle("root"), ["other"]);
    assert.deepEqual(
      preferences.writes.map((write) => [write.key, write.expectedRevision, write.value]),
      [
        [COLLAPSED_THREADS_KEY, 1, ["root", "other"]],
        [COLLAPSED_THREADS_KEY, 2, ["other"]],
      ],
    );
  });

  it("re-reads and retries when bb's own sidebar wrote first", async () => {
    const { preferences, store } = storeOver(["root"]);
    const original = preferences.set.bind(preferences);
    let intercepted = false;
    preferences.set = async (args) => {
      if (!intercepted) {
        // Another writer lands between this store's read and its write.
        intercepted = true;
        preferences.bump(["theirs"]);
      }
      return original(args);
    };
    assert.deepEqual(await store.toggle("mine"), ["theirs", "mine"]);
    assert.deepEqual(await store.list(), ["theirs", "mine"]);
  });

  it("gives up after repeated stale revisions", async () => {
    const { preferences, store } = storeOver([]);
    preferences.set = async () => {
      throw new Error("stale");
    };
    await assert.rejects(store.toggle("a"), /stale/);
  });
});
