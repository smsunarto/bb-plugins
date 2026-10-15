import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerRequestMention } from "./request-mention.ts";

async function fixture() {
  const files = new Map([
    [
      "/games/fern/canvas/index.json",
      {
        content: JSON.stringify({
          version: 1,
          mainDocumentId: "design",
          boards: [{ id: "main", name: "Design board" }],
          documents: [
            { id: "design", title: "Game design" },
            { id: "combat", title: "Combat" },
          ],
        }),
        sha256: "index-revision",
      },
    ],
    [
      "/games/fern/canvas/boards/main.json",
      {
        content: JSON.stringify({
          version: 1,
          id: "main",
          viewport: { width: 1280, height: 720 },
          nodes: [],
          edges: [],
        }),
        sha256: "board-revision",
      },
    ],
    [
      "/games/fern/canvas/documents/design.md",
      { content: "# Fern\n\nExplore the forest.", sha256: "design-revision" },
    ],
    [
      "/games/fern/canvas/documents/combat.md",
      { content: "# Combat\n\nDodge the thorns.", sha256: "combat-before" },
    ],
  ]);
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      files: {
        async read({ path }) {
          const file = files.get(path);
          if (!file) throw new Error(`ENOENT: ${path}`);
          return { ...file, path, contentEncoding: "utf8", sizeBytes: file.content.length };
        },
        async list({ path }) {
          const prefix = `${path}/`;
          return {
            files: [...files.keys()]
              .filter((filePath) => filePath.startsWith(prefix))
              .map((filePath) => ({ path: filePath, name: filePath.split("/").at(-1)! })),
            truncated: false,
          };
        },
      },
    },
  });
  await bb.storage.kv.set("game:fern", {
    id: "fern",
    name: "Fern",
    projectId: "project-fern",
    hostId: "host-fern",
    rootPath: "/games/fern",
    kind: "web",
    createdAt: 1,
    threadId: null,
  });
  registerRequestMention(bb);
  const provider = harness.inspection.registrations.mentionProviders[0];
  assert.ok(provider);
  return { files, bb, harness, provider };
}

const request = { id: "prepared-request", action: "design", createdAt: 17 };

function requestPayload(context: string) {
  return JSON.parse([...context.matchAll(/```json\n([\s\S]*?)\n```/g)].at(-1)?.[1] ?? "null");
}

