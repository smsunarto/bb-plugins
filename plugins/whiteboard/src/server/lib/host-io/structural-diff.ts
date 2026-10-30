import type * as upstream from "../../../shared/node/review/structural-diff.ts";
import { routeHost } from "./client.ts";
import { lastProbedDiffr } from "./probe.ts";
import { structuralStream } from "./structural-stream.ts";

/**
 * Server facade for `server/structural-diff` (design §1.6, §3.1).
 * `structuralDiff` stays an AsyncGenerator, fed by ordered `structuralEvents`
 * host signals from the host that owns `repositoryPath` (a pinned checkout
 * that host created). The host runs upstream `structuralDiff`, so diffr
 * resolution, validation and error text are upstream's.
 */
export type {
  DiffComparison,
  StructuralDiffRequest,
} from "../../../shared/node/review/structural-diff.ts";

export const structuralDiff: typeof upstream.structuralDiff = async function* (input) {
  input.signal.throwIfAborted();
  const hostId = await routeHost({ rootPath: input.repositoryPath });
  yield* structuralStream(hostId, input);
};

/**
 * The diffr executable the last host probe found, or upstream's PATH fallback
 * `diffr`. The packageRoot argument is ignored: diffr resolves on the host.
 */
export const diffrExecutable: typeof upstream.diffrExecutable = () => lastProbedDiffr() ?? "diffr";

/** Upstream's message, naming the probed executable. */
export const diffrMissingError: typeof upstream.diffrMissingError = () =>
  new Error(
    `Cannot find diffr at ${diffrExecutable()}. Install diffr on the PATH of the bb host that holds the checkout, or set REVIEW_DIFFR_BINARY there to its executable.`,
  );
