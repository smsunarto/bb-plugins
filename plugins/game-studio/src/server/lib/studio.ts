import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  assetSchema,
  boardSchema,
  gameSchema,
  indexSchema,
  evidenceRunSchema,
  nodeSchema,
  unityRequestSchema,
  type Asset,
  type Board,
  type CanvasNode,
  type Game,
  type Workspace,
  type EvidenceRun,
  type UnityRequest,
  type attachGameInput,
  type createBoardInput,
  type createDocumentInput,
  type createGameInput,
  type promptInput,
  type recordRequestInput,
  type saveBoardInput,
  type saveDocumentInput,
  type updateGameInput,
  type uploadAssetInput,
  type inspectUnityInput,
} from "../../shared/schema.ts";
import { files as instructions } from "./instructions.ts";
import { absoluteRoot, pathTools, projectFile, relativeFile } from "./paths.ts";
import { starterHtml } from "./starter.ts";

type Index = z.infer<typeof indexSchema>;
type File = Awaited<ReturnType<BbPluginApi["sdk"]["files"]["read"]>>;
const prefix = "game:";
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const queues = new WeakMap<BbPluginApi, Map<string, Promise<unknown>>>();
const layoutSchema = boardSchema.shape.editorLayout;
const persistedBoardSchema = boardSchema.omit({ editorLayout: true }).extend({
  nodes: z.array(nodeSchema.omit({ position: true, width: true, height: true })).max(2000),
});
const manifestSchema = z.object({
  version: z.literal(1),
  assets: z.record(z.string(), z.object({ name: z.string(), path: z.string() }).passthrough()),
});
const boardRevisionSchema = z.object({ content: z.string(), layout: z.string().nullable() });
const evidenceManifestSchema = z.object({
  version: z.literal(1),
  runs: z
    .array(
      evidenceRunSchema.extend({ files: z.array(z.string().min(1).max(1000)).min(1).max(100) }),
    )
    .max(1000),
});

async function serialized<T>(bb: BbPluginApi, key: string, work: () => Promise<T>): Promise<T> {
  let active = queues.get(bb);
  if (!active) {
    active = new Map();
    queues.set(bb, active);
  }
  const previous = active.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  active.set(key, next);
  try {
    return await next;
  } finally {
    if (active.get(key) === next) active.delete(key);
  }
}

function locationId(hostId: string, rootPath: string): string {
  const paths = pathTools(rootPath);
  const normalized = paths.normalize(rootPath).replace(/[\\/]+$/, "");
  const root = paths.sep === "\\" ? normalized.toLowerCase() : normalized;
  return createHash("sha256").update(`${hostId}\0${root}`).digest("hex").slice(0, 32);
}

function args(game: Pick<Game, "hostId" | "rootPath">, path: string) {
  return { hostId: game.hostId, rootPath: game.rootPath, path: projectFile(game.rootPath, path) };
}

function missing(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/ENOENT|no such file or directory/i.test(error.message) ||
      ("code" in error && error.code === "ENOENT"))
  );
}