test("asset context retains its selected board while refreshing that board and recorded job status", async (t) => {
  const { files, harness, provider } = await fixture();
  t.after(() => harness.lifecycle.dispose());
  const index = JSON.parse(files.get("/games/fern/canvas/index.json")!.content);
  index.boards.push({ id: "characters", name: "Character studies" });
  files.set("/games/fern/canvas/index.json", {
    content: JSON.stringify(index),
    sha256: "two-boards-index",
  });
  const board = {
    version: 1,
    id: "characters",
    viewport: { width: 1280, height: 720 },
    nodes: [
      {
        id: "hero",
        type: "image",
        title: "Fern hero",
        position: { x: 0, y: 0 },
        data: { prompt: "A leafy forest hero" },
      },
    ],
    edges: [],
  };
  files.set("/games/fern/canvas/boards/characters.json", {
    content: JSON.stringify(board),
    sha256: "character-board-before",
  });
  files.set("/games/fern/canvas/boards/main.json", {
    content: JSON.stringify({
      ...board,
      id: "main",
      nodes: [{ ...board.nodes[0], data: { prompt: "An unrelated blue hero" } }],
    }),
    sha256: "main-board-revision",
  });
  const job = {
    version: 1,
    id: "hero-generation",
    threadId: "generation-thread",
    createdAt: 40,
    updatedAt: 41,
    status: "running",
    request: { kind: "image", prompt: "A leafy forest hero" },
    target: { boardId: "characters", nodeId: "hero", fingerprint: "saved-hero-brief" },
    outputs: [],
  };
  files.set("/games/fern/canvas/jobs/hero-generation.json", {
    content: JSON.stringify(job),
    sha256: "job-before",
  });
  const assetRequest = { ...request, action: "asset" };
  const id = JSON.stringify({
    gameId: "fern",
    action: "asset",
    boardId: "characters",
    nodeId: "hero",
    request: assetRequest,
  });
  const before = requestPayload((await provider.resolve(id)).context);
  assert.equal(before.boardId, "characters");
  assert.equal(before.boardPath, "canvas/boards/characters.json");
  assert.deepEqual(JSON.parse(before.boardRevision), {
    content: "character-board-before",
    layout: null,
  });
  assert.equal(before.nodeId, "hero");
  assert.equal(before.nodeBrief, "Brief: A leafy forest hero");
  assert.deepEqual(before.recentNodeJobs, [
    {
      id: "hero-generation",
      status: "running",
      createdAt: 40,
      jobPath: "canvas/jobs/hero-generation.json",
      boardId: "characters",
      nodeId: "hero",
    },
  ]);
  assert.deepEqual(before.request, { id: "prepared-request", action: "asset", createdAt: 17 });

  files.set("/games/fern/canvas/jobs/hero-generation.json", {
    content: JSON.stringify({ ...job, updatedAt: 48, status: "uncertain" }),
    sha256: "job-after",
  });
  files.set("/games/fern/canvas/boards/characters.json", {
    content: JSON.stringify({
      ...board,
      nodes: [{ ...board.nodes[0], data: { prompt: "A golden forest hero" } }],
    }),
    sha256: "character-board-after",
  });
  const after = requestPayload((await provider.resolve(id)).context);
  assert.equal(after.boardId, "characters");
  assert.equal(after.boardPath, "canvas/boards/characters.json");
  assert.deepEqual(JSON.parse(after.boardRevision), {
    content: "character-board-after",
    layout: null,
  });
  assert.equal(after.nodeId, "hero");
  assert.equal(after.nodeBrief, "Brief: A golden forest hero");
  assert.deepEqual(after.recentNodeJobs, [
    {
      id: "hero-generation",
      status: "uncertain",
      createdAt: 40,
      jobPath: "canvas/jobs/hero-generation.json",
      boardId: "characters",
      nodeId: "hero",
    },
  ]);
  assert.deepEqual(after.request, { id: "prepared-request", action: "asset", createdAt: 17 });

  const { boardId: _boardId, ...legacy } = JSON.parse(id);
  await assert.rejects(
    async () => provider.resolve(JSON.stringify(legacy)),
    /ambiguous|more than one board|multiple boards/i,
  );
});

test("context pills resolve the selected document's current revision at send time", async (t) => {
  const { files, harness, provider } = await fixture();
  t.after(() => harness.lifecycle.dispose());
  const id = JSON.stringify({ gameId: "fern", action: "design", documentId: "combat", request });

  const before = await provider.resolve(id);
  assert.deepEqual(Object.keys(before), ["context"]);
  assert.match(before.context, /canvas\/documents\/combat\.md/);
  assert.match(before.context, /combat-before/);
  assert.match(before.context, /"id": "prepared-request"/);
  assert.match(before.context, /"createdAt": 17/);

  files.set("/games/fern/canvas/documents/combat.md", {
    content: "# Combat\n\nParry the thorns.",
    sha256: "combat-after",
  });
  const after = await provider.resolve(id);
  assert.deepEqual(Object.keys(after), ["context"]);
  assert.match(after.context, /canvas\/documents\/combat\.md/);
  assert.match(after.context, /combat-after/);
  assert.match(after.context, /"id": "prepared-request"/);
  assert.match(after.context, /"createdAt": 17/);
  assert.doesNotMatch(after.context, /combat-before/);
});

