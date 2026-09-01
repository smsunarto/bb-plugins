import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPluginPerformanceReporter,
  finishTraceOnSuccess,
  rpcTraceOperation,
  startPluginTrace,
  toolTraceOperation,
  type PluginPerformanceReporter,
  type PluginPerformanceTrace,
} from "./performance-reporter.ts";

function recordingReporter() {
  const started: Array<{ operation: string; variant?: string }> = [];
  const events: string[] = [];
  const reporter: PluginPerformanceReporter = {
    start(args) {
      started.push({ ...args });
      return {
        checkpoint(name) {
          events.push(`checkpoint:${name}`);
        },
        finish(outcome) {
          events.push(`finish:${outcome}`);
        },
      };
    },
  };
  return { started, events, reporter };
}

test("reporter factory failures fail open", () => {
  assert.equal(
    createPluginPerformanceReporter(() => {
      throw new Error("constructor failed");
    }, "demo"),
    undefined,
  );
  assert.equal(createPluginPerformanceReporter(undefined, "demo"), undefined);
});

test("started traces forward operation, variant, checkpoints, and outcomes", () => {
  const recording = recordingReporter();
  const trace = startPluginTrace(recording.reporter, "rpc.echo", "warm");
  assert.ok(trace);
  trace.checkpoint("validated");
  trace.finish("ok");
  assert.deepEqual(recording.started, [{ operation: "rpc.echo", variant: "warm" }]);
  assert.deepEqual(recording.events, ["checkpoint:validated", "finish:ok"]);
  assert.equal(startPluginTrace(undefined, "rpc.echo"), undefined);
});

test("an omitted variant is not sent as an explicit undefined", () => {
  const recording = recordingReporter();
  startPluginTrace(recording.reporter, "plugin.startup");
  assert.deepEqual(recording.started, [{ operation: "plugin.startup" }]);
  assert.equal("variant" in (recording.started[0] ?? {}), false);
});

test("a reporter that throws at start, checkpoint, or finish never reaches the caller", () => {
  assert.equal(
    startPluginTrace(
      {
        start() {
          throw new Error("start failed");
        },
      },
      "rpc.echo",
    ),
    undefined,
  );
  const trace = startPluginTrace(
    {
      start: () => ({
        checkpoint() {
          throw new Error("checkpoint failed");
        },
        finish() {
          throw new Error("finish failed");
        },
      }),
    },
    "rpc.echo",
  );
  assert.ok(trace);
  trace.checkpoint("safe");
  trace.finish("ok");
});

test("finishTraceOnSuccess finishes ok only when the callback settles successfully", async () => {
  const events: string[] = [];
  const trace: PluginPerformanceTrace = {
    checkpoint() {},
    finish(outcome) {
      events.push(outcome);
    },
  };
  assert.equal(
    finishTraceOnSuccess(trace, () => "sync"),
    "sync",
  );
  assert.equal(await finishTraceOnSuccess(trace, () => Promise.resolve("async")), "async");
  assert.deepEqual(events, ["ok", "ok"]);

  const syncFailure = new Error("sync failed");
  assert.throws(
    () =>
      finishTraceOnSuccess(trace, () => {
        throw syncFailure;
      }),
    (error) => error === syncFailure,
  );
  const asyncFailure = new Error("async failed");
  await assert.rejects(
    Promise.resolve(
      finishTraceOnSuccess(trace, async () => {
        throw asyncFailure;
      }),
    ),
    (error: unknown) => error === asyncFailure,
  );
  assert.deepEqual(events, ["ok", "ok"]);
});

test("trace operations are valid telemetry identifiers", () => {
  assert.equal(rpcTraceOperation("echo"), "rpc.echo");
  assert.equal(rpcTraceOperation("commitSelection"), "rpc.commit-selection");
  assert.equal(rpcTraceOperation("readURL"), "rpc.read-u-r-l");
  assert.equal(toolTraceOperation("user"), "tool.user");
  assert.equal(toolTraceOperation("sync_result"), "tool.sync_result");
  const identifier = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
  for (const operation of [
    rpcTraceOperation("commitSelection"),
    rpcTraceOperation("readURL"),
    toolTraceOperation("sync_result"),
    "plugin.startup",
  ]) {
    assert.match(operation, identifier);
  }
});
