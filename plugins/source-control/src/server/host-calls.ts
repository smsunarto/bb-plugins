/**
 * How the server talks to a checkout's host: the calls it makes, the deadline
 * it holds them to, and what a failed call means as a problem naming the host.
 */
import { Effect, Schema } from "effect";
import type {
  Patches,
  PatchSource,
  Placement,
  Problem,
  Revision,
  VcsAction,
  VcsResult,
} from "../core/change.ts";
import type {
  HostFailure,
  HostWorkspace,
  RangeAnswer,
  RangeRead,
  ReadAs,
} from "../contract/host.ts";

export const HOST_DEADLINE_MS = 10_000;

type Outcome<T> = { ok: true; value: T } | { ok: false; error: HostFailure };
export type CallOptions = { signal: AbortSignal; timeoutMs: number };

/** The host calls the server makes, bound to a host by id. */
export type HostCalls = {
  workspace(
    hostId: string,
    input: { path: string; readAs: ReadAs },
    options: CallOptions,
  ): Promise<Outcome<HostWorkspace>>;
  renewWatch(hostId: string, path: string, options: CallOptions): Promise<unknown>;
  vcsAction(
    hostId: string,
    input: { path: string; readAs: ReadAs; action: VcsAction; expected: Revision },
    options: CallOptions,
  ): Promise<VcsResult>;
  patches(
    hostId: string,
    input: { path: string; readAs: ReadAs; source: PatchSource },
    options: CallOptions,
  ): Promise<Outcome<Patches>>;
  range(
    hostId: string,
    input: { path: string; base: string; head: string; read: RangeRead },
    options: CallOptions,
  ): Promise<Outcome<RangeAnswer>>;
};

/** The host did not answer before the server's deadline. */
export class HostDeadline extends Schema.TaggedError<HostDeadline>()("HostDeadline", {}) {}

/** The host call rejected: the host went away, or the SDK gave up on it. */
export class HostCallFailed extends Schema.TaggedError<HostCallFailed>()("HostCallFailed", {
  cause: Schema.Defect(),
}) {}

/**
 * One host call held to `deadlineMs`. The SDK resends a retryable read
 * halfway through its own timeout and its promise ignores an abort, so the
 * deadline is kept here: when it passes, the call's signal aborts and its
 * answer is no longer awaited.
 */
export function hostCall<T>(
  deadlineMs: number,
  call: (options: CallOptions) => Promise<T>,
): Effect.Effect<T, HostDeadline | HostCallFailed> {
  return Effect.tryPromise({
    try: (signal) => call({ signal, timeoutMs: deadlineMs }),
    catch: (cause) => new HostCallFailed({ cause }),
  }).pipe(
    Effect.timeoutOrElse({ duration: deadlineMs, orElse: () => Effect.fail(new HostDeadline()) }),
  );
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const offline = (placement: Placement): Problem => ({
  kind: "host-offline",
  host: placement.hostName,
});

/** A call that rejected, as a problem: offline when bb no longer has the host connected. */
export function callProblem(
  placement: Placement,
  error: HostDeadline | HostCallFailed,
  stillConnected: boolean,
): Problem {
  if (error._tag === "HostDeadline" || !stillConnected) return offline(placement);
  const cause = error.cause;
  const timedOut =
    cause instanceof Error && (cause.name === "TimeoutError" || /timed? ?out/i.test(cause.message));
  if (timedOut) return offline(placement);
  return { kind: "failed", site: placement.hostName, detail: message(cause) };
}

/** A failure the host reported, as a problem naming the host. */
export function failureProblem(placement: Placement, failure: HostFailure): Problem {
  if (failure.code === "git-missing" || failure.code === "but-missing")
    return {
      kind: "tool-missing",
      tool: failure.code === "git-missing" ? "git" : "but",
      host: placement.hostName,
      detail: failure.message,
    };
  return { kind: "failed", site: placement.hostName, detail: failure.message };
}

/** A host names itself "host" in problems; the server knows its name. */
export function named(problem: Problem, placement: Placement): Problem {
  if (problem.kind === "failed" && problem.site === "host")
    return { ...problem, site: placement.hostName };
  if (problem.kind === "tool-missing" && problem.host === "host")
    return { ...problem, host: placement.hostName };
  return problem;
}
