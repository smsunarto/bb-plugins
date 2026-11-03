import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createWakeJob } from "./wake-job.ts";
import { WakeRequestError } from "./wake-error.ts";

const tick = () => setImmediate();
function fixture() {
  const lifetime = new AbortController();
  const host = {
    id: "gcp",
    status: "disconnected",
    lifecycle: { phase: "suspended", message: null as string | null },
  };
  let time = 0;
  let calls = 0;
  let onWake = async () => {
    host.status = "connected";
    host.lifecycle.phase = "active";
    return host;
  };
  let onPause = async (ms: number) => {
    time += ms;
  };
  const job = createWakeJob({
    wake: () => {
      calls++;
      return onWake();
    },
    readHost: async () => host,
    signal: lifetime.signal,
    now: () => time,
    pause: (ms) => onPause(ms),
  });
  return {
    job,
    host,
    lifetime,
    calls: () => calls,
    wake: (fn: typeof onWake) => {
      onWake = fn;
    },
    pause: (fn: typeof onPause) => {
      onPause = fn;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test("ready requires a connected active daemon", async () => {
  const f = fixture();
  const { jobId } = f.job.start();
  await tick();
  assert.deepEqual(f.job.get(jobId), { kind: "ready" });
});

test("slow native resume is observed without consuming retries; duplicate clicks join", async () => {
  const f = fixture();
  let polls = 0;
  f.wake(async () => {
    f.host.lifecycle.phase = "resuming";
    return f.host;
  });
  f.pause(async (ms) => {
    f.advance(ms);
    if (++polls === 45) {
      f.host.lifecycle.phase = "active";
      f.host.status = "connected";
    }
  });
  const first = f.job.start();
  const duplicate = f.job.start();
  assert.equal(duplicate.jobId, first.jobId);
  await tick();
  assert.deepEqual(f.job.get(first.jobId), { kind: "ready" });
  assert.equal(f.calls(), 1);
  assert.equal(polls, 45);
});

test("transient rejected requests retry with backoff and eventually connect", async () => {
  const f = fixture();
  const waits: number[] = [];
  f.wake(async () => {
    if (f.calls() < 3) throw new WakeRequestError("controller temporarily unavailable", true);
    f.host.lifecycle.phase = "active";
    f.host.status = "connected";
    return f.host;
  });
  f.pause(async (ms) => {
    waits.push(ms);
    f.advance(ms);
  });
  const { jobId } = f.job.start();
  await tick();
  assert.deepEqual(f.job.get(jobId), { kind: "ready" });
  assert.equal(f.calls(), 3);
  assert.deepEqual(waits, [5000, 15000]);
});

test("retry exhaustion reports failure and a new manual request can start", async () => {
  const f = fixture();
  f.wake(async () => {
    throw new WakeRequestError("offline", true);
  });
  const first = f.job.start();
  await tick();
  assert.deepEqual(f.job.get(first.jobId), { kind: "failed", error: "offline" });
  assert.equal(f.calls(), 3);
  const second = f.job.start();
  assert.notEqual(first.jobId, second.jobId);
  await tick();
  assert.equal(f.job.get(first.jobId).kind, "failed");
});

test("terminal rejection and uncertain bootstrap failure are never automatically replayed", async () => {
  for (const error of [
    new WakeRequestError("VM deleted", false),
    new Error("SSH connection lost after command started"),
  ]) {
    const f = fixture();
    f.wake(async () => {
      throw error;
    });
    const { jobId } = f.job.start();
    await tick();
    assert.equal(f.calls(), 1);
    assert.equal(f.job.get(jobId).kind, error instanceof WakeRequestError ? "failed" : "unknown");
  }
});

test("a pending resume exceeding the observation deadline stays uncertain", async () => {
  const f = fixture();
  f.wake(async () => {
    f.host.lifecycle.phase = "resuming";
    return f.host;
  });
  f.pause(async () => {
    f.advance(26 * 60_000);
  });
  const { jobId } = f.job.start();
  await tick();
  assert.equal(f.job.get(jobId).kind, "unknown");
  assert.equal(f.calls(), 1);
});

test("disposal cancels pending retries", async () => {
  const f = fixture();
  f.wake(async () => {
    throw new WakeRequestError("offline", true);
  });
  f.pause(async () => {
    f.lifetime.abort();
  });
  const { jobId } = f.job.start();
  await tick();
  assert.equal(f.job.get(jobId).kind, "unknown");
  assert.equal(f.calls(), 1);
});

test("polling a job lost in a reload reports unknown", () => {
  const f = fixture();
  assert.equal(f.job.get("previous-generation").kind, "unknown");
});

test("a lost start response cannot restart a completed job", async () => {
  const f = fixture();
  const first = f.job.start("same-click");
  await tick();
  const replay = f.job.start("same-click");
  assert.equal(first.jobId, replay.jobId);
  assert.equal(replay.state.kind, "ready");
  assert.equal(f.calls(), 1);
});

test("coalesced request receipts survive completion and subsequent jobs", async () => {
  const f = fixture();
  f.wake(async () => {
    throw new Error("uncertain SSH result");
  });
  const first = f.job.start("window-a");
  const joined = f.job.start("window-b");
  assert.equal(first.jobId, joined.jobId);
  await tick();
  const replay = f.job.start("window-b");
  assert.equal(replay.state.kind, "unknown");
  assert.equal(f.calls(), 1);
  f.job.start("window-c");
  await tick();
  assert.equal(f.job.start("window-a").jobId, first.jobId);
  assert.equal(f.calls(), 2);
});

test("expired requests cannot start another wake", async () => {
  const f = fixture();
  f.advance(6 * 60_000);
  assert.equal(f.job.start("expired", 0).state.kind, "unknown");
  await tick();
  assert.equal(f.calls(), 0);
});

test("an unclassified asynchronous native bootstrap failure is not replayed", async () => {
  const f = fixture();
  f.wake(async () => {
    f.host.lifecycle.phase = "resuming";
    return f.host;
  });
  f.pause(async () => {
    f.host.lifecycle.phase = "suspended";
    f.host.lifecycle.message = "SSH lost after command started";
  });
  const { jobId } = f.job.start();
  await tick();
  assert.equal(f.job.get(jobId).kind, "unknown");
  assert.equal(f.calls(), 1);
});

test("a lost start response after reload is not resubmitted", async () => {
  let receipts: [string, number][] = [];
  let calls = 0;
  const host = { id: "gcp", status: "connected", lifecycle: { phase: "active", message: null } };
  const options = {
    wake: async () => {
      calls++;
      return host;
    },
    readHost: async () => host,
    signal: new AbortController().signal,
    seenRequests: {
      load: () => receipts,
      save: (value: typeof receipts) => {
        receipts = value;
      },
    },
  };
  createWakeJob(options).start("same-click");
  await tick();
  assert.equal(createWakeJob(options).start("same-click").state.kind, "unknown");
  assert.equal(calls, 1);
});
