import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import type { Board, CanvasNode } from "../../shared/schema.ts";
import { canvasContextInput } from "../../shared/canvas-agent.ts";
import { providerCapabilities } from "../../shared/generation.ts";
import { nodeInputs } from "../../shared/recipes.ts";
import { loadWorkspace } from "./studio.ts";

const budget = 40_000;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const history = new Set(["takes", "reviews", "judgements"]);

function semanticNode(
  { position: _position, width: _width, height: _height, ...node }: CanvasNode,
  board: Board,
) {
  const data: CanvasNode["data"] = {};
  const omittedDataKeys: string[] = [];
  for (const [key, value] of Object.entries(node.data)) {
    if (history.has(key) || size(value) > 6000 || size(data) + size({ [key]: value }) > 12_000)
      omittedDataKeys.push(key);
    else data[key] = value;
  }
  const inputPorts = nodeInputs(node, (id) => board.nodes.find((node) => node.id === id)?.type).map(
    ({ port, refs }) =>
      Object.assign({}, port, {
        max: Number.isFinite(port.max) ? port.max : null,
        connected: refs.length,
      }),
  );
  return { ...node, data, omittedDataKeys, inputPorts };
}

/** A page always makes progress, and reports exactly which collection it pages. */
function page<T>(items: T[], input: { offset: number; limit: number }, header: object) {
  const entries: T[] = [];
  for (const item of items.slice(input.offset, input.offset + input.limit)) {
    if (size({ ...header, items: [...entries, item] }) > budget - 1000) break;
    entries.push(item);
  }
  if (!entries.length && input.offset < items.length)
    throw new Error("This entry exceeds the context budget. Read the named canvas file directly.");
  const end = input.offset + entries.length;
  return {
    ...header,
    items: entries,
    total: items.length,
    offset: input.offset,
    nextOffset: end < items.length ? end : null,
  };
}

function fieldPage(
  nodes: CanvasNode[],
  field: NonNullable<z.output<typeof canvasContextInput>["field"]>,
  header: object,
) {
  const node = nodes.find(({ id }) => id === field.nodeId);
  if (!node || !Object.hasOwn(node.data, field.key))
    throw new Error("The requested node data field does not exist.");
  const value = node.data[field.key];
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let length = field.limit;
  const result = () => ({
    ...header,
    section: "field",
    nodeId: node.id,
    key: field.key,
    encoding: typeof value === "string" ? "text" : "json",
    text: text.slice(field.offset, field.offset + length),
    total: text.length,
    offset: field.offset,
    nextOffset: field.offset + length < text.length ? field.offset + length : null,
  });
  while (size(result()) > budget && length > 1) length = Math.floor(length / 2);
  return result();
}

export async function readCanvasContext(
  bb: BbPluginApi,
  input: z.output<typeof canvasContextInput>,
) {
  const workspace = await loadWorkspace(bb, input.gameId);
  const main = workspace.documents.find((doc) => doc.id === workspace.index.mainDocumentId);
  const header = {
    game: workspace.game,
    mainDocument: main
      ? {
          id: main.id,
          title: main.title,
          revision: main.revision,
          path: `canvas/documents/${main.id}.md`,
        }
      : null,
    documentCount: workspace.documents.length,
    assetCount: workspace.assets.length,
  };
  if (input.section === "assets")
    return page(workspace.assets, input, { ...header, section: "assets" });
  if (input.section === "documents")
    return page(
      workspace.documents.map(({ markdown: _markdown, ...doc }) => ({
        ...doc,
        path: `canvas/documents/${doc.id}.md`,
      })),
      input,
      { ...header, section: "documents" },
    );
  if (!input.boardId) {
    if (input.section === "edges") throw new Error("section edges requires boardId.");
    return page(
      workspace.boards.map(({ board, revision }) => ({
        id: board.id,
        name: board.name,
        revision,
        nodeCount: board.nodes.length,
        edgeCount: board.edges.length,
        path: `canvas/boards/${board.id}.json`,
      })),
      input,
      { ...header, section: "boards", providers: providerCapabilities },
    );
  }
  const selected = workspace.boards.find(({ board }) => board.id === input.boardId);
  if (!selected) throw new Error(`Board ${input.boardId} does not exist.`);
  const { board, revision } = selected;
  const boardHeader = {
    ...header,
    board: { id: board.id, name: board.name, revision, path: `canvas/boards/${board.id}.json` },
  };
  if (input.field) return fieldPage(board.nodes, input.field, boardHeader);
  if (input.section === "edges")
    return page(board.edges, input, { ...boardHeader, section: "edges" });
  if (input.nodeIds?.some((id) => !board.nodes.some((node) => node.id === id)))
    throw new Error("One of the requested nodeIds does not exist on this board.");
  const nodes = input.nodeIds
    ? board.nodes.filter(({ id }) => input.nodeIds!.includes(id))
    : board.nodes;
  return page(
    nodes.map((node) => semanticNode(node, board)),
    input,
    { ...boardHeader, section: "nodes" },
  );
}
