import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import type { Workspace } from "../shared/schema.ts";

installDom();
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { pluginQueryClient, PluginQueryBoundary } = await import("@bb-kit/core/rpc/query");
const { cleanup, fireEvent, waitFor } = await import("@testing-library/react");
const { act, useState } = await import("react");
const { useStudioWorkspace, holdsChange, SAFETY_POLL_MS } = await import("./workspace-sync.ts");
const { useUnityEditors, EDITOR_POLL_MS } = await import("./unity.tsx");

beforeEach(() => pluginQueryClient.clear());
afterEach(() => {
  cleanup();
  pluginQueryClient.clear();
  jest.useRealTimers();
});

const revision = (content: string, layout: string | null = null) =>
  JSON.stringify({ content, layout });
function workspace(boardRevision = revision("content-1")): Workspace {
  return {
    game: {
      id: "orbit",
      name: "Orbit",
      projectId: "project",
      hostId: "host",
      rootPath: "/games/orbit",
      kind: "general",
      createdAt: 0,
      threadId: null,
      previewPath: "index.html",
    },
    index: {
      version: 1,
      mainDocumentId: "design",
      boards: [{ id: "main", name: "Design board" }],
      documents: [{ id: "design", title: "Design" }],
    },
    indexRevision: "index-1",
    boards: [
      {
        revision: boardRevision,
        freshness: {},
        pending: {},
        board: {
          version: 1,
          id: "main",
          viewport: { width: 1280, height: 720 },
          nodes: [],
          edges: [],
          editorLayout: {
            version: 1,
            view: "canvas",
            nodes: {},
            viewport: { x: 0, y: 0, zoom: 1 },
          },
        },
      },
    ],
    documents: [{ id: "design", title: "Design", markdown: "# Orbit", revision: "doc-1" }],
    assets: [],
    evidence: [],
    evidenceRuns: [],
    requests: [],
    generationJobs: [],
    mediaDir: null,
  };
}

function Studio() {
  const { query, saveBoard } = useStudioWorkspace("orbit");
  const [outcome, setOutcome] = useState("");
  const entry = query.data?.boards[0];
  return (
    <div>
      <output aria-label="revision">{entry?.revision ?? "loading"}</output>
      <output aria-label="outcome">{outcome}</output>
      <button
        onClick={() =>
          void saveBoard(entry!.board, entry!.revision).then(
            (result) => setOutcome(`saved ${result.revision}`),
            (error: Error) => setOutcome(error.message),
          )
        }
      >
        Save
      </button>
    </div>
  );
}

function mount(rpc: Record<string, (input: unknown) => unknown>) {
  return renderSlot(
    {
      component: () => (
        <PluginQueryBoundary>
          <Studio />
        </PluginQueryBoundary>
      ),
    },
    {},
    { rpc },
  );
}
const calls = (slot: ReturnType<typeof mount>, method: string) =>
  slot.rpcCalls.filter((call) => call.method === method);

