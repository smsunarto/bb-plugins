import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const DOCS_PATH_LIST_LIMIT = 5_000;

export const docsHostContract = defineRpcContract({
  listPaths: {
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
    input: z.object({ vaultIds: z.array(z.string().min(1)).max(1_000) }).strict(),
    output: z.object({ live: z.array(z.string()) }).strict(),
  },
});

export const docsHostSignals = {
  vaultChanged: {
    payload: z
      .object({
        vaultId: z.string().min(1),
        kind: z.enum(["changed", "rescan-required", "watch-error"]),
      })
      .strict(),
  },
} as const;
