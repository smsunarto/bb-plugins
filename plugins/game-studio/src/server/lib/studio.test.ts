import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { create } from "../rpc/create.ts";
import { attach } from "../rpc/attach.ts";
import { get } from "../rpc/get.ts";
import { overview } from "../rpc/overview.ts";
import { saveBoard } from "../rpc/save-board.ts";
import { saveDocument } from "../rpc/save-document.ts";
import { createDocument } from "../rpc/create-document.ts";
import { createBoard } from "../rpc/create-board.ts";
import { updateGame } from "../rpc/update-game.ts";
import { uploadAsset } from "../rpc/upload-asset.ts";
import { preview } from "../rpc/preview.ts";
import { prompt } from "../rpc/prompt.ts";
import { inspectUnity } from "../rpc/inspect-unity.ts";
import { recordRequest } from "../rpc/record-request.ts";
import { projectFile, relativeFile } from "./paths.ts";
import { fakeCanvasHosts } from "../../../test/canvas-host.ts";

interface FakeFile {
  content: string;
  contentEncoding: "utf8" | "base64";
  sha256: string;
}
interface FileArgs {
  hostId?: string;
  rootPath?: string;
  path: string;
}
interface WriteArgs extends FileArgs {
  content: string;
  contentEncoding?: "utf8" | "base64";
  expectedSha256?: string | null;
}
interface Project {
  id: string;
  name: string;
  sources: { hostId: string; path: string }[];
}

function fake() {
  const files = new Map<string, FakeFile>();
  const directories = new Set<string>();
  const values = new Map<string, unknown>();
  const projects: Project[] = [];
  const writes: WriteArgs[] = [];
  let projectFailure = false;
  let beforeWrite: ((args: WriteArgs) => void) | undefined;
  const key = (hostId: string, path: string): string => `${hostId}:${path}`;
  const seed = (
    hostId: string,
    path: string,
    content: string,
    contentEncoding: "utf8" | "base64" = "utf8",
  ): void => {
    files.set(key(hostId, path), {
      content,
      contentEncoding,
      sha256: createHash("sha256").update(Buffer.from(content, contentEncoding)).digest("hex"),
    });
    const paths = win32.isAbsolute(path) && !posix.isAbsolute(path) ? win32 : posix;
    let dir = paths.dirname(path);
    while (dir !== paths.dirname(dir)) {
      directories.add(key(hostId, dir));
      dir = paths.dirname(dir);
    }
  };
  const fenced = (input: FileArgs): void => {
    if (!input.rootPath) return;
    const paths =
      win32.isAbsolute(input.rootPath) && !posix.isAbsolute(input.rootPath) ? win32 : posix;
    const relative = paths.relative(input.rootPath, input.path);
    if (relative.startsWith("..") || paths.isAbsolute(relative))
      throw new Error("outside rootPath");
  };
  const bb: BbPluginApi = {
    hosts: fakeCanvasHosts(() => bb),
    storage: {
      kv: {
        async get(k: string) {
          return structuredClone(values.get(k));
        },
        async set(k: string, value: unknown) {
          values.set(k, structuredClone(value));
        },
        async list(prefix = "") {
          return [...values.keys()].filter((k) => k.startsWith(prefix));
        },
      },
    },
    sdk: {
      files: {
        async read(input: FileArgs) {
          fenced(input);
          const file = files.get(key(input.hostId ?? "host", input.path));
          if (!file) throw new Error(`ENOENT: ${input.path}`);
          return { ...file, path: input.path, sizeBytes: file.content.length };
        },
        async write(input: WriteArgs) {
          fenced(input);
          writes.push(input);
          beforeWrite?.(input);
          const old = files.get(key(input.hostId ?? "host", input.path));
          if (
            input.expectedSha256 !== undefined &&
            input.expectedSha256 !== (old?.sha256 ?? null)
          ) {
            return { outcome: "conflict" as const, currentSha256: old?.sha256 ?? null };
          }
          seed(input.hostId ?? "host", input.path, input.content, input.contentEncoding);
          return {
            outcome: "written" as const,
            sha256: files.get(key(input.hostId ?? "host", input.path))!.sha256,
            sizeBytes: input.content.length,
          };
        },
        async mkdir(input: FileArgs) {
          directories.add(key(input.hostId ?? "host", input.path));
          return { ok: true };
        },
        async list(input: FileArgs) {
          const hostId = input.hostId ?? "host";
          if (!directories.has(key(hostId, input.path))) throw new Error(`ENOENT: ${input.path}`);
          const slash = input.path.includes("\\") ? "\\" : "/";
          const prefix = `${hostId}:${input.path}${slash}`;
          return {
            files: [...files.entries()]
              .filter(([name]) => name.startsWith(prefix))
              .map(([name]) => {
                const path = name.slice(hostId.length + 1);
                return { path, name: path.split(slash).pop()! };
              }),
            truncated: false,
          };
        },
        async createPreview(input: { hostId: string; rootPath: string }) {
          return {
            baseUrl: `https://preview.test/${input.hostId}/${encodeURIComponent(input.rootPath)}/`,
            expiresAtMs: 100000,
          };
        },
      },
      hosts: {
        async list() {
          return [
            { id: "host", name: "Dev machine", status: "connected", lifecycle: { phase: "ready" } },
          ];
        },
      },
      projects: {
        async list() {
          return structuredClone(projects);
        },
        async get({ projectId }: { projectId: string }) {
          const project = projects.find(({ id }) => id === projectId);
          if (!project) throw new Error("project not found");
          return structuredClone(project);
        },
        async create(input: { name: string; source: { hostId: string; path: string } }) {
          if (projectFailure) {
            projectFailure = false;
            throw new Error("project temporarily unavailable");
          }
          const project = {
            id: `project-${projects.length + 1}`,
            name: input.name,
            sources: [input.source],
          };
          projects.push(project);
          return structuredClone(project);
        },
      },
      threads: {
        async get({ threadId }: { threadId: string }) {
          return {
            id: threadId,
            projectId: threadId === "foreign" ? "other" : "project-1",
            environmentId: threadId === "no-environment" ? null : threadId,
          };
        },
      },
      environments: {
        async get({ environmentId }: { environmentId: string }) {
          return {
            hostId: environmentId === "wrong-host" ? "other-host" : "host",
            path: environmentId === "wrong-path" ? "/games/orbit-worktree" : "/games/./orbit/",
            status: environmentId === "destroyed" ? "destroyed" : "active",
          };
        },
      },
    },
  } as unknown as BbPluginApi;
  return {
    bb,
    projects,
    writes,
    seed,
    remove: (host: string, path: string) => files.delete(key(host, path)),
    directories,
    failProjectOnce: () => {
      projectFailure = true;
    },
    interceptWrite: (handler: (args: WriteArgs) => void) => {
      beforeWrite = handler;
    },
    contents: (host: string, path: string) => files.get(key(host, path))?.content,
  };
}
const input = {
  name: "Orbit Garden",
  hostId: "host",
  rootPath: "/games/orbit",
  kind: "unity" as const,
};

function requestPayload(context: string) {
  return JSON.parse([...context.matchAll(/```json\n([\s\S]*?)\n```/g)].at(-1)?.[1] ?? "null");
}

test("Unity design workspace reopens persisted Markdown and BB project identity", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  const first = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.equal(first.game.projectId, "project-1");
  assert.equal(first.unityVersion, null);
  assert.deepEqual(first.index.boards, [{ id: "main", name: "Design board" }]);
  const doc = first.documents[0]!;
  await saveDocument.execute(
    { bb: f.bb },
    {
      gameId: game.id,
      documentId: doc.id,
      revision: doc.revision,
      markdown: "# Orbit Garden\nCollect falling stars.",
    },
  );
  assert.equal(
    (await get.execute({ bb: f.bb }, { gameId: game.id })).documents[0]!.markdown,
    "# Orbit Garden\nCollect falling stars.",
  );
  assert.equal(f.contents("host", "/games/orbit/index.html"), undefined);
  assert.equal(f.contents("host", "/games/orbit/AGENTS.md"), undefined);
  assert.ok(f.writes.every((file) => file.path.startsWith("/games/orbit/canvas/")));
  const resumed = await create.execute({ bb: f.bb }, input);
  assert.equal(resumed.id, game.id);
  assert.equal(f.projects.length, 1);
});

test("interrupted initialization retries without replacing existing project files", async () => {
  const f = fake();
  f.seed("host", "/games/orbit/AGENTS.md", "Existing project policy");
  f.failProjectOnce();
  await assert.rejects(async () => create.execute({ bb: f.bb }, input), /temporarily unavailable/);
  f.seed("host", "/games/orbit/canvas/documents/design.md", "# Keep this changed brief");
  const game = await create.execute({ bb: f.bb }, input);
  assert.equal(
    (await get.execute({ bb: f.bb }, { gameId: game.id })).documents[0]!.markdown,
    "# Keep this changed brief",
  );
  assert.equal(f.contents("host", "/games/orbit/AGENTS.md"), "Existing project policy");
  assert.equal(f.projects.length, 1);
});

test("simultaneous game creates both survive in overview", async () => {
  const f = fake();
  const games = await Promise.all([
    create.execute({ bb: f.bb }, input),
    create.execute({ bb: f.bb }, { ...input, name: "Star Orchard", rootPath: "/games/orchard" }),
  ]);
  const list = await overview.execute({ bb: f.bb }, {});
  assert.deepEqual(list.games.map(({ name }) => name).sort(), ["Orbit Garden", "Star Orchard"]);
  assert.equal(new Set(games.map(({ projectId }) => projectId)).size, 2);
});

test("Unity attach validates the registered remote Windows project and preserves its canvas", async () => {
  const f = fake();
  f.projects.push({
    id: "project-existing",
    name: "Existing game",
    sources: [{ hostId: "windows", path: "C:\\Games\\Orbit" }],
  });
  f.seed(
    "windows",
    "C:\\Games\\Orbit\\ProjectSettings\\ProjectVersion.txt",
    "m_EditorVersion: 6000.3.4f1\nm_EditorVersionWithRevision: 6000.3.4f1 (abc)",
  );
  f.directories.add("windows:C:\\Games\\Orbit\\Assets");
  const game = await attach.execute(
    { bb: f.bb },
    {
      projectId: "project-existing",
      hostId: "windows",
      rootPath: "C:\\Games\\Orbit",
      kind: "unity",
    },
  );
  const workspace = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.equal(workspace.unityVersion, "6000.3.4f1");
  assert.equal(workspace.game.rootPath, "C:\\Games\\Orbit");
  const before = f.contents("windows", "C:\\Games\\Orbit\\canvas\\index.json");
  await attach.execute(
    { bb: f.bb },
    {
      projectId: "project-existing",
      hostId: "windows",
      rootPath: "C:\\Games\\Orbit",
      kind: "unity",
    },
  );
  assert.equal(f.contents("windows", "C:\\Games\\Orbit\\canvas\\index.json"), before);
  await assert.rejects(
    async () =>
      attach.execute(
        { bb: f.bb },
        {
          projectId: "project-existing",
          hostId: "host",
          rootPath: "C:\\Games\\Orbit",
          kind: "unity",
        },
      ),
    /not a source/,
  );
});

