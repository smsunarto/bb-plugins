import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  boardSchema,
  type Board,
  type CanvasNode,
  type Workspace,
  type Asset,
} from "../../shared/schema.ts";
import { canvasEditInput, inputReference } from "../../shared/canvas-agent.ts";
import { initialData } from "../../shared/node-defaults.ts";
import { filterNodeReferences } from "../../shared/node-references.ts";
import { newNodePosition } from "../../shared/node-position.ts";
import { nodeInputs } from "../../shared/recipes.ts";
import {
  connectInput,
  connectAssetInput,
  disconnectInput,
  removeInput,
  withEdges,
} from "../../shared/canvas-connections.ts";
import { nodeRefs } from "../../shared/inputs.ts";
import { reviewSettings } from "../../shared/review.ts";
import { judgeSettings } from "../../shared/judge.ts";
import { loadWorkspace, saveBoard } from "./studio.ts";

const protectedKeys = new Set(["takes", "reviews", "judgements", "generationJobId", "briefJobId"]);
const selectedAssetTypes: Partial<Record<CanvasNode["type"], Asset["type"]>> = {
  image: "image",
  "model-3d": "model",
  video: "video",
};
function validateSelectedData(
  data: CanvasNode["data"],
  workspace: Workspace,
  kind: CanvasNode["type"],
) {
  if (data.assetId !== undefined) {
    const id = z.string().parse(data.assetId);
    const asset = workspace.assets.find((asset) => asset.id === id);
    const expected = selectedAssetTypes[kind];
    if (id && (!asset || (expected && asset.type !== expected)))
      throw new Error("Select an existing asset of this node's media type.");
  }
  if (data.documentId !== undefined) {
    const id = z.string().parse(data.documentId);
    if (id && !workspace.documents.some((doc) => doc.id === id))
      throw new Error("The selected document does not exist.");
  }
}
function checkedData(
  data: CanvasNode["data"],
  workspace: Workspace,
  kind: CanvasNode["type"],
  adding = false,
) {
  validateSelectedData(data, workspace, kind);
  if (!adding && ["images", "references", "promptSource"].some((key) => key in data))
    throw new Error(
      "Use connect/disconnect for wires and connect_asset/remove_input for library or wireless inputs.",
    );
  if (
    adding &&
    (data.promptSource !== undefined || nodeRefs({ data }).some((ref) => ref.type === "node"))
  )
    throw new Error("Use connect to add node inputs and their canvas wires together.");
  for (const key of Object.keys(data))
    if (protectedKeys.has(key))
      throw new Error(`${key} is generation history; edit the brief or selected asset instead.`);
  for (const key of ["images", "references"])
    if (data[key] !== undefined) z.array(inputReference).parse(data[key]);
  if (data.review !== undefined) reviewSettings.strict().parse(data.review);
  if (data.judge !== undefined) judgeSettings.strict().parse(data.judge);
  return data;
}

function validateNodeInputs(node: CanvasNode, board: Board, workspace: Workspace) {
  const kindOf = (id: string) => board.nodes.find((node) => node.id === id)?.type;
  for (const ref of nodeRefs(node)) {
    if (ref.type === "node" && (ref.nodeId === node.id || !kindOf(String(ref.nodeId))))
      throw new Error(`${node.id}: input refers to a missing node or itself.`);
    if (
      ref.type === "library" &&
      !workspace.assets.some((asset) => asset.id === ref.assetId && asset.type === "image")
    )
      throw new Error(
        `${node.id}: library input ${ref.assetId} must name an existing image asset.`,
      );
  }
  for (const { port, refs } of nodeInputs(node, kindOf)) {
    if (refs.length > port.max) throw new Error(`${node.id}: input port ${port.id} is full.`);
    if (refs.some((ref) => typeof ref.port === "string" && ref.port !== port.id))
      throw new Error(`${node.id}: an input names an unavailable port.`);
  }
}

function nodeById(board: Board, id: string) {
  const node = board.nodes.find((node) => node.id === id);
  if (!node) throw new Error(`Node ${id} does not exist.`);
  return node;
}
/** Build a complete draft before any disk write; saveBoard owns the atomic revision check. */
export function applyCanvasEdits(workspace: Workspace, input: z.output<typeof canvasEditInput>) {
  const selected = workspace.boards.find(({ board }) => board.id === input.boardId);
  if (!selected) throw new Error(`Board ${input.boardId} does not exist.`);
  if (selected.revision !== input.revision)
    throw new Error(
      `The board changed. Read canvas_context for board ${input.boardId} before editing. Current revision: ${selected.revision}`,
    );
  const board = structuredClone(selected.board);
  const validate = new Set<string>();
  for (const operation of input.operations) {
    switch (operation.op) {
      case "add_node": {
        if (board.nodes.some(({ id }) => id === operation.node.id))
          throw new Error(`Node ${operation.node.id} already exists.`);
        const position = newNodePosition(
          { x: 140, y: 150 },
          board.nodes.map((node) => ({
            position: node.position,
            measured: { width: node.width, height: node.height },
          })),
        );
        board.nodes.push({
          ...operation.node,
          position,
          data: {
            ...initialData(operation.node.type, workspace.documents),
            ...checkedData(operation.node.data, workspace, operation.node.type, true),
          },
        });
        validate.add(operation.node.id);
        break;
      }
      case "update_node": {
        const node = nodeById(board, operation.id);
        const { data, ...patch } = operation.patch;
        Object.assign(node, patch);
        if (data) node.data = { ...node.data, ...checkedData(data, workspace, node.type) };
        if (data?.recipe !== undefined) validate.add(node.id);
        break;
      }
      case "move_node": {
        const node = nodeById(board, operation.id);
        node.position = operation.position;
        break;
      }
      case "remove_node": {
        nodeById(board, operation.id);
        board.nodes = board.nodes.filter(({ id }) => id !== operation.id);
        board.edges = board.edges.filter(
          ({ source, target }) => source !== operation.id && target !== operation.id,
        );
        for (const node of board.nodes)
          node.data = filterNodeReferences(node.data, (id) => id !== operation.id);
        break;
      }
      case "connect":
        Object.assign(board, connectInput(board, operation));
        validate.add(operation.target);
        break;
      case "connect_asset":
        Object.assign(board, connectAssetInput(board, workspace.assets, operation));
        validate.add(operation.target);
        break;
      case "remove_input":
        Object.assign(board, removeInput(board, operation.id, operation.input));
        break;
      case "disconnect":
        Object.assign(board, disconnectInput(board, operation.id));
        break;
    }
  }
  for (const node of board.nodes.filter((node) => validate.has(node.id)))
    validateNodeInputs(node, board, workspace);
  return boardSchema.parse(withEdges(board));
}

export async function editCanvas(bb: BbPluginApi, input: z.output<typeof canvasEditInput>) {
  const workspace = await loadWorkspace(bb, input.gameId);
  const board = applyCanvasEdits(workspace, input);
  const saved = input.dryRun
    ? { revision: input.revision }
    : await saveBoard(bb, { gameId: input.gameId, board, revision: input.revision });
  return {
    ...saved,
    saved: !input.dryRun,
    boardId: board.id,
    nodeCount: board.nodes.length,
    edgeCount: board.edges.length,
    operations: input.operations.map((operation) => ({
      op: operation.op,
      id:
        operation.op === "add_node"
          ? operation.node.id
          : "id" in operation
            ? operation.id
            : operation.target,
    })),
    placement: "estimated",
  };
}
