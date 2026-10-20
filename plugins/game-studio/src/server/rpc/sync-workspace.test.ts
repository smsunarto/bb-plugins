import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { nodeDisk } from "../../host/canvas.ts";
import { canvasHostRouter } from "../../../test/canvas-host.ts";
import { workspaceChangedChannel } from "../../shared/canvas-contract.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
const board = `${JSON.stringify({ version: 1, id: "main", viewport: { width: 1280, height: 720 }, nodes: [], edges: [] })}\n`;

/** The server plugin over a real game directory, whose host runs in-process. */
async function studio({ partBytes }: { partBytes?: number } = {}) {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), "studio-sync-")));
  const seed = async (path: string, content: string) => {
    await mkdir(dirname(join(rootPath, path)), { recursive: true });
    await writeFile(join(rootPath, path), content);
  };
  await seed(
    "canvas/index.json",
    JSON.stringify({
      version: 1,
      mainDocumentId: "design",
      boards: [{ id: "main", name: "Design board" }],
      documents: [{ id: "design", title: "Design" }],
    }),
  );
  await seed("canvas/boards/main.json", board);
  await seed("canvas/documents/design.md", "# Orbit\n");
  const canvas = canvasHostRouter(() => nodeDisk, undefined, partBytes ? { partBytes } : {});
  const reads: { since?: string; status: string }[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      if (!canvas.handles(method)) throw new Error(`Unexpected host call: ${method}`);
      const output = await canvas.call(method, input, hostId);
      if (method === "readCanvas")
        reads.push({
          ...((input as { since?: string }).since
            ? { since: (input as { since: string }).since }
            : {}),
          status: (output as { status: string }).status,
        });
      return output;
    },
  });
  await plugin(bb);
  await bb.storage.kv.set("game:orbit", {
    id: "orbit",
    name: "Orbit",
    projectId: "project",
    hostId: "host",
    rootPath,
    kind: "general",
    createdAt: 0,
    threadId: null,
  });
  cleanups.push(async () => {
    await harness.lifecycle.dispose();
    await rm(rootPath, { recursive: true, force: true });
  });
  const hostCalls = () => harness.inspection.experimental_hostRpcCalls.map(({ method }) => method);
  const fileCalls = () =>
    harness.inspection.sdk.calls.filter(({ path }) => path.startsWith("files."));
  return { rootPath, seed, harness, reads, hostCalls, fileCalls };
}

type Synced = {
  status: string;
  fingerprint: string;
  workspace?: { boards: { revision: string }[] };
};

test("a studio's read is one host call, and an unchanged workspace returns only its fingerprint", async () => {
  const f = await studio();
  const first = (await f.harness.behavior.callRpc("syncWorkspace", { gameId: "orbit" })) as Synced;
  expect(first.status).toBe("changed");
  expect(first.workspace?.boards[0]?.revision).toBe(
    JSON.stringify({ content: sha256(board), layout: null }),
  );
  expect(f.hostCalls()).toEqual(["readCanvas"]);
  expect(f.harness.inspection.experimental_hostRpcCalls[0]?.input).toMatchObject({
    watch: { gameId: "orbit" },
  });

  const second = (await f.harness.behavior.callRpc("syncWorkspace", {
    gameId: "orbit",
    since: first.fingerprint,
  })) as Synced;
  expect(second).toEqual({ status: "unchanged", fingerprint: first.fingerprint });
  // The server sent the host the canvas it kept, and the host had nothing to add.
  expect(f.reads).toEqual([
    { status: "changed" },
    { since: f.reads[1]!.since!, status: "unchanged" },
  ]);
  expect(f.hostCalls()).toEqual(["readCanvas", "readCanvas"]);
  expect(f.fileCalls()).toEqual([]);

  await f.seed("canvas/documents/design.md", "# Orbit\nCollect stars.\n");
  const third = (await f.harness.behavior.callRpc("syncWorkspace", {
    gameId: "orbit",
    since: first.fingerprint,
  })) as Synced;
  expect(third.status).toBe("changed");
  expect(third.fingerprint).not.toBe(first.fingerprint);
  expect(f.reads[2]?.status).toBe("changed");
});

