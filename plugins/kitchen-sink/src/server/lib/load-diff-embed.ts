import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { join } from "node:path";
import type { RenderEmbedInput, RenderEmbedOutput } from "../../shared/contract.ts";
import { rangePatch } from "./diff-range.ts";
import { relativeEmbedPath, splitPatchFiles } from "./patch-file.ts";
import { readDiffSnapshot, saveDiffSnapshot, snapshotDatabase } from "./diff-snapshot.ts";

type Input = Exclude<RenderEmbedInput, { kind: "code" }>;
const MAX_PATCH_BYTES = 1_500_000;

/** Scan only persisted diff events, matching the exact directive turn. Never pick a nearby turn. */
async function recordedPatch(bb: BbPluginApi, threadId: string, turnId: string): Promise<string> {
  let beforeSeq: string | undefined;
  for (let page = 0; page < 100; page++) {
    const events = await bb.sdk.threads.events.list({
      threadId,
      types: ["turn/diff/updated"],
      order: "desc",
      limit: "100",
      ...(beforeSeq ? { beforeSeq } : {}),
    });
    for (const event of events) {
      if (
        event.type === "turn/diff/updated" &&
        event.scope.kind === "turn" &&
        event.scope.turnId === turnId
      ) {
        if (event.data.diff === undefined) throw new Error("This turn has no recorded patch.");
        return event.data.diff;
      }
    }
    if (events.length < 100) break;
    beforeSeq = String(events.at(-1)!.seq);
  }
  throw new Error(
    "Recorded patch unavailable for this turn. Supply an exact commit SHA or a saved smart-patch file. No current workspace diff was substituted.",
  );
}

function validateInput(input: Input): void {
  if (input.path !== undefined && !relativeEmbedPath(input.path))
    throw new Error("Expected a worktree-relative file path.");
  if (input.start !== undefined && input.end !== undefined && input.end < input.start)
    throw new Error("The diff end line must not come before its start line.");
  if (input.kind === "patch") {
    if (!relativeEmbedPath(input.file) || !input.file.endsWith(".patch"))
      throw new Error("Expected a thread-storage-relative .patch file.");
    return;
  }
  if (input.sha && input.source !== "commit") throw new Error('Use source="commit" with sha.');
  if (input.source === "commit" && !input.sha)
    throw new Error("Commit evidence requires a full 40-character commit SHA.");
}

type Source = { patch: string; source: string };
async function gitSource(
  bb: BbPluginApi,
  input: Extract<Input, { kind: "diff" }>,
): Promise<Source> {
  const thread = await bb.sdk.threads.get({ threadId: input.threadId });
  if (!thread.environmentId) throw new Error("This thread has no workspace environment.");
  const environmentId = thread.environmentId;
  let target: Parameters<BbPluginApi["sdk"]["environments"]["diff"]>[0];
  if (input.source === "commit") target = { environmentId, target: "commit", sha: input.sha! };
  else {
    const environment = await bb.sdk.environments.get({ environmentId });
    let mergeBaseBranch = environment.mergeBaseBranch ?? environment.defaultBranch;
    if (!mergeBaseBranch) {
      const status = await bb.sdk.environments.status({ environmentId });
      if (status.outcome === "available")
        mergeBaseBranch =
          status.workspace.mergeBase?.mergeBaseBranch ?? status.workspace.branch.defaultBranch;
    }
    if (!mergeBaseBranch)
      throw new Error(
        "No workspace comparison branch is selected. Select a base in BB or use an exact commit.",
      );
    target = { environmentId, target: "all", mergeBaseBranch };
  }
  const result = await bb.sdk.environments.diff(target);
  if (result.outcome !== "available")
    throw new Error(result.outcome === "unavailable" ? result.failure.message : result.message);
  if (result.diff.truncated)
    throw new Error("The source diff was truncated. Use a smaller explicit commit or saved patch.");
  return {
    patch: result.diff.diff,
    source:
      input.source === "commit"
        ? `Commit: ${input.sha}`
        : "Workspace: branch and uncommitted changes at first display",
  };
}
async function loadSource(bb: BbPluginApi, input: Input): Promise<Source> {
  if (input.kind === "patch") {
    const location = await bb.sdk.threads.storageLocation({ threadId: input.threadId });
    const file = await bb.sdk.files
      .read({
        hostId: location.hostId,
        rootPath: location.storageRootPath,
        path: join(location.storageRootPath, input.file),
      })
      .catch((error: unknown) => {
        bb.log.warn(`Proposal read failed: ${String(error)}`);
        throw new Error(
          `Proposal file unavailable: ${input.file}. Keep the .patch file in this thread's storage.`,
        );
      });
    if (file.contentEncoding !== "utf8") throw new Error("Proposed patches require UTF-8 text.");
    return { patch: file.content, source: `Proposal: ${input.file}` };
  }
  if ((input.source ?? "turn") !== "turn") return gitSource(bb, input);
  if (!input.turnId)
    throw new Error(
      "This message has no recorded turn identity. Supply source=commit with sha, or source=workspace explicitly.",
    );
  return {
    patch: await recordedPatch(bb, input.threadId, input.turnId),
    source: `Recorded turn: ${input.turnId}`,
  };
}
function selectEvidence(input: Input, { patch, source }: Source): RenderEmbedOutput {
  if (new TextEncoder().encode(patch).byteLength > MAX_PATCH_BYTES)
    throw new Error("This patch is too large for an inline embed.");
  const files = splitPatchFiles(patch);
  const matches = input.path
    ? files.filter((file) => file.path === input.path || file.previousPath === input.path)
    : files;
  if (!matches.length)
    return {
      status: "empty",
      message: `No changes for ${input.path ?? "this proposal"} in ${source}.`,
    };
  if (matches.length !== 1) {
    if (
      input.kind !== "patch" ||
      input.path ||
      input.start !== undefined ||
      input.end !== undefined
    )
      throw new Error(
        "Select one file with path before using a line range. Repeated changes for the same path cannot be combined.",
      );
    return {
      status: "ready",
      kind: "patch",
      path: input.file,
      label: input.file,
      patch,
      files: matches.map(({ path, patch }) => ({ path, patch })),
      source,
      truncated: false,
    };
  }
  const file = matches[0]!;
  let label = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
  patch = file.patch;
  if (input.start !== undefined || input.end !== undefined) {
    const ranged = rangePatch(file.path, patch, input.start, input.end);
    if ("error" in ranged) throw new Error(ranged.error);
    if ("empty" in ranged) return { status: "empty", message: ranged.empty };
    patch = ranged.patch;
    label = ranged.label;
  }
  return {
    status: "ready",
    kind: input.kind,
    path: file.path,
    label,
    patch,
    source,
    truncated: false,
  };
}
export async function loadDiffEmbed(bb: BbPluginApi, input: Input): Promise<RenderEmbedOutput> {
  try {
    validateInput(input);
    const db = input.kind === "diff" ? snapshotDatabase(bb) : null;
    if (input.kind === "diff" && db) {
      const saved = readDiffSnapshot(db, input);
      if (saved) return saved;
    }
    const output = selectEvidence(input, await loadSource(bb, input));
    if (input.kind === "diff" && db && output.status === "ready" && output.kind === "diff")
      return saveDiffSnapshot(db, input, { ...output, kind: "diff" });
    return output;
  } catch (error) {
    bb.log.warn(`Smart diff source unavailable: ${String(error)}`);
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Could not load this diff source.",
    };
  }
}