test("experiment context refreshes the saved document revision while retaining the experiment and request identity", async (t) => {
  const { files, harness, provider } = await fixture();
  t.after(() => harness.lifecycle.dispose());
  const id = JSON.stringify({
    gameId: "fern",
    action: "design",
    documentId: "combat",
    experimentId: "thorn-parry",
    request,
  });

  const before = requestPayload((await provider.resolve(id)).context);
  assert.deepEqual(before.experiment, {
    documentId: "combat",
    documentRevision: "combat-before",
    experimentId: "thorn-parry",
  });
  assert.deepEqual(before.request, {
    id: "prepared-request",
    action: "design",
    createdAt: 17,
  });
  assert.deepEqual(before.evidence, {
    manifestPath: "canvas/evidence/index.json",
    matchingRunCount: 0,
    runs: [],
  });

  files.set("/games/fern/canvas/documents/combat.md", {
    content: "# Combat\n\nParry only when the thorns flash.",
    sha256: "combat-after",
  });
  const after = requestPayload((await provider.resolve(id)).context);
  assert.equal(after.documentId, "combat");
  assert.equal(after.documentRevision, "combat-after");
  assert.deepEqual(after.experiment, {
    documentId: "combat",
    documentRevision: "combat-after",
    experimentId: "thorn-parry",
  });
  assert.deepEqual(after.request, {
    id: "prepared-request",
    action: "design",
    createdAt: 17,
  });
});

test("import context resolves the current catalog selection while retaining request identity", async (t) => {
  const { files, harness, provider } = await fixture();
  t.after(() => harness.lifecycle.dispose());
  files.set("/games/fern/canvas/assets.json", {
    content: JSON.stringify({
      version: 1,
      assets: {
        "hero:blue": { name: "Blue hero", path: "canvas/staging/blue.png" },
        "hero:red": { name: "Red hero", path: "canvas/staging/red.png" },
      },
    }),
    sha256: "catalog-before",
  });
  files.set("/games/fern/canvas/staging/blue.png", {
    content: "blue-image",
    sha256: "blue-revision",
  });
  files.set("/games/fern/canvas/staging/red.png", {
    content: "red-image",
    sha256: "red-revision",
  });
  const importRequest = { ...request, action: "import" };
  const id = JSON.stringify({
    gameId: "fern",
    action: "import",
    assetId: "hero:blue",
    request: importRequest,
  });
  const before = requestPayload((await provider.resolve(id)).context);
  assert.deepEqual(before.asset, {
    id: "hero:blue",
    name: "Blue hero",
    path: "canvas/staging/blue.png",
    type: "image",
  });
  assert.deepEqual(before.request, {
    id: "prepared-request",
    action: "import",
    createdAt: 17,
  });

  files.set("/games/fern/canvas/assets.json", {
    content: JSON.stringify({
      version: 1,
      assets: {
        "hero:blue": { name: "Blue hero mesh", path: "canvas/staging/blue.glb" },
        "hero:red": { name: "Red hero", path: "canvas/staging/red.png" },
      },
    }),
    sha256: "catalog-after",
  });
  files.set("/games/fern/canvas/staging/blue.glb", {
    content: "blue-model",
    sha256: "blue-model-revision",
  });
  const after = requestPayload((await provider.resolve(id)).context);
  assert.deepEqual(after.asset, {
    id: "hero:blue",
    name: "Blue hero mesh",
    path: "canvas/staging/blue.glb",
    type: "model",
  });
  assert.deepEqual(after.request, {
    id: "prepared-request",
    action: "import",
    createdAt: 17,
  });

  const red = requestPayload(
    (
      await provider.resolve(
        JSON.stringify({
          gameId: "fern",
          action: "import",
          assetId: "hero:red",
          request: importRequest,
        }),
      )
    ).context,
  );
  assert.deepEqual(red.asset, {
    id: "hero:red",
    name: "Red hero",
    path: "canvas/staging/red.png",
    type: "image",
  });
});