test("a file too large for the host's answer is read on its own, so the workspace still opens", async () => {
  const f = await studio();
  const large = `# Orbit\n${"x".repeat(5 * 1024 * 1024)}\n`;
  await f.seed("canvas/documents/design.md", large);
  f.harness.inspection.sdk.stub("files.read", async ({ path }: { path: string }) => {
    const content = await readFile(path, "utf8");
    return {
      content,
      contentEncoding: "utf8",
      sha256: sha256(content),
      sizeBytes: Buffer.byteLength(content),
    };
  });
  const synced = (await f.harness.behavior.callRpc("syncWorkspace", { gameId: "orbit" })) as {
    status: string;
    workspace: { documents: { markdown: string; revision: string }[] };
  };
  expect(synced.status).toBe("changed");
  expect(synced.workspace.documents[0]).toMatchObject({ revision: sha256(large) });
  expect(synced.workspace.documents[0]!.markdown.length).toBe(large.length);
  expect(f.fileCalls().map(({ path }) => path)).toEqual(["files.read"]);
});

test("a board save is one host call that compares and swaps on the host", async () => {
  const f = await studio();
  const synced = (await f.harness.behavior.callRpc("syncWorkspace", { gameId: "orbit" })) as {
    workspace: { boards: { board: unknown; revision: string }[] };
  };
  const { board: current, revision } = synced.workspace.boards[0]!;
  const saved = (await f.harness.behavior.callRpc("saveBoard", {
    gameId: "orbit",
    board: current,
    revision,
  })) as { revision: string };
  expect(f.hostCalls()).toEqual(["readCanvas", "saveCanvasBoard"]);
  expect(f.fileCalls()).toEqual([]);
  const { content, layout } = JSON.parse(saved.revision) as { content: string; layout: string };
  expect(sha256(await readFile(join(f.rootPath, "canvas/editor/main.json"), "utf8"))).toBe(layout);
  expect(sha256(await readFile(join(f.rootPath, "canvas/boards/main.json"), "utf8"))).toBe(content);
  await expect(
    f.harness.behavior.callRpc("saveBoard", { gameId: "orbit", board: current, revision }),
  ).rejects.toThrow("changed on disk");
});

test("canvas changes and finished BB runs reach studios over realtime", async () => {
  const f = await studio();
  const changes = [{ path: "canvas/boards/main.json", sha256: sha256(board) }];
  await f.harness.behavior.experimental_emitHostSignal("host", "canvasChanged", {
    gameId: "orbit",
    changes,
  });
  await f.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: "canvas-run", originPluginId: "game-studio" }),
    lastAssistantText: "done",
  });
  await f.harness.behavior.emitThreadEvent("thread.failed", {
    thread: makeThreadResponse({ id: "someone-else", originPluginId: null }),
    error: null,
  });
  expect(f.harness.inspection.realtimeSignals).toEqual([
    { channel: workspaceChangedChannel, payload: { gameId: "orbit", changes } },
    { channel: workspaceChangedChannel, payload: { threadId: "canvas-run" } },
  ]);
});

test("a canvas too large for one host result arrives in parts and still reads as one workspace", async () => {
  // Each entry is its own part, so the board, document and index each take a call.
  const f = await studio({ partBytes: 1 });
  const first = (await f.harness.behavior.callRpc("syncWorkspace", {
    gameId: "orbit",
  })) as Synced & {
    workspace?: { documents: { markdown: string }[] };
  };
  expect(first.status).toBe("changed");
  expect(first.workspace?.boards[0]?.revision).toBe(
    JSON.stringify({ content: sha256(board), layout: null }),
  );
  expect(first.workspace?.documents[0]?.markdown).toBe("# Orbit\n");
  const parts = f.reads.length;
  expect(parts).toBeGreaterThan(1);
  // Every part after the first reads from the one before it.
  expect(f.reads.slice(1).every(({ since }) => since)).toBe(true);
  expect(
    await f.harness.behavior.callRpc("syncWorkspace", {
      gameId: "orbit",
      since: first.fingerprint,
    }),
  ).toEqual({ status: "unchanged", fingerprint: first.fingerprint });
  expect(f.reads.length).toBe(parts + 1);
});