test("Unity attach rejects an ordinary folder without inventing engine files", async () => {
  const f = fake();
  f.projects.push({
    id: "p",
    name: "Plain folder",
    sources: [{ hostId: "host", path: "/games/plain" }],
  });
  f.directories.add("host:/games/plain");
  await assert.rejects(
    async () =>
      attach.execute(
        { bb: f.bb },
        { projectId: "p", hostId: "host", rootPath: "/games/plain", kind: "unity" },
      ),
    /existing Unity project/,
  );
  assert.equal(f.writes.length, 0);
});

test("a stale document save rejects and preserves the external edit", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  const doc = (await get.execute({ bb: f.bb }, { gameId: game.id })).documents[0]!;
  f.seed("host", "/games/orbit/canvas/documents/design.md", "# External edit");
  await assert.rejects(
    async () =>
      saveDocument.execute(
        { bb: f.bb },
        {
          gameId: game.id,
          documentId: doc.id,
          revision: doc.revision,
          markdown: "# Stale browser",
        },
      ),
    /changed on disk/,
  );
  assert.equal(
    (await get.execute({ bb: f.bb }, { gameId: game.id })).documents[0]!.markdown,
    "# External edit",
  );
});

test("board content and editor layout round trip separately and reject stale saves", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  const detail = (await get.execute({ bb: f.bb }, { gameId: game.id })).boards[0]!;
  const board = {
    ...detail.board,
    nodes: [
      {
        id: "brief",
        type: "text" as const,
        position: { x: 140, y: 240 },
        width: 300,
        data: { text: "Collect stars" },
      },
    ],
  };
  const saved = await saveBoard.execute(
    { bb: f.bb },
    { gameId: game.id, board, revision: detail.revision },
  );
  const reopened = (await get.execute({ bb: f.bb }, { gameId: game.id })).boards[0]!;
  assert.equal(reopened.revision, saved.revision);
  assert.deepEqual(reopened.board.nodes[0], board.nodes[0]);
  assert.deepEqual(
    JSON.parse(f.contents("host", "/games/orbit/canvas/boards/main.json")!).nodes[0],
    { id: "brief", type: "text", data: { text: "Collect stars" } },
  );
  assert.deepEqual(
    JSON.parse(f.contents("host", "/games/orbit/canvas/editor/main.json")!).nodes.brief,
    { x: 140, y: 240, width: 300 },
  );
  await assert.rejects(
    async () =>
      saveBoard.execute({ bb: f.bb }, { gameId: game.id, board, revision: detail.revision }),
    /changed on disk/,
  );
});

test("a disk edit between board validation and write is never overwritten", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  const detail = (await get.execute({ bb: f.bb }, { gameId: game.id })).boards[0]!;
  f.interceptWrite((write) => {
    if (write.path.endsWith("boards/main.json"))
      f.seed("host", write.path, '{"external":"preserve"}');
  });
  await assert.rejects(
    async () =>
      saveBoard.execute(
        { bb: f.bb },
        { gameId: game.id, board: detail.board, revision: detail.revision },
      ),
    /changed on disk/,
  );
  assert.equal(
    f.contents("host", "/games/orbit/canvas/boards/main.json"),
    '{"external":"preserve"}',
  );
});

test("new documents and boards persist in the index without racing each other", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  await Promise.all([
    createDocument.execute({ bb: f.bb }, { gameId: game.id, title: "Combat" }),
    createBoard.execute({ bb: f.bb }, { gameId: game.id, name: "Moodboard" }),
  ]);
  const workspace = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.deepEqual(
    workspace.documents.map(({ title }) => title),
    ["Game design", "Combat"],
  );
  assert.deepEqual(
    workspace.index.boards.map(({ name }) => name),
    ["Design board", "Moodboard"],
  );
});

test("Unity uploads stay in staging and externally imported assets appear after reopen", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  const asset = await uploadAsset.execute(
    { bb: f.bb },
    { gameId: game.id, name: "star.png", content: Buffer.from("image-bytes").toString("base64") },
  );
  assert.match(asset.path, /^canvas\/staging\/[a-f0-9-]+-star\.png$/);
  assert.equal(asset.type, "image");
  f.seed("host", "/games/orbit/Assets/GameStudio/Sound/jump.wav", "audio");
  const workspace = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.deepEqual(
    workspace.assets.map(({ name, type }) => ({ name, type })),
    [
      { name: "jump.wav", type: "audio" },
      { name: "star.png", type: "image" },
    ],
  );
  assert.equal(
    f.writes.some(({ path }) => path.includes("/Assets/")),
    false,
  );
});

test("import requests target the exact staged catalog selection without recording progress", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  f.seed(
    "host",
    "/games/orbit/canvas/assets.json",
    JSON.stringify({
      version: 1,
      assets: {
        "hero:blue": { name: "Blue hero", path: "canvas/staging/heroes/blue.png" },
        "hero:red": { name: "Red hero", path: "canvas/staging/heroes/red.glb" },
      },
    }),
  );
  f.seed("host", "/games/orbit/canvas/staging/heroes/blue.png", "blue-image");
  f.seed("host", "/games/orbit/canvas/staging/heroes/red.glb", "red-model");
  const writesBefore = f.writes.length;
  const blue = await prompt.execute(
    { bb: f.bb },
    { gameId: game.id, action: "import", assetId: "hero:blue" },
  );
  const red = await prompt.execute(
    { bb: f.bb },
    { gameId: game.id, action: "import", assetId: "hero:red" },
  );
  assert.deepEqual(requestPayload(blue.context).asset, {
    id: "hero:blue",
    name: "Blue hero",
    path: "canvas/staging/heroes/blue.png",
    type: "image",
  });
  assert.deepEqual(requestPayload(red.context).asset, {
    id: "hero:red",
    name: "Red hero",
    path: "canvas/staging/heroes/red.glb",
    type: "model",
  });
  assert.match(blue.prompt, /Blue hero/);
  assert.doesNotMatch(blue.prompt, /Red hero/);
  assert.match(red.prompt, /Red hero/);
  assert.equal(requestPayload(blue.context).request.action, "import");
  assert.equal(requestPayload(blue.context).request.id, blue.request.id);

  const generic = await prompt.execute({ bb: f.bb }, { gameId: game.id, action: "import" });
  assert.match(generic.prompt, /Orbit Garden/);
  assert.equal(requestPayload(generic.context).asset, undefined);
  assert.equal(requestPayload(generic.context).generation, undefined);
  assert.equal(f.writes.length, writesBefore);
  assert.deepEqual((await get.execute({ bb: f.bb }, { gameId: game.id })).requests, []);
});

test("targeted import rejects removed and non-staged assets", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  f.seed(
    "host",
    "/games/orbit/canvas/assets.json",
    JSON.stringify({
      version: 1,
      assets: {
        imported: { name: "Imported hero", path: "Assets/GameStudio/hero.png" },
        nearStaging: { name: "Unstaged hero", path: "canvas/staging-copy/hero.png" },
      },
    }),
  );
  f.seed("host", "/games/orbit/Assets/GameStudio/hero.png", "imported-image");
  f.seed("host", "/games/orbit/canvas/staging-copy/hero.png", "unstaged-image");
  const writesBefore = f.writes.length;
  for (const assetId of ["removed", "imported", "nearStaging"]) {
    await assert.rejects(
      async () => prompt.execute({ bb: f.bb }, { gameId: game.id, action: "import", assetId }),
      /selected asset|staging|staged asset|does not exist/i,
    );
  }
  assert.equal(f.writes.length, writesBefore);
  assert.deepEqual((await get.execute({ bb: f.bb }, { gameId: game.id })).requests, []);
});

test("import preparation resolves large catalog models without reading their bytes", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  f.seed(
    "host",
    "/games/orbit/canvas/assets.json",
    JSON.stringify({
      version: 1,
      assets: { "hero:large": { name: "Large hero", path: "canvas/staging/large.glb" } },
    }),
  );
  const read = f.bb.sdk.files.read;
  f.bb.sdk.files.read = async (args) => {
    if (args.path.endsWith("/large.glb")) throw new Error("Model exceeds the read limit.");
    return read(args);
  };
  const result = await prompt.execute(
    { bb: f.bb },
    { gameId: game.id, action: "import", assetId: "hero:large" },
  );
  assert.deepEqual(requestPayload(result.context).asset, {
    id: "hero:large",
    name: "Large hero",
    path: "canvas/staging/large.glb",
    type: "model",
  });
});

test("targeted import includes the newest matching output receipt without claiming current file verification", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  const path = "canvas/staging/hero/blue.png";
  f.seed(
    "host",
    "/games/orbit/canvas/assets.json",
    JSON.stringify({
      version: 1,
      assets: {
        "hero:blue": { name: "Blue hero", path },
        "hero:red": { name: "Red hero", path: "canvas/staging/hero/red.png" },
      },
    }),
  );
  f.seed("host", `/games/orbit/${path}`, "changed-after-generation");
  const receipt = { path, type: "image", sizeBytes: 42, sha256: "b".repeat(64) };
  for (const [id, createdAt, outputs] of [
    ["older", 10, [{ ...receipt, sizeBytes: 24, sha256: "a".repeat(64) }]],
    ["matching", 20, [receipt]],
    ["unrelated", 30, [{ ...receipt, path: "canvas/staging/other/blue.png" }]],
  ] as const) {
    f.seed(
      "host",
      `/games/orbit/canvas/jobs/${id}.json`,
      JSON.stringify({
        version: 1,
        id,
        threadId: "generation-thread",
        createdAt,
        updatedAt: createdAt + 1,
        status: "succeeded",
        request: { kind: "image", prompt: "A blue hero" },
        outputs,
      }),
    );
  }
  const selected = await prompt.execute(
    { bb: f.bb },
    { gameId: game.id, action: "import", assetId: "hero:blue" },
  );
  assert.deepEqual(requestPayload(selected.context).generation, {
    jobId: "matching",
    status: "succeeded",
    requestPath: "canvas/jobs/matching.json",
    output: {
      path: "canvas/staging/hero/blue.png",
      type: "image",
      sizeBytes: 42,
      sha256: "b".repeat(64),
    },
  });
  const unmatched = await prompt.execute(
    { bb: f.bb },
    { gameId: game.id, action: "import", assetId: "hero:red" },
  );
  assert.deepEqual(requestPayload(unmatched.context).asset, {
    id: "hero:red",
    name: "Red hero",
    path: "canvas/staging/hero/red.png",
    type: "image",
  });
  assert.equal(requestPayload(unmatched.context).generation, undefined);
});

