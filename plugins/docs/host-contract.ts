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
            z
              .object({
                kind: z.enum(["file", "directory"]),
                path: z.string().min(1),
              })
              .strict(),
          )
          .max(DOCS_PATH_LIST_LIMIT),
        truncated: z.boolean(),
      })
      .strict(),
  },
});
