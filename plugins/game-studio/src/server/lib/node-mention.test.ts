import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { nodeDisk } from "../../host/canvas.ts";
import { canvasHostRouter } from "../../../test/canvas-host.ts";
import { NODE_MENTION_PROVIDER } from "../../shared/node-mention.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const rootPath = await mkdtemp(join(tmpdir(), "studio-mention-"));
  const canvas = canvasHostRouter(
    () => nodeDisk,
    async (root) => ({ workspacePath: root, jobs: [], stale: false }),
  );
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({ id: threadId, projectId: "project", environmentId: "environment" }),
      },
      files: {
        read: async ({ path }) => {
          const bytes = await readFile(path);
          const binary = /\.(png|jpe?g|webp)$/i.test(path);
          return {
            path,
            content: bytes.toString(binary ? "base64" : "utf8"),
            contentEncoding: binary ? "base64" : "utf8",
            sizeBytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          } as never;
        },
      },
    },
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      if (method === "resolveWorkspace") return { workspacePath: rootPath };
      if (canvas.handles(method)) return canvas.call(method, input, hostId);
      throw new Error(`Unexpected host call: ${method}`);
    },
  });
  await plugin(bb);
  cleanups.push(async () => {
    await harness.lifecycle.dispose();
    await rm(rootPath, { recursive: true, force: true });
  });
  const seed = async (path: string, value: unknown) => {
    await mkdir(dirname(join(rootPath, path)), { recursive: true });
    await writeFile(
      join(rootPath, path),
      typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value),
    );
  };
  await bb.storage.kv.set("game:game", {
    id: "game",
    name: "Orbit",
    projectId: "project",
    hostId: "host",
    rootPath,
    kind: "web",
    createdAt: 0,
    threadId: "owner",
  });
  await seed("canvas/index.json", {
    version: 1,
    boards: [{ id: "main", name: "Main" }],
    documents: [],
  });
  await seed("canvas/assets.json", {
    version: 1,
    assets: { front: { name: "Front", path: "assets/front.png" } },
  });
  await seed("assets/front.png", Buffer.from("png bytes"));
  await seed("canvas/boards/main.json", {
    version: 1,
    id: "main",
    viewport: { width: 1280, height: 720 },
    edges: [],
    nodes: [
      { id: "brief", type: "text", title: "Brief", data: { text: "A brass key" } },
      {
        id: "concept",
        type: "image",
        title: "Concept art",
        data: {
          recipe: "nano-banana",
          prompt: "A brass key on velvet",
          images: [{ type: "node", nodeId: "brief", studioEdgeId: "brief-concept" }],
          assetId: "front",
        },
      },
    ],
  });
  const provider = harness.registrations.mentionProviders.find(
    ({ id }) => id === NODE_MENTION_PROVIDER,
  )!;
  return { bb, harness, provider };
}

test("typing @ lists the project's canvas nodes, and sending hands the agent the node with its output", async () => {
  const f = await fixture();
  expect(f.provider.label).toBe("Game Studio nodes");
  const all = await f.provider.search({ trigger: "@", query: "", projectId: null, threadId: null });
  expect(all.map(({ title }) => title)).toEqual(["Brief", "Concept art"]);
  const some = await f.provider.search({
    trigger: "@",
    query: "con",
    projectId: "project",
    threadId: null,
  });
  expect(some).toEqual([
    {
      id: JSON.stringify({ gameId: "game", boardId: "main", nodeId: "concept" }),
      title: "Concept art",
      subtitle: "Orbit · Main",
      icon: "Image",
    },
  ]);
  expect(
    await f.provider.search({ trigger: "@", query: "", projectId: "other", threadId: null }),
  ).toEqual([]);
  const resolved = await f.provider.resolve(some[0]!.id);
  expect(resolved.context).toContain(
    "Game Studio node “Concept art” (image) on board “Main” of game “Orbit”.",
  );
  expect(resolved.context).toContain("nodeId: concept");
  expect(resolved.context).toContain("Prompt: A brass key on velvet");
  expect(resolved.context).toContain("“Brief” (brief)");
  expect(resolved.context).toContain("Output: assets/front.png (image)");
  expect(resolved.experimental_images).toEqual([
    {
      type: "image",
      url: `data:image/png;base64,${Buffer.from("png bytes").toString("base64")}`,
      context: "Output of “Concept art”",
    },
  ]);
  const text = await f.provider.resolve(
    JSON.stringify({ gameId: "game", boardId: "main", nodeId: "brief" }),
  );
  expect(text.context).toContain("Text: A brass key");
  expect(text.context).toContain("Output: none yet");
  expect(text.experimental_images).toBeUndefined();
  await expect(
    f.provider.resolve(JSON.stringify({ gameId: "game", boardId: "main", nodeId: "gone" })),
  ).rejects.toThrow("no longer exists");
  await expect(f.provider.resolve("not json")).rejects.toThrow("invalid");
});
