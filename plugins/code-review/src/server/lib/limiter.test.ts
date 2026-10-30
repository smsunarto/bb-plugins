import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { createLimiter } from "./limiter.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Reads that note when they start and hold their slot until `finish(name)`. */
function reads() {
  const started: string[] = [];
  const done = new Map<string, () => void>();
  const read = (name: string) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          started.push(name);
          done.set(name, resolve);
        }),
    );
  return { started, read, finish: (name: string) => done.get(name)!() };
}

test("a source that is full holds only its own slots", async () => {
  const limiter = createLimiter({ perKey: 2, total: 3 });
  const { started, read, finish } = reads();
  for (const name of ["laptop 1", "laptop 2", "laptop 3"]) {
    Effect.runFork(limiter.run("host:laptop", read(name)));
  }
  // Another repository still reads while the sleeping machine's reads wait.
  Effect.runFork(limiter.run("github:acme/game", read("github")));
  await tick();
  expect(started).toEqual(["laptop 1", "laptop 2", "github"]);
  finish("github");
  await tick();
  expect(started).toEqual(["laptop 1", "laptop 2", "github"]);
  finish("laptop 1");
  await tick();
  expect(started).toEqual(["laptop 1", "laptop 2", "github", "laptop 3"]);
});

test("one source's reads run one at a time when it has one slot, in call order", async () => {
  const limiter = createLimiter({ perKey: 1, total: 8 });
  const { started, read, finish } = reads();
  for (const name of ["a", "b", "c"]) Effect.runFork(limiter.run("host:laptop", read(name)));
  await tick();
  expect(started).toEqual(["a"]);
  finish("a");
  await tick();
  expect(started).toEqual(["a", "b"]);
  finish("b");
  await tick();
  expect(started).toEqual(["a", "b", "c"]);
});

test("the shared slots go to sources first come, first served", async () => {
  const limiter = createLimiter({ perKey: 2, total: 1 });
  const { started, read, finish } = reads();
  for (const key of ["a", "b", "c"]) Effect.runFork(limiter.run(key, read(key)));
  await tick();
  expect(started).toEqual(["a"]);
  finish("a");
  await tick();
  expect(started).toEqual(["a", "b"]);
});

test("a read stopped while it waits leaves the queue and takes no slot", async () => {
  const limiter = createLimiter({ perKey: 1, total: 1 });
  const { started, read, finish } = reads();
  Effect.runFork(limiter.run("a", read("first")));
  const waiting = Effect.runFork(limiter.run("a", read("stopped")));
  await tick();
  await Effect.runPromise(Fiber.interrupt(waiting));
  Effect.runFork(limiter.run("a", read("next")));
  finish("first");
  await tick();
  expect(started).toEqual(["first", "next"]);
  // The slot the stopped read gave up is the only one: a fourth read still waits.
  Effect.runFork(limiter.run("a", read("fourth")));
  await tick();
  expect(started).toEqual(["first", "next"]);
  finish("next");
  await tick();
  expect(started).toEqual(["first", "next", "fourth"]);
});
