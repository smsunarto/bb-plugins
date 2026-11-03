import { randomUUID } from "node:crypto";
import { WakeRequestError } from "./wake-error.ts";
import { setTimeout as delay } from "node:timers/promises";
import type { WakeState } from "../../shared/wake-contract.ts";

type Host = {
  id: string;
  status: string;
  lifecycle: { phase: string; message: string | null };
};
const isReady = (host: Host) => host.status === "connected" && host.lifecycle.phase === "active";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One manual wake job per plugin, shared by all browser windows. */
export function createWakeJob({
  wake,
  readHost,
  signal,
  now = Date.now,
  resumeFailure = () => undefined,
  seenRequests = { load: () => [], save: () => {} },
  pause = (ms: number) => delay(ms, undefined, { signal }),
}: {
  wake(): Promise<Host>;
  readHost(): Promise<Host>;
  signal: AbortSignal;
  now?: () => number;
  resumeFailure?: () => unknown;
  seenRequests?: { load(): [string, number][]; save(entries: [string, number][]): void };
  pause?: (ms: number) => Promise<void>;
}) {
  let state: WakeState = { kind: "idle" };
  let running = false;
  let jobId = "";
  const remembered = new Map(seenRequests.load());
  const receipts = new Map<string, { requestedAt: number; jobId: string; state: WakeState }>();
  const unknown = (error: string) => ({
    jobId: "unavailable",
    state: { kind: "unknown" as const, error },
  });

  function ensureTime(deadline: number, backoff = 0) {
    if (now() + backoff >= deadline)
      throw new Error(
        "The wake observation deadline was reached. Check the machine connection before trying again.",
      );
  }

  async function observe(hostId: string, deadline: number): Promise<Host> {
    for (;;) {
      signal.throwIfAborted();
      const host = await readHost();
      if (host.id !== hostId) throw new Error("The enrolled GCP machine changed. Try again.");
      if (isReady(host)) return host;
      if (now() >= deadline)
        throw new Error(
          "Wake is still unresolved. BB may still be resuming the machine; check its connection before trying again.",
        );
      if (host.lifecycle.phase !== "resuming" && host.lifecycle.phase !== "suspending") return host;
      await pause(2000);
    }
  }

  async function requestWake(hostId: string, deadline: number) {
    ensureTime(deadline);
    const current = await readHost();
    if (current.id !== hostId) throw new Error("The enrolled GCP machine changed. Try again.");
    return wake();
  }

  async function run() {
    // A resume acknowledgement is not completion. Observe BB, never poll GCE.
    const deadline = now() + 25 * 60_000;
    const initial = await readHost();
    for (let attempt = 1; attempt <= 3; attempt++) {
      signal.throwIfAborted();
      state = { kind: "waking", attempt };
      let error = "The BB daemon did not reconnect.";
      let rejection: unknown;
      try {
        await requestWake(initial.id, deadline);
      } catch (cause) {
        error = message(cause);
        rejection = cause;
      }
      const host = await observe(initial.id, deadline);
      if (isReady(host)) {
        state = { kind: "ready" };
        return;
      }
      if (host.lifecycle.phase === "removing" || host.lifecycle.phase === "destroyed") {
        state = { kind: "failed", error: "The GCP machine is being removed." };
        return;
      }
      rejection ??= resumeFailure();
      if (rejection !== undefined) error = message(rejection);
      if (rejection instanceof WakeRequestError && !rejection.retryable) {
        state = { kind: "failed", error };
        return;
      }
      const retryable = rejection instanceof WakeRequestError && rejection.retryable;
      if (!retryable) {
        state = {
          kind: "unknown",
          error: `${error} Check the machine connection before trying again.`,
        };
        return;
      }
      error = host.lifecycle.message || error;
      if (attempt === 3) {
        state = { kind: "failed", error };
        return;
      }
      const backoff = [5000, 15000][attempt - 1] ?? 0;
      ensureTime(deadline, backoff);
      state = { kind: "retrying", attempt, retryAt: now() + backoff, error };
      await pause(backoff);
    }
  }

  return {
    current: () => state,
    get(requestedId: string): WakeState {
      if (requestedId === jobId) return state;
      for (const receipt of receipts.values())
        if (receipt.jobId === requestedId) return receipt.state;
      return {
        kind: "unknown",
        error:
          "This wake job is no longer available. The server may have restarted; check the machine connection.",
      };
    },
    start(id: string = randomUUID(), requestedAt = now()) {
      const cutoff = now() - 5 * 60_000;
      if (requestedAt < cutoff || requestedAt > now() + 30_000)
        return unknown(
          "This wake request expired. Check the machine connection before clicking again.",
        );
      for (const [key, receipt] of receipts) if (receipt.requestedAt < cutoff) receipts.delete(key);
      for (const [key, at] of remembered) if (at < cutoff) remembered.delete(key);
      const previous = receipts.get(id);
      if (previous) return previous.jobId === jobId ? { jobId, state } : previous;
      if (remembered.has(id))
        return unknown(
          "This wake request was accepted before a restart. Check the machine connection.",
        );
      if (signal.aborted || remembered.size >= 100)
        return unknown(
          "Wake is temporarily unavailable. Check the machine connection before trying again.",
        );
      remembered.set(id, requestedAt);
      seenRequests.save([...remembered]);
      if (running) {
        receipts.set(id, { requestedAt, jobId, state });
        return { jobId, state };
      }
      jobId = randomUUID();
      running = true;
      state = { kind: "waking", attempt: 1 };
      receipts.set(id, { requestedAt, jobId, state });
      void run()
        .catch((cause: unknown) => {
          // A failed observation cannot prove that the power operation stopped.
          state = {
            kind: cause instanceof WakeRequestError && !cause.retryable ? "failed" : "unknown",
            error: message(cause),
          };
        })
        .finally(() => {
          for (const receipt of receipts.values())
            if (receipt.jobId === jobId) receipt.state = state;
          running = false;
        });
      return { jobId, state };
    },
  };
}