test("asset targets are accepted only for import requests", async () => {
  const { promptInput } = await import("../../shared/schema.ts");
  assert.deepEqual(promptInput.parse({ gameId: "orbit", action: "import", assetId: "hero:blue" }), {
    gameId: "orbit",
    action: "import",
    assetId: "hero:blue",
  });
  for (const action of ["design", "playtest", "asset", "build"]) {
    assert.throws(() => promptInput.parse({ gameId: "orbit", action, assetId: "hero:blue" }));
  }
  for (const assetId of ["", null, 17, "a".repeat(1001)]) {
    assert.throws(() => promptInput.parse({ gameId: "orbit", action: "import", assetId }));
  }
});

test("preview paths reject traversal across POSIX and Windows roots", async () => {
  assert.equal(
    projectFile("C:\\Games\\Orbit", "dist/index.html"),
    "C:\\Games\\Orbit\\dist\\index.html",
  );
  for (const path of [
    "../secret",
    "folder/../secret",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "\\\\machine\\share",
    "folder//index.html",
    "data:secret",
    "folder/./secret",
  ]) {
    assert.throws(() => relativeFile(path), /relative|segments/);
  }
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  await assert.rejects(
    async () => updateGame.execute({ bb: f.bb }, { gameId: game.id, previewPath: "../secret" }),
    /segments/,
  );
  assert.equal(
    (await get.execute({ bb: f.bb }, { gameId: game.id })).game.previewPath,
    "index.html",
  );
});

