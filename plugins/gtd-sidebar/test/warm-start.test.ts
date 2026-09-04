import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeWarmStartProviders,
  decodeWarmStartRows,
  encodeWarmStartProviders,
  encodeWarmStartRows,
  readWarmStartProviders,
  readWarmStartRows,
  resetWarmStartMemoryForTests,
  writeWarmStartProviders,
  writeWarmStartRows,
  MAX_WARM_START_ENTRY_CHARS,
  MAX_WARM_START_ROWS,
  WARM_START_PROVIDERS_KEY,
  WARM_START_ROWS_KEY,
  type WarmStartProvider,
  type WarmStartStorage,
} from "../lib/warm-start.ts";
import type { ThreadLifecycleRow } from "../lib/lifecycle.ts";

const row = (overrides: Partial<ThreadLifecycleRow> = {}): ThreadLifecycleRow => ({
  threadId: "thr_1",
  snoozedUntil: null,
  snoozedAt: null,
  ...overrides,
});

interface FakeStorage extends WarmStartStorage {
  entries: Map<string, string>;
}

function storage(seed: Record<string, string> = {}): FakeStorage {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

// Private mode, a disabled store, an exhausted quota: every one of them throws
// out of the plain property access, not out of a promise.
const brokenStorage: WarmStartStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("decodeWarmStartRows", () => {
  // Newest park first, because that is the order the cap keeps. Order is not
  // load-bearing anywhere else: the hook rebuilds a Map from these.
  it("round-trips what encodeWarmStartRows wrote", () => {
    const older = row({ threadId: "a", snoozedUntil: 9_000, snoozedAt: 500 });
    const newer = row({ threadId: "b", snoozedUntil: 9_000, snoozedAt: 700 });
    assert.deepEqual(decodeWarmStartRows(encodeWarmStartRows([older, newer])), [newer, older]);
  });

  it("reads nothing stored as a miss", () => {
    assert.equal(decodeWarmStartRows(null), null);
  });

  it("reads unparseable text as a miss", () => {
    assert.equal(decodeWarmStartRows("{not json"), null);
    assert.equal(decodeWarmStartRows(""), null);
  });

  it("reads a payload that is not an array as a miss", () => {
    assert.equal(decodeWarmStartRows(`{"threadId":"a"}`), null);
    assert.equal(decodeWarmStartRows("null"), null);
    assert.equal(decodeWarmStartRows("42"), null);
  });

  // Having nothing parked is the common case, so reading it as a miss would
  // hold the list blank on every start for most users.
  it("keeps a hit with no rows apart from a miss", () => {
    assert.deepEqual(decodeWarmStartRows("[]"), []);
  });

  it("rejects a row without a usable thread id", () => {
    assert.equal(decodeWarmStartRows(`[{"threadId":7}]`), null);
    assert.equal(decodeWarmStartRows(`[{"threadId":"  "}]`), null);
    assert.equal(decodeWarmStartRows(`[{"snoozedAt":500}]`), null);
  });

  it("rejects an entry that is not an object", () => {
    assert.equal(decodeWarmStartRows(`["thr_1"]`), null);
    assert.equal(decodeWarmStartRows("[null]"), null);
    assert.equal(decodeWarmStartRows("[[]]"), null);
  });

  it("rejects a timestamp the wire could not have produced", () => {
    assert.equal(decodeWarmStartRows(`[{"threadId":"a","snoozedAt":0}]`), null);
    assert.equal(decodeWarmStartRows(`[{"threadId":"a","snoozedAt":-1}]`), null);
    assert.equal(decodeWarmStartRows(`[{"threadId":"a","snoozedAt":1.5}]`), null);
    assert.equal(decodeWarmStartRows(`[{"threadId":"a","snoozedAt":"500"}]`), null);
  });

  // `1e999` parses to Infinity, which passes `typeof x === "number"` and then
  // never elapses: the thread stays hidden for good and the slim row prints
  // "Infinityd". `-1e999` fails the other way, waking it the moment it is read.
  // NaN is not tested because it cannot arrive — JSON has no literal for it.
  it("rejects a non-finite timestamp", () => {
    assert.equal(decodeWarmStartRows(`[{"threadId":"a","snoozedUntil":1e999}]`), null);
    assert.equal(decodeWarmStartRows(`[{"threadId":"a","snoozedUntil":-1e999}]`), null);
  });

  it("reads an absent timestamp as null", () => {
    assert.deepEqual(decodeWarmStartRows(`[{"threadId":"a"}]`), [row({ threadId: "a" })]);
  });

  // Rows written before settle became bb's archive carry a `settledAt`. The
  // key is unchanged because such a row decodes into one with no snooze, which
  // the shelves read as active until the mount read replaces it.
  it("ignores a settledAt an older version wrote", () => {
    assert.deepEqual(decodeWarmStartRows(`[{"threadId":"a","settledAt":500}]`), [
      row({ threadId: "a" }),
    ]);
  });

  // A half-accepted cache claims to know the shelves and is wrong about them;
  // a miss simply waits for the read.
  it("rejects the whole payload when one row is bad", () => {
    assert.equal(
      decodeWarmStartRows(`[{"threadId":"a","snoozedAt":500},{"threadId":"b","snoozedAt":true}]`),
      null,
    );
  });

  // Not written through `encodeWarmStartRows`, which caps: over the cap is a
  // shape only something other than this plugin can have written.
  it("rejects more rows than the encoder would ever write", () => {
    const rows = Array.from({ length: MAX_WARM_START_ROWS + 1 }, (_, index) =>
      row({ threadId: `thr_${index}`, snoozedUntil: 9_000_000, snoozedAt: index + 1 }),
    );
    assert.equal(decodeWarmStartRows(JSON.stringify(rows)), null);
    assert.notEqual(decodeWarmStartRows(JSON.stringify(rows.slice(0, MAX_WARM_START_ROWS))), null);
  });

  // The parse runs during render, so its cost is bounded before it is paid.
  it("rejects an entry too long to be worth parsing", () => {
    const oversized = `["${"a".repeat(MAX_WARM_START_ENTRY_CHARS)}"]`;
    assert.equal(oversized.length > MAX_WARM_START_ENTRY_CHARS, true);
    assert.equal(decodeWarmStartRows(oversized), null);
  });
});

describe("encodeWarmStartRows", () => {
  it("writes an array, which is the only shape that survives the trip", () => {
    assert.equal(
      encodeWarmStartRows([row({ threadId: "a", snoozedUntil: 9_000, snoozedAt: 500 })]),
      `[{"threadId":"a","snoozedUntil":9000,"snoozedAt":500}]`,
    );
  });

  it("carries only the three fields a row is made of", () => {
    const encoded = encodeWarmStartRows([
      { ...row({ threadId: "a" }), extra: "leak" } as ThreadLifecycleRow,
    ]);
    assert.equal(encoded.includes("leak"), false);
  });

  // `thread.deleted` only fires while the plugin runs, so rows outlive the
  // threads they name and nothing else prunes the entry. Past the cap the tail
  // does not warm-start and flickers exactly as it did before this cache.
  it("caps the entry and keeps the newest parks", () => {
    const rows = Array.from({ length: MAX_WARM_START_ROWS + 2 }, (_, index) =>
      row({ threadId: `thr_${index}`, snoozedUntil: 9_000_000, snoozedAt: index + 1 }),
    );
    const kept = decodeWarmStartRows(encodeWarmStartRows(rows));
    assert.equal(kept?.length, MAX_WARM_START_ROWS);
    assert.equal(kept?.[0]?.threadId, `thr_${MAX_WARM_START_ROWS + 1}`);
  });

  // A wake time is absolute and in the future — "Next week" is about now+7d —
  // so ranking on it would put a month-old snooze above one made seconds ago,
  // in the one order whose whole job is to say which snooze is newest.
  it("ranks a snooze by when it was made, not by when it ends", () => {
    const shortRecent = row({ threadId: "a", snoozedUntil: 2_000, snoozedAt: 1_000 });
    const longOld = row({ threadId: "b", snoozedUntil: 9_000, snoozedAt: 500 });
    const kept = decodeWarmStartRows(encodeWarmStartRows([longOld, shortRecent]));
    assert.deepEqual(
      kept?.map((entry) => entry.threadId),
      ["a", "b"],
    );
  });

  // Where that ordering stops being a quibble: ranked on the wake time, a full
  // cap of long snoozes would evict the one the user just made.
  it("keeps a fresh short snooze over a full cap of long snoozes", () => {
    const snoozes = Array.from({ length: MAX_WARM_START_ROWS }, (_, index) =>
      row({
        threadId: `snoozed_${index}`,
        snoozedUntil: 9_000_000 + index,
        snoozedAt: 1_000 + index,
      }),
    );
    const kept = decodeWarmStartRows(
      encodeWarmStartRows([
        ...snoozes,
        row({ threadId: "fresh", snoozedUntil: 9_000, snoozedAt: 8_000 }),
      ]),
    );
    assert.equal(kept?.length, MAX_WARM_START_ROWS);
    assert.equal(kept?.[0]?.threadId, "fresh");
  });
});

describe("readWarmStartRows", () => {
  it("serves what was stored", () => {
    resetWarmStartMemoryForTests();
    const store = storage({
      [WARM_START_ROWS_KEY]: encodeWarmStartRows([
        row({ threadId: "a", snoozedUntil: 9_000, snoozedAt: 500 }),
      ]),
    });
    assert.deepEqual(readWarmStartRows(store), [
      row({ threadId: "a", snoozedUntil: 9_000, snoozedAt: 500 }),
    ]);
  });

  it("does not throw when the store does", () => {
    resetWarmStartMemoryForTests();
    assert.equal(readWarmStartRows(brokenStorage), null);
    assert.equal(readWarmStartRows(null), null);
  });

  // The tier that fixes the remount is the one that does not need a store at
  // all, so a store that refuses every call must not disable the cache.
  it("still serves from memory after the store failed", () => {
    resetWarmStartMemoryForTests();
    writeWarmStartRows(
      [row({ threadId: "a", snoozedUntil: 9_000, snoozedAt: 500 })],
      brokenStorage,
    );
    assert.deepEqual(readWarmStartRows(brokenStorage), [
      row({ threadId: "a", snoozedUntil: 9_000, snoozedAt: 500 }),
    ]);
  });

  // Memory before storage is the decision the two tiers rest on: a `setItem`
  // that threw leaves the store holding the older value, and reading the store
  // first would serve that back over the write that did succeed. Mutating the
  // entry behind the cache is what a storage-first read would see.
  it("prefers the memory tier over what the store holds", () => {
    resetWarmStartMemoryForTests();
    const store = storage();
    writeWarmStartRows([row({ threadId: "a", snoozedUntil: 9_000, snoozedAt: 500 })], store);
    store.entries.set(
      WARM_START_ROWS_KEY,
      encodeWarmStartRows([row({ threadId: "b", snoozedUntil: 9_000, snoozedAt: 900 })]),
    );
    assert.deepEqual(readWarmStartRows(store), [
      row({ threadId: "a", snoozedUntil: 9_000, snoozedAt: 500 }),
    ]);
  });

  // The seed runs inside a render, so a value that cannot be decoded must not
  // sit there waiting to be re-read on every mount the origin ever hosts.
  it("drops an entry that did not decode", () => {
    resetWarmStartMemoryForTests();
    const store = storage({ [WARM_START_ROWS_KEY]: "{not json" });
    assert.equal(readWarmStartRows(store), null);
    assert.equal(store.entries.has(WARM_START_ROWS_KEY), false);
  });

  it("ignores an entry written under another version's key", () => {
    resetWarmStartMemoryForTests();
    assert.equal(WARM_START_ROWS_KEY, "gtd-sidebar:v1:lifecycle-rows");
    const store = storage({
      "gtd-sidebar:v0:lifecycle-rows": encodeWarmStartRows([
        row({ threadId: "a", snoozedUntil: 9_000, snoozedAt: 500 }),
      ]),
    });
    assert.equal(readWarmStartRows(store), null);
  });
});

describe("writeWarmStartRows", () => {
  it("does not throw when the store does", () => {
    resetWarmStartMemoryForTests();
    writeWarmStartRows([row()], brokenStorage);
    writeWarmStartRows([row()], null);
  });

  it("writes under the versioned key", () => {
    resetWarmStartMemoryForTests();
    const store = storage();
    writeWarmStartRows([row({ threadId: "a", snoozedUntil: 9_000, snoozedAt: 500 })], store);
    assert.deepEqual(decodeWarmStartRows(store.entries.get(WARM_START_ROWS_KEY) ?? null), [
      row({ threadId: "a", snoozedUntil: 9_000, snoozedAt: 500 }),
    ]);
  });

  // The plugin shipped as t3sidebar, and bb installs the renamed one under a
  // new id — so the old install's keys are left on an origin nothing else will
  // ever sweep. A write is what proves the store takes writes at all, so it is
  // where the sweep goes.
  it("retires the keys written under the old name", () => {
    resetWarmStartMemoryForTests();
    const store = storage({
      "t3sidebar:v1:lifecycle-rows": encodeWarmStartRows([row()]),
      "t3sidebar:v1:providers": "[]",
    });
    writeWarmStartRows([row({ threadId: "a", snoozedUntil: 9_000, snoozedAt: 500 })], store);
    assert.equal(store.entries.has("t3sidebar:v1:lifecycle-rows"), false);
    assert.equal(store.entries.has("t3sidebar:v1:providers"), false);
    assert.equal(store.entries.has(WARM_START_ROWS_KEY), true);
  });

  // A store that refused the write is one where freeing those two entries is
  // worth the most, so the sweep is not spent on the attempt that failed.
  it("leaves the old keys for the next write when the store refuses", () => {
    resetWarmStartMemoryForTests();
    const store = storage({ "t3sidebar:v1:providers": "[]" });
    let refusing = true;
    const flaky: FakeStorage = {
      ...store,
      setItem: (key, value) => {
        if (refusing) throw new Error("quota");
        store.setItem(key, value);
      },
    };
    writeWarmStartRows([row()], flaky);
    assert.equal(store.entries.has("t3sidebar:v1:providers"), true);
    refusing = false;
    writeWarmStartRows([row()], flaky);
    assert.equal(store.entries.has("t3sidebar:v1:providers"), false);
  });

  // A quota that filled once frees again. Deduping the repeat write against
  // memory — which holds the value the store refused — would call it done and
  // never offer it to the store again, so every later page load would seed
  // from the stale entry: the cold start this cache exists for, broken for
  // good by one transient throw.
  it("offers a refused value to the store again", () => {
    resetWarmStartMemoryForTests();
    const rows = [row({ threadId: "a", snoozedUntil: 9_000, snoozedAt: 500 })];
    const store = storage();
    let refusing = true;
    const flaky: FakeStorage = {
      ...store,
      setItem: (key, value) => {
        if (refusing) throw new Error("quota");
        store.setItem(key, value);
      },
    };
    writeWarmStartRows(rows, flaky);
    assert.equal(store.entries.has(WARM_START_ROWS_KEY), false);

    refusing = false;
    writeWarmStartRows(rows, flaky);
    assert.deepEqual(decodeWarmStartRows(store.entries.get(WARM_START_ROWS_KEY) ?? null), rows);
  });
});

const provider = { id: "codex", displayName: "Codex", logoUrl: null };

describe("decodeWarmStartProviders", () => {
  it("round-trips providers", () => {
    assert.deepEqual(decodeWarmStartProviders(encodeWarmStartProviders([provider])), [provider]);
  });

  it("reads a miss as null", () => {
    assert.equal(decodeWarmStartProviders(null), null);
    assert.equal(decodeWarmStartProviders("{not json"), null);
    assert.equal(decodeWarmStartProviders(`{"id":"codex"}`), null);
  });

  it("rejects a provider with no name to fall back to", () => {
    assert.equal(decodeWarmStartProviders(`[{"id":"codex"}]`), null);
    assert.equal(decodeWarmStartProviders(`[{"displayName":"Codex"}]`), null);
  });

  // `ProviderGlyph` falls back with `??`, which an empty string passes through
  // — leaving a `role="img"` element whose accessible name is empty, announced
  // as an image with no name at all.
  it("rejects a provider whose name is blank", () => {
    assert.equal(decodeWarmStartProviders(`[{"id":"codex","displayName":""}]`), null);
    assert.equal(decodeWarmStartProviders(`[{"id":"codex","displayName":"   "}]`), null);
  });

  // The glyph paints the logo as a CSS mask and probes it with an `Image`, so
  // a poisoned entry would fetch from an arbitrary host on every render of
  // every row.
  it("drops a logo that is not a same-origin path", () => {
    const decoded = decodeWarmStartProviders(
      `[{"id":"codex","displayName":"Codex","logoUrl":"https://evil.test/x.svg"},
        {"id":"amp","displayName":"Amp","logoUrl":"//evil.test/x.svg"},
        {"id":"claude","displayName":"Claude","logoUrl":"/api/v1/logo"}]`,
    );
    assert.deepEqual(
      decoded?.map((entry) => entry.logoUrl),
      [null, null, "/api/v1/logo"],
    );
  });

  // One leading slash is not a same-origin test. URL parsing reads a backslash
  // as a slash, so this value resolves to https://evil.test/x.svg.
  it("drops a path that resolves onto another host", () => {
    const decoded = decodeWarmStartProviders(
      String.raw`[{"id":"codex","displayName":"Codex","logoUrl":"/\\evil.test/x.svg"}]`,
    );
    assert.deepEqual(
      decoded?.map((entry) => entry.logoUrl),
      [null],
    );
  });

  // The value is interpolated into `url("…")`. A quote and a parenthesis close
  // that token and open a second mask layer, which the browser fetches.
  it("drops a path carrying the characters that end a CSS token", () => {
    const decoded = decodeWarmStartProviders(
      `[{"id":"codex","displayName":"Codex","logoUrl":"/x.svg\\"), url(\\"https://evil.test/beacon.svg"}]`,
    );
    assert.deepEqual(
      decoded?.map((entry) => entry.logoUrl),
      [null],
    );
  });

  it("rejects an entry too long to be worth parsing", () => {
    const oversized = `["${"a".repeat(MAX_WARM_START_ENTRY_CHARS)}"]`;
    assert.equal(decodeWarmStartProviders(oversized), null);
  });
});

describe("encodeWarmStartProviders", () => {
  it("carries only the three fields the glyph reads", () => {
    const encoded = encodeWarmStartProviders([{ ...provider, extra: "leak" } as WarmStartProvider]);
    assert.equal(encoded.includes("leak"), false);
  });
});

describe("readWarmStartProviders", () => {
  it("serves what was stored", () => {
    resetWarmStartMemoryForTests();
    const store = storage({
      [WARM_START_PROVIDERS_KEY]: encodeWarmStartProviders([provider]),
    });
    assert.deepEqual(readWarmStartProviders(store), [provider]);
  });

  it("survives a store that throws on every call", () => {
    resetWarmStartMemoryForTests();
    assert.equal(readWarmStartProviders(brokenStorage), null);
    writeWarmStartProviders([provider], brokenStorage);
    assert.deepEqual(readWarmStartProviders(brokenStorage), [provider]);
  });

  // Same reason as the rows entry: a value that cannot be decoded would be
  // re-read and re-rejected on every mount for the life of the origin.
  it("drops an entry that did not decode", () => {
    resetWarmStartMemoryForTests();
    const store = storage({ [WARM_START_PROVIDERS_KEY]: "{not json" });
    assert.equal(readWarmStartProviders(store), null);
    assert.equal(store.entries.has(WARM_START_PROVIDERS_KEY), false);
  });

  it("ignores an entry written under another version's key", () => {
    resetWarmStartMemoryForTests();
    assert.equal(WARM_START_PROVIDERS_KEY, "gtd-sidebar:v1:providers");
    const store = storage({
      "gtd-sidebar:v0:providers": encodeWarmStartProviders([provider]),
    });
    assert.equal(readWarmStartProviders(store), null);
  });
});

describe("writeWarmStartProviders", () => {
  it("does not throw when the store does", () => {
    resetWarmStartMemoryForTests();
    writeWarmStartProviders([provider], brokenStorage);
    writeWarmStartProviders([provider], null);
  });

  it("keeps its own versioned key", () => {
    resetWarmStartMemoryForTests();
    const store = storage();
    writeWarmStartProviders([provider], store);
    assert.equal(store.entries.has(WARM_START_ROWS_KEY), false);
    assert.deepEqual(
      decodeWarmStartProviders(store.entries.get(WARM_START_PROVIDERS_KEY) ?? null),
      [provider],
    );
  });
});
