import {
  experimental_PluginRpcCallError as PluginRpcCallError,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  CATALOG_TAG,
  LIVE_SESSION_TAG,
  liveSessionInput,
  sessionTag,
  sessionsInput,
} from "../shared/contracts/rpc.ts";
import { type Input, type Output, wire } from "./rpc.ts";

/**
 * The live reads as the SDK needs them in the app, where it validates a
 * read's input and computes its tags. The server's `contract` module also
 * registers the handlers, so the app cannot import it; live.test.tsx pins
 * these entries to it.
 */
export const liveContract = {
  sessions: {
    input: sessionsInput,
    output: z.custom<Output<"sessions">>(),
    tags: () => [CATALOG_TAG],
  },
  liveSession: {
    input: liveSessionInput,
    output: z.custom<Output<"liveSession">>(),
    tags: (_input: unknown, output: Output<"liveSession">) => [
      sessionTag(output.reviewId),
      LIVE_SESSION_TAG,
    ],
  },
};

export type LiveMethod = keyof typeof liveContract;

/** A live read's newest answer, or the failure of its latest attempt. */
export type LiveState<T> = { value: T } | { error: PluginRpcCallError };

/** What `followLive` attaches to: a read's current state, then each change. */
export interface LiveRead<T> {
  subscribe(listener: (state: LiveState<T>) => void): () => void;
}

/** The session is gone or not the caller's: no retry can answer this read. */
export function isTerminalRefusal(cause: unknown): cause is PluginRpcCallError {
  return (
    cause instanceof PluginRpcCallError &&
    (cause.code === "not_found" || cause.code === "forbidden")
  );
}

/** A failed read retries after this, doubling up to `MAX_RETRY_MS`, until one answers. */
export const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

function createLiveSource<T>() {
  let current: LiveState<T> | undefined;
  const listeners = new Set<(state: LiveState<T>) => void>();
  return {
    publish(state: LiveState<T>) {
      current = state;
      // A listener that subscribes during delivery already got `state` as its replay.
      for (const listener of Array.from(listeners)) listener(state);
    },
    subscribe(listener: (state: LiveState<T>) => void) {
      listeners.add(listener);
      if (current) listener(current);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * One SDK live read, shared by every `followLive` on it. The server
 * invalidates its tags when what it reads changes, and bb refreshes all reads
 * on reconnect. A failed read retries with backoff. A terminal refusal
 * disables the read instead, until the input changes or an answer clears it.
 * Each answer is published once, and the cached one again after a failure
 * clears, so followers learn the read recovered.
 */
export function useLiveRead<M extends LiveMethod>(method: M, input: Input<M>): LiveRead<Output<M>> {
  const sent = wire(input)!;
  const identity = JSON.stringify([method, sent]);
  // A new input is a new read: its followers never see the old input's state.
  const [live, setLive] = useState(() => ({
    identity,
    source: createLiveSource<Output<M>>(),
    refused: false,
  }));
  if (live.identity !== identity)
    setLive({ identity, source: createLiveSource<Output<M>>(), refused: false });
  const read = useRpcQuery({
    contract: liveContract,
    method,
    input: sent,
    enabled: live.identity !== identity || !live.refused,
  });
  const refused = isTerminalRefusal(read.error);
  if (live.identity === identity && refused !== live.refused) setLive({ ...live, refused });
  // SAFETY: the method's contract output is `Output<M>`; the SDK types it per contract entry.
  const data = read.data as Output<M> | undefined;
  const refetch = useRef(read.refetch);
  /** The next retry's delay, per read. */
  const retry = useRef({ source: live.source, delay: FIRST_RETRY_MS });
  useLayoutEffect(() => {
    refetch.current = read.refetch;
  });

  useEffect(() => {
    if (read.error) live.source.publish({ error: read.error });
    else if (data !== undefined) {
      retry.current = { source: live.source, delay: FIRST_RETRY_MS };
      live.source.publish({ value: data });
    }
  }, [live.source, data, read.error]);

  useEffect(() => {
    if (!read.error || isTerminalRefusal(read.error)) return;
    if (retry.current.source !== live.source)
      retry.current = { source: live.source, delay: FIRST_RETRY_MS };
    const { delay } = retry.current;
    retry.current.delay = Math.min(delay * 2, MAX_RETRY_MS);
    const timer = setTimeout(() => void refetch.current(), delay);
    return () => clearTimeout(timer);
  }, [live.source, read.error]);

  return live.source;
}

/** A failed `accept` retries its value after this, unless a newer one arrived. */
export const ACCEPT_RETRY_MS = 1000;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Feed a live read to one consumer until `signal` aborts: its current state
 * at once, then each change. One `accept` runs at a time, and while it runs
 * only the newest state waits, so a slow render delays only its own newest
 * state. A read failure takes that place like a value does: it is reported
 * after the running `accept`, and an older waiting value is dropped. A
 * failed `accept` is reported and its value retried after `ACCEPT_RETRY_MS`,
 * unless a newer state arrived. Each read failure is reported once; a
 * throwing `disconnected` cannot stop delivery.
 */
export function followLive<T>(
  read: LiveRead<T>,
  signal: AbortSignal,
  accept: (value: T) => void | Promise<void>,
  disconnected: (cause: unknown) => void,
): void {
  if (signal.aborted) return;
  let queued: LiveState<T> | undefined;
  let draining = false;
  const report = (cause: unknown) => {
    if (signal.aborted) return;
    try {
      disconnected(cause);
    } catch {
      // The consumer's handler must not stop its own delivery.
    }
  };
  const drain = async () => {
    draining = true;
    while (queued && !signal.aborted) {
      const next = queued;
      queued = undefined;
      if ("error" in next) {
        report(next.error);
        continue;
      }
      try {
        await accept(next.value);
      } catch (error) {
        report(error);
        await sleep(ACCEPT_RETRY_MS, signal);
        queued ??= next;
      }
    }
    draining = false;
  };
  const unsubscribe = read.subscribe((state) => {
    if (signal.aborted) return;
    queued = state;
    if (!draining) void drain();
  });
  signal.addEventListener("abort", unsubscribe, { once: true });
}
