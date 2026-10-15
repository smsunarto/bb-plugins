import { expect, test } from "bun:test";
import { canvasRequest } from "./canvas-generation.ts";
import { workspaceSchema } from "../../shared/schema.ts";
const workspace = () =>
  workspaceSchema.parse({
    game: {
      id: "game",
      name: "Orbit",
      projectId: "project",
      hostId: "host",
      rootPath: "/game",
      kind: "unity",
      createdAt: 0,
      threadId: "thread",
    },
    index: {
      version: 1,
      mainDocumentId: "design",
      boards: [{ id: "board", name: "Board" }],
      documents: [{ id: "design", title: "Design" }],
    },
    indexRevision: "index",
    documents: [
      { id: "design", title: "Design", markdown: "Brass and teal", revision: "document-1" },
    ],
    assets: [{ id: "ref", name: "Key", path: "canvas/staging/key.png", type: "image" }],
    boards: [
      {
        revision: "board-1",
        board: {
          version: 1,
          id: "board",
          viewport: { width: 1280, height: 720 },
          editorLayout: {
            version: 1,
            view: "canvas",
            nodes: {},
            viewport: { x: 0, y: 0, zoom: 1 },
          },
          edges: [],
          nodes: [
            {
              id: "design-node",
              type: "document",
              position: { x: 0, y: 0 },
              data: { documentId: "design" },
            },
            {
              id: "image",
              type: "image",
              position: { x: 300, y: 0 },
              data: {
                prompt: "A key icon",
                promptSource: { type: "node", nodeId: "design-node" },
                images: [{ type: "library", assetId: "ref" }],
              },
            },
            {
              id: "model",
              type: "model-3d",
              position: { x: 500, y: 0 },
              data: { images: [{ type: "library", assetId: "ref" }] },
            },
          ],
        },
      },
    ],
  });
const input = {
  gameId: "game",
  boardId: "board",
  nodeId: "image",
  revision: "board-1",
  requestId: "request",
};
test("saved document sources and image references become a typed request without canvas layout", () => {
  const state = workspace();
  const result = canvasRequest(state, input);
  expect(result.request).toMatchObject({
    kind: "image",
    prompt: "A key icon\n\nBrass and teal",
    images: ["canvas/staging/key.png"],
  });
  state.boards[0]!.board.nodes[1]!.position.x = 900;
  expect(canvasRequest(state, input).target.fingerprint).toBe(result.target.fingerprint);
  state.documents[0]!.revision = "document-2";
  expect(canvasRequest(state, input).target.fingerprint).not.toBe(result.target.fingerprint);
  expect(() => canvasRequest(state, { ...input, revision: "stale" })).toThrow("board changed");
});
test("3D requires the explicitly approved path to be one of the saved node's image references", () => {
  const state = workspace();
  expect(() => canvasRequest(state, { ...input, nodeId: "model" })).toThrow();
  const result = canvasRequest(state, {
    ...input,
    nodeId: "model",
    approvedImagePath: "canvas/staging/key.png",
  });
  expect(result.request).toMatchObject({
    kind: "model-3d",
    approvedImagePath: "canvas/staging/key.png",
    targetPolycount: 20000,
  });
  expect(() =>
    canvasRequest(state, {
      ...input,
      nodeId: "model",
      approvedImagePath: "canvas/staging/unrelated.png",
    }),
  ).toThrow("saved references");
});
