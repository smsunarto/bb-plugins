import { expect, test } from "bun:test";
import { canvasRequest } from "./canvas-generation.ts";
import { workspaceSchema } from "../../shared/schema.ts";
import { generationPrompt } from "../../shared/generation-prompt.ts";
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
function promptParts(prompt: string) {
  const [brief, key] = prompt.split("\n\nAttached image references (in attachment order):\n");
  return {
    brief,
    references: key
      ? key.split("\n").map((line) => ({
          image: Number(line.slice(0, line.indexOf("."))),
          labels: JSON.parse(line.slice(line.indexOf(".") + 2)),
        }))
      : [],
  };
}
test("saved document sources and image references become a typed request without canvas layout", () => {
  const state = workspace();
  const result = canvasRequest(state, input);
  expect(result.request).toMatchObject({
    kind: "image",
    images: ["canvas/staging/key.png"],
  });
  expect(
    promptParts(result.request.kind === "image" ? generationPrompt(result.request) : ""),
  ).toEqual({
    brief: "A key icon\n\nBrass and teal",
    references: [{ image: 1, labels: ["Key (asset: ref)"] }],
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
test("text and image node inputs resolve current outputs while text uses BB's selected provider", () => {
  const state = workspace(),
    board = state.boards[0]!.board;
  board.nodes.push({
    id: "lore",
    type: "text",
    position: { x: 0, y: 300 },
    data: { text: "An observatory key" },
  });
  board.nodes.push({
    id: "reference-image",
    type: "image",
    position: { x: 300, y: 300 },
    data: { assetId: "ref" },
  });
  board.nodes.push({
    id: "generated-text",
    type: "text",
    position: { x: 600, y: 300 },
    data: {
      instruction: "Write an item description",
      text: "Old output",
      references: [
        { type: "node", nodeId: "lore" },
        { type: "node", nodeId: "reference-image" },
      ],
    },
  });
  const request = canvasRequest(state, {
    ...input,
    nodeId: "generated-text",
    textProviderId: "my-bb-provider",
    model: { provider: "bb", id: "selected-model" },
  });
  expect(request.request).toEqual({
    kind: "text",
    model: { provider: "bb", id: "selected-model" },
    providerId: "my-bb-provider",
    outputCount: 1,
    images: ["canvas/staging/key.png"],
    imageReferenceKey:
      'Attached image references (in attachment order):\n1. ["Key (node: reference-image)"]',
    prompt: "Write an item description\n\nAn observatory key",
  });
  expect(
    promptParts(request.request.kind === "text" ? generationPrompt(request.request) : ""),
  ).toEqual({
    brief: "Write an item description\n\nAn observatory key",
    references: [{ image: 1, labels: ["Key (node: reference-image)"] }],
  });
  board.nodes.find((node) => node.id === "lore")!.data.text = "A broken observatory key";
  expect(canvasRequest(state, { ...input, nodeId: "generated-text" }).target.fingerprint).not.toBe(
    request.target.fingerprint,
  );
  board.nodes.find((node) => node.id === "image")!.data = {
    prompt: "Illustrate this item",
    references: [
      { type: "node", nodeId: "generated-text" },
      { type: "node", nodeId: "reference-image" },
    ],
  };
  expect(canvasRequest(state, input).request).toMatchObject({
    kind: "image",
    images: ["canvas/staging/key.png"],
  });
  const updated = canvasRequest(state, input).request;
  expect(promptParts(updated.kind === "image" ? updated.prompt : "").brief).toBe(
    "Illustrate this item\n\nOld output",
  );
});

for (const kind of ["image", "text"] as const) {
  test(`${kind} references keep attachment order and every name when duplicate images are collapsed`, () => {
    const state = workspace(),
      board = state.boards[0]!.board;
    state.assets.push({
      id: "palette",
      name: "Palette",
      path: "canvas/staging/palette.png",
      type: "image",
    });
    board.nodes.push(
      {
        id: "hero",
        type: "image",
        title: "Hero",
        position: { x: 0, y: 0 },
        data: { assetId: "ref" },
      },
      {
        id: "alias",
        type: "image",
        title: "Shape study",
        position: { x: 0, y: 0 },
        data: { assetId: "ref" },
      },
    );
    board.nodes[1]!.type = kind;
    board.nodes[1]!.data = {
      prompt: "Use Hero for shape and Palette for color",
      instruction: "Use Hero for shape and Palette for color",
      images: [
        { type: "node", nodeId: "hero" },
        { type: "library", assetId: "palette" },
        { type: "library", assetId: "ref" },
      ],
      references: [{ type: "node", nodeId: "alias" }],
    };
    const request = canvasRequest(state, input).request;
    expect(request).toMatchObject({
      kind,
      images: ["canvas/staging/key.png", "canvas/staging/palette.png"],
    });
    expect(promptParts(request.kind !== "model-3d" ? generationPrompt(request) : "")).toEqual({
      brief: "Use Hero for shape and Palette for color",
      references: [
        {
          image: 1,
          labels: ["Hero (node: hero)", "Key (asset: ref)", "Shape study (node: alias)"],
        },
        { image: 2, labels: ["Palette (asset: palette)"] },
      ],
    });
  });
}

test("reference fingerprints follow catalog replacements and labels, without following unrelated assets", () => {
  const state = workspace();
  const original = canvasRequest(state, input).target.fingerprint;
  state.assets.push({ id: "unrelated", name: "Other", path: "other.png", type: "image" });
  expect(canvasRequest(state, input).target.fingerprint).toBe(original);
  state.assets[0]!.path = "canvas/staging/new-key.png";
  expect(canvasRequest(state, input).target.fingerprint).not.toBe(original);
  state.assets[0]!.path = "canvas/staging/key.png";
  state.assets[0]!.name = "Renamed key";
  const renamed = canvasRequest(state, input);
  expect(renamed.target.fingerprint).not.toBe(original);
  expect(
    promptParts(renamed.request.kind === "image" ? generationPrompt(renamed.request) : "")
      .references,
  ).toEqual([{ image: 1, labels: ["Renamed key (asset: ref)"] }]);
  state.assets.splice(0, 1);
  expect(() => canvasRequest(state, input)).toThrow("existing image output");
});

test("image requests without references preserve the brief verbatim", () => {
  const state = workspace();
  state.boards[0]!.board.nodes[1]!.data = { prompt: "A key icon" };
  expect(canvasRequest(state, input).request).toMatchObject({
    kind: "image",
    prompt: "A key icon",
    images: [],
  });
  // Existing pending jobs without image inputs keep their pre-reference-key fingerprint.
  expect(canvasRequest(state, input).target.fingerprint).toBe(
    "661c31f46f366048605c9f32b4b4f82845fae173ec3b11e81b5ef0c0e53d389b",
  );
});

test("reference labels preserve the authored brief limits and cannot replace an empty brief", () => {
  const state = workspace(),
    node = state.boards[0]!.board.nodes[1]!;
  delete node.data.promptSource;
  node.data.prompt = "";
  expect(() => canvasRequest(state, input)).toThrow();
  node.data.prompt = "x".repeat(12000);
  const request = canvasRequest(state, input).request;
  expect(request).toMatchObject({
    kind: "image",
    prompt: "x".repeat(12000),
    imageReferenceKey: 'Attached image references (in attachment order):\n1. ["Key (asset: ref)"]',
  });
  expect(
    request.kind === "image" ? promptParts(generationPrompt(request)).references : null,
  ).toEqual([{ image: 1, labels: ["Key (asset: ref)"] }]);
  node.data.prompt = "x".repeat(12001);
  expect(() => canvasRequest(state, input)).toThrow();
});
