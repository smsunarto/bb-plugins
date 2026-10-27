import { expect, test } from "bun:test";
import { createLimiter } from "./limiter.ts";

const never = new AbortController().signal;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a source that is full holds only its own slots", async () => {
  const limiter = createLimiter({ perKey: 2, total: 3 });
  const asleep = [
    await limiter.acquire("host:laptop", never),
    await limiter.acquire("host:laptop", never),
  ];
  let third = false;
  void limiter.acquire("host:laptop", never).then(() => (third = true));
  // Another repository still reads while the sleeping machine's reads wait.
  const other = await limiter.acquire("github:acme/game", never);
  await tick();
  expect(third).toBe(false);
  other();
  asleep[0]!();
  await tick();
  expect(third).toBe(true);
});

test("a read abandoned while waiting leaves the queue and takes no slot", async () => {
  const limiter = createLimiter({ perKey: 1, total: 1 });
  const release = await limiter.acquire("a", never);
  const controller = new AbortController();
  const waiting = limiter.acquire("a", controller.signal);
  controller.abort();
  await expect(waiting).rejects.toBeDefined();
  release();
  const next = await limiter.acquire("a", never);
  next();
  next();
  // Releasing twice frees one slot, once.
  const again = await limiter.acquire("a", never);
  let blocked = true;
  void limiter.acquire("a", never).then(() => (blocked = false));
  await tick();
  expect(blocked).toBe(true);
  again();
});
