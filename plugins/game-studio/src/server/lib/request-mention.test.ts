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
        async list() {
          return { files: [], truncated: false };
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
