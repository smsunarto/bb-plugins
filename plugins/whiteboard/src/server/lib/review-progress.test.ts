import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BlobBatchReader } from "../../shared/node/vendor/local-vcs/src/blob-batch-reader.ts";
import { selectSource, selectionKey } from "../../shared/vendor/review/src/lens-selection.ts";
import { ReviewInputError } from "../../shared/vendor/review/src/review-api/document.ts";
import { LocalReviewData } from "./vendor/review/src/review-api/local-data.ts";
import { reviewProgress } from "./vendor/review/src/review-api/review-progress.ts";
import { ReviewStore } from "./vendor/review/src/review-api/store.ts";
import { gitFixture } from "./host-io/testing/git-fixture.ts";

const pins = { repositoryId: "repository", base: "base", head: "head" };
let directory: string;
let store: ReviewStore;
let data: LocalReviewData;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "whiteboard-progress-"));
  store = new ReviewStore(path.join(directory, "reviews.db"), {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });
  data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({ snapshot, pins }));
  vi.spyOn(data, "coverage").mockResolvedValue({
    files: [],
    fileSources: new Map(),
    alignments: new Map(),
  });
});

afterEach(async () => {
  await data.close();
  await store.close();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

async function peek(side: "base" | "head", sourcePins = pins, file = "one-sided.ts") {
  const { reviewId } = await store.execute({
    commandId: randomUUID(),
    operation: { type: "create", source: "pins", title: "Peek", pins: sourcePins },
  });
  const source = selectSource({ file, side, fromLine: 1, toLine: 1 });
  await store.execute({
    commandId: randomUUID(),
    operation: {
      type: "edit",
      reviewId,
      edit: { type: "insert", content: { type: "code_peek", source } },
    },
  });
  return { snapshot: store.read(reviewId), source };
}

it.each(["base", "head"] as const)("resolves a context peek available only on %s", async (side) => {
  const { snapshot, source } = await peek(side);
  vi.spyOn(data, "file").mockImplementation(async (pins, requestedSide, file) => {
    if (requestedSide !== side) throw new ReviewInputError("File is unavailable", 404);
    return {
      file,
      side: requestedSide,
      commit: pins[requestedSide],
      text: "export const value = 1;",
    };
  });

  const progress = await reviewProgress(store, data, snapshot);

  expect(progress.lenses.some((lens) => lens.state === "pending")).toBe(false);
  expect(progress.resolvedSelections[selectionKey(source)]).toEqual([
    { file: "one-sided.ts", side, fromLine: 1, toLine: 1 },
  ]);
  expect(progress.unavailableSelections).toEqual({});
});

it("keeps a failed read unavailable instead of treating it as a missing side", async () => {
  const { snapshot, source } = await peek("head");
  vi.spyOn(data, "file").mockImplementation(async (pins, side, file) => {
    if (side === "base") throw new Error("Host unavailable");
    return { file, side, commit: pins[side], text: "export const value = 1;" };
  });

  const progress = await reviewProgress(store, data, snapshot);

  expect(progress.resolvedSelections[selectionKey(source)]).toBeUndefined();
  expect(progress.unavailableSelections?.[selectionKey(source)]).toBeTruthy();
});

it("keeps a failed host blob read unavailable through the production source reader", async () => {
  const repo = gitFixture("whiteboard-progress-host-");
  try {
    const repository = await data.register(repo.root);
    const realPins = { repositoryId: repository.id, base: repo.base, head: repo.head };
    vi.mocked(data.resolveSource).mockImplementation(async (snapshot) => ({
      snapshot,
      pins: realPins,
    }));
    const { snapshot, source } = await peek("head", realPins, "src/a.ts");
    const read = BlobBatchReader.prototype.readObject;
    vi.spyOn(BlobBatchReader.prototype, "readObject").mockImplementation(
      function (this: BlobBatchReader, commit, file) {
        if (commit === repo.base)
          return Promise.reject(new Error("git cat-file stopped before answering"));
        return read.call(this, commit, file);
      },
    );

    const progress = await reviewProgress(store, data, snapshot);

    expect(progress.resolvedSelections[selectionKey(source)]).toBeUndefined();
    expect(progress.unavailableSelections?.[selectionKey(source)]).toBeTruthy();
  } finally {
    repo.remove();
  }
});

it.each(["missing", "changed", "other-side"])("keeps %s context unavailable", async (kind) => {
  const { snapshot, source } = await peek("head");
  vi.spyOn(data, "file").mockImplementation(async (pins, side, file) => {
    if (kind === "missing" || (kind === "other-side" && side === "head"))
      throw new ReviewInputError("File is unavailable", 404);
    return { file, side, commit: pins[side], text: kind === "changed" ? side : "unchanged" };
  });

  const progress = await reviewProgress(store, data, snapshot);

  expect(progress.resolvedSelections[selectionKey(source)]).toBeUndefined();
  expect(progress.unavailableSelections?.[selectionKey(source)]).toBeTruthy();
});

it("keeps context pending until coverage finishes, then resolves unchanged lines", async () => {
  const { snapshot, source } = await peek("head");
  const file = vi.spyOn(data, "file").mockImplementation(async (pins, side, file) => ({
    file,
    side,
    commit: pins[side],
    text: "unchanged",
  }));

  const pending = await reviewProgress(store, data, snapshot, undefined, "structural", {
    files: [],
    fileSources: new Map(),
    alignments: new Map(),
  });
  expect(pending.lenses.map((lens) => lens.state)).toEqual(["pending"]);
  expect(pending.unavailableSelections).toEqual({});
  expect(file).not.toHaveBeenCalled();

  const ready = await reviewProgress(store, data, snapshot);
  expect(ready.lenses.some((lens) => lens.state === "pending")).toBe(false);
  expect(ready.resolvedSelections[selectionKey(source)]).toEqual([
    { file: "one-sided.ts", side: "base", fromLine: 1, toLine: 1 },
    { file: "one-sided.ts", side: "head", fromLine: 1, toLine: 1 },
  ]);
});
