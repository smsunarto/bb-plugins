import { randomUUID } from "node:crypto";
import {
  HOST_TIMEOUT_MS,
  type HostSignalPayload,
} from "../../../shared/contracts/host-contract.ts";
import type { StructuralDiffRequest } from "../../../shared/node/vendor/review/src/server/structural-diff.ts";
import type { StructuralDiffEvent } from "../../../shared/vendor/review-protocol/src/index.ts";
import { fromWireError, hostIo, onStructuralEvents, onUninstall, onWorkerExit } from "./client.ts";

/** After the run call resolves, wait this long for a `done` batch still in flight. */
export const DONE_GRACE_MS = 5_000;

type Batch = HostSignalPayload<"structuralEvents">;

/** Move consecutive batches from `pending` to `ready`, stopping at the `done` batch. */
function drain(
  pending: Map<number, Batch>,
  nextSeq: number,
  ready: StructuralDiffEvent[],
): { nextSeq: number; done?: Batch } {
  let seq = nextSeq;
  for (let batch = pending.get(seq); batch; batch = pending.get(seq)) {
    pending.delete(seq++);
    ready.push(...(batch.events as unknown as StructuralDiffEvent[]));
    if (batch.done) return { nextSeq: seq, done: batch };
  }
  return { nextSeq: seq };
}

/**
 * Start a host diffr run and yield its `structuralEvents` signals in `seq`
 * order (design §1.6). The stream ends at the `done` batch and throws its
 * error. Breaking out of the loop or aborting `request.signal` sends
 * `cancelStructuralDiff` and aborts the run call; a worker exit or a plugin
 * dispose fails the stream.
 */
export async function* structuralStream(
  hostId: string,
  request: StructuralDiffRequest,
): AsyncGenerator<StructuralDiffEvent> {
  request.signal.throwIfAborted();
  const { client } = hostIo();
  const streamId = randomUUID();
  const run = new AbortController();
  const pending = new Map<number, Batch>();
  const ready: StructuralDiffEvent[] = [];
  let nextSeq = 0;
  let finished = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const fail = (error: Error) => {
    if (finished) return;
    failure ??= error;
    finished = true;
    notify();
  };
  const offs = [
    onStructuralEvents(streamId, hostId, (payload) => {
      pending.set(payload.seq, payload);
      const drained = drain(pending, nextSeq, ready);
      nextSeq = drained.nextSeq;
      if (drained.done) {
        if (drained.done.error) failure ??= fromWireError(drained.done.error);
        finished = true;
      }
      notify();
    }),
    onWorkerExit((exited) => {
      if (exited === hostId)
        fail(new Error("whiteboard: the host worker exited during the structural diff."));
    }),
    onUninstall(() => {
      run.abort();
      fail(new Error("whiteboard: the plugin stopped during the structural diff."));
    }),
  ];
  const onAbort = () => fail(request.signal.reason ?? new Error("aborted"));
  request.signal.addEventListener("abort", onAbort, { once: true });

  const runCall = async () => {
    try {
      const result = await client.call(
        "structuralDiff",
        {
          streamId,
          repositoryPath: request.repositoryPath,
          comparison: request.comparison,
          ...(request.paths ? { paths: [...request.paths] } : {}),
        },
        { hostId, signal: run.signal, timeoutMs: HOST_TIMEOUT_MS.long },
      );
      if (finished) return;
      // The `done` batch normally lands first; give a late one a moment.
      const ended = result.ok
        ? new Error("whiteboard: the structural diff ended without its final batch.")
        : fromWireError(result.error);
      graceTimer = setTimeout(() => fail(ended), DONE_GRACE_MS);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  void runCall();

  try {
    while (true) {
      if (ready.length) {
        yield ready.shift()!;
        continue;
      }
      if (finished) {
        if (failure) throw failure;
        return;
      }
      await new Promise<void>((resolve) => (wake = resolve));
    }
  } finally {
    clearTimeout(graceTimer);
    request.signal.removeEventListener("abort", onAbort);
    for (const off of offs) off();
    if (!finished || failure) {
      // A consumer that stops early cancels the host run.
      run.abort();
      void client.call("cancelStructuralDiff", { streamId }, { hostId }).catch(() => {});
    }
  }
}