async function readOptional(
  bb: BbPluginApi,
  game: Pick<Game, "hostId" | "rootPath">,
  path: string,
): Promise<File | null> {
  try {
    return await bb.sdk.files.read(args(game, path));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function text(file: File, path: string): string {
  if (file.contentEncoding !== "utf8") throw new Error(`${path} must be a UTF-8 text file.`);
  return file.content;
}

async function readRequired(bb: BbPluginApi, game: Game, path: string): Promise<File> {
  const file = await readOptional(bb, game, path);
  if (!file)
    throw new Error(`${path} is missing from this game. Restore the file before reopening it.`);
  return file;
}

function parse<T>(schema: z.ZodType<T>, file: File, path: string): T {
  try {
    return schema.parse(JSON.parse(text(file, path)));
  } catch (cause) {
    throw new Error(
      `${path} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

async function write(
  bb: BbPluginApi,
  game: Pick<Game, "hostId" | "rootPath">,
  path: string,
  content: string,
  expectedSha256: string | null,
  encoding: "utf8" | "base64" = "utf8",
): Promise<string> {
  const result = await bb.sdk.files.write({
    ...args(game, path),
    content,
    contentEncoding: encoding,
    expectedSha256,
    createParents: true,
  });
  if (result.outcome !== "written") {
    throw new Error(
      `${path} changed on disk. Reload the workspace before saving again; your newer disk file was preserved.`,
    );
  }
  return result.sha256;
}

async function initializeFile(
  bb: BbPluginApi,
  game: Pick<Game, "hostId" | "rootPath">,
  path: string,
  content: string,
): Promise<void> {
  const result = await bb.sdk.files.write({
    ...args(game, path),
    content,
    contentEncoding: "utf8",
    expectedSha256: null,
    createParents: true,
  });
  // Retrying initialization only fills missing files. Existing project content always wins.
  if (result.outcome === "conflict") await bb.sdk.files.read(args(game, path));
}

function emptyBoard(id: string, name: string): Board {
  return {
    version: 1,
    id,
    name,
    viewport: { width: 1280, height: 720 },
    nodes: [],
    edges: [],
    editorLayout: { version: 1, view: "canvas", nodes: {}, viewport: { x: 64, y: 32, zoom: 1 } },
  };
}

function splitBoard(board: Board) {
  const { editorLayout, ...rest } = board;
  const nodes = board.nodes.map(
    ({ position: _position, width: _width, height: _height, ...node }) => node,
  );
  const layout = {
    ...editorLayout,
    nodes: Object.fromEntries(
      board.nodes.map((node) => [
        node.id,
        {
          ...node.position,
          ...(node.width === undefined ? {} : { width: node.width }),
          ...(node.height === undefined ? {} : { height: node.height }),
        },
      ]),
    ),
  };
  return { content: { ...rest, nodes }, layout };
}

function checkIndex(index: Index): Index {
  for (const entries of [index.boards, index.documents, index.tables ?? []]) {
    if (new Set(entries.map(({ id }) => id)).size !== entries.length)
      throw new Error("canvas/index.json contains duplicate IDs.");
  }
  if (index.mainDocumentId && !index.documents.some(({ id }) => id === index.mainDocumentId)) {
    throw new Error("canvas/index.json refers to an unknown main document.");
  }
  return index;
}

function checkBoard(board: Board): void {
  const ids = new Set(board.nodes.map(({ id }) => id));
  if (ids.size !== board.nodes.length) throw new Error("The board contains duplicate node IDs.");
  if (new Set(board.edges.map(({ id }) => id)).size !== board.edges.length)
    throw new Error("The board contains duplicate edge IDs.");
  if (board.edges.some(({ source, target }) => !ids.has(source) || !ids.has(target))) {
    throw new Error("An edge refers to a missing board node.");
  }
}

async function readIndex(bb: BbPluginApi, game: Game): Promise<{ index: Index; revision: string }> {
  const file = await readRequired(bb, game, "canvas/index.json");
  return {
    index: checkIndex(parse(indexSchema, file, "canvas/index.json")),
    revision: file.sha256,
  };
}

async function initializeCanvas(
  bb: BbPluginApi,
  game: Pick<Game, "hostId" | "rootPath" | "name" | "kind">,
  starter: boolean,
): Promise<void> {
  if (await readOptional(bb, game, "canvas/index.json")) return;
  const board = splitBoard(emptyBoard("main", "Design board"));
  await initializeFile(bb, game, "canvas/boards/main.json", json(board.content));
  await initializeFile(bb, game, "canvas/editor/main.json", json(board.layout));
  await initializeFile(
    bb,
    game,
    "canvas/documents/design.md",
    `# ${game.name}\n\n## Game concept\n\n## Player experience\n\n## Visual direction\n\n## Asset inventory\n\n## Acceptance criteria\n`,
  );
  await initializeFile(bb, game, "canvas/assets.json", json({ version: 1, assets: {} }));
  await initializeFile(
    bb,
    game,
    game.kind === "unity" ? "canvas/AGENTS.md" : "AGENTS.md",
    `${instructions.read("workspace")}\n`,
  );
  if (starter) await initializeFile(bb, game, "index.html", starterHtml);
  // Publish the index last: interrupted initialization can safely retry the preceding creates.
  await initializeFile(
    bb,
    game,
    "canvas/index.json",
    json({
      version: 1,
      mainDocumentId: "design",
      boards: [{ id: "main", name: "Design board" }],
      documents: [{ id: "design", title: "Game design" }],
    }),
  );
}

export async function getGame(bb: BbPluginApi, gameId: string): Promise<Game> {
  const raw = await bb.storage.kv.get(`${prefix}${gameId}`);
  if (!raw)
    throw new Error(
      "This game is no longer registered. Attach its project directory to reopen it.",
    );
  return gameSchema.parse(raw);
}

export async function overview(bb: BbPluginApi) {
  const [keys, hosts, projects] = await Promise.all([
    bb.storage.kv.list(prefix),
    bb.sdk.hosts.list(),
    bb.sdk.projects.list(),
  ]);
  const games = (await Promise.all(keys.map((key) => bb.storage.kv.get(key))))
    .map((raw) => gameSchema.parse(raw))
    .sort((a, b) => b.createdAt - a.createdAt);
  return {
    games,
    hosts: hosts
      .filter((host) => host.lifecycle.phase !== "removing" && host.lifecycle.phase !== "destroyed")
      .map((host) => ({ id: host.id, name: host.name, online: host.status === "connected" })),
    projects: projects.map(({ id, name }) => ({ id, name })),
  };
}

export async function createGame(
  bb: BbPluginApi,
  input: z.infer<typeof createGameInput>,
): Promise<Game> {
  const rootPath = absoluteRoot(input.rootPath);
  const id = locationId(input.hostId, rootPath);
  return serialized(bb, id, async () => {
    const existing = await bb.storage.kv.get<Game>(`${prefix}${id}`);
    if (existing) {
      await initializeCanvas(bb, existing, existing.kind !== "unity");
      return gameSchema.parse(existing);
    }
    await bb.sdk.files.mkdir({ hostId: input.hostId, path: rootPath, recursive: true });
    await initializeCanvas(bb, { ...input, rootPath }, input.kind !== "unity");
    // A retry after project creation recovers its existing source instead of duplicating the project.
    const projects = await bb.sdk.projects.list();
    const project =
      projects.find((item) =>
        item.sources.some(
          (source) =>
            source.hostId === input.hostId && locationId(source.hostId, source.path) === id,
        ),
      ) ??
      (await bb.sdk.projects.create({
        name: input.name,
        source: { type: "local_path", hostId: input.hostId, path: rootPath },
      }));
    const game: Game = {
      ...input,
      rootPath,
      id,
      projectId: project.id,
      createdAt: Date.now(),
      threadId: null,
      previewPath: "index.html",
    };
    await bb.storage.kv.set(`${prefix}${id}`, game);
    return game;
  });
}

export async function attachGame(
  bb: BbPluginApi,
  input: z.infer<typeof attachGameInput>,
): Promise<Game> {
  const rootPath = absoluteRoot(input.rootPath);
  const id = locationId(input.hostId, rootPath);
  return serialized(bb, id, async () => {
    const project = await bb.sdk.projects.get({ projectId: input.projectId });
    if (
      !project.sources.some(
        (source) => source.hostId === input.hostId && locationId(source.hostId, source.path) === id,
      )
    ) {
      throw new Error(
        "This directory is not a source of the selected BB project. Select its matching machine and directory.",
      );
    }
    // Listing verifies the directory exists on the intended host without creating it.
    await bb.sdk.files.list({ hostId: input.hostId, path: rootPath, limit: 1 });
    if (input.kind === "unity") await unityVersion(bb, { hostId: input.hostId, rootPath }, true);
    const existing = await bb.storage.kv.get<Game>(`${prefix}${id}`);
    if (existing) {
      if (existing.projectId !== project.id)
        throw new Error("This directory is already attached to another BB project.");
      return gameSchema.parse(existing);
    }
    const game: Game = {
      id,
      rootPath,
      hostId: input.hostId,
      projectId: project.id,
      name: project.name,
      kind: input.kind ?? "general",
      createdAt: Date.now(),
      threadId: null,
      previewPath: "index.html",
    };
    await initializeCanvas(bb, game, false);
    await readIndex(bb, game);
    await bb.storage.kv.set(`${prefix}${id}`, game);
    return game;
  });
}

function assetType(path: string): Asset["type"] {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext && ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].includes(ext)) return "image";
  if (ext && ["mp4", "webm", "mov", "m4v"].includes(ext)) return "video";
  if (ext && ["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(ext)) return "audio";
  if (ext && ["glb", "gltf", "obj", "fbx", "stl", "blend"].includes(ext)) return "model";
  return "file";
}

async function assetCatalog(bb: BbPluginApi, game: Game): Promise<Asset[]> {
  const manifest = await readOptional(bb, game, "canvas/assets.json");
  const entries = manifest ? parse(manifestSchema, manifest, "canvas/assets.json").assets : {};
  const assets = Object.entries(entries).map(([id, entry]) =>
    assetSchema.parse({
      id,
      name: entry.name,
      path: relativeFile(entry.path),
      type: assetType(entry.path),
    }),
  );
  const roots = game.kind === "unity" ? ["canvas/staging", "Assets/GameStudio"] : ["assets"];
  return scanAssets(bb, game, roots, assets);
}

async function scanAssets(
  bb: BbPluginApi,
  game: Game,
  roots: string[],
  initial: Asset[] = [],
): Promise<Asset[]> {
  const assets = [...initial];
  for (const folder of roots) {
    let listing: Awaited<ReturnType<BbPluginApi["sdk"]["files"]["list"]>>;
    try {
      listing = await bb.sdk.files.list({
        hostId: game.hostId,
        path: projectFile(game.rootPath, folder),
        limit: 10000,
      });
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    if (listing.truncated) throw new Error(`${folder} exceeds the 10,000-file catalog limit.`);
    for (const file of listing.files) {
      if (file.name.endsWith(".meta")) continue;
      const path = listedPath(game.rootPath, folder, file.path);
      if (assets.some((asset) => asset.path === path)) continue;
      assets.push({
        id: createHash("sha256").update(path).digest("hex").slice(0, 32),
        name: file.name,
        path,
        type: assetType(path),
      });
    }
  }
  return assets.sort((a, b) => a.name.localeCompare(b.name));
}

function listedPath(rootPath: string, folder: string, path: string): string {
  const paths = pathTools(rootPath);
  if (paths.isAbsolute(path))
    return relativeFile(paths.relative(rootPath, path).replaceAll("\\", "/"));
  const normalized = path.replaceAll("\\", "/");
  return relativeFile(normalized.startsWith(`${folder}/`) ? normalized : `${folder}/${normalized}`);
}

async function loadBoard(
  bb: BbPluginApi,
  game: Game,
  id: string,
): Promise<{ board: Board; revision: string }> {
  const contentPath = `canvas/boards/${id}.json`;
  const layoutPath = `canvas/editor/${id}.json`;
  const [contentFile, layoutFile] = await Promise.all([
    readRequired(bb, game, contentPath),
    readOptional(bb, game, layoutPath),
  ]);
  const content = parse(persistedBoardSchema, contentFile, contentPath);
  if (content.id !== id) throw new Error(`${contentPath} has a different board ID.`);
  const layout = layoutFile
    ? parse(layoutSchema, layoutFile, layoutPath)
    : emptyBoard(id, "").editorLayout;
  const nodes = content.nodes.map((node, index) => {
    const position = layout.nodes[node.id] ?? {
      x: 96 + Math.floor(index / 3) * 560,
      y: 96 + (index % 3) * 480,
    };
    return {
      ...node,
      position: { x: position.x, y: position.y },
      ...(position.width === undefined ? {} : { width: position.width }),
      ...(position.height === undefined ? {} : { height: position.height }),
    };
  });
  const board = boardSchema.parse({ ...content, nodes, editorLayout: layout });
  checkBoard(board);
  return {
    board,
    revision: JSON.stringify({ content: contentFile.sha256, layout: layoutFile?.sha256 ?? null }),
  };
}

export async function loadWorkspace(bb: BbPluginApi, gameId: string): Promise<Workspace> {
  const game = await getGame(bb, gameId);
  const { index, revision: indexRevision } = await readIndex(bb, game);
  const [boards, documents, assets, captures, requests] = await Promise.all([
    Promise.all(index.boards.map(({ id }) => loadBoard(bb, game, id))),
    Promise.all(
      index.documents.map(async ({ id, title }) => {
        const path = `canvas/documents/${id}.md`;
        const file = await readRequired(bb, game, path);
        return { id, title, markdown: text(file, path), revision: file.sha256 };
      }),
    ),
    assetCatalog(bb, game),
    scanAssets(bb, game, ["canvas/evidence"]),
    readRequests(bb, game),
  ]);
  const evidence = captures.filter(({ type }) => type === "image" || type === "video");
  const evidenceRuns = await readEvidenceRuns(bb, game, evidence);
  return {
    game,
    index,
    indexRevision,
    boards,
    documents,
    assets,
    evidence,
    evidenceRuns,
    requests,
    ...(game.kind === "unity" ? { unityVersion: await unityVersion(bb, game, false) } : {}),
  };
}

async function readRequests(bb: BbPluginApi, game: Game): Promise<UnityRequest[]> {
  const folder = "canvas/requests";
  let listing: Awaited<ReturnType<BbPluginApi["sdk"]["files"]["list"]>>;
  try {
    listing = await bb.sdk.files.list({
      hostId: game.hostId,
      path: projectFile(game.rootPath, folder),
      limit: 10000,
    });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const paths = listing.files.flatMap((file) => {
    try {
      const path = listedPath(game.rootPath, folder, file.path);
      return /^canvas\/requests\/[a-zA-Z0-9_-]{1,100}\.json$/.test(path) ? [path] : [];
    } catch {
      return [];
    }
  });
  const requests: UnityRequest[] = [];
  // Each agent owns one file. A partial progress write must not hide the workspace.
  for (let offset = 0; offset < Math.min(paths.length, 1000); offset += 20) {
    const batch = await Promise.all(
      paths.slice(offset, Math.min(offset + 20, 1000)).map(async (path) => {
        try {
          const file = await readOptional(bb, game, path);
          if (!file) return [];
          const request = parse(unityRequestSchema, file, path);
          return path === `${folder}/${request.id}.json` ? [request] : [];
        } catch {
          return [];
        }
      }),
    );
    requests.push(...batch.flat());
  }
  return requests.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).slice(0, 5);
}

async function readEvidenceRuns(
  bb: BbPluginApi,
  game: Game,
  captures: Asset[],
): Promise<EvidenceRun[]> {
  const path = "canvas/evidence/index.json";
  const file = await readOptional(bb, game, path);
  if (!file) return [];
  const manifest = parse(evidenceManifestSchema, file, path);
  if (new Set(manifest.runs.map(({ id }) => id)).size !== manifest.runs.length) {
    throw new Error(`${path} contains duplicate run IDs.`);
  }
  const known = new Map(captures.map((asset) => [asset.path, asset]));
  return manifest.runs
    .map((run) =>
      Object.assign({}, run, {
        files: run.files.map((relative) => {
          const capturePath = relativeFile(relative);
          if (!capturePath.startsWith("canvas/evidence/")) {
            throw new Error(`${path}: run ${run.id} must reference files under canvas/evidence/.`);
          }
          const asset = known.get(capturePath);
          if (!asset)
            throw new Error(
              `${path}: run ${run.id} references missing or unsupported media ${capturePath}.`,
            );
          return asset;
        }),
      }),
    )
    .sort((a, b) => b.capturedAtMs - a.capturedAtMs);
}

async function unityVersion(
  bb: BbPluginApi,
  game: Pick<Game, "hostId" | "rootPath">,
  required: boolean,
): Promise<string | null> {
  const file = await readOptional(bb, game, "ProjectSettings/ProjectVersion.txt");
  if (!file) {
    if (required)
      throw new Error(
        "Choose an existing Unity project containing ProjectSettings/ProjectVersion.txt and Assets.",
      );
    return null;
  }
  const version = /^m_EditorVersion:\s*(\S+)\s*$/m.exec(
    text(file, "ProjectSettings/ProjectVersion.txt"),
  )?.[1];
  if (!version)
    throw new Error("ProjectSettings/ProjectVersion.txt does not contain a Unity Editor version.");
  await bb.sdk.files.list({
    hostId: game.hostId,
    path: projectFile(game.rootPath, "Assets"),
    limit: 1,
  });
  return version;
}

export async function inspectUnity(bb: BbPluginApi, input: z.infer<typeof inspectUnityInput>) {
  return {
    version: await unityVersion(
      bb,
      { hostId: input.hostId, rootPath: absoluteRoot(input.rootPath) },
      false,
    ),
  };
}

export async function saveBoard(bb: BbPluginApi, input: z.infer<typeof saveBoardInput>) {
  return serialized(bb, input.gameId, async () => {
    const game = await getGame(bb, input.gameId);
    const { index } = await readIndex(bb, game);
    if (!index.boards.some(({ id }) => id === input.board.id))
      throw new Error("This board is not registered in the workspace.");
    checkBoard(input.board);
    let previous: z.infer<typeof boardRevisionSchema>;
    try {
      previous = boardRevisionSchema.parse(JSON.parse(input.revision));
    } catch {
      throw new Error("The board revision is invalid. Reload the workspace before saving.");
    }
    const current = await loadBoard(bb, game, input.board.id);
    if (current.revision !== input.revision)
      throw new Error("This board changed on disk. Reload the workspace before saving again.");
    const { content, layout } = splitBoard(input.board);
    // SDK CAS is per file. Layout first means a late content conflict never replaces external content.
    const layoutRevision = await write(
      bb,
      game,
      `canvas/editor/${input.board.id}.json`,
      json(layout),
      previous.layout,
    );
    const contentRevision = await write(
      bb,
      game,
      `canvas/boards/${input.board.id}.json`,
      json(content),
      previous.content,
    );
    return { revision: JSON.stringify({ content: contentRevision, layout: layoutRevision }) };
  });
}

export async function saveDocument(bb: BbPluginApi, input: z.infer<typeof saveDocumentInput>) {
  return serialized(bb, input.gameId, async () => {
    const game = await getGame(bb, input.gameId);
    const { index } = await readIndex(bb, game);
    if (!index.documents.some(({ id }) => id === input.documentId))
      throw new Error("This document is not registered in the workspace.");
    return {
      revision: await write(
        bb,
        game,
        `canvas/documents/${input.documentId}.md`,
        input.markdown,
        input.revision,
      ),
    };
  });
}

export async function createDocument(
  bb: BbPluginApi,
  input: z.infer<typeof createDocumentInput>,
): Promise<Workspace> {
  return serialized(bb, input.gameId, async () => {
    const game = await getGame(bb, input.gameId);
    const { index, revision } = await readIndex(bb, game);
    if (index.documents.length >= 200) throw new Error("A workspace supports up to 200 documents.");
    const id = randomUUID();
    await write(bb, game, `canvas/documents/${id}.md`, `# ${input.title}\n`, null);
    index.documents.push({ id, title: input.title });
    await write(bb, game, "canvas/index.json", json(index), revision);
    return loadWorkspace(bb, input.gameId);
  });
}

export async function createBoard(
  bb: BbPluginApi,
  input: z.infer<typeof createBoardInput>,
): Promise<Workspace> {
  return serialized(bb, input.gameId, async () => {
    const game = await getGame(bb, input.gameId);
    const { index, revision } = await readIndex(bb, game);
    if (index.boards.length >= 100) throw new Error("A workspace supports up to 100 boards.");
    const id = randomUUID();
    const { content, layout } = splitBoard(emptyBoard(id, input.name));
    await write(bb, game, `canvas/boards/${id}.json`, json(content), null);
    await write(bb, game, `canvas/editor/${id}.json`, json(layout), null);
    index.boards.push({ id, name: input.name });
    await write(bb, game, "canvas/index.json", json(index), revision);
    return loadWorkspace(bb, input.gameId);
  });
}

export async function createPreview(bb: BbPluginApi, gameId: string) {
  const game = await getGame(bb, gameId);
  const { baseUrl, expiresAtMs } = await bb.sdk.files.createPreview({
    hostId: game.hostId,
    rootPath: game.rootPath,
    ttlMs: 60 * 60 * 1000,
  });
  return { baseUrl, expiresAtMs };
}

export async function updateGame(
  bb: BbPluginApi,
  input: z.infer<typeof updateGameInput>,
): Promise<Game> {
  return serialized(bb, input.gameId, async () => {
    const game = await getGame(bb, input.gameId);
    if (input.threadId) await validateRequestThread(bb, game, input.threadId);
    const next: Game = {
      ...game,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.previewPath === undefined ? {} : { previewPath: relativeFile(input.previewPath) }),
    };
    await bb.storage.kv.set(`${prefix}${game.id}`, next);
    return next;
  });
}

async function validateRequestThread(bb: BbPluginApi, game: Game, threadId: string): Promise<void> {
  const thread = await bb.sdk.threads.get({ threadId });
  if (thread.projectId !== game.projectId)
    throw new Error("The agent thread belongs to a different BB project.");
  if (!thread.environmentId)
    throw new Error("The agent thread has no workspace. Open a thread in this game's directory.");
  const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
  if (
    environment.status === "destroyed" ||
    !environment.path ||
    locationId(environment.hostId, environment.path) !== locationId(game.hostId, game.rootPath)
  ) {
    throw new Error(
      "The agent thread uses a different machine or directory. Open a thread in this game's exact workspace.",
    );
  }
}

export async function recordRequest(
  bb: BbPluginApi,
  input: z.infer<typeof recordRequestInput>,
): Promise<UnityRequest> {
  return serialized(bb, input.gameId, async () => {
    const game = await getGame(bb, input.gameId);
    await validateRequestThread(bb, game, input.threadId);
    const path = `canvas/requests/${input.request.id}.json`;
    await initializeFile(
      bb,
      game,
      path,
      json({ ...input.request, threadId: input.threadId, status: input.status }),
    );
    const current = parse(unityRequestSchema, await readRequired(bb, game, path), path);
    if (
      current.id !== input.request.id ||
      current.action !== input.request.action ||
      current.createdAt !== input.request.createdAt ||
      current.threadId !== input.threadId
    ) {
      throw new Error("The request progress file belongs to a different request or agent thread.");
    }
    return current;
  });
}

export async function uploadAsset(
  bb: BbPluginApi,
  input: z.infer<typeof uploadAssetInput>,
): Promise<Asset> {
  return serialized(bb, input.gameId, async () => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content)) {
      throw new Error("The upload is not valid base64.");
    }
    if (Buffer.byteLength(input.content, "base64") > 20 * 1024 * 1024)
      throw new Error("Assets must be 20 MB or smaller.");
    if (/[\\/\0]/.test(input.name) || input.name === "." || input.name === "..")
      throw new Error("Use a filename without directory separators.");
    const game = await getGame(bb, input.gameId);
    const id = randomUUID();
    const filename = input.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${game.kind === "unity" ? "canvas/staging" : "assets"}/${id}-${filename}`;
    const manifestFile = await readOptional(bb, game, "canvas/assets.json");
    const manifest = manifestFile
      ? parse(manifestSchema, manifestFile, "canvas/assets.json")
      : { version: 1 as const, assets: {} as z.infer<typeof manifestSchema>["assets"] };
    if (Object.keys(manifest.assets).length >= 10000)
      throw new Error("The workspace supports up to 10,000 catalog assets.");
    await write(bb, game, path, input.content, null, "base64");
    manifest.assets[id] = { name: input.name, path };
    // A concurrent manifest edit rejects; the uploaded file remains discoverable under assets/.
    await write(bb, game, "canvas/assets.json", json(manifest), manifestFile?.sha256 ?? null);
    return { id, name: input.name, path, type: assetType(path) };
  });
}

function requestBrief(node: CanvasNode | undefined): string {
  const brief = node?.data.prompt ?? node?.description ?? node?.data.text;
  if (typeof brief !== "string" || !brief.trim()) return "";
  return instructions.read("requests/brief", { brief: brief.trim() });
}

function unitySetupLabels(setup: Game["unitySetup"]) {
  return {
    unityVersion: setup?.version ?? instructions.read("requests/unity-choice").trim(),
    unityTemplate: setup
      ? instructions.read(`requests/unity-templates/${setup.template}`).trim()
      : instructions.read("requests/unity-choice").trim(),
  };
}

export async function prompt(bb: BbPluginApi, input: z.infer<typeof promptInput>) {
  const workspace = await loadWorkspace(bb, input.gameId);
  const target = input.nodeId
    ? workspace.boards.find(({ board }) => board.nodes.some(({ id }) => id === input.nodeId))
    : workspace.boards[0];
  const node = input.nodeId ? target?.board.nodes.find(({ id }) => id === input.nodeId) : undefined;
  if (input.nodeId && !node)
    throw new Error("The selected canvas node no longer exists. Reload the workspace.");
  const recipe = input.action === "asset" ? input.recipe : undefined;
  const descriptor = { id: randomUUID(), action: input.action, createdAt: Date.now() };
  const requestPath = `canvas/requests/${descriptor.id}.json`;
  const unitySetup = unitySetupLabels(workspace.game.unitySetup);
  const request = instructions
    .read(recipe ? `requests/generation/${recipe}` : `requests/${input.action}`, {
      title: node?.title?.trim() || node?.id || workspace.game.name,
      board:
        target?.board.name ||
        workspace.index.boards.find(({ id }) => id === target?.board.id)?.name ||
        "",
      brief: requestBrief(node),
      ...unitySetup,
    })
    .replace(/\n{3,}/g, "\n\n");
  const references = {
    hostId: workspace.game.hostId,
    rootPath: workspace.game.rootPath,
    request: descriptor,
    requestPath,
    ...(input.action === "new-unity" && workspace.game.unitySetup
      ? { unitySetup: workspace.game.unitySetup }
      : {}),
    ...(workspace.index.mainDocumentId
      ? { documentPath: `canvas/documents/${workspace.index.mainDocumentId}.md` }
      : {}),
    ...(target ? { boardPath: `canvas/boards/${target.board.id}.json` } : {}),
    ...(node ? { nodeId: node.id } : {}),
    ...(recipe ? { generationRequest: { recipe, outputCount: 1 } } : {}),
  };
  return {
    prompt: `${request}\n\n${instructions.read("requests/progress")}\n\n\`\`\`json\n${JSON.stringify(references, null, 2)}\n\`\`\``,
    context: [
      instructions.read("workspace"),
      instructions.read("request-progress"),
      instructions.read(input.action, unitySetup),
      ...(recipe ? [instructions.read(`generation/${recipe}`)] : []),
    ].join("\n\n"),
    request: descriptor,
  };
}