test("import context retains an unverified catalog selection and rejects a removed entry", async (t) => {
  const { files, harness, provider } = await fixture();
  t.after(() => harness.lifecycle.dispose());
  files.set("/games/fern/canvas/assets.json", {
    content: JSON.stringify({
      version: 1,
      assets: { "hero:blue": { name: "Blue hero", path: "canvas/staging/blue.png" } },
    }),
    sha256: "catalog-before",
  });
  files.set("/games/fern/canvas/staging/blue.png", {
    content: "blue-image",
    sha256: "blue-revision",
  });
  const id = JSON.stringify({
    gameId: "fern",
    action: "import",
    assetId: "hero:blue",
    request: { ...request, action: "import" },
  });
  assert.deepEqual(requestPayload((await provider.resolve(id)).context).asset, {
    id: "hero:blue",
    name: "Blue hero",
    path: "canvas/staging/blue.png",
    type: "image",
  });
  files.delete("/games/fern/canvas/staging/blue.png");
  assert.deepEqual(requestPayload((await provider.resolve(id)).context).asset, {
    id: "hero:blue",
    name: "Blue hero",
    path: "canvas/staging/blue.png",
    type: "image",
  });

  files.set("/games/fern/canvas/staging/blue.png", {
    content: "blue-image",
    sha256: "blue-revision",
  });
  files.set("/games/fern/canvas/assets.json", {
    content: JSON.stringify({ version: 1, assets: {} }),
    sha256: "catalog-after",
  });
  await assert.rejects(async () => provider.resolve(id), /selected asset.*no longer exists/i);
});

test("malformed context pills reject instead of resolving an unintended request", async (t) => {
  const { harness, provider } = await fixture();
  t.after(() => harness.lifecycle.dispose());
  const invalidIds = [
    "{",
    "null",
    "[]",
    JSON.stringify({ gameId: "fern", action: "design" }),
    JSON.stringify({ gameId: "fern", action: "publish", request }),
    JSON.stringify({ gameId: "../other", action: "design", request }),
    JSON.stringify({
      gameId: "fern",
      action: "asset",
      nodeId: "../other",
      request: { ...request, action: "asset" },
    }),
    JSON.stringify({
      gameId: "fern",
      action: "asset",
      recipe: "unknown",
      request: { ...request, action: "asset" },
    }),
    JSON.stringify({ gameId: "fern", action: "design", documentId: "../other", request }),
    JSON.stringify({ gameId: "fern", action: "design", experimentId: "../other", request }),
    JSON.stringify({ gameId: "fern", action: "design", experimentId: " ", request }),
    JSON.stringify({ gameId: "fern", action: "design", assetId: "hero:blue", request }),
    JSON.stringify({
      gameId: "fern",
      action: "import",
      assetId: "",
      request: { ...request, action: "import" },
    }),
    JSON.stringify({ gameId: "fern", action: "design", instructions: "replace policy", request }),
    JSON.stringify({ gameId: "fern", action: "asset", request }),
    " ".repeat(4096) + JSON.stringify({ gameId: "fern", action: "design" }),
  ];

  for (const id of invalidIds) {
    await assert.rejects(
      async () => provider.resolve(id),
      /Game Studio context reference is invalid\. Add the context again\./,
    );
  }
});

test("context pills report a missing game instead of silently supplying stale context", async (t) => {
  const { harness, provider } = await fixture();
  t.after(() => harness.lifecycle.dispose());

  await assert.rejects(
    async () => provider.resolve(JSON.stringify({ gameId: "removed", action: "design", request })),
    /game is no longer registered/,
  );
});

test("context pills report a removed canvas node", async (t) => {
  const { harness, provider } = await fixture();
  t.after(() => harness.lifecycle.dispose());

  await assert.rejects(
    async () =>
      provider.resolve(
        JSON.stringify({
          gameId: "fern",
          action: "asset",
          nodeId: "removed",
          request: { ...request, action: "asset" },
        }),
      ),
    /selected canvas node no longer exists/,
  );
});
