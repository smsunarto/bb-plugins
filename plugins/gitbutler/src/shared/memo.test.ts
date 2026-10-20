import { expect, test } from "bun:test";
import { createMemo } from "./memo.ts";

function gate<T>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test("callers asking while a read runs share it, and its answer for the ttl only", async () => {
  let now = 0;
  const memo = createMemo({ ttlMs: 1_000, now: () => now });
  let loads = 0;
  const answer = gate<string>();
  const load = () => {
    loads += 1;
    return answer.promise;
  };
  const both = Promise.all([memo.read("k", load), memo.read("k", load)]);
  answer.open("a");
  expect(await both).toEqual(["a", "a"]);
  expect(await memo.read("k", async () => "b")).toBe("a");
  now = 1_000;
  expect(await memo.read("k", async () => "b")).toBe("b");
  expect(loads).toBe(1);
});

test("one caller giving up leaves the read to the others, and the last one stops it", async () => {
  const memo = createMemo({ ttlMs: 0 });
  let stopped: AbortSignal | null = null;
  const answer = gate<string>();
  const load = (signal: AbortSignal) => {
    stopped = signal;
    return answer.promise;
  };
  const first = new AbortController();
  const second = new AbortController();
  const reads = [memo.read("k", load, first.signal), memo.read("k", load, second.signal)];
  first.abort(new Error("gone"));
  await expect(reads[0]!).rejects.toThrow("gone");
  expect(stopped!.aborted).toBe(false);
  second.abort(new Error("gone too"));
  await expect(reads[1]!).rejects.toThrow("gone too");
  expect(stopped!.aborted).toBe(true);
});

test("a failure is not kept, and clear hands nobody a read from before it", async () => {
  const memo = createMemo({ ttlMs: 60_000 });
  await expect(memo.read("k", () => Promise.reject(new Error("no")))).rejects.toThrow("no");
  expect(await memo.read("k", async () => "after failure")).toBe("after failure");

  const before = gate<string>();
  const running = memo.read("other", () => before.promise);
  memo.clear();
  expect(await memo.read("other", async () => "after clear")).toBe("after clear");
  before.open("before clear");
  expect(await running).toBe("before clear");
  // The read from before the clear never replaced the answer after it.
  expect(await memo.read("other", async () => "unused")).toBe("after clear");
});

test("an answer `keep` refuses is shared while it is read, then read again", async () => {
  const memo = createMemo({ ttlMs: 1_000, keep: (value) => value !== null });
  let loads = 0;
  const answer = gate<string | null>();
  const load = () => {
    loads += 1;
    return answer.promise;
  };
  const both = Promise.all([memo.read("k", load), memo.read("k", load)]);
  answer.open(null);
  expect(await both).toEqual([null, null]);
  expect(await memo.read("k", async () => "origin")).toBe("origin");
  expect(await memo.read("k", async () => "later")).toBe("origin");
  expect(loads).toBe(1);
});
