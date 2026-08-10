import assert from "node:assert/strict";
import { test } from "node:test";
import {
  latestRunWasManuallyStopped,
  THREAD_EVENT_PAGE_SIZE,
} from "../lifecycle.ts";

interface Event {
  seq: number;
  type: string;
  data: unknown;
}

function event(seq: number, type: string, data: unknown = {}): Event {
  return { seq, type, data };
}

function list(events: Event[]) {
  return async ({ afterSeq, limit }: { afterSeq?: string; limit: string }) =>
    events
      .filter((item) => item.seq > Number(afterSeq ?? 0))
      .slice(0, Number(limit));
}

test("manual stop of the latest run suppresses its idle notification", async () => {
  const stopped = await latestRunWasManuallyStopped(
    list([
      event(1, "client/turn/requested"),
      event(2, "turn/started"),
      event(3, "system/thread/interrupted", { reason: "manual-stop" }),
    ]),
  );

  assert.equal(stopped, true);
});

test("an old manual stop does not suppress a later completed run", async () => {
  const stopped = await latestRunWasManuallyStopped(
    list([
      event(1, "client/turn/requested"),
      event(2, "system/thread/interrupted", { reason: "manual-stop" }),
      // A provider start is also a run boundary, even if an older log does not
      // contain the corresponding client request event.
      event(3, "turn/started"),
      event(4, "turn/completed", { status: "completed" }),
    ]),
  );

  assert.equal(stopped, false);
});

test("non-manual interruptions do not suppress notifications", async () => {
  for (const reason of ["host-daemon-restarted", "provider-turn-idle"]) {
    const stopped = await latestRunWasManuallyStopped(
      list([
        event(1, "client/turn/requested"),
        event(2, "system/thread/interrupted", { reason }),
      ]),
    );
    assert.equal(stopped, false, reason);
  }
});

test("the event log is paged until a manual stop is found", async () => {
  const events = Array.from({ length: THREAD_EVENT_PAGE_SIZE + 2 }, (_, index) =>
    event(index + 1, "item/completed"),
  );
  events[0] = event(1, "client/turn/requested");
  events.at(-1)!.type = "system/thread/interrupted";
  events.at(-1)!.data = { reason: "manual-stop" };
  const afterSeqs: Array<string | undefined> = [];

  const stopped = await latestRunWasManuallyStopped(async (args) => {
    afterSeqs.push(args.afterSeq);
    return list(events)(args);
  });

  assert.equal(stopped, true);
  assert.deepEqual(afterSeqs, [undefined, String(THREAD_EVENT_PAGE_SIZE)]);
});
