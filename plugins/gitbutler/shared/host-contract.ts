import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  commitIntentSchema,
  commitOutcomeSchema,
  hostRepositorySnapshotSchema,
  repositoryIssueSchema,
  repositoryPathSchema,
} from "./domain.ts";

export const hostInspectResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable"), issue: repositoryIssueSchema }).strict(),
  z.object({ kind: z.literal("ready"), repository: hostRepositorySnapshotSchema }).strict(),
]);

export const hostCommitResultSchema = z
  .object({ outcome: commitOutcomeSchema, repository: hostRepositorySnapshotSchema.nullable() })
  .strict();

export const gitButlerHostContract = defineRpcContract({
  inspectRepository: {
    input: z.object({ repositoryPath: repositoryPathSchema }).strict(),
    output: hostInspectResultSchema,
  },
  commitSelection: {
    input: z.object({ repositoryPath: repositoryPathSchema, intent: commitIntentSchema }).strict(),
    output: hostCommitResultSchema,
  },
});

export type HostInspectResult = z.infer<typeof hostInspectResultSchema>;
export type HostCommitResult = z.infer<typeof hostCommitResultSchema>;
