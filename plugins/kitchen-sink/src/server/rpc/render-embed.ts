import { loadDiffEmbed } from "../lib/load-diff-embed.ts";
import { defineQuery } from "@bb-kit/core/rpc";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { join } from "node:path";
import { isUnityAsset } from "@bb-plugins/unity-inspector/model";
import { buildUnityCitation } from "@bb-plugins/unity-inspector/parse";
import {
  renderEmbedInputSchema,
  renderEmbedOutputSchema,
  type RenderEmbedInput,
  type RenderEmbedOutput,
} from "../../shared/contract.ts";
import { codeCitation } from "../lib/code-citation.ts";
import {
  candidateWorkspaceRoots,
  labelForeignHost,
  resolveWorkspace,
  threadWorkspaceRoot,
  WorkspaceError,
  type WorkspaceRoot,
} from "../lib/workspace-root.ts";
const MAX_PATH_LENGTH = 1024;
const MAX_FILE_BYTES = 1_500_000;
/** A sleeping machine must not stall a citation the reader is waiting on. */
const PROBE_TIMEOUT_MS = 3_000;
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

type FileResult = Awaited<ReturnType<BbPluginApi["sdk"]["files"]["read"]>>;

/** The read produced a real miss, not an offline host or a policy refusal. */
function isMissingFile(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error)
    return (error as { status: unknown }).status === 404;
  return error instanceof Error && /does not exist|no such file|not found/i.test(error.message);
}

function readAt(bb: BbPluginApi, root: WorkspaceRoot, path: string): Promise<FileResult> {
  return bb.sdk.files.read({
    hostId: root.hostId,
    path: join(root.path, path),
    rootPath: root.path,
  });
}

/**
 * Probe other project checkouts for the cited path. Hits on the thread's own
 * machine win over other machines, and the thread's project wins outright; a
 * single hit elsewhere resolves; several hits fail closed with the workspace
 * names so the reader can pin one. Another machine's checkout of the thread's
 * own project is never a candidate: it holds a different working copy.
 */
async function probeWorkspaceRoots(
  bb: BbPluginApi,
  threadId: string,
  path: string,
): Promise<WorkspaceRoot> {
  const thread = await bb.sdk.threads.get({ threadId });
  const own = await threadWorkspaceRoot(bb, threadId).catch(() => null);
  const candidates = (
    await candidateWorkspaceRoots(
      bb,
      thread.projectId ?? null,
      own ?? { hostId: "", path: "", label: "" },
    )
  ).filter((root) => !own || root.projectId !== thread.projectId || root.hostId === own.hostId);
  const byHost = new Map<string, WorkspaceRoot[]>();
  for (const root of candidates) {
    const list = byHost.get(root.hostId) ?? [];
    list.push(root);
    byHost.set(root.hostId, list);
  }
  const found = new Set<WorkspaceRoot>();
  await Promise.all(
    [...byHost].map(async ([hostId, roots]) => {
      try {
        const result = await bb.sdk.hosts.pathsExist({
          hostId,
          paths: roots.map((root) => join(root.path, path)),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        for (const root of roots) {
          if (result.existence[join(root.path, path)]) found.add(root);
        }
      } catch {
        // An unreachable or sleeping host simply cannot hold the citation.
      }
    }),
  );
  // Candidate order decides, never which host answered first.
  const hits = candidates.filter((root) => found.has(root));
  const local = hits.filter((hit) => hit.hostId === own?.hostId);
  const pool = local.length > 0 ? local : hits;
  const labelled = (root: WorkspaceRoot) => labelForeignHost(bb, root, own?.hostId);
  const preferred = pool.find((hit) => hit.projectId === thread.projectId);
  if (preferred) return labelled(preferred);
  if (pool.length === 1) return labelled(pool[0]!);
  if (pool.length > 1) {
    const roots = await Promise.all(pool.map(labelled));
    const labels = [...new Set(roots.map((root) => root.label))].join(", ");
    throw new WorkspaceError(
      `${path} exists in several workspaces (${labels}). Add workspace="<name>" to choose.`,
    );
  }
  throw new WorkspaceError(`Could not load ${path} from any known workspace.`);
}

type CitationFile = { file: FileResult; workspace?: string };
async function citationFile(
  bb: BbPluginApi,
  input: Extract<RenderEmbedInput, { kind: "code" }>,
  path: string,
): Promise<CitationFile> {
  if (input.workspace !== undefined) {
    const own = await threadWorkspaceRoot(bb, input.threadId).catch(() => null);
    const root = await resolveWorkspace(bb, input.workspace, own?.hostId);
    const file = await readAt(bb, root, path);
    if (own && own.hostId === root.hostId && own.path === root.path) return { file };
    return { file, workspace: (await labelForeignHost(bb, root, own?.hostId)).label };
  }
  const root = await threadWorkspaceRoot(bb, input.threadId);
  try {
    return { file: await readAt(bb, root, path) };
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const hit = await probeWorkspaceRoots(bb, input.threadId, path);
    return { file: await readAt(bb, hit, path), workspace: hit.label };
  }
}

function decorateUnityCitation(
  bb: BbPluginApi,
  output: Extract<RenderEmbedOutput, { status: "ready"; kind: "code" }>,
  input: Extract<RenderEmbedInput, { kind: "code" }>,
  fileContent: string,
): void {
  if (!isUnityAsset(output.path)) return;
  try {
    const ranged = input.start !== undefined || input.end !== undefined;
    output.unity = buildUnityCitation(
      fileContent,
      ranged ? output.startLine : undefined,
      ranged ? output.startLine + output.content.split("\n").length - 1 : undefined,
    );
    if (!output.unity.groups.length) throw new Error("No properties in selected range");
    if (!ranged) {
      output.label = output.path;
      output.content = fileContent;
      output.startLine = 1;
    }
  } catch (error) {
    bb.log.debug(`Unity citation uses YAML for ${output.path}: ${String(error)}`);
    output.unityNotice = "Object view unavailable for this citation. Showing YAML.";
  }
}

export const renderEmbed = defineQuery({
  description:
    "Render a Smart Embed: a source citation, a recorded turn or commit diff, or a saved patch.",
  input: renderEmbedInputSchema,
  output: renderEmbedOutputSchema,
  async execute(ctx, input): Promise<RenderEmbedOutput> {
    if (input.kind !== "code") return loadDiffEmbed(ctx.bb, input);
    const path = relativePath(input.path);
    if (path === null)
      return { status: "error", message: "Expected a worktree-relative file path." };
    try {
      const { file, workspace } = await citationFile(ctx.bb, input, path);
      if (file.contentEncoding !== "utf8")
        return { status: "error", message: "Code citations require a UTF-8 text file." };
      if (utf8Bytes(file.content) > MAX_FILE_BYTES)
        return { status: "error", message: "This file is too large for an inline citation." };
      const excerpt = codeCitation(path, file.content, input.start, input.end);
      if ("error" in excerpt) return { status: "error", message: excerpt.error };
      const output: Extract<RenderEmbedOutput, { status: "ready"; kind: "code" }> = {
        status: "ready",
        kind: "code",
        path,
        ...excerpt,
        truncated: false,
        ...(workspace ? { workspace } : {}),
      };
      decorateUnityCitation(ctx.bb, output, input, file.content);
      return output;
    } catch (error) {
      ctx.bb.log.warn(`smart citation failed: ${String(error)}`);
      const message =
        error instanceof WorkspaceError
          ? error.message
          : `Could not load ${path} from this workspace.`;
      return { status: "error", message };
    }
  },
});
