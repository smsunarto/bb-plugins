import { defineQuery } from "@bb-kit/core/rpc";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { join } from "node:path";
import type { z } from "zod";
import {
  renderEmbedInputSchema,
  renderEmbedOutputSchema,
  type RenderEmbedOutput,
} from "../../shared/contract.ts";
import { citationPatch } from "../lib/citation-patch.ts";
import { rangePatch } from "../lib/diff-range.ts";
import { splitPatchFiles } from "../lib/patch-file.ts";

const MAX_PATH_LENGTH = 1_024;
const MAX_FILE_BYTES = 1_500_000;

/** A relative path that stays inside its root: no leading slash, no `..`, no empty segments. */
function relativePath(value: string | undefined): string | null {
  const path = value?.trim() ?? "";
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
    if (input.kind === "patch") return renderPatch(ctx, input);

    const path = relativePath(input.path);
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

type QueryContext = { bb: BbPluginApi };
type PatchInput = z.output<typeof renderEmbedInputSchema>;

/**
 * Render a patch the agent wrote to thread storage but has not applied. The
 * file is read under the thread's storage root; `path` picks one file out of a
 * multi-file patch and is inferred when the patch touches exactly one.
 */
async function renderPatch(ctx: QueryContext, input: PatchInput): Promise<RenderEmbedOutput> {
  const file = relativePath(input.file);
  if (file === null) {
    return { status: "error", message: "Expected a thread-storage-relative patch file." };
  }
  const requestedPath = input.path === undefined ? undefined : relativePath(input.path);
  if (requestedPath === null) {
    return { status: "error", message: "Expected a worktree-relative file path." };
  }

  try {
    const location = await ctx.bb.sdk.threads.storageLocation({ threadId: input.threadId });
    const read = await ctx.bb.sdk.files.read({
      hostId: location.hostId,
      path: join(location.storageRootPath, ...file.split("/")),
      rootPath: location.storageRootPath,
    });
    if (read.contentEncoding !== "utf8") {
      return { status: "error", message: "A patch embed needs a UTF-8 unified diff." };
    }
    if (utf8Bytes(read.content) > MAX_FILE_BYTES) {
      return { status: "error", message: "This patch is too large for an inline embed." };
    }
    const files = splitPatchFiles(read.content);
    if (files.length === 0) {
      return { status: "empty", message: `No file changes found in ${file}.` };
    }
    const selected =
      requestedPath === undefined
        ? files.length === 1
          ? files[0]
          : undefined
        : files.find((candidate) => candidate.path === requestedPath);
    if (selected === undefined) {
      return {
        status: "error",
        message:
          requestedPath === undefined
            ? `${file} touches ${files.length} files. Add path= to choose one.`
            : `${file} has no changes for ${requestedPath}.`,
      };
    }
    if (input.start === undefined && input.end === undefined) {
      return {
        status: "ready",
        kind: "patch",
        path: selected.path,
        label: selected.path,
        patch: selected.patch,
        truncated: false,
      };
    }
    const range = rangePatch(selected.path, selected.patch, input.start, input.end);
    if ("error" in range) return { status: "error", message: range.error };
    if ("empty" in range) return { status: "empty", message: range.empty };
    return {
      status: "ready",
      kind: "patch",
      path: selected.path,
      label: range.label,
      patch: range.patch,
      truncated: false,
    };
  } catch (error) {
    ctx.bb.log.warn(
      `smart patch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { status: "error", message: `Could not load ${file} from this thread's storage.` };
  }
}
