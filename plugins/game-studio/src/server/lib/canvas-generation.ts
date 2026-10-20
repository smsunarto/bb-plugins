import { createHash } from "node:crypto";
import { z } from "zod";
import {
  mediaRequest,
  modelEditDefaults,
  modelOperations,
  modelViewPaths,
  modelViews,
  type AgentSelection,
  type GenerationJob,
  type MediaRequest,
  type canvasGenerationInput,
} from "../../shared/generation.ts";
import {
  nodeReviewSettings,
  nodeReviews,
  retryLineage,
  retryRequestId,
  retryWanted,
  reviewable,
  reviewedJobId,
  reviewVerdict,
} from "../../shared/review.ts";
import { nodeTakes } from "../../shared/takes.ts";
import { judgeCandidateLimit, judgeable, nodeJudgeSettings } from "../../shared/judge.ts";
import type { Workspace, Board, CanvasNode } from "../../shared/schema.ts";
import { files as instructions } from "./instructions.ts";
import { nodeBriefRecipe, nodeInputs, nodeRecipe } from "../../shared/recipes.ts";
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
    // Reviews judge outputs; they never change what the node generates.
    review: _review,
    reviews: _reviews,
    // A judge only moves the pick between outputs the node already made.
    judge: _judge,
    judgements: _judgements,
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
    modelPaths: string[] = [],
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
    if (asset?.type === "model") {
      modelPaths.push(asset.path);
      return;
    }
    if (!asset || asset.type !== "image")
      throw new Error("Every image or 3D reference needs an existing output.");
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
    node.type === "text" || node.type === "agent"
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
  const labels =
    node.type === "image" || node.type === "text" || node.type === "agent" ? referenceKey : {};
  const operation = tripoOperations[nodeRecipe(node)?.id ?? ""];
  const kind =
    node.type === "text"
      ? "text"
      : node.type === "agent"
        ? "agent"
        : node.type === "model-3d"
          ? operation
            ? "model-edit"
            : "model-3d"
          : node.type === "video"
            ? "video"
            : node.type === "image"
              ? "image"
              : undefined;
  if (!kind) throw new Error("Select a text, agent, image, video, or 3D node.");
  const agent = {
    providerId: input.textProviderId,
    ...(input.reasoningLevel ? { reasoningLevel: input.reasoningLevel } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
  };
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
  const editInput = () => {
    const sourcePath = slotPath("model");
    if (!sourcePath) throw new Error("Connect a 3D model to the Model input first.");
    const views = Object.fromEntries(
      modelViews.flatMap((view) => {
        const path = slotPath(view);
        return path ? [[view, path]] : [];
      }),
    );
    const text = (key: keyof typeof modelEditDefaults) =>
      typeof node.data[key] === "string" && node.data[key].trim()
        ? node.data[key].trim()
        : modelEditDefaults[key];
    return {
      kind,
      operation,
      sourcePath,
      ...(sourceTask(workspace, sourcePath)
        ? { sourceTaskId: sourceTask(workspace, sourcePath) }
        : {}),
      ...(operation === "texture" && Object.keys(views).length ? { views } : {}),
      ...(operation === "texture" && prompt ? { prompt } : {}),
      ...(operation === "texture" ? { textureQuality: text("textureQuality") } : {}),
      ...(operation === "rig" ? { rigType: text("rigType") } : {}),
      ...(operation === "animate" ? { animation: text("animation") } : {}),
    };
  };
  const request = mediaRequest.parse(
    kind === "text" || kind === "agent"
      ? {
          kind,
          prompt,
          ...agent,
          ...(input.model ? { model: input.model } : {}),
          images: [...new Set(paths)],
          ...(kind === "agent" ? { files: [...new Set(modelPaths)] } : {}),
          ...labels,
        }
      : kind === "model-edit"
        ? editInput()
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

/** The Tripo processing step each Tripo recipe runs. */
const tripoOperations: Partial<Record<string, (typeof modelOperations)[number]>> = {
  "tripo-texture": "texture",
  "tripo-pbr": "pbr",
  "tripo-rig": "rig",
  "tripo-animate": "animate",
};
/**
 * The Tripo task that made a model on this machine, so the next step processes that task
 * directly. A rig only survives this way: an animation must start from its rig's own task.
 */
function sourceTask(workspace: Workspace, path: string) {
  return workspace.generationJobs.find(
    (job) =>
      job.status === "succeeded" &&
      job.request.model.provider === "tripo" &&
      job.outputs.some((output) => output.path === path),
  )?.taskId;
}

/** The inputs a run was made from: its brief, and its input images with their roles. */
function runInputs(node: CanvasNode, request: MediaRequest | undefined) {
  if (request?.kind === "image")
    return {
      brief: request.prompt,
      images: request.images,
      roles:
        request.imageReferenceKey ??
        request.images.map((_, index) => `${index + 1}. input`).join("\n"),
    };
  if (request?.kind === "model-3d") {
    const views = modelViewPaths(request);
    return {
      brief:
        typeof node.data.prompt === "string" && node.data.prompt.trim()
          ? node.data.prompt
          : "(none: the model was built from the views alone)",
      images: views.map(([, path]) => path),
      roles: views.map(([view], index) => `${index + 1}. ${view} view`).join("\n"),
    };
  }
  return { brief: node.description || "(none)", images: [], roles: "" };
}

/**
 * A review of some of a node's outputs against the inputs of the run that made them: its saved
 * request when the run is still on record, else the node's current inputs.
 */
export function reviewRequest(
  workspace: Workspace,
  boardId: string,
  nodeId: string,
  assetIds: string[],
) {
  const selected = workspace.boards.find(({ board }) => board.id === boardId);
  const node = selected?.board.nodes.find(({ id }) => id === nodeId);
  if (!selected || !node) throw new Error("The canvas node no longer exists.");
  if (!reviewable(node.type)) throw new Error("Only image and 3D nodes can review their outputs.");
  const outputs = assetIds.map((id) => {
    const asset = workspace.assets.find((item) => item.id === id);
    if (!asset || (asset.type !== "image" && asset.type !== "model"))
      throw new Error("Review needs an existing image or 3D output.");
    return asset;
  });
  const inputs = sourceInputs(workspace, selected, node, assetIds);
  const images = outputs.filter((asset) => asset.type === "image").map((asset) => asset.path);
  const files = outputs.filter((asset) => asset.type === "model").map((asset) => asset.path);
  const first = inputs.images.length + 1;
  const settings = nodeReviewSettings(node);
  const request = mediaRequest.parse({
    kind: "text",
    reviewOf: assetIds,
    prompt: instructions.read("review-input", {
      brief: inputs.brief,
      inputs: inputs.images.length
        ? `Images 1–${inputs.images.length} are the run's input images:\n${inputs.roles}`
        : "The run had no input images.",
      outputs: [
        ...images.map(
          (path, index) =>
            `Image ${first + index}: ${path.split("/").pop()} (output ${index + 1} of ${outputs.length})`,
        ),
        ...files.map((path) => `File: ${path}`),
      ].join("\n"),
      criteria: settings?.criteria?.trim() || "(none)",
    }),
    images: [...inputs.images, ...images],
    ...(files.length ? { files } : {}),
    ...agentFields(settings?.agent),
  });
  return {
    request,
    target: { boardId, nodeId, fingerprint: nodeFingerprint(node, selected.board, workspace) },
  };
}

/**
 * A judgement between some of an image node's outputs by its judge criteria. It reads the brief
 * and inputs of the newest candidate's run, and sends those inputs only when every candidate
 * still fits beside them.
 */
export function judgeRequest(
  workspace: Workspace,
  boardId: string,
  nodeId: string,
  assetIds: string[],
) {
  const selected = workspace.boards.find(({ board }) => board.id === boardId);
  const node = selected?.board.nodes.find(({ id }) => id === nodeId);
  if (!selected || !node) throw new Error("The canvas node no longer exists.");
  if (!judgeable(node.type)) throw new Error("Only image nodes can judge their outputs.");
  if (assetIds.length < 2) throw new Error("A judge needs at least two outputs to choose from.");
  const candidates = assetIds.slice(-judgeCandidateLimit).map((id) => {
    const asset = workspace.assets.find((item) => item.id === id);
    if (asset?.type !== "image") throw new Error("A judge compares existing image outputs.");
    return asset;
  });
  const runInput = sourceInputs(workspace, selected, node, [...assetIds].reverse());
  const inputs =
    runInput.images.length + candidates.length <= textImageLimit
      ? runInput
      : { ...runInput, images: [], roles: "" };
  const first = inputs.images.length + 1;
  const settings = nodeJudgeSettings(node);
  const pick = typeof node.data.assetId === "string" ? node.data.assetId : undefined;
  const request = mediaRequest.parse({
    kind: "text",
    judgeOf: candidates.map(({ id }) => id),
    ...(pick ? { judgePick: pick } : {}),
    prompt: instructions.read("judge-input", {
      brief: inputs.brief,
      inputs: inputs.images.length
        ? `Images 1–${inputs.images.length} are the run's input images:\n${inputs.roles}`
        : runInput.images.length
          ? "The run's input images are left out so that every candidate fits."
          : "The run had no input images.",
      candidates: candidates
        .map(
          (asset, index) =>
            `Candidate ${index + 1} is image ${first + index}: ${asset.name}${asset.id === pick ? " (the node's current pick)" : ""}`,
        )
        .join("\n"),
      criteria: settings?.criteria?.trim() || "(none: choose the best fit for the brief)",
    }),
    images: [...inputs.images, ...candidates.map(({ path }) => path)],
    ...agentFields(settings?.agent),
  });
  return {
    request,
    target: { boardId, nodeId, fingerprint: nodeFingerprint(node, selected.board, workspace) },
  };
}

/** The most images one text run takes, per the text request schema. */
const textImageLimit = 20;

/** The run behind the first of these outputs still on record, else the node's current inputs. */
function sourceInputs(
  workspace: Workspace,
  selected: Workspace["boards"][number],
  node: CanvasNode,
  assetIds: string[],
) {
  const takes = nodeTakes(node);
  const jobId = assetIds
    .map((id) => takes.find((take) => take.assetId === id)?.jobId)
    .find((id) => id && workspace.generationJobs.some((job) => job.id === id));
  let source: MediaRequest | undefined = workspace.generationJobs.find(
    (job) => job.id === jobId,
  )?.request;
  if (!source)
    try {
      source = canvasRequest(workspace, {
        gameId: workspace.game.id,
        requestId: "review",
        boardId: selected.board.id,
        nodeId: node.id,
        revision: selected.revision,
      }).request;
    } catch {
      // A hand-made output has no inputs on record; it is judged on its own.
    }
  return runInputs(node, source);
}

/** The text run's agent, when the node pins one; else BB's default agent runs it. */
function agentFields(agent: AgentSelection | undefined) {
  return agent
    ? {
        providerId: agent.providerId,
        model: { provider: "bb", id: agent.model },
        reasoningLevel: agent.reasoningLevel,
        ...(agent.serviceTier ? { serviceTier: agent.serviceTier } : {}),
      }
    : {};
}

/**
 * The run an automatic review asks for: the judged run again, with the same snapshotted brief
 * and inputs, when the node's retry setting covers the verdict and the chain has retries left.
 */
export function retryRequest(workspace: Workspace, review: GenerationJob) {
  const sourceId = reviewedJobId(review.id);
  if (review.request.kind !== "text" || !review.request.reviewOf || !review.target || !sourceId)
    return undefined;
  const node = workspace.boards
    .find(({ board }) => board.id === review.target!.boardId)
    ?.board.nodes.find(({ id }) => id === review.target!.nodeId);
  const settings = node && nodeReviewSettings(node);
  const record = node && nodeReviews(node).find(({ jobId }) => jobId === review.id);
  const source = workspace.generationJobs.find(({ id }) => id === sourceId);
  if (!settings || !record || !source?.target || source.request.kind === "text") return undefined;
  if (!retryWanted(settings, reviewVerdict(record.text), retryLineage(source.id).attempt))
    return undefined;
  return { requestId: retryRequestId(source.id), request: source.request, target: source.target };
}
