import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capturePluginFailure,
  createPluginErrorReporter,
  createPluginErrorReporterDisposer,
  isAbortedFailure,
  observePluginFailure,
  type PluginErrorReporter,
} from "./error-reporter.ts";

test("reporter factory and capture failures fail open", () => {
  assert.equal(
    createPluginErrorReporter(() => {
      throw new Error("constructor failed");
    }, "demo"),
    undefined,
  );
  const reporter: PluginErrorReporter = {
    capture() {
      throw new Error("capture failed");
    },
  };
  assert.equal(
    capturePluginFailure(reporter, { boundary: "plugin.factory", error: new Error("original") }),
    undefined,
  );
});

test("failure observation keeps synchronous values synchronous and preserves errors", async () => {
  const value = { ok: true };
  const returned = observePluginFailure(
    () => value,
    () => assert.fail("unexpected capture"),
  );
  assert.equal(returned, value);
  assert.equal(returned instanceof Promise, false);

  const syncFailure = new Error("sync");
  let syncCaptured: unknown;
  assert.throws(
    () =>
      observePluginFailure(
        () => {
          throw syncFailure;
        },
        (error) => {
          syncCaptured = error;
        },
      ),
    (error) => error === syncFailure,
  );
  assert.equal(syncCaptured, syncFailure);

  const asyncFailure = new Error("async");
  let asyncCaptured: unknown;
  const rejection = observePluginFailure(
    () => Promise.reject(asyncFailure),
    (error) => {
      asyncCaptured = error;
    },
  );
  await assert.rejects(rejection, (error: unknown) => error === asyncFailure);
  assert.equal(asyncCaptured, asyncFailure);
});

test("reporter disposal is memoized, bounded, and never rejects", async () => {
  let calls = 0;
  let receivedTimeout: number | undefined;
  const reporter: PluginErrorReporter = {
    capture: () => undefined,
    dispose(timeoutMs) {
      calls += 1;
      receivedTimeout = timeoutMs;
      return new Promise(() => {});
    },
  };
  const dispose = createPluginErrorReporterDisposer(reporter, 5);
  await Promise.all([dispose(), dispose()]);
  assert.equal(calls, 1);
  assert.equal(receivedTimeout, 5);

  const rejecting = createPluginErrorReporterDisposer({
    capture: () => undefined,
    dispose: () => Promise.reject(new Error("close failed")),
  });
  await rejecting();

  const throwingGetter: PluginErrorReporter = { capture: () => undefined };
  Object.defineProperty(throwingGetter, "dispose", {
    get() {
      throw new Error("dispose getter failed");
    },
  });
  await createPluginErrorReporterDisposer(throwingGetter)();
});

test("abort filtering requires both an aborted signal and AbortError", () => {
  const controller = new AbortController();
  const abortError = new Error("cancelled");
  abortError.name = "AbortError";
  assert.equal(isAbortedFailure(abortError, controller.signal), false);
  controller.abort();
  assert.equal(isAbortedFailure(abortError, controller.signal), true);
  assert.equal(isAbortedFailure(new Error("concurrent"), controller.signal), false);
});