test("generation requests show the selected brief and provider while keeping policy in separate context", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, { ...input, kind: "web" });
  const lease = await preview.execute({ bb: f.bb }, { gameId: game.id });
  assert.equal(lease.baseUrl, "https://preview.test/host/%2Fgames%2Forbit/");
  const detail = (await get.execute({ bb: f.bb }, { gameId: game.id })).boards[0]!;
  await saveBoard.execute(
    { bb: f.bb },
    {
      gameId: game.id,
      revision: detail.revision,
      board: {
        ...detail.board,
        nodes: [
          {
            id: "sprite",
            type: "image",
            title: "Dragon concept",
            position: { x: 800, y: 900 },
            data: { prompt: "A green dragon" },
          },
        ],
      },
    },
  );
  const result = await prompt.execute(
    { bb: f.bb },
    { gameId: game.id, action: "asset", nodeId: "sprite", recipe: "concept-art" },
  );
  assert.equal(
    result.prompt.split("\n")[0],
    "Generate 4 concept art candidates (Midjourney) for Dragon concept on Design board.",
  );
  assert.match(result.prompt, /Brief: A green dragon/);
  const { request, requestPath, ...references } = requestPayload(result.context);
  const current = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.deepEqual(references, {
    gameId: game.id,
    hostId: "host",
    rootPath: "/games/orbit",
    documentId: "design",
    documentPath: "canvas/documents/design.md",
    documentRevision: current.documents[0]!.revision,
    boardId: "main",
    boardPath: "canvas/boards/main.json",
    boardRevision: current.boards[0]!.revision,
    nodeId: "sprite",
    nodeBrief: "Brief: A green dragon",
    nodeInputs: { images: [], references: [] },
    recentNodeJobs: [],
    generationRequest: { recipe: "concept-art", outputCount: 4 },
  });
  assert.deepEqual(request, result.request);
  assert.equal(request.action, "asset");
  assert.match(request.id, /^[a-f0-9-]{36}$/);
  assert.equal(requestPath, `canvas/requests/${request.id}.json`);
  assert.match(result.context, /`game-dev`/);
  assert.doesNotMatch(result.context, /scott-engineering:game-dev/);
  assert.match(result.context, /Concept art · Midjourney/);
  const { files } = await import("./instructions.ts");
  assert.ok(result.context.includes(files.read("prompting/concept-art")));
  assert.doesNotMatch(
    result.prompt,
    /game-dev|authoring claim|selectedNode|position|requestPath|documentRevision|```json/,
  );
  await assert.rejects(
    async () =>
      prompt.execute({ bb: f.bb }, { gameId: game.id, action: "asset", nodeId: "missing" }),
    /no longer exists/,
  );
});

test("asset request context includes only the newest five recorded jobs for its selected node", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, { ...input, kind: "web" });
  const detail = (await get.execute({ bb: f.bb }, { gameId: game.id })).boards[0]!;
  await saveBoard.execute(
    { bb: f.bb },
    {
      gameId: game.id,
      revision: detail.revision,
      board: {
        ...detail.board,
        nodes: [
          {
            id: "sprite",
            type: "image",
            title: "Dragon concept",
            position: { x: 0, y: 0 },
            data: { prompt: "A green dragon", generationJobId: "legacy-linked" },
          },
          {
            id: "untested",
            type: "image",
            title: "Forest concept",
            position: { x: 200, y: 0 },
            data: { prompt: "A green forest" },
          },
        ],
      },
    },
  );
  const selectedTarget = { boardId: "main", nodeId: "sprite", fingerprint: "older-brief" };
  for (const [id, createdAt, status, target] of [
    ["oldest", 10, "failed", selectedTarget],
    ["older", 20, "succeeded", selectedTarget],
    ["third", 30, "failed", selectedTarget],
    ["fourth", 40, "succeeded", selectedTarget],
    ["fifth", 50, "running", selectedTarget],
    ["sixth", 60, "uncertain", selectedTarget],
    ["legacy-linked", 70, "succeeded", undefined],
    ["unlinked", 80, "queued", undefined],
    ["other-board", 90, "queued", { ...selectedTarget, boardId: "moodboard" }],
    ["other-node", 95, "running", { ...selectedTarget, nodeId: "another-sprite" }],
  ] as const) {
    f.seed(
      "host",
      `/games/orbit/canvas/jobs/${id}.json`,
      JSON.stringify({
        version: 1,
        id,
        threadId: "generation-thread",
        createdAt,
        updatedAt: createdAt + 1,
        status,
        request: { kind: "image", prompt: "A previous dragon brief" },
        ...(target ? { target } : {}),
        outputs: [],
      }),
    );
  }
  const writesBefore = f.writes.length;
  const selected = await prompt.execute(
    { bb: f.bb },
    { gameId: game.id, action: "asset", nodeId: "sprite" },
  );
  assert.deepEqual(requestPayload(selected.context).recentNodeJobs, [
    {
      id: "legacy-linked",
      status: "succeeded",
      createdAt: 70,
      jobPath: "canvas/jobs/legacy-linked.json",
    },
    {
      id: "sixth",
      status: "uncertain",
      createdAt: 60,
      jobPath: "canvas/jobs/sixth.json",
      boardId: "main",
      nodeId: "sprite",
    },
    {
      id: "fifth",
      status: "running",
      createdAt: 50,
      jobPath: "canvas/jobs/fifth.json",
      boardId: "main",
      nodeId: "sprite",
    },
    {
      id: "fourth",
      status: "succeeded",
      createdAt: 40,
      jobPath: "canvas/jobs/fourth.json",
      boardId: "main",
      nodeId: "sprite",
    },
    {
      id: "third",
      status: "failed",
      createdAt: 30,
      jobPath: "canvas/jobs/third.json",
      boardId: "main",
      nodeId: "sprite",
    },
  ]);
  assert.equal(requestPayload(selected.context).nodeId, "sprite");

  const noJobs = await prompt.execute(
    { bb: f.bb },
    { gameId: game.id, action: "asset", nodeId: "untested" },
  );
  assert.equal(requestPayload(noJobs.context).nodeId, "untested");
  assert.deepEqual(requestPayload(noJobs.context).recentNodeJobs, []);

  for (const action of ["design", "playtest", "build"] as const) {
    const unrelated = await prompt.execute(
      { bb: f.bb },
      { gameId: game.id, action, nodeId: "sprite" },
    );
    assert.equal(requestPayload(unrelated.context).request.action, action);
    assert.equal(requestPayload(unrelated.context).recentNodeJobs, undefined);
  }
  const noSelection = await prompt.execute({ bb: f.bb }, { gameId: game.id, action: "asset" });
  assert.equal(requestPayload(noSelection.context).request.action, "asset");
  assert.equal(requestPayload(noSelection.context).recentNodeJobs, undefined);
  assert.equal(f.writes.length, writesBefore);
  assert.deepEqual((await get.execute({ bb: f.bb }, { gameId: game.id })).requests, []);
});

test("board-scoped asset requests resolve duplicate node ids without falling back to another board", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, { ...input, kind: "web" });
  const workspace = await createBoard.execute(
    { bb: f.bb },
    { gameId: game.id, name: "Character studies" },
  );
  const second = workspace.boards.find(({ board }) => board.id !== "main")!;
  for (const detail of workspace.boards) {
    const isSecond = detail.board.id === second.board.id;
    await saveBoard.execute(
      { bb: f.bb },
      {
        gameId: game.id,
        revision: detail.revision,
        board: {
          ...detail.board,
          nodes: [
            {
              id: "hero",
              type: "image",
              title: isSecond ? "Red hero" : "Green hero",
              position: { x: 0, y: 0 },
              data: {
                prompt: isSecond ? "A red fox hero" : "A green forest hero",
                references: [
                  { type: "library", assetId: isSecond ? "fox-reference" : "forest-reference" },
                ],
              },
            },
            ...(isSecond
              ? [
                  {
                    id: "banner",
                    type: "image" as const,
                    position: { x: 200, y: 0 },
                    data: { prompt: "A golden banner" },
                  },
                ]
              : []),
          ],
        },
      },
    );
  }
  for (const [id, boardId, createdAt] of [
    ["forest-job", "main", 90],
    ["fox-job", second.board.id, 50],
  ] as const) {
    f.seed(
      "host",
      `/games/orbit/canvas/jobs/${id}.json`,
      JSON.stringify({
        version: 1,
        id,
        threadId: null,
        createdAt,
        updatedAt: createdAt,
        status: "running",
        request: { kind: "image", prompt: "A hero" },
        target: { boardId, nodeId: "hero", fingerprint: "saved-brief" },
        outputs: [],
      }),
    );
  }
  const writesBefore = f.writes.length;
  const selected = await prompt.execute(
    { bb: f.bb },
    { gameId: game.id, action: "asset", boardId: second.board.id, nodeId: "hero" },
  );
  const payload = requestPayload(selected.context);
  assert.equal(payload.boardId, second.board.id);
  assert.equal(payload.boardPath, `canvas/boards/${second.board.id}.json`);
  assert.equal(payload.nodeId, "hero");
  assert.equal(payload.nodeBrief, "Brief: A red fox hero");
  assert.deepEqual(payload.nodeInputs, {
    images: [],
    references: [{ type: "library", assetId: "fox-reference" }],
  });
  assert.deepEqual(payload.recentNodeJobs, [
    {
      id: "fox-job",
      status: "running",
      createdAt: 50,
      jobPath: "canvas/jobs/fox-job.json",
      boardId: second.board.id,
      nodeId: "hero",
    },
  ]);
  const current = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.equal(
    payload.boardRevision,
    current.boards.find(({ board }) => board.id === second.board.id)!.revision,
  );

  await assert.rejects(
    async () => prompt.execute({ bb: f.bb }, { gameId: game.id, action: "asset", nodeId: "hero" }),
    /ambiguous|more than one board|multiple boards/i,
  );
  for (const [boardId, nodeId] of [
    ["missing-board", "hero"],
    ["main", "banner"],
    [second.board.id, "missing-node"],
  ]) {
    await assert.rejects(
      async () =>
        prompt.execute({ bb: f.bb }, { gameId: game.id, action: "asset", boardId, nodeId }),
      /no longer exists|selected board|selected canvas/i,
    );
  }
  const legacyUnique = requestPayload(
    (await prompt.execute({ bb: f.bb }, { gameId: game.id, action: "asset", nodeId: "banner" }))
      .context,
  );
  assert.equal(legacyUnique.boardId, second.board.id);
  assert.equal(legacyUnique.nodeBrief, "Brief: A golden banner");
  assert.equal(f.writes.length, writesBefore);
  assert.deepEqual(current.requests, []);
});

test("design requests use the selected document and its saved revision", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  const workspace = await createDocument.execute(
    { bb: f.bb },
    { gameId: game.id, title: "Movement experiment" },
  );
  const document = workspace.documents.find((item) => item.id !== "design")!;
  const saved = await saveDocument.execute(
    { bb: f.bb },
    {
      gameId: game.id,
      documentId: document.id,
      revision: document.revision,
      markdown: "# Movement experiment\nTest whether the dash clears the gap.",
    },
  );
  const result = await prompt.execute(
    { bb: f.bb },
    { gameId: game.id, action: "design", documentId: document.id },
  );
  const payload = requestPayload(result.context);
  assert.equal(payload.documentId, document.id);
  assert.equal(payload.documentPath, `canvas/documents/${document.id}.md`);
  assert.equal(payload.documentRevision, saved.revision);
  assert.match(result.context, new RegExp(saved.revision));
  assert.equal(payload.request.id, result.request.id);
  await assert.rejects(
    async () =>
      prompt.execute({ bb: f.bb }, { gameId: game.id, action: "design", documentId: "missing" }),
    /selected design document no longer exists/,
  );
});

test("Unity setup selections survive reopen and appear only in new-project requests", async () => {
  const f = fake();
  const game = await create.execute(
    { bb: f.bb },
    { ...input, unitySetup: { version: "6000.3.4f1", template: "2d-urp" } },
  );
  const workspace = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.deepEqual(workspace.game.unitySetup, { version: "6000.3.4f1", template: "2d-urp" });
  const writeCount = f.writes.length;
  const result = await prompt.execute({ bb: f.bb }, { gameId: game.id, action: "new-unity" });
  const payload = requestPayload(result.context);
  assert.deepEqual(payload.unitySetup, { version: "6000.3.4f1", template: "2d-urp" });
  assert.match(result.prompt, /Editor version: 6000\.3\.4f1\. Template: 2D URP\./);
  assert.match(result.context, /Requested Editor: 6000\.3\.4f1\./);
  assert.match(result.context, /Requested template: 2D URP\./);
  assert.equal(payload.request.action, "new-unity");
  assert.equal(payload.request.id, result.request.id);
  assert.equal(f.writes.length, writeCount);
  assert.deepEqual((await get.execute({ bb: f.bb }, { gameId: game.id })).requests, []);
  const followup = await prompt.execute({ bb: f.bb }, { gameId: game.id, action: "build" });
  const references = requestPayload(followup.context);
  assert.equal(references.request.action, "build");
  assert.equal(references.unitySetup, undefined);
  const automatic = await create.execute(
    { bb: f.bb },
    { ...input, rootPath: "/games/automatic", unitySetup: { version: null, template: "empty" } },
  );
  const automaticPrompt = await prompt.execute(
    { bb: f.bb },
    { gameId: automatic.id, action: "new-unity" },
  );
  assert.match(automaticPrompt.prompt, /Editor version: Agent chooses via Hub\. Template: Empty\./);
});

test("accepted requests record queued progress and retries preserve agent completion", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  const request = { id: "request-1", action: "playtest" as const, createdAt: 1735689600000 };
  const queued = await recordRequest.execute(
    { bb: f.bb },
    { gameId: game.id, request, threadId: "matching", status: "queued" },
  );
  assert.deepEqual(queued, {
    id: "request-1",
    action: "playtest",
    createdAt: 1735689600000,
    threadId: "matching",
    status: "queued",
  });
  f.seed(
    "host",
    "/games/orbit/canvas/requests/request-1.json",
    JSON.stringify({ ...queued, status: "done", detail: "Scene compiled and capture verified." }),
  );
  const retried = await recordRequest.execute(
    { bb: f.bb },
    { gameId: game.id, request, threadId: "matching", status: "running" },
  );
  assert.deepEqual(retried, {
    ...queued,
    status: "done",
    detail: "Scene compiled and capture verified.",
  });
  assert.deepEqual((await get.execute({ bb: f.bb }, { gameId: game.id })).requests, [retried]);
});

test("a faster agent progress write wins over initial request recording", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  const request = { id: "fast-agent", action: "build" as const, createdAt: 1735689600100 };
  f.interceptWrite((write) => {
    if (write.path.endsWith("canvas/requests/fast-agent.json")) {
      f.seed(
        "host",
        write.path,
        JSON.stringify({
          ...request,
          threadId: "matching",
          status: "done",
          detail: "Compilation verified.",
        }),
      );
    }
  });
  const recorded = await recordRequest.execute(
    { bb: f.bb },
    { gameId: game.id, request, threadId: "matching", status: "queued" },
  );
  assert.deepEqual(recorded, {
    id: "fast-agent",
    action: "build",
    createdAt: 1735689600100,
    threadId: "matching",
    status: "done",
    detail: "Compilation verified.",
  });
  assert.equal(
    JSON.parse(f.contents("host", "/games/orbit/canvas/requests/fast-agent.json")!).status,
    "done",
  );
});

test("request history keeps the five newest reported statuses and skips partial or mismatched files", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  const states = ["queued", "running", "done", "failed", "uncertain", "queued", "running"];
  for (let index = 0; index < states.length; index++) {
    f.seed(
      "host",
      `/games/orbit/canvas/requests/request-${index}.json`,
      JSON.stringify({
        id: `request-${index}`,
        action: "build",
        createdAt: 1000 + index,
        threadId: "matching",
        status: states[index],
      }),
    );
  }
  f.seed("host", "/games/orbit/canvas/requests/partial.json", '{"id":');
  f.seed(
    "host",
    "/games/orbit/canvas/requests/mismatch.json",
    JSON.stringify({
      id: "other",
      action: "build",
      createdAt: 9999,
      threadId: "matching",
      status: "done",
    }),
  );
  const workspace = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.deepEqual(
    workspace.requests?.map(({ id, status }) => ({ id, status })),
    [
      { id: "request-6", status: "running" },
      { id: "request-5", status: "queued" },
      { id: "request-4", status: "uncertain" },
      { id: "request-3", status: "failed" },
      { id: "request-2", status: "done" },
    ],
  );
  assert.equal(workspace.documents[0]!.title, "Game design");
});

test("request recording rejects a different project, host, directory, or missing workspace", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  const request = { id: "scoped", action: "connect" as const, createdAt: 1735689600000 };
  const writeCount = f.writes.length;
  for (const threadId of ["foreign", "wrong-host", "wrong-path", "destroyed", "no-environment"]) {
    await assert.rejects(
      async () =>
        recordRequest.execute(
          { bb: f.bb },
          { gameId: game.id, request, threadId, status: "queued" },
        ),
      /different BB project|different machine or directory|no workspace/,
    );
  }
  assert.equal(f.writes.length, writeCount);
  const matching = await recordRequest.execute(
    { bb: f.bb },
    { gameId: game.id, request, threadId: "matching", status: "queued" },
  );
  assert.equal(matching.threadId, "matching");
  assert.equal(matching.status, "queued");
});

test("evidence lists real image and video captures while excluding notes and Unity metadata", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  f.seed("host", "/games/orbit/canvas/evidence/shot.png", "actual-capture-bytes");
  f.seed("host", "/games/orbit/canvas/evidence/run.webm", "actual-recording-bytes");
  f.seed("host", "/games/orbit/canvas/evidence/notes.md", "Unverified playtest notes");
  f.seed("host", "/games/orbit/canvas/evidence/shot.png.meta", "fileFormatVersion: 2");
  const workspace = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.deepEqual(
    workspace.evidence?.map(({ name, path, type }) => ({ name, path, type })),
    [
      { name: "run.webm", path: "canvas/evidence/run.webm", type: "video" },
      { name: "shot.png", path: "canvas/evidence/shot.png", type: "image" },
    ],
  );
});

test("a registered thread from another BB project is rejected", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  await assert.rejects(
    async () => updateGame.execute({ bb: f.bb }, { gameId: game.id, threadId: "foreign" }),
    /different BB project/,
  );
  const updated = await updateGame.execute({ bb: f.bb }, { gameId: game.id, threadId: "matching" });
  assert.equal(updated.threadId, "matching");
  assert.equal((await get.execute({ bb: f.bb }, { gameId: game.id })).game.threadId, "matching");
});

test("Unity media receives a preview lease without a web game entry", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  const lease = await preview.execute({ bb: f.bb }, { gameId: game.id });
  assert.deepEqual(lease, {
    baseUrl: "https://preview.test/host/%2Fgames%2Forbit/",
    expiresAtMs: 100000,
  });
  assert.equal(f.contents("host", "/games/orbit/index.html"), undefined);
});

test("linking a thread requires the game's exact machine and live workspace directory", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  for (const threadId of ["wrong-host", "wrong-path", "destroyed"]) {
    await assert.rejects(
      async () => updateGame.execute({ bb: f.bb }, { gameId: game.id, threadId }),
      /different machine or directory/,
    );
  }
  await assert.rejects(
    async () => updateGame.execute({ bb: f.bb }, { gameId: game.id, threadId: "no-environment" }),
    /no workspace/,
  );
  const linked = await updateGame.execute({ bb: f.bb }, { gameId: game.id, threadId: "matching" });
  assert.equal(linked.threadId, "matching");
  assert.equal((await get.execute({ bb: f.bb }, { gameId: game.id })).game.threadId, "matching");
});

test("inspect Unity reports the real engine version without creating any workspace files", async () => {
  const f = fake();
  const empty = await inspectUnity.execute(
    { bb: f.bb },
    { hostId: "host", rootPath: "/games/orbit" },
  );
  assert.deepEqual(empty, { version: null });
  f.seed(
    "host",
    "/games/orbit/ProjectSettings/ProjectVersion.txt",
    "m_EditorVersion: 6000.2.8f1\n",
  );
  f.directories.add("host:/games/orbit/Assets");
  const unity = await inspectUnity.execute(
    { bb: f.bb },
    { hostId: "host", rootPath: "/games/orbit" },
  );
  assert.deepEqual(unity, { version: "6000.2.8f1" });
  assert.equal(f.writes.length, 0);
});

test("a concurrent asset-manifest edit rejects and keeps both newer metadata and the staged upload", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  f.interceptWrite((write) => {
    if (write.path.endsWith("canvas/assets.json")) {
      f.seed(
        "host",
        write.path,
        JSON.stringify({
          version: 1,
          assets: {
            sound: {
              name: "jump.wav",
              path: "Assets/GameStudio/jump.wav",
              description: "External metadata",
            },
          },
        }),
      );
    }
  });
  await assert.rejects(
    async () =>
      uploadAsset.execute(
        { bb: f.bb },
        {
          gameId: game.id,
          name: "star.png",
          content: Buffer.from("image").toString("base64"),
        },
      ),
    /changed on disk/,
  );
  const workspace = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.equal(workspace.assets.find(({ id }) => id === "sound")?.name, "jump.wav");
  const staged = workspace.assets.find(({ type }) => type === "image");
  assert.match(staged?.path ?? "", /^canvas\/staging\/[a-f0-9-]+-star\.png$/);
  assert.equal(f.contents("host", `/games/orbit/${staged!.path}`), "aW1hZ2U=");
  assert.equal(
    JSON.parse(f.contents("host", "/games/orbit/canvas/assets.json")!).assets.sound.description,
    "External metadata",
  );
});

test("provided playtest runs resolve real captures and retain their reported time, scene, outcome and thread", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  f.seed("host", "/games/orbit/canvas/evidence/menu.png", "image");
  f.seed("host", "/games/orbit/canvas/evidence/combat.webm", "recording");
  f.seed(
    "host",
    "/games/orbit/canvas/evidence/index.json",
    JSON.stringify({
      version: 1,
      runs: [
        {
          id: "menu",
          capturedAtMs: 1735689600000,
          scene: "MainMenu",
          outcome: "pass",
          threadId: "thr_menu",
          files: ["canvas/evidence/menu.png"],
        },
        {
          id: "combat",
          capturedAtMs: 1735776000000,
          scene: "Arena",
          outcome: "fail",
          files: ["canvas/evidence/combat.webm"],
        },
      ],
    }),
  );
  const workspace = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.deepEqual(
    workspace.evidenceRuns?.map((run) => ({
      id: run.id,
      capturedAtMs: run.capturedAtMs,
      scene: run.scene,
      outcome: run.outcome,
      threadId: run.threadId,
      files: run.files.map(({ path }) => path),
    })),
    [
      {
        id: "combat",
        capturedAtMs: 1735776000000,
        scene: "Arena",
        outcome: "fail",
        threadId: undefined,
        files: ["canvas/evidence/combat.webm"],
      },
      {
        id: "menu",
        capturedAtMs: 1735689600000,
        scene: "MainMenu",
        outcome: "pass",
        threadId: "thr_menu",
        files: ["canvas/evidence/menu.png"],
      },
    ],
  );
  assert.deepEqual(
    workspace.evidence?.map(({ path }) => path),
    ["canvas/evidence/combat.webm", "canvas/evidence/menu.png"],
  );
});

test("playtest evidence preserves tested builds and historical experiment provenance", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  f.seed("host", "/games/orbit/canvas/evidence/dash.png", "image");
  f.seed(
    "host",
    "/games/orbit/canvas/evidence/index.json",
    JSON.stringify({
      version: 1,
      runs: [
        {
          id: "dash-v1",
          capturedAtMs: 1735689600000,
          testedRevision: "  build-a41f  ",
          experiment: {
            documentId: "design",
            documentRevision: " historical-design-revision ",
            experimentId: "dash-gap",
          },
          files: ["canvas/evidence/dash.png"],
        },
        {
          id: "archived-experiment",
          capturedAtMs: 1735776000000,
          testedRevision: "prototype-2025-01-02",
          experiment: {
            documentId: "removed-document",
            documentRevision: "removed-document-revision",
            experimentId: "dash-gap",
          },
          files: ["canvas/evidence/dash.png"],
        },
      ],
    }),
  );

  const workspace = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.ok(workspace.evidenceRuns);
  assert.deepEqual(
    workspace.evidenceRuns.map(({ id, testedRevision, experiment }) => ({
      id,
      testedRevision,
      experiment,
    })),
    [
      {
        id: "archived-experiment",
        testedRevision: "prototype-2025-01-02",
        experiment: {
          documentId: "removed-document",
          documentRevision: "removed-document-revision",
          experimentId: "dash-gap",
        },
      },
      {
        id: "dash-v1",
        testedRevision: "build-a41f",
        experiment: {
          documentId: "design",
          documentRevision: "historical-design-revision",
          experimentId: "dash-gap",
        },
      },
    ],
  );
  assert.equal(workspace.documents[0]!.id, "design");
});

test("recorded experiment definitions survive GDD edits and removal while retests use the saved document", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  f.seed("host", "/games/orbit/canvas/evidence/dash.png", "image");
  f.seed(
    "host",
    "/games/orbit/canvas/evidence/index.json",
    JSON.stringify({
      version: 1,
      runs: [
        {
          id: "dash-v1",
          capturedAtMs: 1735689600000,
          testedRevision: "build-a41f",
          experiment: {
            documentId: "design",
            documentRevision: "tested-design-revision",
            experimentId: "dash-gap",
            definition: {
              question: "  Can players read the landing zone before dashing?  ",
              criterion: "  Four of five new players land safely on their first attempt.  ",
              setup: "  Start at the marked gap; show the landing ring; allow one dash.  ",
            },
          },
          files: ["canvas/evidence/dash.png"],
        },
      ],
    }),
  );
  const initial = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.deepEqual(initial.evidenceRuns?.[0]?.experiment, {
    documentId: "design",
    documentRevision: "tested-design-revision",
    experimentId: "dash-gap",
    definition: {
      question: "Can players read the landing zone before dashing?",
      criterion: "Four of five new players land safely on their first attempt.",
      setup: "Start at the marked gap; show the landing ring; allow one dash.",
    },
  });

  const saved = await saveDocument.execute(
    { bb: f.bb },
    {
      gameId: game.id,
      documentId: "design",
      revision: initial.documents[0]!.revision,
      markdown:
        "# New dash experiment\n\nQuestion: Can players chain two dashes?\nCriterion: Finish in ten seconds.\nSetup: Remove the landing ring and use two gaps.",
    },
  );
  const retest = requestPayload(
    (
      await prompt.execute(
        { bb: f.bb },
        { gameId: game.id, action: "playtest", documentId: "design", experimentId: "dash-gap" },
      )
    ).context,
  );
  assert.deepEqual(retest.experiment, {
    documentId: "design",
    documentRevision: saved.revision,
    experimentId: "dash-gap",
  });
  assert.notEqual(retest.documentRevision, "tested-design-revision");
  assert.deepEqual(retest.evidence.runs[0].experiment, {
    documentId: "design",
    documentRevision: "tested-design-revision",
    experimentId: "dash-gap",
    definition: {
      question: "Can players read the landing zone before dashing?",
      criterion: "Four of five new players land safely on their first attempt.",
      setup: "Start at the marked gap; show the landing ring; allow one dash.",
    },
  });

  f.seed(
    "host",
    "/games/orbit/canvas/index.json",
    JSON.stringify({
      version: 1,
      boards: [{ id: "main", name: "Design board" }],
      documents: [],
    }),
  );
  const archived = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.deepEqual(archived.documents, []);
  assert.deepEqual(archived.evidenceRuns?.[0]?.experiment, {
    documentId: "design",
    documentRevision: "tested-design-revision",
    experimentId: "dash-gap",
    definition: {
      question: "Can players read the landing zone before dashing?",
      criterion: "Four of five new players land safely on their first attempt.",
      setup: "Start at the marked gap; show the landing ring; allow one dash.",
    },
  });
});

test("evidence rejects incomplete or malformed experiment provenance and accepts legacy runs", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  f.seed("host", "/games/orbit/canvas/evidence/dash.png", "image");
  const valid = {
    documentId: "design",
    documentRevision: "historical-revision",
    experimentId: "dash-gap",
  };
  const definition = {
    question: "Can players clear the gap?",
    criterion: "Four of five new players land safely.",
    setup: "Start at the marked gap with one dash.",
  };
  for (const metadata of [
    { testedRevision: " " },
    { testedRevision: "a".repeat(201) },
    { experiment: null },
    { experiment: {} },
    { experiment: { documentId: "design", experimentId: "dash-gap" } },
    { experiment: { documentRevision: "old", experimentId: "dash-gap" } },
    { experiment: { documentId: "design", documentRevision: "old" } },
    { experiment: { ...valid, documentId: "../design" } },
    { experiment: { ...valid, documentId: "" } },
    { experiment: { ...valid, experimentId: "../dash-gap" } },
    { experiment: { ...valid, experimentId: " " } },
    { experiment: { ...valid, documentRevision: " " } },
    { experiment: { ...valid, documentRevision: "a".repeat(201) } },
    { experiment: { ...valid, unexpected: "ignored" } },
    ...[
      null,
      "current GDD",
      {},
      { criterion: definition.criterion, setup: definition.setup },
      { question: definition.question, setup: definition.setup },
      { question: definition.question, criterion: definition.criterion },
      { ...definition, question: " " },
      { ...definition, criterion: "\n\t" },
      { ...definition, setup: " " },
      { ...definition, question: "q".repeat(501) },
      { ...definition, criterion: "c".repeat(1001) },
      { ...definition, setup: "s".repeat(2001) },
      { ...definition, question: 12 },
      { ...definition, outcome: "pass" },
    ].map((definition) => ({ experiment: { ...valid, definition } })),
  ]) {
    f.seed(
      "host",
      "/games/orbit/canvas/evidence/index.json",
      JSON.stringify({
        version: 1,
        runs: [
          {
            id: "invalid",
            capturedAtMs: 1735689600000,
            files: ["canvas/evidence/dash.png"],
            ...metadata,
          },
        ],
      }),
    );
    await assert.rejects(
      async () => get.execute({ bb: f.bb }, { gameId: game.id }),
      /canvas\/evidence\/index\.json/,
    );
  }

  f.seed(
    "host",
    "/games/orbit/canvas/evidence/index.json",
    JSON.stringify({
      version: 1,
      runs: [
        {
          id: "legacy",
          capturedAtMs: 1735689600000,
          files: ["canvas/evidence/dash.png"],
        },
        {
          id: "provenance-only",
          capturedAtMs: 1735689600001,
          experiment: valid,
          files: ["canvas/evidence/dash.png"],
        },
      ],
    }),
  );
  const workspace = await get.execute({ bb: f.bb }, { gameId: game.id });
  const legacy = workspace.evidenceRuns?.find(({ id }) => id === "legacy");
  assert.ok(legacy);
  assert.equal(legacy.id, "legacy");
  assert.equal(legacy.files[0]!.path, "canvas/evidence/dash.png");
  assert.equal(legacy.testedRevision, undefined);
  assert.equal(legacy.experiment, undefined);
  assert.deepEqual(workspace.evidenceRuns?.[0]?.experiment, {
    documentId: "design",
    documentRevision: "historical-revision",
    experimentId: "dash-gap",
  });
});

test("experiment requests summarize the latest matching evidence without rewriting reported revisions", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  f.seed("host", "/games/orbit/canvas/evidence/dash.png", "image");
  const experiment = {
    documentId: "design",
    documentRevision: "tested-design-revision",
    experimentId: "dash-gap",
  };
  f.seed(
    "host",
    "/games/orbit/canvas/evidence/index.json",
    JSON.stringify({
      version: 1,
      runs: [
        ...Array.from({ length: 12 }, (_, index) => ({
          id: `dash-${index + 1}`,
          capturedAtMs: 1735689600000 + index,
          scene: "GapCourse",
          outcome: "fail",
          threadId: "thr_dash",
          testedRevision: "prototype-a41f",
          experiment,
          files: ["canvas/evidence/dash.png"],
        })),
        {
          id: "other-experiment",
          capturedAtMs: 1735776000000,
          experiment: { ...experiment, experimentId: "jump-height" },
          files: ["canvas/evidence/dash.png"],
        },
        {
          id: "other-document",
          capturedAtMs: 1735776000001,
          experiment: { ...experiment, documentId: "removed-document" },
          files: ["canvas/evidence/dash.png"],
        },
        {
          id: "legacy",
          capturedAtMs: 1735776000002,
          files: ["canvas/evidence/dash.png"],
        },
      ],
    }),
  );
  const workspace = await get.execute({ bb: f.bb }, { gameId: game.id });
  const result = await prompt.execute(
    { bb: f.bb },
    { gameId: game.id, action: "playtest", documentId: "design", experimentId: "dash-gap" },
  );
  const payload = requestPayload(result.context);
  assert.deepEqual(payload.experiment, {
    documentId: "design",
    documentRevision: workspace.documents[0]!.revision,
    experimentId: "dash-gap",
  });
  assert.equal(payload.evidence.manifestPath, "canvas/evidence/index.json");
  assert.equal(payload.evidence.matchingRunCount, 12);
  assert.deepEqual(
    payload.evidence.runs.map(({ id }: { id: string }) => id),
    [
      "dash-12",
      "dash-11",
      "dash-10",
      "dash-9",
      "dash-8",
      "dash-7",
      "dash-6",
      "dash-5",
      "dash-4",
      "dash-3",
    ],
  );
  assert.deepEqual(payload.evidence.runs[0], {
    id: "dash-12",
    capturedAtMs: 1735689600011,
    scene: "GapCourse",
    outcome: "fail",
    threadId: "thr_dash",
    testedRevision: "prototype-a41f",
    experiment: {
      documentId: "design",
      documentRevision: "tested-design-revision",
      experimentId: "dash-gap",
    },
    captureCount: 1,
  });

  const design = requestPayload(
    (
      await prompt.execute(
        { bb: f.bb },
        { gameId: game.id, action: "design", documentId: "design" },
      )
    ).context,
  );
  assert.equal(design.evidence.matchingRunCount, 14);
  assert.deepEqual(
    design.evidence.runs.map(({ id }: { id: string }) => id),
    [
      "legacy",
      "other-experiment",
      "dash-12",
      "dash-11",
      "dash-10",
      "dash-9",
      "dash-8",
      "dash-7",
      "dash-6",
      "dash-5",
    ],
  );
  assert.equal(design.experiment, undefined);

  const build = requestPayload(
    (
      await prompt.execute(
        { bb: f.bb },
        { gameId: game.id, action: "build", documentId: "design", experimentId: "dash-gap" },
      )
    ).context,
  );
  assert.equal(build.evidence.matchingRunCount, 12);
  assert.equal(build.evidence.runs[0].id, "dash-12");
  const generalBuild = requestPayload(
    (await prompt.execute({ bb: f.bb }, { gameId: game.id, action: "build" })).context,
  );
  assert.equal(generalBuild.gameId, game.id);
  assert.equal(generalBuild.evidence, undefined);
});

test("experiment requests require a saved document", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  f.seed(
    "host",
    "/games/orbit/canvas/index.json",
    JSON.stringify({
      version: 1,
      boards: [{ id: "main", name: "Design board" }],
      documents: [],
    }),
  );
  await assert.rejects(
    async () =>
      prompt.execute(
        { bb: f.bb },
        { gameId: game.id, action: "playtest", experimentId: "dash-gap" },
      ),
    /saved design document/,
  );
  const result = await prompt.execute({ bb: f.bb }, { gameId: game.id, action: "playtest" });
  assert.equal(requestPayload(result.context).gameId, game.id);
});

test("evidence manifests reject traversal, external paths, missing captures and nonmedia files", async () => {
  const f = fake();
  const game = await create.execute({ bb: f.bb }, input);
  f.seed("host", "/games/orbit/canvas/evidence/notes.md", "Untested note");
  for (const path of [
    "../secret.png",
    "canvas/evidence/../secret.png",
    "Assets/GameStudio/secret.png",
    "canvas/evidence/missing.png",
    "canvas/evidence/notes.md",
  ]) {
    f.seed(
      "host",
      "/games/orbit/canvas/evidence/index.json",
      JSON.stringify({
        version: 1,
        runs: [{ id: "bad", capturedAtMs: 1735689600000, files: [path] }],
      }),
    );
    await assert.rejects(
      async () => get.execute({ bb: f.bb }, { gameId: game.id }),
      /segments|under canvas\/evidence|missing or unsupported media/,
    );
  }
});

test("generation candidates attach only to the current brief and preserve the user's editor layout", async () => {
  const { adoptGeneration } = await import("./studio.ts");
  const { canvasRequest } = await import("./canvas-generation.ts");
  const { gameSchema, workspaceSchema } = await import("../../shared/schema.ts");
  const { generationJob } = await import("../../shared/generation.ts");
  const f = fake(),
    game = gameSchema.parse(await create.execute({ bb: f.bb }, input));
  const original = (await get.execute({ bb: f.bb }, { gameId: game.id })).boards[0]!;
  await saveBoard.execute(
    { bb: f.bb },
    {
      gameId: game.id,
      revision: original.revision,
      board: {
        ...original.board,
        nodes: [
          {
            id: "image",
            type: "image",
            title: "Key",
            position: { x: 860, y: 200 },
            data: { prompt: "A brass key" },
          },
        ],
      },
    },
  );
  const workspace = workspaceSchema.parse(await get.execute({ bb: f.bb }, { gameId: game.id }));
  const request = canvasRequest(workspace, {
    gameId: game.id,
    boardId: "main",
    nodeId: "image",
    revision: workspace.boards[0]!.revision,
    requestId: "generation",
  });
  const layoutBefore = f.contents("host", "/games/orbit/canvas/editor/main.json");
  const path = "canvas/staging/generation/key.png";
  f.seed("host", `/games/orbit/${path}`, "image", "base64");
  const job = generationJob.parse({
    version: 1,
    id: "generation",
    threadId: "thread",
    createdAt: 1,
    updatedAt: 2,
    status: "succeeded",
    ...request,
    outputs: [{ path, type: "image", sizeBytes: 4, sha256: "a".repeat(64) }],
  });
  const adopted = await adoptGeneration(f.bb, game, job);
  assert.equal(adopted.attached, true);
  const updated = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.equal(updated.boards[0]!.board.nodes[0]!.data.assetId, adopted.candidateAssetIds[0]);
  assert.equal(
    updated.assets.find((asset) => asset.id === adopted.candidateAssetIds[0])?.path,
    path,
  );
  assert.equal(f.contents("host", "/games/orbit/canvas/editor/main.json"), layoutBefore);
  const catalog = JSON.parse(f.contents("host", "/games/orbit/canvas/assets.json")!);
  catalog.assets[adopted.candidateAssetIds[0]!].name = "Approved key";
  catalog.assets[adopted.candidateAssetIds[0]!].license = "Project license";
  f.seed("host", "/games/orbit/canvas/assets.json", JSON.stringify(catalog));
  await adoptGeneration(f.bb, game, job);
  assert.deepEqual(
    JSON.parse(f.contents("host", "/games/orbit/canvas/assets.json")!).assets[
      adopted.candidateAssetIds[0]!
    ],
    { name: "Approved key", path, license: "Project license" },
  );
  await saveBoard.execute(
    { bb: f.bb },
    {
      gameId: game.id,
      revision: updated.boards[0]!.revision,
      board: {
        ...updated.boards[0]!.board,
        nodes: [{ ...updated.boards[0]!.board.nodes[0]!, data: { prompt: "A silver key" } }],
      },
    },
  );
  // An edited brief keeps its text; the earlier run's output stays available as a take.
  const stale = await adoptGeneration(f.bb, game, job);
  assert.equal(stale.attached, true);
  const final = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.deepEqual(final.boards[0]!.board.nodes[0]!.data, {
    prompt: "A silver key",
    takes: [{ assetId: adopted.candidateAssetIds[0], jobId: "generation" }],
    assetId: adopted.candidateAssetIds[0],
    generationJobId: "generation",
  });
  assert.equal(final.assets.find((asset) => asset.path === path)?.id, adopted.candidateAssetIds[0]);
});

test("rerolls add takes beside earlier ones without replacing the pick or shortlist", async () => {
  const { adoptGeneration } = await import("./studio.ts");
  const { gameSchema } = await import("../../shared/schema.ts");
  const { generationJob } = await import("../../shared/generation.ts");
  const f = fake(),
    game = gameSchema.parse(await create.execute({ bb: f.bb }, input));
  const original = (await get.execute({ bb: f.bb }, { gameId: game.id })).boards[0]!;
  await saveBoard.execute(
    { bb: f.bb },
    {
      gameId: game.id,
      revision: original.revision,
      board: {
        ...original.board,
        nodes: [
          {
            id: "coin",
            type: "image",
            position: { x: 0, y: 0 },
            // A node from before takes: its output and the old candidate list.
            data: { prompt: "Coin", assetId: "old", candidateAssetIds: ["old"] },
          },
        ],
      },
    },
  );
  const run = (id: string, files: string[]) => {
    for (const file of files)
      f.seed("host", `/games/orbit/canvas/staging/${id}/${file}`, "png", "base64");
    return generationJob.parse({
      version: 1,
      id,
      threadId: null,
      origin: { kind: "canvas", gameId: game.id },
      createdAt: 1,
      updatedAt: 2,
      status: "succeeded",
      request: { kind: "image", prompt: "Coin", model: { provider: "midjourney" }, outputCount: 4 },
      target: { boardId: "main", nodeId: "coin", fingerprint: "any" },
      outputs: files.map((file) => ({
        path: `canvas/staging/${id}/${file}`,
        type: "image",
        sizeBytes: 3,
        sha256: "a".repeat(64),
      })),
    });
  };
  const first = await adoptGeneration(f.bb, game, run("run-1", ["a.png", "b.png"]));
  const node = async () =>
    (await get.execute({ bb: f.bb }, { gameId: game.id })).boards[0]!.board.nodes[0]!;
  const [a, b] = first.candidateAssetIds;
  assert.deepEqual((await node()).data, {
    prompt: "Coin",
    assetId: "old",
    takes: [
      { assetId: "old", jobId: "" },
      { assetId: a, jobId: "run-1" },
      { assetId: b, jobId: "run-1" },
    ],
    generationJobId: "run-1",
  });
  // The user shortlists b and picks it, then rerolls.
  const picked = await get.execute({ bb: f.bb }, { gameId: game.id });
  const board = picked.boards[0]!;
  await saveBoard.execute(
    { bb: f.bb },
    {
      gameId: game.id,
      revision: board.revision,
      board: {
        ...board.board,
        nodes: [
          {
            ...board.board.nodes[0]!,
            data: {
              ...board.board.nodes[0]!.data,
              assetId: b!,
              takes: [
                { assetId: "old", jobId: "" },
                { assetId: a!, jobId: "run-1" },
                { assetId: b!, jobId: "run-1", star: true },
              ],
            },
          },
        ],
      },
    },
  );
  const second = await adoptGeneration(f.bb, game, run("run-2", ["c.png"]));
  const after = await node();
  assert.equal(after.data.assetId, b);
  assert.deepEqual(after.data.takes, [
    { assetId: "old", jobId: "" },
    { assetId: a, jobId: "run-1" },
    { assetId: b, jobId: "run-1", star: true },
    { assetId: second.candidateAssetIds[0], jobId: "run-2" },
  ]);
  assert.equal((await adoptGeneration(f.bb, game, run("run-2", ["c.png"]))).attached, true);
  assert.equal(((await node()).data.takes as unknown[]).length, 4);
});

for (const referenceType of ["library", "node"] as const) {
  for (const change of [
    "replace-reference",
    "remove-reference",
    "add-unrelated",
    "replace-bytes",
    "remove-bytes",
    "restore-bytes",
    "legacy-job",
  ] as const) {
    test(`generation attachment follows ${referenceType} inputs after ${change}`, async () => {
      const { adoptGeneration } = await import("./studio.ts");
      const { canvasRequest } = await import("./canvas-generation.ts");
      const { gameSchema, workspaceSchema } = await import("../../shared/schema.ts");
      const { generationJob } = await import("../../shared/generation.ts");
      const { captureCanvasInputs } = await import("./generation-inputs.ts");
      const f = fake(),
        game = gameSchema.parse(await create.execute({ bb: f.bb }, input));
      const sourcePath = "canvas/staging/reference/brass.png";
      const replacementPath = "canvas/staging/reference/silver.png";
      f.seed("host", `/games/orbit/${sourcePath}`, "brass", "base64");
      f.seed("host", `/games/orbit/${replacementPath}`, "silver", "base64");
      const manifest = {
        version: 1,
        assets: { reference: { name: "Key reference", path: sourcePath } },
      };
      f.seed("host", "/games/orbit/canvas/assets.json", JSON.stringify(manifest));
      const original = (await get.execute({ bb: f.bb }, { gameId: game.id })).boards[0]!;
      const references =
        referenceType === "library"
          ? [{ type: "library", assetId: "reference" }]
          : [{ type: "node", nodeId: "reference-node" }];
      await saveBoard.execute(
        { bb: f.bb },
        {
          gameId: game.id,
          revision: original.revision,
          board: {
            ...original.board,
            nodes: [
              {
                id: "image",
                type: "image",
                title: "Key variation",
                position: { x: 600, y: 200 },
                data: { prompt: "Add a crescent-shaped handle", references },
              },
              {
                id: "reference-node",
                type: "image",
                title: "Key reference",
                position: { x: 200, y: 200 },
                data: { assetId: "reference" },
              },
            ],
          },
        },
      );
      const workspace = workspaceSchema.parse(await get.execute({ bb: f.bb }, { gameId: game.id }));
      const prepared = canvasRequest(workspace, {
        gameId: game.id,
        boardId: "main",
        nodeId: "image",
        revision: workspace.boards[0]!.revision,
        requestId: "reference-generation",
      });
      const request =
        change === "legacy-job" ? prepared : await captureCanvasInputs(f.bb, game, prepared);
      assert.equal(request.request.kind, "image");
      if (request.request.kind !== "image") throw new Error("Expected an image request");
      if (change === "legacy-job") assert.deepEqual(request.request.images, [sourcePath]);
      else {
        assert.match(request.request.images[0]!, /^canvas\/inputs\/[a-f0-9]{64}\.png$/);
        assert.equal(f.contents("host", `/games/orbit/${request.request.images[0]!}`), "brass");
      }
      if (change === "replace-reference") manifest.assets.reference.path = replacementPath;
      else if (change === "remove-reference") Reflect.deleteProperty(manifest.assets, "reference");
      else if (change === "add-unrelated")
        Object.assign(manifest.assets, { unrelated: { name: "Other key", path: replacementPath } });
      else if (change === "replace-bytes" || change === "restore-bytes") {
        f.seed("host", `/games/orbit/${sourcePath}`, "silver", "base64");
        assert.equal(f.contents("host", `/games/orbit/${request.request.images[0]!}`), "brass");
        if (change === "restore-bytes")
          f.seed("host", `/games/orbit/${sourcePath}`, "brass", "base64");
      } else if (change === "remove-bytes") f.remove("host", `/games/orbit/${sourcePath}`);
      f.seed("host", "/games/orbit/canvas/assets.json", JSON.stringify(manifest));
      const path = "canvas/staging/reference-generation/key.png";
      f.seed("host", `/games/orbit/${path}`, "output", "base64");
      const job = generationJob.parse({
        version: 1,
        id: "reference-generation",
        threadId: "thread",
        createdAt: 1,
        updatedAt: 2,
        status: "succeeded",
        ...request,
        outputs: [{ path, type: "image", sizeBytes: 6, sha256: "a".repeat(64) }],
      });
      const adopted = await adoptGeneration(f.bb, game, job);
      // Takes record what each run produced, so changed references never discard the output.
      assert.equal(adopted.attached, true);
      const final = await get.execute({ bb: f.bb }, { gameId: game.id });
      const generated = final.assets.find((asset) => asset.path === path);
      assert.equal(generated?.id, adopted.candidateAssetIds[0]);
      assert.equal(generated?.type, "image");
      const expectedReferencePath = {
        "replace-reference": replacementPath,
        "remove-reference": undefined,
        "add-unrelated": sourcePath,
        "replace-bytes": sourcePath,
        "remove-bytes": sourcePath,
        "restore-bytes": sourcePath,
        "legacy-job": sourcePath,
      }[change];
      assert.equal(
        final.assets.find((asset) => asset.id === "reference")?.path,
        expectedReferencePath,
      );
      const target = final.boards[0]!.board.nodes.find((node) => node.id === "image")!;
      assert.equal(target.data.prompt, "Add a crescent-shaped handle");
      assert.deepEqual(target.data.references, references);
      assert.equal(target.data.assetId, generated!.id);
      assert.deepEqual(target.data.takes, [
        { assetId: generated!.id, jobId: "reference-generation" },
      ]);
      assert.equal(
        final.boards[0]!.board.nodes.find((node) => node.id === "reference-node")!.data.assetId,
        "reference",
      );
    });
  }
}

test("a generation status service outage preserves the workspace and marks pending jobs uncertain", async () => {
  const f = fake(),
    game = await create.execute({ bb: f.bb }, input);
  f.seed(
    "host",
    "/games/orbit/canvas/jobs/pending.json",
    JSON.stringify({
      version: 1,
      id: "pending",
      threadId: "thread",
      createdAt: 1,
      updatedAt: 1,
      status: "running",
      request: { kind: "image", prompt: "A key", model: { provider: "google" } },
      outputs: [],
    }),
  );
  const workspace = await get.execute(
    {
      bb: f.bb,
      generations: {
        list: async () => {
          throw new Error("Host unavailable");
        },
      } as never,
    },
    { gameId: game.id },
  );
  assert.equal(workspace.game.id, game.id);
  assert.equal(workspace.boards[0]!.board.id, "main");
  assert.equal(workspace.generationJobs![0]!.status, "uncertain");
  assert.match(workspace.generationJobs![0]!.detail!, /Could not refresh/);
});

test("a BB-written brief replaces the media node's prompt and keeps its output", async () => {
  const { adoptGeneration } = await import("./studio.ts");
  const { canvasRequest } = await import("./canvas-generation.ts");
  const { gameSchema, workspaceSchema } = await import("../../shared/schema.ts");
  const { generationJob } = await import("../../shared/generation.ts");
  const f = fake(),
    game = gameSchema.parse(await create.execute({ bb: f.bb }, input));
  const original = (await get.execute({ bb: f.bb }, { gameId: game.id })).boards[0]!;
  await saveBoard.execute(
    { bb: f.bb },
    {
      gameId: game.id,
      revision: original.revision,
      board: {
        ...original.board,
        nodes: [
          {
            id: "shot",
            type: "video",
            position: { x: 300, y: 200 },
            data: { prompt: "coin spins", recipe: "fal-video", generationJobId: "earlier" },
          },
        ],
      },
    },
  );
  const workspace = workspaceSchema.parse(await get.execute({ bb: f.bb }, { gameId: game.id }));
  const request = canvasRequest(workspace, {
    gameId: game.id,
    boardId: "main",
    nodeId: "shot",
    revision: workspace.boards[0]!.revision,
    requestId: "brief-run",
    brief: true,
  });
  assert.equal(request.request.kind === "text" && request.request.briefFor, "fal-video");
  const path = "canvas/staging/brief-run/output.md";
  f.seed("host", `/games/orbit/${path}`, "A gold coin spins on black velvet. [Truck left]");
  const job = generationJob.parse({
    version: 1,
    id: "brief-run",
    threadId: null,
    origin: { kind: "canvas", gameId: game.id },
    createdAt: 1,
    updatedAt: 2,
    status: "succeeded",
    ...request,
    outputs: [{ path, type: "text", sizeBytes: 47, sha256: "a".repeat(64) }],
  });
  assert.equal((await adoptGeneration(f.bb, game, job)).attached, true);
  const node = (await get.execute({ bb: f.bb }, { gameId: game.id })).boards[0]!.board.nodes[0]!;
  assert.deepEqual(node.data, {
    prompt: "A gold coin spins on black velvet. [Truck left]",
    recipe: "fal-video",
    generationJobId: "earlier",
    briefJobId: "brief-run",
  });
  assert.equal((await adoptGeneration(f.bb, game, job)).attached, true);
});
test("generated text returns to its node without cataloging media or changing layout, and keeps newer drafts", async () => {
  const { adoptGeneration } = await import("./studio.ts");
  const { canvasRequest } = await import("./canvas-generation.ts");
  const { gameSchema, workspaceSchema } = await import("../../shared/schema.ts");
  const { generationJob } = await import("../../shared/generation.ts");
  const f = fake(),
    game = gameSchema.parse(await create.execute({ bb: f.bb }, input));
  const original = (await get.execute({ bb: f.bb }, { gameId: game.id })).boards[0]!;
  await saveBoard.execute(
    { bb: f.bb },
    {
      gameId: game.id,
      revision: original.revision,
      board: {
        ...original.board,
        nodes: [
          {
            id: "text",
            type: "text",
            position: { x: 300, y: 200 },
            data: { instruction: "Write key lore", text: "Original" },
          },
        ],
      },
    },
  );
  const workspace = workspaceSchema.parse(await get.execute({ bb: f.bb }, { gameId: game.id }));
  const request = canvasRequest(workspace, {
    gameId: game.id,
    boardId: "main",
    nodeId: "text",
    revision: workspace.boards[0]!.revision,
    requestId: "text-run",
  });
  const path = "canvas/staging/text-run/output.md";
  f.seed("host", `/games/orbit/${path}`, "A brass key to the observatory.");
  const layout = f.contents("host", "/games/orbit/canvas/editor/main.json");
  const job = generationJob.parse({
    version: 1,
    id: "text-run",
    threadId: null,
    origin: { kind: "canvas", gameId: game.id },
    createdAt: 1,
    updatedAt: 2,
    status: "succeeded",
    ...request,
    outputs: [{ path, type: "text", sizeBytes: 30, sha256: "a".repeat(64) }],
  });
  assert.equal((await adoptGeneration(f.bb, game, job)).attached, true);
  const updated = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.equal(updated.boards[0]!.board.nodes[0]!.data.text, "A brass key to the observatory.");
  assert.equal(
    updated.assets.some((asset) => asset.type !== "file"),
    false,
  );
  assert.equal(f.contents("host", "/games/orbit/canvas/editor/main.json"), layout);
  const edited = {
    ...updated.boards[0]!.board,
    nodes: [
      {
        ...updated.boards[0]!.board.nodes[0]!,
        data: { instruction: "Write key lore", text: "My newer draft" },
      },
    ],
  };
  await saveBoard.execute(
    { bb: f.bb },
    { gameId: game.id, revision: updated.boards[0]!.revision, board: edited },
  );
  assert.equal((await adoptGeneration(f.bb, game, job)).attached, false);
  const final = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.equal(final.boards[0]!.board.nodes[0]!.data.text, "My newer draft");
});

test("a review joins the node's reviews once and never touches its outputs", async () => {
  const { adoptGeneration } = await import("./studio.ts");
  const { gameSchema } = await import("../../shared/schema.ts");
  const { generationJob } = await import("../../shared/generation.ts");
  const f = fake(),
    game = gameSchema.parse(await create.execute({ bb: f.bb }, input));
  const original = (await get.execute({ bb: f.bb }, { gameId: game.id })).boards[0]!;
  const data = {
    prompt: "Coin",
    assetId: "coin-a",
    takes: [{ assetId: "coin-a", jobId: "run-1" }],
  };
  await saveBoard.execute(
    { bb: f.bb },
    {
      gameId: game.id,
      revision: original.revision,
      board: {
        ...original.board,
        nodes: [{ id: "coin", type: "image", position: { x: 0, y: 0 }, data }],
      },
    },
  );
  f.seed(
    "host",
    "/games/orbit/canvas/staging/run-1-review/output.md",
    "**Fail** — the rim is cut off.",
  );
  const review = generationJob.parse({
    version: 1,
    id: "run-1-review",
    threadId: null,
    origin: { kind: "canvas", gameId: game.id },
    createdAt: 1,
    updatedAt: 2,
    status: "succeeded",
    request: { kind: "text", prompt: "Review", reviewOf: ["coin-a"] },
    target: { boardId: "main", nodeId: "coin", fingerprint: "stale" },
    outputs: [
      {
        path: "canvas/staging/run-1-review/output.md",
        type: "text",
        sizeBytes: 3,
        sha256: "a".repeat(64),
      },
    ],
  });
  const node = async () =>
    (await get.execute({ bb: f.bb }, { gameId: game.id })).boards[0]!.board.nodes[0]!;
  // A stale fingerprint does not matter: a review judges outputs, not the current brief.
  assert.equal((await adoptGeneration(f.bb, game, review)).attached, true);
  assert.equal((await adoptGeneration(f.bb, game, review)).attached, true);
  assert.deepEqual((await node()).data, {
    ...data,
    reviews: [
      { assetIds: ["coin-a"], jobId: "run-1-review", text: "**Fail** — the rim is cut off." },
    ],
  });
});

test("a judgement makes its choice the pick unless the pick changed while it ran", async () => {
  const { adoptGeneration } = await import("./studio.ts");
  const { gameSchema } = await import("../../shared/schema.ts");
  const { generationJob } = await import("../../shared/generation.ts");
  const f = fake(),
    game = gameSchema.parse(await create.execute({ bb: f.bb }, input));
  const takes = [
    { assetId: "coin-a", jobId: "run-1" },
    { assetId: "coin-b", jobId: "run-2" },
  ];
  const seedNode = async (assetId: string) => {
    const original = (await get.execute({ bb: f.bb }, { gameId: game.id })).boards[0]!;
    await saveBoard.execute(
      { bb: f.bb },
      {
        gameId: game.id,
        revision: original.revision,
        board: {
          ...original.board,
          nodes: [
            { id: "coin", type: "image", position: { x: 0, y: 0 }, data: { assetId, takes } },
          ],
        },
      },
    );
  };
  const judge = (id: string) => {
    f.seed("host", `/games/orbit/canvas/staging/${id}/output.md`, "**Pick: Candidate 2** — rim.");
    return generationJob.parse({
      version: 1,
      id,
      threadId: null,
      origin: { kind: "canvas", gameId: game.id },
      createdAt: 1,
      updatedAt: 2,
      status: "succeeded",
      request: {
        kind: "text",
        prompt: "Judge",
        judgeOf: ["coin-a", "coin-b"],
        judgePick: "coin-a",
      },
      target: { boardId: "main", nodeId: "coin", fingerprint: "stale" },
      outputs: [
        {
          path: `canvas/staging/${id}/output.md`,
          type: "text",
          sizeBytes: 3,
          sha256: "a".repeat(64),
        },
      ],
    });
  };
  const node = async () =>
    (await get.execute({ bb: f.bb }, { gameId: game.id })).boards[0]!.board.nodes[0]!;
  await seedNode("coin-a");
  assert.equal((await adoptGeneration(f.bb, game, judge("run-2-judge"))).attached, true);
  assert.equal((await adoptGeneration(f.bb, game, judge("run-2-judge"))).attached, true);
  const judged = await node();
  assert.equal(judged.data.assetId, "coin-b");
  assert.deepEqual(judged.data.judgements, [
    {
      assetIds: ["coin-a", "coin-b"],
      jobId: "run-2-judge",
      text: "**Pick: Candidate 2** — rim.",
      choice: "coin-b",
      applied: true,
    },
  ]);
  // Someone picked by hand while the next judge ran, so their pick stands.
  await seedNode("coin-b");
  await adoptGeneration(f.bb, game, judge("run-3-judge"));
  const kept = await node();
  assert.equal(kept.data.assetId, "coin-b");
  assert.equal((kept.data.judgements as { applied: boolean }[]).at(-1)?.applied, false);
});
