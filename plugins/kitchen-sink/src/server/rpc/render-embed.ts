import { defineQuery } from "@bb-kit/core/rpc";
import { join } from "node:path";
import {
  renderEmbedInputSchema,
  renderEmbedOutputSchema,
  type RenderEmbedOutput,
} from "../../shared/contract.ts";
import { citationPatch } from "../lib/citation-patch.ts";
import { rangePatch } from "../lib/diff-range.ts";

const MAX_PATH_LENGTH = 1_024;
const MAX_FILE_BYTES = 1_500_000;

function workspacePath(value: string): string | null {
  const path = value.trim();
  if (
    path.length === 0 ||
    path.length > MAX_PATH_LENGTH ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.includes("\n") ||
    path.includes("\r")
  ) {
    return null;
  }
  const segments = path.split("/");
  return segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ? null
    : path;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export const renderEmbed = defineQuery({
  input: renderEmbedInputSchema,
  output: renderEmbedOutputSchema,
  async execute(ctx, input): Promise<RenderEmbedOutput> {
    const path = workspacePath(input.path);
    if (path === null) {
      return { status: "error", message: "Expected a worktree-relative file path." };
    }

    try {
      const thread = await ctx.bb.sdk.threads.get({ threadId: input.threadId });
      if (thread.environmentId === null) {
        return { status: "error", message: "This thread has no workspace environment." };
      }
      const environment = await ctx.bb.sdk.environments.get({
        environmentId: thread.environmentId,
      });

      if (input.kind === "diff") {
        const mergeBase =
          environment.mergeBaseBranch ?? environment.baseBranch ?? environment.defaultBranch;
        const target = mergeBase
          ? ({ type: "all", mergeBaseBranch: mergeBase } as const)
          : ({ type: "uncommitted" } as const);
        const result = await ctx.bb.sdk.environments.diffPatch({
          environmentId: environment.id,
          paths: [path],
          target,
        });
        if (result.outcome !== "available") {
          return { status: "error", message: "The workspace diff is not available." };
        }
        const file =
          result.patches.find((candidate) => candidate.path === path) ?? result.patches[0];
        if (file === undefined || file.patch.trim().length === 0) {
          return {
            status: "empty",
            message: `No branch or working-tree changes found for ${path}.`,
          };
        }
        if (input.start === undefined && input.end === undefined) {
          return {
            status: "ready",
            kind: "diff",
            path,
            label: path,
            patch: file.patch,
            truncated: file.truncated,
          };
        }
        const range = rangePatch(path, file.patch, input.start, input.end);
        if ("error" in range) return { status: "error", message: range.error };
        if ("empty" in range) return { status: "empty", message: range.empty };
        return {
          status: "ready",
          kind: "diff",
          path,
          label: range.label,
          patch: range.patch,
          truncated: file.truncated,
        };
      }

      if (environment.path === null) {
        return { status: "error", message: "This environment has no readable worktree." };
      }
      const file = await ctx.bb.sdk.files.read({
        hostId: environment.hostId,
        path: join(environment.path, ...path.split("/")),
        rootPath: environment.path,
      });
      if (file.contentEncoding !== "utf8") {
        return { status: "error", message: "Code citations require a UTF-8 text file." };
      }
      if (utf8Bytes(file.content) > MAX_FILE_BYTES) {
        return { status: "error", message: "This file is too large for an inline citation." };
      }
      const citation = citationPatch(path, file.content, input.start, input.end);
      if ("error" in citation) {
        return { status: "error", message: citation.error };
      }
      return {
        status: "ready",
        kind: "code",
        path,
        label: citation.label,
        patch: citation.patch,
        truncated: false,
      };
    } catch (error) {
      ctx.bb.log.warn(
        `smart embed failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: "error", message: `Could not load ${path} from this workspace.` };
    }
  },
});
