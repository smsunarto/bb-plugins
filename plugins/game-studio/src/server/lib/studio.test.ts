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
      sha256: createHash("sha256").update(`${contentEncoding}:${content}`).digest("hex"),
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
  const bb = {
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
  const payload = result.prompt.match(/```json\n([\s\S]+)\n```$/)?.[1];
  const { request, requestPath, ...references } = JSON.parse(payload ?? "null");
  assert.deepEqual(references, {
    gameId: game.id,
    hostId: "host",
    rootPath: "/games/orbit",
    documentPath: "canvas/documents/design.md",
    boardPath: "canvas/boards/main.json",
    nodeId: "sprite",
    generationRequest: { recipe: "concept-art", outputCount: 4 },
  });
  assert.deepEqual(request, result.request);
  assert.equal(request.action, "asset");
  assert.match(request.id, /^[a-f0-9-]{36}$/);
  assert.equal(requestPath, `canvas/requests/${request.id}.json`);
  assert.match(result.context, /scott-engineering:game-dev/);
  assert.match(result.context, /Concept art · Midjourney/);
  assert.doesNotMatch(
    result.prompt,
    /scott-engineering:game-dev|authoring claim|selectedNode|position/,
  );
  await assert.rejects(
    async () =>
      prompt.execute({ bb: f.bb }, { gameId: game.id, action: "asset", nodeId: "missing" }),
    /no longer exists/,
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
  const payload = JSON.parse(result.prompt.match(/```json\n([\s\S]+)\n```$/)![1]!);
  assert.deepEqual(payload.unitySetup, { version: "6000.3.4f1", template: "2d-urp" });
  assert.match(result.prompt, /Editor version: 6000\.3\.4f1\. Template: 2D URP\./);
  assert.match(result.context, /Requested Editor: 6000\.3\.4f1\./);
  assert.match(result.context, /Requested template: 2D URP\./);
  assert.equal(payload.request.action, "new-unity");
  assert.equal(payload.request.id, result.request.id);
  assert.equal(f.writes.length, writeCount);
  assert.deepEqual((await get.execute({ bb: f.bb }, { gameId: game.id })).requests, []);
  const followup = await prompt.execute({ bb: f.bb }, { gameId: game.id, action: "build" });
  const references = JSON.parse(followup.prompt.match(/```json\n([\s\S]+)\n```$/)![1]!);
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
  const stale = await adoptGeneration(f.bb, game, job);
  assert.equal(stale.attached, false);
  const final = await get.execute({ bb: f.bb }, { gameId: game.id });
  assert.equal(final.boards[0]!.board.nodes[0]!.data.prompt, "A silver key");
  assert.equal(final.boards[0]!.board.nodes[0]!.data.assetId, undefined);
  assert.equal(final.assets.find((asset) => asset.path === path)?.id, adopted.candidateAssetIds[0]);
});

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
