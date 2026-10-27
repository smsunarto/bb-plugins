import { isUnityMeta } from "@bb-plugins/unity-inspector/model";
import {
  UnityLimitError,
  buildUnityDiffAsync,
  buildUnityMetaDiff,
} from "@bb-plugins/unity-inspector/parse";
import type { Comparison, UnityPreview } from "../../shared/schema.ts";
import { BlobError, type BlobReader } from "./blobs.ts";
import { createCache } from "./cache.ts";
import { timedOut, withDeadline } from "./deadline.ts";

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

export function createUnityPreviews(blobs: BlobReader): UnityPreviews {
  // Pinned to commits, so an answer never goes stale. Failures, timeouts
  // included, are not kept, so the card's Retry reads again.
  const answers = createCache<UnityPreview>(64);

  async function compare(
    comparison: Comparison,
    path: string,
    previousPath: string | null,
  ): Promise<UnityPreview> {
    const reading = withDeadline(READ_MS);
    let before: string | null;
    let after: string | null;
    try {
      [before, after] = await Promise.all([
        blobs.text(
          { comparison, side: "base", path: previousPath ?? path },
          MAX_UNITY_BYTES,
          reading,
        ),
        blobs.text({ comparison, side: "head", path }, MAX_UNITY_BYTES, reading),
      ]);
    } catch (error) {
      if (error instanceof BlobError && (error.status === 413 || error.status === 415)) {
        return { state: "unavailable", reason: error.message };
      }
      if (timedOut(reading)) throw new BlobError(504, "Reading the asset took too long.");
      throw error;
    }
    const signal = withDeadline(UNITY_MS);
    try {
      if (isUnityMeta(path)) {
        return { state: "meta", diff: buildUnityMetaDiff(before ?? "", after ?? "") };
      }
      const diff = await buildUnityDiffAsync(before ?? "", after ?? "", null, { signal });
      return { state: "objects", diff };
    } catch (error) {
      if (error instanceof UnityLimitError) {
        return {
          state: "unavailable",
          reason: "This asset changed in too many places to show as objects.",
        };
      }
      // A busy server may compare it in time later, so this is a failure to retry, not an answer.
      if (signal.aborted)
        throw new BlobError(504, "This asset took too long to compare as objects.");
      return {
        state: "unavailable",
        reason: "This asset is not saved as Unity text YAML, or its YAML could not be read.",
      };
    }
  }

  return {
    read(comparison, path, previousPath) {
      return answers.read(JSON.stringify([comparison, path, previousPath]), () =>
        compare(comparison, path, previousPath),
      );
    },
  };
}
