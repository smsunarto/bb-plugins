import { createHash } from "node:crypto";
import { z } from "zod";
import { mediaRequest, type canvasGenerationInput } from "../../shared/generation.ts";
import type { Workspace, Board, CanvasNode } from "../../shared/schema.ts";
import { files as instructions } from "./instructions.ts";
import { nodeBriefRecipe, nodeInputs } from "../../shared/recipes.ts";
import type { InputRef } from "../../shared/inputs.ts";

const reference = z.discriminatedUnion("type", [
  z.object({ type: z.literal("node"), nodeId: z.string(), port: z.string().optional() }),
  z.object({ type: z.literal("library"), assetId: z.string(), port: z.string().optional() }),
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
    takes: _takes,
    briefJobId: _briefJobId,
    ...data
  } = node.data;
  return { type: node.type, title: node.title, description: node.description, data };
}
/** Includes connected briefs and resolved catalog inputs, ignoring presentation-only layout. */
export function nodeFingerprint(
  node: CanvasNode,
  board: Board,
  workspace: Pick<Workspace, "documents" | "assets">,
) {
  const refs = references(node);
  const assetIds = new Set(refs.flatMap((ref) => (ref.type === "library" ? [ref.assetId] : [])));
  const dependencies = refs.flatMap((ref) => (ref.type === "node" ? [ref.nodeId] : []));
  const source = z
    .object({ type: z.literal("node"), nodeId: z.string() })
    .optional()
    .parse(node.data.promptSource);
  if (source) dependencies.push(source.nodeId);
  const sources = [...new Set(dependencies)].sort().map((id) => {
    const other = board.nodes.find((item) => item.id === id);
    if (!other) return { id, missing: true };
    if (
      other.type !== "text" &&
      other.type !== "document" &&
      typeof other.data.assetId === "string"
    )
      assetIds.add(other.data.assetId);
    const doc = workspace.documents.find((item) => item.id === other.data.documentId);
    return Object.assign(
      {},
      { id },
      semantic(other),
      { assetId: other.data.assetId },
      doc ? { documentRevision: doc.revision } : {},
    );
  });
  const assets = [...assetIds].sort().map((id) => {
    const asset = workspace.assets.find((item) => item.id === id);
    return asset
      ? { id, name: asset.name, path: asset.path, type: asset.type }
      : { id, missing: true };
  });
  return createHash("sha256")
    .update(JSON.stringify({ node: semantic(node), sources, ...(assets.length ? { assets } : {}) }))
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
  const imageLabels = new Map<string, Set<string>>();
  const visited = new Set<string>();
  const addNode = (id: string, promptOnly = false) => {
    if (id === node.id) throw new Error("A node cannot use itself as an input.");
    const other = board.nodes.find((item) => item.id === id);
    if (!other) throw new Error(`Reference node ${id} no longer exists.`);
    if (visited.has(id)) return;
    visited.add(id);
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
    addAsset(other.data.assetId, other);
  };
  const addAsset = (id: unknown, sourceNode?: CanvasNode) => {
    const asset = workspace.assets.find((item) => item.id === id);
    if (!asset || asset.type !== "image")
      throw new Error("Every image reference needs an existing image output.");
    paths.push(asset.path);
    const labels = imageLabels.get(asset.path) ?? new Set<string>();
    labels.add(
      sourceNode
        ? `${sourceNode.title || asset.name} (node: ${sourceNode.id})`
        : `${asset.name} (asset: ${asset.id})`,
    );
    imageLabels.set(asset.path, labels);
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
  const kindOf = (id: string) => board.nodes.find((item) => item.id === id)?.type;
  const ports = nodeInputs(node, kindOf);
  const over = ports.find(({ port, refs }) => refs.length > port.max);
  if (over)
    throw new Error(
      over.port.max
        ? `${over.port.label} takes ${over.port.max} input${over.port.max === 1 ? "" : "s"}. Remove the extra connection.`
        : `This model does not take ${over.port.type} inputs. Remove that connection.`,
    );
  /** The image connected to a single-image port such as a start frame or front view. */
  const slotPath = (id: string) => {
    const ref: InputRef | undefined = ports.find(({ port }) => port.id === id)?.refs[0];
    const assetId =
      ref?.type === "library"
        ? ref.assetId
        : board.nodes.find((item) => item.id === ref?.nodeId)?.data.assetId;
    return workspace.assets.find((asset) => asset.id === assetId)?.path;
  };
  const frames = node.type === "video" ? [slotPath("start"), slotPath("end")] : [];
  const promptSections = [
    node.type === "text"
      ? String(node.data.instruction ?? "")
      : typeof node.data.prompt === "string"
        ? node.data.prompt
        : (node.description ?? ""),
    ...linkedText,
  ];
  const prompt = promptSections.filter(Boolean).join("\n\n");
  const referenceKey = imageLabels.size
    ? {
        imageReferenceKey: instructions.read("generation/reference-key", {
          references: [...imageLabels.values()]
            .map((names, index) => `${index + 1}. ${JSON.stringify(Array.from(names))}`)
            .join("\n"),
        }),
      }
    : {};
  const target = {
    boardId: input.boardId,
    nodeId: input.nodeId,
    fingerprint: nodeFingerprint(node, board, workspace),
  };
  if (input.brief) {
    const recipe = nodeBriefRecipe(node);
    if (!recipe) throw new Error("Select an image or video node to write its brief.");
    const draft = typeof node.data.prompt === "string" ? node.data.prompt.trim() : "";
    if (!draft && !linkedText.length && !paths.length)
      throw new Error("Write a rough idea or connect inputs before writing the brief.");
    const settings =
      node.type === "video"
        ? `${String(node.data.aspectRatio ?? "16:9")}, ${String(node.data.duration ?? 5)} seconds${
            frames[0]
              ? `; image 1 is the start frame${frames[1] ? " and image 2 the end frame" : ""}`
              : ""
          }`
        : `${String(node.data.aspectRatio ?? "1:1")}, ${String(node.data.resolution ?? "1K")}`;
    return {
      request: mediaRequest.parse({
        kind: "text",
        briefFor: recipe.id,
        prompt: instructions.read("brief-input", {
          draft: draft || "(none: write it from the connected context)",
          context: linkedText.filter(Boolean).join("\n\n") || "(none)",
          settings,
        }),
        providerId: input.textProviderId,
        ...(input.model ? { model: input.model } : {}),
        images: node.type === "video" ? frames.filter(Boolean) : [...new Set(paths)],
        ...referenceKey,
      }),
      target,
    };
  }
  const labels = node.type === "image" || node.type === "text" ? referenceKey : {};
  const kind =
    node.type === "text"
      ? "text"
      : node.type === "model-3d"
        ? "model-3d"
        : node.type === "video"
          ? "video"
          : node.type === "image"
            ? "image"
            : undefined;
  if (!kind) throw new Error("Select a text, image, video, or 3D node.");
  const modelInput = () => {
    const front = slotPath("front");
    if (!front) throw new Error("Connect a Front view image before generating the 3D model.");
    if (input.approvedImagePath && input.approvedImagePath !== front)
      throw new Error("The approved image must be this node's Front view input.");
    const views = Object.fromEntries(
      (["left", "back", "right"] as const).flatMap((view) => {
        const path = slotPath(view);
        return path ? [[view, path]] : [];
      }),
    );
    return {
      kind,
      ...(input.model ? { model: input.model } : {}),
      approvedImagePath: front,
      ...(Object.keys(views).length ? { views } : {}),
      targetPolycount: node.data.targetPolycount,
    };
  };
  const request = mediaRequest.parse(
    kind === "text"
      ? {
          kind,
          prompt,
          providerId: input.textProviderId,
          ...(input.model ? { model: input.model } : {}),
          images: [...new Set(paths)],
          ...labels,
        }
      : kind === "model-3d"
        ? modelInput()
        : kind === "video"
          ? {
              kind,
              prompt,
              ...(input.model ? { model: input.model } : {}),
              imagePath: frames[0],
              endImagePath: frames[1],
              duration: node.data.duration,
              aspectRatio: node.data.aspectRatio,
            }
          : {
              kind,
              prompt,
              ...(input.model ? { model: input.model } : {}),
              images: [...new Set(paths)],
              ...labels,
              aspectRatio: node.data.aspectRatio,
              resolution: node.data.resolution,
            },
  );
  return { request, target };
}
