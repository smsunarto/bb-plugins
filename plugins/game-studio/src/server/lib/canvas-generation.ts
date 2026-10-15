import { createHash } from "node:crypto";
import { z } from "zod";
import { mediaRequest, type canvasGenerationInput } from "../../shared/generation.ts";
import type { Workspace, Board, CanvasNode } from "../../shared/schema.ts";

const reference = z.discriminatedUnion("type", [
  z.object({ type: z.literal("node"), nodeId: z.string() }),
  z.object({ type: z.literal("library"), assetId: z.string() }),
]);
function references(node: CanvasNode) {
  return [node.data.images, node.data.references].flatMap((raw) =>
    raw === undefined ? [] : z.array(reference).parse(raw),
  );
}
function semantic(node: CanvasNode) {
  const {
    assetId: _assetId,
    generationJobId: _jobId,
    candidateAssetIds: _candidates,
    ...data
  } = node.data;
  return { type: node.type, title: node.title, description: node.description, data };
}
/** Includes connected briefs and their document revisions, while ignoring presentation-only layout. */
export function nodeFingerprint(
  node: CanvasNode,
  board: Board,
  workspace: Pick<Workspace, "documents">,
) {
  const dependencies = references(node).flatMap((ref) => (ref.type === "node" ? [ref.nodeId] : []));
  const source = z
    .object({ type: z.literal("node"), nodeId: z.string() })
    .optional()
    .parse(node.data.promptSource);
  if (source) dependencies.push(source.nodeId);
  const sources = [...new Set(dependencies)].sort().map((id) => {
    const other = board.nodes.find((item) => item.id === id);
    if (!other) return { id, missing: true };
    const doc = workspace.documents.find((item) => item.id === other.data.documentId);
    return Object.assign(
      {},
      { id },
      semantic(other),
      { assetId: other.data.assetId },
      doc ? { documentRevision: doc.revision } : {},
    );
  });
  return createHash("sha256")
    .update(JSON.stringify({ node: semantic(node), sources }))
    .digest("hex");
}
export function canvasRequest(workspace: Workspace, input: z.output<typeof canvasGenerationInput>) {
  const selected = workspace.boards.find(({ board }) => board.id === input.boardId);
  if (!selected || selected.revision !== input.revision)
    throw new Error(
      "The board changed. Read canvas_context and review the current brief before generating.",
    );
  const board = selected.board,
    node = board.nodes.find(({ id }) => id === input.nodeId);
  if (!node) throw new Error("The canvas node no longer exists.");
  const paths: string[] = [],
    linkedText: string[] = [];
  const addNode = (id: string, promptOnly = false) => {
    const other = board.nodes.find((item) => item.id === id);
    if (!other) throw new Error(`Reference node ${id} no longer exists.`);
    if (other.type === "text") {
      linkedText.push(String(other.data.text ?? ""));
      return;
    }
    if (other.type === "document") {
      const doc = workspace.documents.find((item) => item.id === other.data.documentId);
      if (!doc) throw new Error("The referenced design document is missing.");
      linkedText.push(doc.markdown);
      return;
    }
    if (promptOnly) throw new Error("promptSource must refer to a text or document node.");
    addAsset(other.data.assetId);
  };
  const addAsset = (id: unknown) => {
    const asset = workspace.assets.find((item) => item.id === id);
    if (!asset || asset.type !== "image")
      throw new Error("Every image reference needs an existing image output.");
    paths.push(asset.path);
  };
  const source = z
    .object({ type: z.literal("node"), nodeId: z.string() })
    .optional()
    .parse(node.data.promptSource);
  if (source) addNode(source.nodeId, true);
  for (const ref of references(node)) {
    if (ref.type === "node") addNode(ref.nodeId);
    else addAsset(ref.assetId);
  }
  const prompt = [
    typeof node.data.prompt === "string" ? node.data.prompt : (node.description ?? ""),
    ...linkedText,
  ]
    .filter(Boolean)
    .join("\n\n");
  const kind =
    node.type === "model-3d"
      ? "model-3d"
      : node.type === "video"
        ? "video"
        : node.type === "image"
          ? "image"
          : undefined;
  if (!kind) throw new Error("Select an image, video, or 3D node.");
  const request = mediaRequest.parse(
    kind === "model-3d"
      ? {
          kind,
          ...(input.model ? { model: input.model } : {}),
          approvedImagePath: input.approvedImagePath,
          targetPolycount: node.data.targetPolycount,
        }
      : kind === "video"
        ? {
            kind,
            prompt,
            ...(input.model ? { model: input.model } : {}),
            imagePath: paths[0],
            endImagePath: paths[1],
            duration: node.data.duration,
            aspectRatio: node.data.aspectRatio,
          }
        : {
            kind,
            prompt,
            ...(input.model ? { model: input.model } : {}),
            images: [...new Set(paths)],
            aspectRatio: node.data.aspectRatio,
            resolution: node.data.resolution,
          },
  );
  if (kind === "model-3d" && !paths.includes(input.approvedImagePath ?? ""))
    throw new Error("The approved image must be one of this node's saved references.");
  if (kind === "video" && paths.length > 2)
    throw new Error("This video tool accepts at most a start image and an end image.");
  return {
    request,
    target: {
      boardId: input.boardId,
      nodeId: input.nodeId,
      fingerprint: nodeFingerprint(node, board, workspace),
    },
  };
}
