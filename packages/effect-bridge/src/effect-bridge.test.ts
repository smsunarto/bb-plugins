import assert from "node:assert/strict";
import { test } from "node:test";
import { Context, Deferred, Effect, Layer, Schema } from "effect";
import { makePluginRuntime, type PluginRuntimeHost } from "./effect-bridge.ts";

class Missing extends Schema.TaggedError<Missing>()("Missing", { message: Schema.String }) {}

class Counter extends Context.Service<Counter, { readonly value: number }>()("test/Counter") {}

function fakeHost() {
  const logs: Array<[string, string]> = [];
  const disposers: Array<() => void | Promise<void>> = [];
  const host: PluginRuntimeHost = {
    log: {
      debug: (message) => logs.push(["debug", message]),
      info: (message) => logs.push(["info", message]),
      warn: (message) => logs.push(["warn", message]),
      error: (message) => logs.push(["error", message]),
    },
    onDispose: (hook) => disposers.push(hook),
  };
  const dispose = async () => {
    for (const hook of disposers.toReversed()) await hook();
  };
  return { host, logs, dispose };
}

const counter = Layer.succeed(Counter, { value: 7 });

test("a call returns its value and rejects with the original error", async () => {
  const { host, dispose } = fakeHost();
  const runtime = await makePluginRuntime(host, counter);

  assert.equal(
    await runtime.run(
      Effect.gen(function* () {
        return (yield* Counter).value + 1;
      }),
    ),
    8,
  );

  const failed = await runtime.run(new Missing({ message: "no such file" })).catch((e) => e);
  assert.ok(failed instanceof Missing);
  assert.equal(failed.message, "no such file");

  const defect = new TypeError("broken");
  assert.equal(await runtime.run(Effect.die(defect)).catch((e) => e), defect);
  await dispose();
});

test("an aborted call is interrupted and rejects with the signal's reason", async () => {
  const { host, dispose } = fakeHost();
  const runtime = await makePluginRuntime(host, counter);
  const released = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reason = new Error("caller left");

  const call = runtime.run(
    Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => released.resolve()))),
    controller.signal,
  );
  controller.abort(reason);

  assert.equal(await call.catch((e) => e), reason);
  await released.promise;
  await dispose();
});

test("a service resolves when the SDK aborts it and rejects when it fails", async () => {
  const { host, dispose } = fakeHost();
  const runtime = await makePluginRuntime(host, counter);
  const controller = new AbortController();

  const running = runtime.service(Effect.never)(controller.signal);
  controller.abort();
  assert.equal(await running, undefined);

  const crash = new Missing({ message: "offline" });
  assert.equal(
    await runtime
      .service(crash)(new AbortController().signal)
      .catch((e) => e),
    crash,
  );
  await dispose();
});

test("a forked failure is logged instead of escaping", async () => {
  const { host, logs, dispose } = fakeHost();
  const runtime = await makePluginRuntime(host, counter);
  const done = Promise.withResolvers<void>();

  runtime.fork(
    Effect.fail(new Missing({ message: "gone" })).pipe(Effect.ensuring(Effect.sync(done.resolve))),
  );
  await done.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(
    logs.some(([level, line]) => level === "error" && line.includes("gone")),
    JSON.stringify(logs),
  );
  await dispose();
});

test("Effect logs go to the plugin log at their level", async () => {
  const { host, logs, dispose } = fakeHost();
  const runtime = await makePluginRuntime(host, counter);

  await runtime.run(
    Effect.all([
      Effect.logInfo("hello", { n: 1 }),
      Effect.logWarning("careful"),
      Effect.logDebug("detail"),
    ]),
  );

  assert.deepEqual(logs, [
    ["info", 'hello {\n  "n": 1\n}'],
    ["warn", "careful"],
    ["debug", "detail"],
  ]);
  await dispose();
});

test("unloading waits for running calls but not for forked work", async () => {
  const { host, dispose } = fakeHost();
  const order: string[] = [];
  const resource = Layer.effect(
    Counter,
    Effect.acquireRelease(Effect.succeed({ value: 1 }), () =>
      Effect.sync(() => order.push("layer released")),
    ),
  );
  const runtime = await makePluginRuntime(host, resource, { drainMs: 5_000 });
  const finish = await Effect.runPromise(Deferred.make<void>());
  const forkStarted = await Effect.runPromise(Deferred.make<void>());

  runtime.fork(
    Deferred.succeed(forkStarted, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => order.push("fork interrupted"))),
    ),
  );
  await Effect.runPromise(Deferred.await(forkStarted));
  const call = runtime.run(
    Deferred.await(finish).pipe(
      Effect.andThen(Effect.sync(() => order.push("call finished"))),
      Effect.as("saved"),
    ),
  );
  const unloading = dispose();
  await assert.rejects(runtime.run(Effect.void), /unloaded before this call ran/);

  await Effect.runPromise(Deferred.succeed(finish, undefined));
  assert.equal(await call, "saved");
  await unloading;
  assert.deepEqual(order, ["call finished", "fork interrupted", "layer released"]);
});

test("unloading interrupts work that outlasts the drain, then releases the layer", async () => {
  const { host, dispose } = fakeHost();
  const order: string[] = [];
  const resource = Layer.effect(
    Counter,
    Effect.acquireRelease(Effect.succeed({ value: 1 }), () =>
      Effect.sync(() => order.push("layer released")),
    ),
  );
  const runtime = await makePluginRuntime(host, resource, { drainMs: 20 });
  const started = await Effect.runPromise(Deferred.make<void>());

  runtime.fork(
    Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => order.push("fork interrupted"))),
    ),
  );
  const call = runtime.run(Effect.never).catch((error: Error) => {
    order.push("call interrupted");
    return error;
  });
  await Effect.runPromise(Deferred.await(started));

  await dispose();
  assert.match((await call).message, /unloaded before this call finished/);
  assert.deepEqual(order.toSorted(), ["call interrupted", "fork interrupted", "layer released"]);
  assert.ok(order.indexOf("fork interrupted") < order.indexOf("layer released"));
});

test("a layer that cannot be built fails the plugin load", async () => {
  const { host } = fakeHost();
  const broken = Layer.effect(Counter, Effect.fail(new Missing({ message: "no config" })));
  await assert.rejects(makePluginRuntime(host, broken), /no config/);
});
