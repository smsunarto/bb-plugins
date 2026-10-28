import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const DOCS_PATH_LIST_LIMIT = 5_000;

/** Changed paths one `vaultChanged` signal names. A larger batch names none,
 *  which listeners read as "anything in the vault may have changed". */
export const VAULT_CHANGE_PATH_LIMIT = 100;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const docsHostContract = defineRpcContract({
  listPaths: {
    experimental_retryable: true,
    input: z
      .object({
        path: z.string().min(1),
        includeFiles: z.boolean(),
        includeDirectories: z.boolean(),
        limit: z.number().int().min(1).max(DOCS_PATH_LIST_LIMIT),
      })
      .strict(),
    output: z
      .object({
        paths: z
          .array(
            z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("directory"), path: z.string().min(1) }).strict(),
              z
                .object({
                  kind: z.literal("file"),
                  path: z.string().min(1),
                  // Archives can restore pre-1970 times, so allow negatives.
                  modifiedAtMs: z.number(),
                  sizeBytes: z.number().int().nonnegative(),
                })
                .strict(),
            ]),
          )
          .max(DOCS_PATH_LIST_LIMIT),
        truncated: z.boolean(),
      })
      .strict(),
  },
  watchVault: {
    input: z.object({ vaultId: z.string().min(1), rootPath: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  unwatchVault: {
    input: z.object({ vaultId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  // Which of these watches the host still holds. A restarted daemon holds none.
  watchAlive: {
    experimental_retryable: true,
    input: z.object({ vaultIds: z.array(z.string().min(1)).max(1_000) }).strict(),
    output: z.object({ live: z.array(z.string()) }).strict(),
  },
  // Whether a file exists, without moving its content off the host.
  statFile: {
    experimental_retryable: true,
    input: z.object({ path: z.string().min(1) }).strict(),
    output: z
      .object({
        file: z
          .object({ modifiedAtMs: z.number(), sizeBytes: z.number().int().nonnegative() })
          .strict()
          .nullable(),
      })
      .strict(),
  },
  // Watch one file outside every vault until `leaseMs` passes without a
  // renewal; renewing answers the file's current hash (null when missing).
  watchFile: {
    input: z
      .object({
        watchId: z.string().min(1),
        path: z.string().min(1),
        leaseMs: z.number().int().min(1_000).max(3_600_000),
      })
      .strict(),
    output: z.object({ sha256: sha256Schema.nullable() }).strict(),
  },
});

export const docsHostSignals = {
  vaultChanged: {
    payload: z
      .object({
        vaultId: z.string().min(1),
        kind: z.enum(["changed", "rescan-required", "watch-error"]),
        // Vault-relative paths with their new hash (null once deleted or too
        // large to hash), so the server can drop the echo of its own writes.
        // Absent when the batch is larger than VAULT_CHANGE_PATH_LIMIT.
        changes: z
          .array(z.object({ path: z.string().min(1), sha256: sha256Schema.nullable() }).strict())
          .max(VAULT_CHANGE_PATH_LIMIT)
          .optional(),
      })
      .strict(),
  },
  fileChanged: {
    payload: z.object({ watchId: z.string().min(1), sha256: sha256Schema.nullable() }).strict(),
  },
} as const;
