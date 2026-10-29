import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { gitEntrySchema, taskResultSchema } from "./domain.ts";

/** The repo path as configured. The host expands a leading `~` against its own home. */
const repoPath = z.string().min(1);

/** What the server asks of the machine that holds the dotfiles checkout. */
export const dotfilesHostContract = defineRpcContract({
  inspect: {
    experimental_retryable: true,
    input: z.object({ repoPath }).strict(),
    output: z.discriminatedUnion("repo", [
      z
        .object({
          repo: z.literal("missing"),
          /** Absolute, with `~` expanded on the host. */
          repoPath: z.string(),
        })
        .strict(),
      z
        .object({
          repo: z.literal("found"),
          /** Absolute, with `~` expanded on the host. */
          repoPath: z.string(),
          branch: z.string(),
          entries: z.array(gitEntrySchema),
          skills: z.array(z.object({ path: z.string(), title: z.string() }).strict()),
          /** Fixed file-list paths absent from the checkout. */
          missingPaths: z.array(z.string()),
        })
        .strict(),
    ]),
  },
  readHead: {
    experimental_retryable: true,
    input: z.object({ repoPath, path: z.string().min(1) }).strict(),
    output: z.object({ content: z.string().nullable() }).strict(),
  },
  run: {
    input: z.object({ repoPath, command: z.string().min(1) }).strict(),
    output: taskResultSchema,
  },
});

export type RepoInspection = z.infer<typeof dotfilesHostContract.inspect.output>;
