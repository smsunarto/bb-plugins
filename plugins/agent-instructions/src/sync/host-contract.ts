import type { ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { isSafeSyncPath, MAX_SYNC_FILES } from "./paths.ts";

const syncPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    isSafeSyncPath,
    "must be a safe relative path under instructions/, rules/, skills/, or conflicts/",
  );

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const fileDigestSchema = z
  .object({
    sha256: sha256Schema,
    executable: z.boolean(),
    size: z.number().int().nonnegative(),
  })
  .strict();

export const syncManifestSchema = z
  .record(syncPathSchema, fileDigestSchema)
  .refine(
    (manifest) => Object.keys(manifest).length <= MAX_SYNC_FILES,
    `manifest cannot exceed ${MAX_SYNC_FILES} files`,
  );

/**
 * Host RPC methods for two-way mirror synchronization.
 * Every method derives the mirror root from `context.experimental_paths.dataDir`
 * so callers cannot redirect mirror I/O to arbitrary host paths.
 */
export const syncHostMethods = {
  mirrorInfo: {
    experimental_retryable: true,
    input: z.null(),
    output: z.object({ mirrorDir: z.string().min(1) }).strict(),
  },
  mirrorEnsureWatch: {
    input: z.null(),
    output: z
      .object({
        mirrorDir: z.string().min(1),
        manifest: syncManifestSchema,
        symlinks: z.array(z.string()),
        tooLarge: z.array(z.string()),
        truncated: z.boolean(),
      })
      .strict(),
  },
  mirrorSnapshot: {
    experimental_retryable: true,
    input: z.null(),
    output: z
      .object({
        mirrorDir: z.string().min(1),
        manifest: syncManifestSchema,
        symlinks: z.array(z.string()),
        tooLarge: z.array(z.string()),
        truncated: z.boolean(),
      })
      .strict(),
  },
  mirrorReadFiles: {
    experimental_retryable: true,
    input: z.object({ paths: z.array(syncPathSchema).max(500) }).strict(),
    output: z
      .object({
        files: z.array(
          z
            .object({
              path: syncPathSchema,
              executable: z.boolean(),
              sha256: sha256Schema,
              base64: z.string(),
            })
            .strict(),
        ),
        missing: z.array(syncPathSchema),
      })
      .strict(),
  },
  mirrorApplyOps: {
    input: z
      .object({
        writes: z
          .array(
            z
              .object({
                path: syncPathSchema,
                executable: z.boolean(),
                base64: z.string(),
                /** Current sha256 expected on the host (null when creating); mismatch refuses overwrite. */
                expectedSha256: sha256Schema.nullable(),
              })
              .strict(),
          )
          .max(500),
        deletes: z
          .array(
            z
              .object({
                path: syncPathSchema,
                expectedSha256: sha256Schema,
              })
              .strict(),
          )
          .max(500),
        /** When false, skip the post-batch full tree walk (caller requests it on the final batch). */
        includeManifest: z.boolean().optional(),
      })
      .strict(),
    output: z
      .object({
        applied: z.array(z.string()),
        conflicts: z.array(z.string()),
        manifest: syncManifestSchema.optional(),
      })
      .strict(),
  },
};

export const syncHostSignals = {
  mirrorChanged: {
    payload: z.object({ mirrorDir: z.string().min(1) }).strict(),
  },
} satisfies ExperimentalHostSignals;
