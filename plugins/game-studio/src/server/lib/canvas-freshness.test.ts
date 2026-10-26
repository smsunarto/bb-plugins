import { expect, test } from "bun:test";
import { workspaceSchema, type Workspace } from "../../shared/schema.ts";
import { generationJob } from "../../shared/generation.ts";
import { inputFingerprint, nodeFingerprint } from "./canvas-generation.ts";
import { boardFreshness } from "./canvas-freshness.ts";

function workspace(): Workspace {
  return workspaceSchema.parse({
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
    index: { version: 1, boards: [{ id: "board", name: "Board" }], documents: [] },
    indexRevision: "index",
    documents: [],
    assets: [
      { id: "sheet-1", name: "sheet-1.png", path: "canvas/staging/s1/sheet.png", type: "image" },
      { id: "sheet-2", name: "sheet-2.png", path: "canvas/staging/s2/sheet.png", type: "image" },
      { id: "final-1", name: "final.png", path: "canvas/staging/f1/final.png", type: "image" },
    ],
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
              id: "note",
              type: "text",
              position: { x: 0, y: 0 },
              data: { instruction: "Describe the courier", text: "", references: [] },
            },
            {
              id: "sheet",
              type: "image",
              position: { x: 0, y: 0 },
              data: {
                prompt: "Character sheet",
                assetId: "sheet-1",
                takes: [
                  { assetId: "sheet-1", jobId: "s1" },
                  { assetId: "sheet-2", jobId: "s2" },
                ],
                images: [{ type: "node", nodeId: "note", port: "text" }],
              },
            },
            {
              id: "final",
              type: "image",
              position: { x: 0, y: 0 },
              data: {
                prompt: "Final render",
                assetId: "final-1",
                takes: [{ assetId: "final-1", jobId: "f1" }],
                images: [{ type: "node", nodeId: "sheet", port: "image" }],
              },
            },
            { id: "upload", type: "image", position: { x: 0, y: 0 }, data: { assetId: "sheet-2" } },
            { id: "empty", type: "video", position: { x: 0, y: 0 }, data: { prompt: "Later" } },
          ],
        },
      },
    ],
  });
}
const job = (id: string, nodeId: string, inputs: string | undefined) =>
  generationJob.parse({
    version: 1,
    id,
    threadId: null,
    origin: { kind: "canvas", gameId: "game" },
    createdAt: 1,
    updatedAt: 1,
    status: "succeeded",
    request: { kind: "image", prompt: "x" },
    target: { boardId: "board", nodeId, fingerprint: "f", ...(inputs ? { inputs } : {}) },
    outputs: [],
  });

test("a pick is fresh while the run that made it saw the same brief and inputs", () => {
  const state = workspace();
  const board = state.boards[0]!.board;
  const [note, sheet, final] = board.nodes as [
    (typeof board.nodes)[number],
    (typeof board.nodes)[number],
    (typeof board.nodes)[number],
  ];
  state.generationJobs = [
    job("s1", "sheet", inputFingerprint(sheet, board, state)),
    job("f1", "final", inputFingerprint(final, board, state)),
  ];
  const freshness = () => boardFreshness(board, state);
  expect(freshness()).toEqual({
    note: "missing",
    sheet: "fresh",
    final: "fresh",
    upload: "unknown",
    empty: "missing",
  });
  // Editing the sheet's own brief leaves the final render's inputs untouched: its pick is the same.
  sheet.data.prompt = "Character sheet, three-quarter view";
  expect(freshness()).toMatchObject({ sheet: "stale", final: "fresh" });
  // A new take does not change what the final render consumed; choosing it does.
  sheet.data.takes = [
    ...(sheet.data.takes as { assetId: string; jobId: string }[]),
    { assetId: "sheet-3", jobId: "s3" },
  ];
  expect(freshness()).toMatchObject({ final: "fresh" });
  sheet.data.assetId = "sheet-2";
  expect(freshness()).toMatchObject({ sheet: "unknown", final: "stale" });
  // Generated text is judged by what it was written from, not by the text it produced.
  note.data.text = "A courier who crosses mossy ruins.";
  note.data.generationJobId = "n1";
  state.generationJobs.push(job("n1", "note", inputFingerprint(note, board, state)));
  expect(freshness()).toMatchObject({ note: "fresh" });
  note.data.instruction = "Describe the courier and her satchel";
  expect(freshness()).toMatchObject({ note: "stale" });
  // The whole-node fingerprint still changes with the text it holds, which guards text results.
  expect(nodeFingerprint(note, board, state)).not.toBe(inputFingerprint(note, board, state));
  // A run without an inputs record cannot be judged.
  state.generationJobs = [job("f1", "final", undefined)];
  expect(freshness()).toMatchObject({ final: "unknown" });
});