test("an autosave keeps the revision it saved instead of reading the workspace again", async () => {
  const slot = mount({
    syncWorkspace: () => ({ status: "changed", fingerprint: "f1", workspace: workspace() }),
    saveBoard: () => ({ revision: revision("content-2", "layout-2") }),
  });
  await slot.findByText(revision("content-1"));
  fireEvent.click(slot.getByText("Save"));
  await slot.findByText(revision("content-2", "layout-2"));
  expect(slot.rpcCalls.map(({ method }) => method)).toEqual(["syncWorkspace", "saveBoard"]);

  // The host's signal for that save names the files and hashes the studio now holds.
  await slot.emitRealtime("workspace-changed", {
    gameId: "orbit",
    changes: [
      { path: "canvas/editor/main.json", sha256: "layout-2" },
      { path: "canvas/boards/main.json", sha256: "content-2" },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls(slot, "syncWorkspace")).toHaveLength(1);
  slot.unmount();
});

test("a conflicting save reads the disk again so the canvas can rebase", async () => {
  let reads = 0;
  const slot = mount({
    syncWorkspace: () => {
      reads += 1;
      return {
        status: "changed",
        fingerprint: `f${reads}`,
        workspace: workspace(revision(`content-${reads}`)),
      };
    },
    saveBoard: () => {
      throw new Error("This board changed on disk. Reload the workspace before saving again.");
    },
  });
  await slot.findByText(revision("content-1"));
  fireEvent.click(slot.getByText("Save"));
  await slot.findByText(/changed on disk/);
  expect(slot.getByLabelText("revision").textContent).toBe(revision("content-2"));
  expect(slot.rpcCalls.map(({ method }) => method)).toEqual([
    "syncWorkspace",
    "saveBoard",
    "syncWorkspace",
  ]);
  expect(calls(slot, "syncWorkspace")[1]?.input).toEqual({ gameId: "orbit", since: "f1" });
  slot.unmount();
});

test("other changes, a reconnect and a finished BB run read again, sending the fingerprint held", async () => {
  const held = { ...workspace(), generationJobs: [] as Workspace["generationJobs"] };
  const slot = mount({
    syncWorkspace: (input) =>
      (input as { since?: string }).since === "f1"
        ? { status: "unchanged", fingerprint: "f1" }
        : { status: "changed", fingerprint: "f1", workspace: held },
  });
  await slot.findByText(revision("content-1"));
  const reads = () => calls(slot, "syncWorkspace").length;
  // Another game, and a file the studio already holds, are not news.
  await slot.emitRealtime("workspace-changed", { gameId: "other", changes: null });
  await slot.emitRealtime("workspace-changed", {
    gameId: "orbit",
    changes: [{ path: "canvas/documents/design.md", sha256: "doc-1" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(reads()).toBe(1);

  await slot.emitRealtime("workspace-changed", {
    gameId: "orbit",
    changes: [{ path: "canvas/documents/design.md", sha256: "doc-2" }],
  });
  await waitFor(() => expect(reads()).toBe(2));
  expect(calls(slot, "syncWorkspace")[1]?.input).toEqual({ gameId: "orbit", since: "f1" });

  await slot.setRealtimeConnectionState("reconnecting");
  await slot.setRealtimeConnectionState("connected");
  await waitFor(() => expect(reads()).toBe(3));

  // A BB run only matters to the studio showing its job.
  await slot.emitRealtime("workspace-changed", { threadId: "someone-else" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(reads()).toBe(3);
  slot.unmount();
});

test("a finished BB run reads the studio showing its job again", async () => {
  const running = workspace();
  running.generationJobs = [
    {
      version: 1,
      id: "brief",
      threadId: null,
      taskId: "canvas-run",
      origin: { kind: "canvas", gameId: "orbit" },
      createdAt: 1,
      updatedAt: 1,
      status: "running",
      outputs: [],
      request: {
        kind: "text",
        prompt: "Write lore",
        providerId: "codex",
        model: { provider: "bb", id: "model" },
        images: [],
        outputCount: 1,
      },
    },
  ];
  const slot = mount({
    syncWorkspace: () => ({ status: "changed", fingerprint: "f1", workspace: running }),
  });
  await slot.findByText(revision("content-1"));
  await slot.emitRealtime("workspace-changed", { threadId: "canvas-run" });
  await waitFor(() => expect(calls(slot, "syncWorkspace")).toHaveLength(2));
  slot.unmount();
});

test("the studio's safety poll is slow", () => {
  expect(SAFETY_POLL_MS).toBeGreaterThanOrEqual(60_000);
});

test("a studio holds a board file only at the revision it last saved or read", () => {
  const held = workspace(revision("content-1", "layout-1"));
  expect(holdsChange(held, { path: "canvas/boards/main.json", sha256: "content-1" })).toBe(true);
  expect(holdsChange(held, { path: "canvas/editor/main.json", sha256: "layout-1" })).toBe(true);
  expect(holdsChange(held, { path: "canvas/editor/main.json", sha256: "layout-2" })).toBe(false);
  expect(holdsChange(held, { path: "canvas/index.json", sha256: "index-1" })).toBe(true);
  expect(holdsChange(held, { path: "canvas/boards/main.json", sha256: null })).toBe(false);
  expect(holdsChange(held, { path: "list:canvas/staging", sha256: null })).toBe(false);
  expect(holdsChange(held, { path: "job:brief", sha256: null })).toBe(false);
});

for (const poll of [false, true]) {
  test(`the Editor inventory ${poll ? "polls on the Unity tab" : "is read once off the Unity tab"}`, async () => {
    jest.useFakeTimers();
    function Inventory() {
      const editors = useUnityEditors("host", { poll });
      return <output>{editors.data ? "listed" : "loading"}</output>;
    }
    const slot = renderSlot(
      {
        component: () => (
          <PluginQueryBoundary>
            <Inventory />
          </PluginQueryBoundary>
        ),
      },
      {},
      {
        rpc: {
          listUnityEditors: () => ({
            hostId: "host",
            instances: [],
            claims: [],
            slots: [],
            warnings: [],
          }),
        },
      },
    );
    for (let tick = 0; tick < 4; tick++)
      await act(async () => {
        jest.advanceTimersByTime(EDITOR_POLL_MS);
        await Promise.resolve();
      });
    jest.useRealTimers();
    await slot.findByText("listed");
    const listed = slot.rpcCalls.filter(({ method }) => method === "listUnityEditors").length;
    if (poll) expect(listed).toBeGreaterThan(1);
    else expect(listed).toBe(1);
    slot.unmount();
  });
}
