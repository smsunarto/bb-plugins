import {
  HOST_PAYLOAD_LIMIT_BYTES,
  type HostInput,
  type HostOutput,
  type HostSignalPayload,
} from "../../shared/contracts/host-contract.ts";
import type { WireError } from "../../shared/contracts/wire.ts";
import { structuralDiff } from "../../shared/node/vendor/review/src/server/structural-diff.ts";
import { hostError } from "./codec.ts";

/** Emits one ordered `structuralEvents` batch to the server. */
export type EmitStructuralEvents = (
  payload: HostSignalPayload<"structuralEvents">,
) => Promise<void>;

/** A batch is flushed this long after its first event, or once it holds `BATCH_BYTES`. */
export const BATCH_MS = 50;
export const BATCH_BYTES = 256 * 1024;

const running = new Map<string, AbortController>();

/**
 * Run upstream `structuralDiff` on the host and emit its events as ordered
 * `structuralEvents` batches; cancel by stream id (design §1.6). The last
 * batch has `done: true` and carries the run's error, if any. The call
 * resolves after that batch is sent.
 */
export async function runStructuralDiff(
  input: HostInput<"structuralDiff">,
  emit: EmitStructuralEvents,
  signal: AbortSignal,
): Promise<HostOutput<"structuralDiff">> {
  const cancel = new AbortController();
  running.set(input.streamId, cancel);
  let seq = 0;
  let batch: HostSignalPayload<"structuralEvents">["events"] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<void> = Promise.resolve();
  let emitFailure: unknown;

  const flush = (done: boolean, error?: WireError) => {
    clearTimeout(timer);
    timer = undefined;
    const payload: HostSignalPayload<"structuralEvents"> = {
      streamId: input.streamId,
      seq: seq++,
      events: batch,
      done,
      ...(error ? { error } : {}),
    };
    batch = [];
    bytes = 0;
    sending = sending.then(() =>
      emit(payload).catch((cause: unknown) => {
        emitFailure ??= cause;
      }),
    );
    return sending;
  };

  let error: WireError | undefined;
  try {
    for await (const event of structuralDiff({
      repositoryPath: input.repositoryPath,
      comparison: input.comparison,
      paths: input.paths,
      signal: AbortSignal.any([signal, cancel.signal]),
    })) {
      // Signals carry JSON: drop undefined members the decoder left behind.
      const text = JSON.stringify(event);
      if (Buffer.byteLength(text) > HOST_PAYLOAD_LIMIT_BYTES)
        throw new Error(
          "whiteboard: a structural diff record exceeds the host transfer limit; the comparison is too large to stream from this host.",
        );
      if (bytes + text.length > BATCH_BYTES && batch.length) void flush(false);
      batch.push(JSON.parse(text));
      bytes += text.length;
      if (bytes >= BATCH_BYTES) void flush(false);
      else timer ??= setTimeout(() => void flush(false), BATCH_MS);
      if (emitFailure) throw emitFailure;
    }
  } catch (cause) {
    error = hostError(cause);
  } finally {
    running.delete(input.streamId);
  }
  await flush(true, error);
  return error ? { ok: false, error } : { ok: true };
}

export function cancelStructuralDiff(
  input: HostInput<"cancelStructuralDiff">,
): HostOutput<"cancelStructuralDiff"> {
  running.get(input.streamId)?.abort();
  return { ok: true };
}
