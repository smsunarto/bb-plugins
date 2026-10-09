import { expect, test } from "bun:test";
import { createLocks } from "./lock.ts";

/** A promise the test settles by hand. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

test("tasks on one key run one at a time, in call order, and a failure releases the key", async () => {
  const withLock = createLocks();
  const log: string[] = [];
  const first = gate();

  const a = withLock("pins", async () => {
    log.push("a starts");
    await first.opened;
    log.push("a fails");
    throw new Error("a failed");
  });
  const b = withLock("pins", async () => {
    log.push("b runs");
    return "b";
  });
  const c = withLock("pins", async () => {
    log.push("c runs");
    return "c";
  });

  await Promise.resolve();
  expect(log).toEqual(["a starts"]);
  first.open();

  await expect(a).rejects.toThrow("a failed");
  expect(await b).toBe("b");
  expect(await c).toBe("c");
  expect(log).toEqual(["a starts", "a fails", "b runs", "c runs"]);
});

test("tasks on different keys run alongside each other", async () => {
  const withLock = createLocks();
  const held = gate();
  const log: string[] = [];

  const pins = withLock("pins", async () => {
    log.push("pins starts");
    await held.opened;
    log.push("pins ends");
  });
  const links = withLock("links:cli/cli#1", async () => {
    log.push("links runs");
  });

  await links;
  expect(log).toEqual(["pins starts", "links runs"]);
  held.open();
  await pins;
  expect(log).toEqual(["pins starts", "links runs", "pins ends"]);
});
