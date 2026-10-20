import { expect, test } from "bun:test";
import { canvasRequest, judgeRequest, retryRequest, reviewRequest } from "./canvas-generation.ts";
import { workspaceSchema } from "../../shared/schema.ts";
import { generationPrompt } from "../../shared/generation-prompt.ts";
import { generationJob } from "../../shared/generation.ts";
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
test("3D sends its Front input as the approved image and other views by name", () => {
  const state = workspace();
  state.assets.push({ id: "side", name: "Side", path: "canvas/staging/side.png", type: "image" });
  const model = state.boards[0]!.board.nodes[2]!;
  const run = (approvedImagePath?: string) =>
    canvasRequest(state, {
      ...input,
      nodeId: "model",
      ...(approvedImagePath ? { approvedImagePath } : {}),
    }).request;
  // An input saved before ports existed fills the first open view.
  expect(run()).toEqual({
    kind: "model-3d",
    model: { provider: "tripo", id: "tripo-p2" },
    approvedImagePath: "canvas/staging/key.png",
    outputCount: 1,
    targetPolycount: 20000,
  });
  expect(() => run("canvas/staging/unrelated.png")).toThrow("Front view input");
  model.data.images = [
    { type: "library", assetId: "side", port: "back" },
    { type: "library", assetId: "ref", port: "front" },
  ];
  expect(run("canvas/staging/key.png")).toMatchObject({
    approvedImagePath: "canvas/staging/key.png",
    views: { back: "canvas/staging/side.png" },
  });
  model.data.images = [{ type: "library", assetId: "side", port: "left" }];
  expect(() => run()).toThrow("Connect a Front view image");
  model.data.images = [{ type: "library", assetId: "ref" }];
  model.data.references = [{ type: "node", nodeId: "design-node" }];
  expect(() => run()).toThrow("This model does not take text inputs");
});
test("video frames follow their Start and End inputs, not connection order", () => {
  const state = workspace();
  state.assets.push({ id: "last", name: "Last", path: "canvas/staging/last.png", type: "image" });
  state.boards[0]!.board.nodes.push({
    id: "shot",
    type: "video",
    position: { x: 0, y: 300 },
    data: {
      prompt: "Fly past",
      references: [
        { type: "library", assetId: "last", port: "end" },
        { type: "library", assetId: "ref" },
      ],
    },
  });
  expect(canvasRequest(state, { ...input, nodeId: "shot" }).request).toMatchObject({
    kind: "video",
    imagePath: "canvas/staging/key.png",
    endImagePath: "canvas/staging/last.png",
  });
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
    expect(
      promptParts(
        request.kind === "image" || request.kind === "text" ? generationPrompt(request) : "",
      ),
    ).toEqual({
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
  expect(() => canvasRequest(state, input)).toThrow("needs an existing output");
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

test("a brief request asks the BB model to write the node's prompt for its selected model", () => {
  const state = workspace();
  const result = canvasRequest(state, { ...input, brief: true, textProviderId: "provider" });
  expect(result.request).toEqual({
    kind: "text",
    briefFor: "nano-banana",
    providerId: "provider",
    model: { provider: "bb" },
    outputCount: 1,
    images: ["canvas/staging/key.png"],
    imageReferenceKey: 'Attached image references (in attachment order):\n1. ["Key (asset: ref)"]',
    prompt: `Draft brief:
A key icon

Connected context:
Brass and teal

Game Studio applies these output settings separately: 1:1, 1K.`,
  });
  expect(result.target).toEqual(canvasRequest(state, input).target);
  state.boards[0]!.board.nodes[1]!.data.recipe = "concept-art";
  expect(canvasRequest(state, { ...input, brief: true }).request).toMatchObject({
    briefFor: "concept-art",
  });
  expect(() => canvasRequest(state, { ...input, nodeId: "model", brief: true })).toThrow(
    "Select an image or video node",
  );
});
test("a video brief names its frame images and duration", () => {
  const state = workspace();
  state.boards[0]!.board.nodes.push({
    id: "shot",
    type: "video",
    position: { x: 0, y: 300 },
    data: { prompt: "", duration: 8, references: [{ type: "library", assetId: "ref" }] },
  });
  const result = canvasRequest(state, { ...input, nodeId: "shot", brief: true });
  expect(result.request).toMatchObject({ kind: "text", briefFor: "omni-video" });
  expect(result.request.kind === "text" && result.request.prompt).toBe(`Draft brief:
(none: write it from the connected context)

Connected context:
(none)

Game Studio applies these output settings separately: 16:9, 8 seconds; image 1 is the start frame.`);
  state.boards[0]!.board.nodes.at(-1)!.data.references = [];
  expect(() => canvasRequest(state, { ...input, nodeId: "shot", brief: true })).toThrow(
    "rough idea",
  );
});

test("a review sends the run's own inputs, then its outputs, on the node's review agent", () => {
  const state = workspace(),
    board = state.boards[0]!.board;
  state.assets.push(
    { id: "take-a", name: "a.png", path: "canvas/staging/run/a.png", type: "image" },
    { id: "take-b", name: "b.png", path: "canvas/staging/run/b.png", type: "image" },
  );
  state.generationJobs.push(
    generationJob.parse({
      version: 1,
      id: "run",
      threadId: null,
      origin: { kind: "canvas", gameId: "game" },
      createdAt: 1,
      updatedAt: 2,
      status: "succeeded",
      // The brief and inputs the run was made from, which differ from the node's current ones.
      request: {
        kind: "image",
        prompt: "A key icon on teal",
        images: ["canvas/inputs/run/key.png"],
        imageReferenceKey: "1. Key",
      },
      outputs: [],
    }),
  );
  const node = board.nodes.find(({ id }) => id === "image")!;
  node.data = {
    ...node.data,
    prompt: "Changed since the run",
    assetId: "take-a",
    takes: [
      { assetId: "take-a", jobId: "run" },
      { assetId: "take-b", jobId: "run" },
    ],
    review: {
      enabled: true,
      agent: { providerId: "claude", model: "opus", reasoningLevel: "high", serviceTier: "fast" },
      criteria: "Readable at 64 px",
    },
  };
  const { request } = reviewRequest(state, "board", "image", ["take-a", "take-b"]);
  if (request.kind !== "text") throw new Error("A review is a text request.");
  expect(request).toMatchObject({
    reviewOf: ["take-a", "take-b"],
    images: ["canvas/inputs/run/key.png", "canvas/staging/run/a.png", "canvas/staging/run/b.png"],
    providerId: "claude",
    model: { provider: "bb", id: "opus" },
    reasoningLevel: "high",
    serviceTier: "fast",
  });
  expect(request.prompt).toContain("A key icon on teal");
  expect(request.prompt).not.toContain("Changed since the run");
  expect(request.prompt).toContain("Images 1–1 are the run's input images:\n1. Key");
  expect(request.prompt).toContain("Image 2: a.png (output 1 of 2)");
  expect(request.prompt).toContain("Readable at 64 px");
});
test("a 3D review reads the GLB from disk and the views as images", () => {
  const state = workspace();
  state.assets.push({
    id: "mesh",
    name: "m.glb",
    path: "canvas/staging/tripo/m.glb",
    type: "model",
  });
  state.generationJobs.push(
    generationJob.parse({
      version: 1,
      id: "tripo",
      threadId: null,
      createdAt: 1,
      updatedAt: 2,
      status: "succeeded",
      request: {
        kind: "model-3d",
        approvedImagePath: "canvas/inputs/tripo/front.png",
        views: { left: "canvas/inputs/tripo/left.png" },
      },
      outputs: [],
    }),
  );
  const node = state.boards[0]!.board.nodes.find(({ id }) => id === "model")!;
  node.data = { ...node.data, assetId: "mesh", takes: [{ assetId: "mesh", jobId: "tripo" }] };
  const { request } = reviewRequest(state, "board", "model", ["mesh"]);
  if (request.kind !== "text") throw new Error("A review is a text request.");
  expect(request.images).toEqual(["canvas/inputs/tripo/front.png", "canvas/inputs/tripo/left.png"]);
  expect(request.files).toEqual(["canvas/staging/tripo/m.glb"]);
  expect(request.prompt).toContain("1. front view\n2. left view");
  expect(() => reviewRequest(state, "board", "design-node", ["mesh"])).toThrow(
    "Only image and 3D nodes",
  );
});

test("a rejected run runs again with its own request until the node's retries run out", () => {
  const state = workspace();
  const job = (id: string, request: unknown, target?: unknown) =>
    generationJob.parse({
      version: 1,
      id,
      threadId: null,
      origin: { kind: "canvas", gameId: "game" },
      createdAt: 1,
      updatedAt: 2,
      status: "succeeded",
      request,
      ...(target ? { target } : {}),
      outputs: [],
    });
  const target = { boardId: "board", nodeId: "image", fingerprint: "then" };
  const image = { kind: "image", prompt: "A key icon", images: ["canvas/inputs/key.png"] };
  const review = (id: string) =>
    job(
      id,
      { kind: "text", prompt: "Review", reviewOf: ["take"] },
      { ...target, fingerprint: "now" },
    );
  state.generationJobs.push(job("run", image, target), job("run-retry-1", image, target));
  const node = state.boards[0]!.board.nodes.find(({ id }) => id === "image")!;
  node.data = {
    ...node.data,
    review: { enabled: true, retries: 2 },
    reviews: [
      { assetIds: ["take"], jobId: "run-review", text: "**Fail** — two subjects." },
      { assetIds: ["take"], jobId: "run-retry-1-review", text: "**Pass with fixes** — eyes." },
    ],
  };
  const retry = retryRequest(state, review("run-review"));
  expect(retry?.requestId).toBe("run-retry-1");
  expect(retry?.request as unknown).toBe(
    state.generationJobs.find(({ id }) => id === "run")!.request,
  );
  expect(retry?.target).toEqual(target);
  // Pass with fixes retries only when the node asks for it, and never past its retry count.
  expect(retryRequest(state, review("run-retry-1-review"))).toBeUndefined();
  node.data.review = { enabled: true, retries: 2, retryOn: "fixes" };
  expect(retryRequest(state, review("run-retry-1-review"))?.requestId).toBe("run-retry-2");
  node.data.review = { enabled: true, retries: 1, retryOn: "fixes" };
  expect(retryRequest(state, review("run-retry-1-review"))).toBeUndefined();
  // A manual review never starts a paid run.
  node.data.review = { enabled: true, retries: 2 };
  node.data.reviews = [{ assetIds: ["take"], jobId: "manual", text: "**Fail**" }];
  expect(retryRequest(state, review("manual"))).toBeUndefined();
});

test("a judge shows the run's inputs, then numbered candidates, on the node's judge agent", () => {
  const state = workspace();
  state.assets.push(
    { id: "take-a", name: "a.png", path: "canvas/staging/run-b0/a.png", type: "image" },
    { id: "take-b", name: "b.png", path: "canvas/staging/run-b1/b.png", type: "image" },
  );
  state.generationJobs.push(
    generationJob.parse({
      version: 1,
      id: "run-b1",
      threadId: null,
      origin: { kind: "canvas", gameId: "game" },
      createdAt: 1,
      updatedAt: 2,
      status: "succeeded",
      request: {
        kind: "image",
        prompt: "A key icon on teal",
        images: ["canvas/inputs/key.png"],
        imageReferenceKey: "1. Key",
      },
      outputs: [],
    }),
  );
  const node = state.boards[0]!.board.nodes.find(({ id }) => id === "image")!;
  node.data = {
    ...node.data,
    assetId: "take-a",
    takes: [
      { assetId: "take-a", jobId: "run-b0" },
      { assetId: "take-b", jobId: "run-b1" },
    ],
    judge: {
      enabled: true,
      agent: { providerId: "claude", model: "opus", reasoningLevel: "high" },
      criteria: "Readable at 64 px",
    },
  };
  const { request } = judgeRequest(state, "board", "image", ["take-a", "take-b"]);
  if (request.kind !== "text") throw new Error("A judgement is a text request.");
  expect(request).toMatchObject({
    judgeOf: ["take-a", "take-b"],
    judgePick: "take-a",
    images: ["canvas/inputs/key.png", "canvas/staging/run-b0/a.png", "canvas/staging/run-b1/b.png"],
    providerId: "claude",
    reasoningLevel: "high",
  });
  expect(request.prompt).toContain("Readable at 64 px");
  expect(request.prompt).toContain("A key icon on teal");
  expect(request.prompt).toContain("Candidate 1 is image 2: a.png (the node's current pick)");
  expect(request.prompt).toContain("Candidate 2 is image 3: b.png");
  expect(() => judgeRequest(state, "board", "image", ["take-a"])).toThrow("at least two");
});

/** A Tripo P2 node whose GLB came from a recorded Tripo task, feeding the node under test. */
function withMesh(state: ReturnType<typeof workspace>, node: Record<string, unknown>) {
  state.assets.push({
    id: "mesh",
    name: "shark.glb",
    path: "canvas/staging/tripo/shark.glb",
    type: "model",
  });
  state.generationJobs.push(
    generationJob.parse({
      version: 1,
      id: "tripo",
      threadId: null,
      createdAt: 1,
      updatedAt: 2,
      status: "succeeded",
      taskId: "geometry-task",
      request: { kind: "model-3d", approvedImagePath: "canvas/staging/key.png" },
      outputs: [
        {
          path: "canvas/staging/tripo/shark.glb",
          type: "model",
          sizeBytes: 3,
          sha256: "a".repeat(64),
        },
      ],
    }),
  );
  const board = state.boards[0]!.board;
  board.nodes.find(({ id }) => id === "model")!.data.assetId = "mesh";
  board.nodes.push({ id: "step", position: { x: 700, y: 0 }, ...node } as never);
}

test("an agent step reads its instruction, notes, images and models from its inputs", () => {
  const state = workspace();
  withMesh(state, {
    type: "agent",
    data: {
      instruction: "Clean up the mesh in Blender",
      promptSource: { type: "node", nodeId: "design-node" },
      references: [
        { type: "node", nodeId: "model" },
        { type: "library", assetId: "ref" },
      ],
    },
  });
  const { request } = canvasRequest(state, {
    ...input,
    nodeId: "step",
    textProviderId: "codex",
    model: { provider: "bb", id: "gpt-6.1-sol" },
    reasoningLevel: "high",
  });
  expect(request).toMatchObject({
    kind: "agent",
    prompt: "Clean up the mesh in Blender\n\nBrass and teal",
    files: ["canvas/staging/tripo/shark.glb"],
    images: ["canvas/staging/key.png"],
    providerId: "codex",
    reasoningLevel: "high",
  });
});

test("a Tripo step processes the task that made its model, with the node's settings", () => {
  const state = workspace();
  withMesh(state, {
    type: "model-3d",
    data: {
      recipe: "tripo-rig",
      rigType: "aquatic",
      references: [{ type: "node", nodeId: "model", port: "model" }],
    },
  });
  const step = { ...input, nodeId: "step" };
  expect(canvasRequest(state, step).request).toEqual({
    kind: "model-edit",
    model: { provider: "tripo", id: "tripo-p2" },
    operation: "rig",
    sourcePath: "canvas/staging/tripo/shark.glb",
    sourceTaskId: "geometry-task",
    rigType: "aquatic",
    outputCount: 1,
  });
  // A texture step reads its reference views and falls back to the shared default quality.
  const node = state.boards[0]!.board.nodes.find(({ id }) => id === "step")!;
  node.data = {
    recipe: "tripo-texture",
    references: [
      { type: "node", nodeId: "model", port: "model" },
      { type: "library", assetId: "ref", port: "front" },
    ],
  };
  expect(canvasRequest(state, step).request).toMatchObject({
    operation: "texture",
    views: { front: "canvas/staging/key.png" },
    textureQuality: "detailed",
  });
  node.data = { recipe: "tripo-pbr", references: [] };
  expect(() => canvasRequest(state, step)).toThrow("Connect a 3D model");
});
