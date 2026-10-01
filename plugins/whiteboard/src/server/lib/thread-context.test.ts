import { expect, test } from "vitest";
import { currentThread, desktopAvailable, runWithThread } from "./thread-context.ts";

test("a thread call carries its context; a thread-less call never inherits one", async () => {
  const signal = new AbortController().signal;
  expect(desktopAvailable()).toBe(false);

  const seen = await runWithThread({ threadId: "t1", projectId: "p1", signal }, async () => {
    const outer = { thread: currentThread(), available: desktopAvailable() };
    const inner = await runWithThread({ projectId: "p1" }, async () => ({
      thread: currentThread(),
      available: desktopAvailable(),
    }));
    return { outer, inner };
  });

  expect(seen).toEqual({
    outer: { thread: { threadId: "t1", projectId: "p1", signal }, available: true },
    inner: { thread: undefined, available: false },
  });
  expect(currentThread()).toBeUndefined();
});

test("an empty context input omits absent fields", async () => {
  const thread = await runWithThread({ threadId: "t2" }, async () => currentThread());
  expect(thread).toStrictEqual({ threadId: "t2" });
});
