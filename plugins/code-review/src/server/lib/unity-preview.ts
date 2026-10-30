import { isUnityMeta } from "@bb-plugins/unity-inspector/model";
import {
  UnityLimitError,
  buildUnityDiffAsync,
  buildUnityMetaDiff,
} from "@bb-plugins/unity-inspector/parse";
import { Cache, Duration, Effect, Exit, Result } from "effect";
import type { BlobRequest } from "../../shared/blob-url.ts";
import type { Comparison, UnityPreview } from "../../shared/schema.ts";
import { BlobError, type BlobReader } from "./blobs.ts";
import { type Run, runDetached } from "./run.ts";

/*
 * A Unity asset's change, compared as objects on the server so a phone gets
 * the small answer instead of two scenes. Both whole files are compared, so
 * a change outside the patch's lines, or behind a Git LFS pointer, still
 * shows. Parsing pauses between documents, so a large scene never holds up
 * the plugin's other requests, and stops at a deadline.
 */

/** Larger assets show only as text. */
export const MAX_UNITY_BYTES = 16 * 1024 * 1024;
/** Reading both sides, which may download Git LFS objects first. */
const READ_MS = 150_000;
/** Comparing them, once read. */
const UNITY_MS = 30_000;

export type UnityPreviews = {
  read(comparison: Comparison, path: string, previousPath: string | null): Promise<UnityPreview>;
};

type Asset = { comparison: Comparison; path: string; previousPath: string | null };

export function createUnityPreviews(blobs: BlobReader, run: Run = runDetached): UnityPreviews {
  const text = (request: BlobRequest) =>
    Effect.tryPromise({
      try: async (signal) => blobs.text(request, MAX_UNITY_BYTES, signal),
      catch: (error) => error,
    });

  const compare = Effect.fnUntraced(function* ({
    comparison,
    path,
    previousPath,
  }: Asset): Effect.fn.Return<UnityPreview, unknown> {
    const read = yield* Effect.all(
      [
        text({ comparison, side: "base", path: previousPath ?? path }),
        text({ comparison, side: "head", path }),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.timeoutOrElse({
        duration: READ_MS,
        orElse: () => Effect.fail(new BlobError(504, "Reading the asset took too long.")),
      }),
      Effect.result,
    );
    if (Result.isFailure(read)) {
      const error = read.failure;
      if (error instanceof BlobError && (error.status === 413 || error.status === 415)) {
        return { state: "unavailable", reason: error.message };
      }
      return yield* Effect.fail(error);
    }
    const [before, after] = read.success;
    const compared = yield* Effect.tryPromise({
      try: async (signal): Promise<UnityPreview> =>
        isUnityMeta(path)
          ? { state: "meta", diff: buildUnityMetaDiff(before ?? "", after ?? "") }
          : {
              state: "objects",
              diff: await buildUnityDiffAsync(before ?? "", after ?? "", null, { signal }),
            },
      catch: (error) => error,
    }).pipe(
      // A busy server may compare it in time later, so this is a failure to retry, not an answer.
      Effect.timeoutOrElse({
        duration: UNITY_MS,
        orElse: () =>
          Effect.fail(new BlobError(504, "This asset took too long to compare as objects.")),
      }),
      Effect.result,
    );
    if (Result.isSuccess(compared)) return compared.success;
    if (compared.failure instanceof BlobError) return yield* Effect.fail(compared.failure);
    return {
      state: "unavailable",
      reason:
        compared.failure instanceof UnityLimitError
          ? "This asset changed in too many places to show as objects."
          : "This asset is not saved as Unity text YAML, or its YAML could not be read.",
    };
  });

  // Pinned to commits, so an answer never goes stale. Failures, timeouts
  // included, are not kept, so the card's Retry reads again.
  const answers = Effect.runSync(
    Cache.makeWith(compare, {
      capacity: 64,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    }),
  );

  return {
    read: (comparison, path, previousPath) =>
      run(Cache.get(answers, { comparison, path, previousPath })),
  };
}
