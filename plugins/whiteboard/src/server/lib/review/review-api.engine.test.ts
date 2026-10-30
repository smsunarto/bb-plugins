import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "../sqlite-testing.ts";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { selectSource } from "../../../shared/review/lens-selection.ts";
import { documentText } from "../../../shared/review/document-text.ts";
import { rpcError } from "../boundary-errors.ts";
import { createReviewApi } from "./api.ts";
import { LocalReviewData } from "./local-data.ts";
import type { ReviewProgress } from "./review-progress.ts";
import { type ReviewProviders, ReviewStore } from "./store.ts";

const pins = { repositoryId: "repo", base: "base-commit", head: "head-commit" };

const signal = new AbortController().signal;

const source = {
  side: "head" as const,
  file: "src/store.ts",
  fromLine: 1,
  toLine: 5,
};

const diagram = {
  type: "sequence",
  title: "Save",
  actors: { app: "App", db: "Database" },
  steps: [{ from: "app", to: "db", label: "Write", source: selectSource(source) }],
};

let directory: string, database: string, store: ReviewStore;

let providers: ReviewProviders;

const request = <Operation>(operation: Operation) => ({
  commandId: randomUUID(),
  operation,
});

const create = () =>
  store.execute(request({ type: "create", source: "pins", title: "Example", pins }));

const edit = <Content>(reviewId: string, value: Content) =>
  store.execute(request({ type: "edit", reviewId, edit: value }));

const writeLens = <Edit>(reviewId: string, value: Edit, leaseId?: string) =>
  store.execute({
    ...request({ type: "lens", reviewId, edit: value }),
    leaseId,
  });

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "review-lean-"));
  database = path.join(directory, "reviews.db");
  vi.stubEnv("DEV_REVIEW_HOME", directory);
  providers = {
    validatePins: vi.fn<ReviewProviders["validatePins"]>(async () => {}),
    validateSource: vi.fn<ReviewProviders["validateSource"]>(async () => {}),
    validateResource: vi.fn<ReviewProviders["validateResource"]>(async () => {}),
  };
  store = new ReviewStore(database, providers);
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("reads, updates and restores a section saved with the retired status field, and rejects new status writes", async () => {
  const { reviewId } = await create();

  const inserted = await edit(reviewId, {
    type: "insert",
    content: { type: "section", title: "Design", children: [] },
  });

  await store.close();
  // A version saved while sections still carried a status.
  const db = new DatabaseSync(database);
  db.prepare(
    `UPDATE versions SET snapshot=json_set(snapshot,'$.document[0].status','in_progress') WHERE review_id=?`,
  ).run(reviewId);
  db.close();
  store = new ReviewStore(database, providers);

  expect(store.read(reviewId).document[0]).not.toHaveProperty("status");
  expect(documentText(store.read(reviewId))).not.toContain("Status");

  await edit(reviewId, {
    type: "update",
    targetId: inserted.targetId,
    changes: { title: "Design notes" },
  });
  expect(store.read(reviewId).document[0]).toEqual({
    id: inserted.targetId,
    type: "section",
    title: "Design notes",
    children: [],
  });

  await store.execute(request({ type: "restore", reviewId, version: inserted.version }));
  expect(store.read(reviewId).document[0]).toEqual({
    id: inserted.targetId,
    type: "section",
    title: "Design",
    children: [],
  });

  const version = store.read(reviewId).version;

  await expect(
    edit(reviewId, {
      type: "update",
      targetId: inserted.targetId,
      changes: { status: "complete" },
    }),
  ).rejects.toThrow(/Unrecognized key/);
  await expect(async () =>
    edit(reviewId, {
      type: "insert",
      content: {
        type: "section",
        title: "Plan",
        status: "pending",
        children: [],
      },
    }),
  ).rejects.toThrow(/Unrecognized key/);
  expect(store.read(reviewId).version).toBe(version);
});

it("persists partial coverage outside document versions and resets it for a changed file", async () => {
  const { reviewId } = await create();
  const version = store.read(reviewId).version;
  store.updateViewedCoverage(
    reviewId,
    [
      {
        path: "a.ts",
        fingerprint: "old",
        scope: { base: [], head: [[0, 10]] },
      },
    ],
    true,
  );
  store.updateViewedCoverage(
    reviewId,
    [
      {
        path: "a.ts",
        fingerprint: "old",
        scope: { base: [], head: [[5, 15]] },
      },
    ],
    true,
  );
  expect(store.viewedCoverage(reviewId).get("a.ts")?.coverage.head).toEqual([[0, 15]]);
  expect(store.read(reviewId).version).toBe(version);
  await store.close();
  store = new ReviewStore(database, providers);
  expect(store.viewedCoverage(reviewId).get("a.ts")?.coverage.head).toEqual([[0, 15]]);
  store.updateViewedCoverage(
    reviewId,
    [{ path: "a.ts", fingerprint: "old", scope: { base: [], head: [[4, 8]] } }],
    false,
  );
  expect(store.viewedCoverage(reviewId).get("a.ts")?.coverage.head).toEqual([
    [0, 4],
    [8, 15],
  ]);
  store.updateViewedCoverage(
    reviewId,
    [
      {
        path: "a.ts",
        fingerprint: "new",
        scope: { base: [], head: [[20, 22]] },
      },
    ],
    true,
  );
  expect(store.viewedCoverage(reviewId).get("a.ts")?.coverage.head).toEqual([[20, 22]]);
});

it("keeps reference coverage apart by pins: one path, changed under one comparison and not another", async () => {
  const { reviewProgress } = await import("./review-progress.ts");
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  const text = "first\nsecond\nthird";
  const changed = { ...pins, base: "other-base", head: "other-head" };
  const same = { repositoryId: pins.repositoryId, head: "other-head" };
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.source!.pins,
  }));
  vi.spyOn(data, "structuralChanges").mockImplementation(async function* ({ pins: at }) {
    const files =
      at.base === at.head
        ? []
        : [
            {
              file: {
                lhs: { path: "a.ts", oid: at.base, mode: "100644" },
                rhs: { path: "a.ts", oid: at.head, mode: "100644" },
              },
              status: "modified" as const,
            },
          ];

    yield {
      type: "start",
      version: 4,
      lhs: { type: "revision", rev: at.base },
      rhs: { type: "revision", rev: at.head },
      files,
    };

    for (const file of files)
      yield {
        type: "file",
        file: file.file,
        diff: {
          type: "text",
          lhs: { text: text },
          rhs: { text: text },
          structural_changes: { base: [], head: [[0, 3]] },
          stats: {
            textual: { added: 3, removed: 0 },
            visible: { added: 3, removed: 0 },
          },
        },
      };
    yield { type: "complete", succeeded: files.length, failed: 0 };
  });
  vi.spyOn(data, "file").mockImplementation(async (at, side, file) => ({
    file,
    side,
    commit: at[side],
    text,
  }));

  const cite = (at: typeof changed | typeof same) => ({
    file: "a.ts",
    start: { side: "head" as const, line: 1 },
    end: { side: "head" as const, line: 2 },
    pins: at,
  });

  await edit(reviewId, {
    type: "insert",
    content: {
      type: "flow_diagram",
      title: "Two pins",
      nodes: [
        {
          key: "changed",
          label: "Changed there",
          attachments: [{ label: "a", sources: [cite(changed)] }],
        },
        {
          key: "same",
          label: "Unchanged there",
          attachments: [{ label: "a", sources: [cite(same)] }],
        },
      ],
      edges: [{ from: "changed", to: "same" }],
    },
  });

  const progress = await reviewProgress(store, data, store.read(reviewId));

  // The document's own comparison stays in `files`; each reference's
  // comparison is its own group.
  expect(progress.files.map((file) => file.path)).toEqual(["a.ts"]);
  expect(Object.keys(progress.referenceFiles!).sort()).toEqual([
    "repo:other-base:other-head",
    "repo:other-head:other-head",
  ]);
  expect(progress.referenceFiles!["repo:other-base:other-head"]!["a.ts"]).toMatchObject({
    changed: { base: [], head: [[0, 3]] },
  });
  expect(progress.referenceFiles!["repo:other-head:other-head"]).toEqual({});
});

it("preserves unchanged partial file coverage across pins and rejects stale writes after either file side changes", async () => {
  const { reviewProgress } = await import("./review-progress.ts");
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  let head = "first\nsecond\ncontext";
  let base = "first\nold\ncontext";
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.source!.pins,
  }));
  vi.spyOn(data, "structuralChanges").mockImplementation(async function* () {
    yield {
      type: "start",
      version: 4,
      lhs: { type: "revision", rev: "base" },
      rhs: { type: "revision", rev: "head" },
      files: [
        {
          file: {
            lhs: { path: "a.ts", oid: "base", mode: "100644" },
            rhs: { path: "a.ts", oid: "head", mode: "100644" },
          },
          status: "modified",
        },
      ],
    };
    yield {
      type: "file",
      file: {
        lhs: { path: "a.ts", oid: "base", mode: "100644" },
        rhs: { path: "a.ts", oid: "head", mode: "100644" },
      },
      diff: {
        type: "text",
        lhs: { text: base },
        rhs: { text: head },
        structural_changes: { base: [[1, 2]], head: [[1, 2]] },
        stats: {
          textual: { added: 99, removed: 99 },
          visible: { added: 0, removed: 0 },
        },
      },
    };
    yield { type: "complete", succeeded: 1, failed: 0 };
  });
  vi.spyOn(data, "file").mockImplementation(async (_pins, side, file) => ({
    file,
    side,
    commit: _pins[side],
    text: side === "head" ? head : base,
  }));
  const api = createReviewApi({ store, data });
  const initial = await reviewProgress(store, data, store.read(reviewId));

  await data.coverage(reviewId, pins, "structural");
  expect(store.list()[0].diffStats).toEqual({
    fileCount: 1,
    additions: 1,
    deletions: 1,
  });
  expect(data.structuralChanges).toHaveBeenCalledTimes(1);
  expect(store.list("textual")[0].diffStats).toBeNull();

  const mark = (fingerprint: string, version: number) =>
    api.markProgress(
      {
        reviewId,
        version,
        viewed: true,
        files: [
          {
            path: "a.ts",
            fingerprint,
            sources: [{ side: "head" as const, file: "a.ts", fromLine: 2, toLine: 2 }],
          },
        ],
      },
      { signal },
    );

  await mark(initial.files[0].fingerprint, 0);
  await store.execute(request({ type: "repin", reviewId, pins: { ...pins, head: "new-pin" } }));
  expect((await reviewProgress(store, data, store.read(reviewId))).files[0].viewed.head).toEqual([
    [1, 2],
  ]);
  head += "\nchanged outside the hunk";
  await store.execute(
    request({
      type: "repin",
      reviewId,
      pins: { ...pins, head: "changed-head" },
    }),
  );
  expect((await reviewProgress(store, data, store.read(reviewId))).files[0].viewed.head).toEqual(
    [],
  );
  await expect(mark(initial.files[0].fingerprint, 0)).rejects.toMatchObject({
    status: 409,
    message: "This file changed. Reload before marking it viewed.",
  });
  const next = await reviewProgress(store, data, store.read(reviewId));
  await mark(next.files[0].fingerprint, store.read(reviewId).version);
  base += "\nnew base context";
  await store.execute(
    request({
      type: "repin",
      reviewId,
      pins: { ...pins, base: "changed-base", head: "changed-head" },
    }),
  );
  expect((await reviewProgress(store, data, store.read(reviewId))).files[0].viewed.head).toEqual(
    [],
  );
});

it("textual coverage uses Git ranges without launching diffr", async () => {
  const { coverageProgress } = await import("../../../shared/review/viewed-coverage.ts");
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.source!.pins,
  }));
  vi.spyOn(data, "changes").mockImplementation((async (_pins: typeof pins, file?: string) =>
    file
      ? "@@ -1 +1 @@\n-const x=1;\n+const x = 1;\n"
      : [{ path: "a.ts", status: "modified", additions: 1, deletions: 1 }]) as typeof data.changes);
  vi.spyOn(data, "file").mockImplementation(async (_pins, side, file) => ({
    file,
    side,
    commit: _pins[side],
    text: side === "head" ? "const x = 1;" : "const x=1;",
  }));
  const structural = vi.spyOn(data, "structuralChanges");

  const api = createReviewApi({ store, data });
  const progress = await api.progress({ reviewId, mode: "textual" }, { signal });
  expect(coverageProgress(progress.files).total).toEqual({
    additions: 1,
    deletions: 1,
  });
  await data.coverage(reviewId, pins, "textual");
  const textualCatalog = await api.catalog({ mode: "textual" });
  expect(textualCatalog[0].diffStats).toEqual({
    fileCount: 1,
    additions: 1,
    deletions: 1,
  });
  expect(structural).not.toHaveBeenCalled();
  structural.mockImplementation(async function* () {
    const file = {
      lhs: { path: "a.ts", oid: "base", mode: "100644" },
      rhs: { path: "a.ts", oid: "head", mode: "100644" },
    };

    yield {
      type: "start",
      version: 4,
      lhs: { type: "revision", rev: "base" },
      rhs: { type: "revision", rev: "head" },
      files: [{ file, status: "modified" }],
    };
    yield {
      type: "file",
      file,
      diff: {
        type: "text",
        lhs: { text: "const x=1;" },
        rhs: { text: "const x = 1;" },
        structural_changes: { base: [], head: [] },
        stats: {
          textual: { added: 1, removed: 1 },
          visible: { added: 0, removed: 0 },
        },
      },
    };
    throw new Error("Counts must not wait for summary events");
  });
  await data.coverage(reviewId, pins, "structural");

  const structuralCatalog = await api.catalog({ mode: "structural" });

  expect(structuralCatalog[0].diffStats).toEqual({
    fileCount: 1,
    additions: 0,
    deletions: 0,
  });

  const structuralProgress = await api.progress({ reviewId, mode: "structural" }, { signal });

  expect(coverageProgress(structuralProgress.files).total).toEqual({
    additions: 0,
    deletions: 0,
  });
  expect(structural).toHaveBeenCalledTimes(1);
  expect(store.list("textual")[0].diffStats).toEqual(textualCatalog[0].diffStats);
});

it("resolves file lenses to whole changed files, preserves empty groups, and shares viewed coverage", async () => {
  const { reviewProgress } = await import("./review-progress.ts");
  const { coverageProgress } = await import("../../../shared/review/viewed-coverage.ts");
  const { reviewId } = await create();

  for (const [title, patterns] of [
    ["Docs", ["docs/**", "docs/old.md"]],
    ["Guide", ["guide/**"]],
    ["Tests", ["**/*.test.ts"]],
  ] as const)
    await writeLens(reviewId, {
      type: "insert",
      title,
      targets: [{ kind: "files", patterns }],
    });
  const data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.source!.pins,
  }));
  vi.spyOn(data, "structuralChanges").mockImplementation(async function* () {
    yield {
      type: "start",
      version: 4,
      lhs: { type: "revision", rev: "base" },
      rhs: { type: "revision", rev: "head" },
      files: [
        {
          file: {
            lhs: { path: "docs/old.md", oid: "base", mode: "100644" },
            rhs: { path: "guide/intro.md", oid: "head", mode: "100644" },
          },
          status: "modified",
        },
      ],
    };
    yield {
      type: "file",
      file: {
        lhs: { path: "docs/old.md", oid: "base", mode: "100644" },
        rhs: { path: "guide/intro.md", oid: "head", mode: "100644" },
      },
      diff: {
        type: "text",
        lhs: { text: "base\ncontext\nmore context" },
        rhs: { text: "head\ncontext\nmore context" },
        structural_changes: { base: [[0, 1]], head: [[0, 1]] },
        stats: {
          textual: { added: 99, removed: 99 },
          visible: { added: 0, removed: 0 },
        },
      },
    };
    yield { type: "complete", succeeded: 1, failed: 0 };
  });
  vi.spyOn(data, "file").mockImplementation(async (_pins, side, file) => ({
    file,
    side,
    commit: _pins[side],
    text: `${side}\ncontext\nmore context`,
  }));
  const initial = await reviewProgress(store, data, store.read(reviewId));
  const [docs, guide, tests] = initial.lenses;
  const sources = [
    { side: "base", file: "docs/old.md", fromLine: 1, toLine: 3 },
    { side: "head" as const, file: "guide/intro.md", fromLine: 1, toLine: 3 },
  ];
  expect(docs).toMatchObject({ state: "ready", fileCount: 1, sources });
  expect(guide).toMatchObject({ state: "ready", sources });
  expect(tests).toMatchObject({ state: "unavailable", reason: expect.any(String) });
  expect(docs.state).not.toBe("unavailable");
  expect(guide.state).not.toBe("unavailable");
  store.updateViewedCoverage(
    reviewId,
    initial.files.map((file) => ({
      path: file.path,
      fingerprint: file.fingerprint,
      scope: file.changed,
    })),
    true,
  );
  const viewed = await reviewProgress(store, data, store.read(reviewId));
  expect(coverageProgress(viewed.files, resolved(docs).sources).state).toBe("viewed");
  expect(coverageProgress(viewed.files, resolved(guide).sources).state).toBe("viewed");
  expect(coverageProgress(viewed.files).total).toEqual({
    additions: 1,
    deletions: 1,
  });
});

it("validates range lens evidence and scopes progress and Uncategorized to distinct changed lines", async () => {
  const { reviewProgress } = await import("./review-progress.ts");

  const { coverageProgress, scopedCoverage } =
    await import("../../../shared/review/viewed-coverage.ts");

  const { reviewId } = await create();

  const selected = {
    side: "head" as const,
    file: "src/a.ts",
    fromLine: 2,
    toLine: 2,
  };

  const { targetId: lensId } = await writeLens(reviewId, {
    type: "insert",
    title: "One line",
    targets: [
      {
        kind: "ranges",
        sources: [selectSource(selected), selectSource(selected)],
      },
    ],
  });

  expect(providers.validateSource).toHaveBeenCalledWith(pins, selected, expect.anything());
  // A diagram's evidence stays in the document: it is not a Diff-view lens
  // and does not categorize the lines it cites.
  await edit(reviewId, {
    type: "insert",
    content: {
      ...diagram,
      steps: [
        {
          ...diagram.steps[0],
          source: selectSource({ ...selected, fromLine: 1, toLine: 1 }),
        },
      ],
    },
  });
  const data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.source!.pins,
  }));
  vi.spyOn(data, "structuralChanges").mockImplementation(async function* () {
    yield {
      type: "start",
      version: 4,
      lhs: { type: "revision", rev: "base" },
      rhs: { type: "revision", rev: "head" },
      files: [
        {
          file: {
            lhs: { path: "src/a.ts", oid: "base", mode: "100644" },
            rhs: { path: "src/a.ts", oid: "head", mode: "100644" },
          },
          status: "modified",
        },
      ],
    };
    yield {
      type: "file",
      file: {
        lhs: { path: "src/a.ts", oid: "base", mode: "100644" },
        rhs: { path: "src/a.ts", oid: "head", mode: "100644" },
      },
      diff: {
        type: "text",
        lhs: { text: "base1\nbase2\nbase3" },
        rhs: { text: "head1\nhead2\nhead3" },
        structural_changes: { base: [[0, 3]], head: [[0, 3]] },
        stats: {
          textual: { added: 99, removed: 99 },
          visible: { added: 0, removed: 0 },
        },
      },
    };
    yield { type: "complete", succeeded: 1, failed: 0 };
  });
  vi.spyOn(data, "file").mockImplementation(async (_pins, side, file) => ({
    file,
    side,
    commit: _pins[side],
    text: `${side}1\n${side}2\n${side}3`,
  }));
  const result = await reviewProgress(store, data, store.read(reviewId));

  const lens = resolved(result.lenses[0]),
    rest = resolved(result.lenses.find((lens) => lens.id === "automatic-uncategorized")!);

  expect(result.lenses.map((lens) => lens.title)).toEqual(["One line", "Uncategorized changes"]);
  expect(lens.sources).toEqual([{ ...selected, side: "base" }, selected]);
  expect(lens.wholeFiles).toBe(false);
  expect(coverageProgress(result.files, lens.sources).total).toEqual({
    additions: 1,
    deletions: 1,
  });
  expect(coverageProgress(result.files, rest.sources).total).toEqual({
    additions: 2,
    deletions: 2,
  });
  expect(rest.wholeFiles).toBe(false);
  store.updateViewedCoverage(
    reviewId,
    result.files.map((file) => ({
      path: file.path,
      fingerprint: file.fingerprint,
      scope: scopedCoverage(file, lens.sources),
    })),
    true,
  );
  const viewed = await reviewProgress(store, data, store.read(reviewId));
  expect(coverageProgress(viewed.files, lens.sources).state).toBe("viewed");
  expect(coverageProgress(viewed.files, rest.sources).remaining).toEqual({
    additions: 2,
    deletions: 2,
  });
  await writeLens(reviewId, {
    type: "update",
    targetId: lensId,
    title: "Stale selection",
    targets: [
      {
        kind: "ranges",
        sources: [
          {
            file: selected.file,
            start: { side: "head", line: 99 },
            end: { side: "head", line: 100 },
          },
        ],
      },
    ],
  });
  const stale = await reviewProgress(store, data, store.read(reviewId));
  expect(stale.lenses[0]).toMatchObject({ state: "unavailable" });
  expect(coverageProgress(stale.files, resolved(stale.lenses.at(-1)!).sources).total).toEqual({
    additions: 3,
    deletions: 3,
  });
});

it("rejects unsafe patterns and missing range sources", async () => {
  const { reviewId } = await create();

  await expect(
    writeLens(reviewId, {
      type: "insert",
      title: "Outside",
      targets: [{ kind: "files", patterns: ["../secrets/**"] }],
    }),
  ).rejects.toThrow(/repository-relative/);
  vi.mocked(providers.validateSource).mockRejectedValue(new Error("File is unavailable"));
  await expect(
    writeLens(reviewId, {
      type: "insert",
      title: "Missing",
      targets: [{ kind: "ranges", sources: [selectSource(source)] }],
    }),
  ).rejects.toThrow("File is unavailable");
  expect(store.read(reviewId).lenses).toBeUndefined();
});

it("returns coverage and lenses after initial files without requesting summary events", async () => {
  const { reviewProgress } = await import("./review-progress.ts");
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.source!.pins,
  }));
  const file = { rhs: { path: "a.ts", oid: "head", mode: "100644" } };
  vi.spyOn(data, "structuralChanges").mockImplementation(async function* () {
    yield {
      type: "start",
      version: 4,
      lhs: { type: "empty_tree" },
      rhs: { type: "revision", rev: "head" },
      files: [{ file, status: "added" }],
    };
    yield {
      type: "file",
      file,
      diff: {
        type: "text",
        rhs: { text: "added" },
        structural_changes: { base: [], head: [[0, 1]] },
        stats: {
          textual: { added: 1, removed: 0 },
          visible: { added: 0, removed: 0 },
        },
      },
    };
    throw new Error("Coverage must not await enrichment");
  });
  const progress = await reviewProgress(store, data, store.read(reviewId));
  expect(progress.files[0].changed).toEqual({ base: [], head: [[0, 1]] });
  expect(progress.lenses.find((lens) => lens.id === "automatic-uncategorized")).toMatchObject({
    state: "ready",
    sources: [{ side: "head", file: "a.ts", fromLine: 1, toLine: 1 }],
  });
  data.close();
});

it("returns pending progress without waiting for coverage and signals completion to late watchers", async () => {
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.source!.pins,
  }));
  vi.spyOn(data, "changes").mockImplementation((async (_pins: typeof pins, file?: string) => {
    await gate;

    return file ? "" : [];
  }) as typeof data.changes);
  const api = createReviewApi({ store, data });
  const read = () =>
    api.progress({ reviewId, version: 0, mode: "textual", wait: false }, { signal });

  try {
    expect(await read()).toMatchObject({
      files: [],
      lenses: [{ id: "automatic-uncategorized", state: "pending" }],
    });
    expect(data.coverageRevision).toBe(0);
    release();
    await data.coverage(reviewId, pins, "textual");
    await vi.waitFor(() => expect(data.coverageRevision).toBeGreaterThan(0));

    expect((await api.liveSession({ reviewId })).coverageRevision).toBeGreaterThan(0);
    const ready = await read();
    expect(ready.lenses.every((lens) => lens.state !== "pending")).toBe(true);
    expect(ready.files).toEqual([]);
    expect(data.changes).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await data.close();
  }
});

it("reports failed background coverage instead of leaving progress pending", async () => {
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.source!.pins,
  }));
  vi.spyOn(data, "changes").mockRejectedValue(new Error("comparison failed"));
  const api = createReviewApi({ store, data });
  const read = () =>
    api.progress({ reviewId, version: 0, mode: "textual", wait: false }, { signal });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    expect((await read()).lenses).toContainEqual(expect.objectContaining({ state: "pending" }));
    await vi.waitFor(() => expect(data.coverageRevision).toBeGreaterThan(0));
    const error = await read().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "comparison failed" });
    // Not a refusal: callers see a crash, its cause logged.
    expect(rpcError("progress", error).message).toMatch(/^Whiteboard operation failed \(Error\)/);
  } finally {
    logged.mockRestore();
    await data.close();
  }
});

it("logs a provider failure and names its kind without returning its local detail", async () => {
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.source!.pins,
  }));

  const failure = Object.assign(
    new Error("EACCES: permission denied, open '/Users/someone/secret.ts'"),
    { code: "EACCES" },
  );

  vi.spyOn(data, "changes").mockRejectedValue(failure);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const api = createReviewApi({ store, data });
  const read = () =>
    api.progress({ reviewId, version: 0, mode: "textual", wait: false }, { signal });

  try {
    await read();
    await vi.waitFor(() => expect(data.coverageRevision).toBeGreaterThan(0));
    const caught = await read().catch((error: unknown) => error);
    const { message } = rpcError("progress", caught);
    expect(message).toContain("EACCES");
    expect(message).toContain("server-stdio.log");
    expect(message).not.toContain("/Users/someone");
    expect(logged).toHaveBeenCalledWith("[Whiteboard] progress failed:", failure);
  } finally {
    logged.mockRestore();
    await data.close();
  }
});

it("makes a diagram step's selection usable before an unrelated file finishes counting", async () => {
  const { selectionKey } = await import("../../../shared/review/lens-selection.ts");
  const { reviewId } = await create();

  const refs = ["a.ts", "b.ts"].map((file) =>
    selectSource({ side: "head", file, fromLine: 1, toLine: 1 }),
  );

  await edit(reviewId, {
    type: "insert",
    content: {
      ...diagram,
      steps: refs.map((source, i) => ({
        from: "app",
        to: "db",
        label: `step ${i}`,
        source,
      })),
    },
  });
  const data = new LocalReviewData(store);
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.source!.pins,
  }));
  vi.spyOn(data, "changes").mockImplementation((async (_pins: typeof pins, file?: string) => {
    if (!file)
      return ["a.ts", "b.ts"].map((path) => ({
        path,
        status: "modified",
        additions: 1,
        deletions: 1,
      }));

    if (file === "b.ts") await gate;

    return "@@ -1 +1 @@\n-old\n+new\n";
  }) as typeof data.changes);
  vi.spyOn(data, "file").mockImplementation(async (_pins, side, file) => ({
    file,
    side,
    commit: _pins[side],
    text: side === "head" ? "new" : "old",
  }));
  const api = createReviewApi({ store, data });
  const version = store.read(reviewId).version;
  const read = () => api.progress({ reviewId, version, mode: "textual", wait: false }, { signal });

  try {
    await read();
    await vi.waitFor(() =>
      expect(data.coverageSnapshot(reviewId, pins, "textual").comparison.files).toHaveLength(1),
    );
    const partial = await read();
    // A diagram is not a Diff-view lens: only the automatic lens is listed.
    expect(partial.lenses).toHaveLength(1);
    expect(partial.resolvedSelections[selectionKey(refs[0])]).toBeDefined();
    expect(partial.resolvedSelections[selectionKey(refs[1])]).toBeUndefined();
    expect(partial.unavailableSelections).toEqual({});
    expect(partial.lenses.at(-1)).toMatchObject({
      id: "automatic-uncategorized",
      state: "pending",
      sources: [],
    });
    release();
    await data.coverage(reviewId, pins, "textual");
    const complete = await read();
    expect(complete.lenses).toHaveLength(1);
    expect(complete.lenses[0].state).not.toBe("pending");
    expect(complete.resolvedSelections[selectionKey(refs[1])]).toBeDefined();
  } finally {
    release();
    await data.close();
  }
});

it("Home reads persisted counts without scheduling comparisons, and changed pins start unknown", async () => {
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  const comparison = vi.spyOn(data, "coverage");
  const api = createReviewApi({ store, data });
  expect((await api.catalog({}))[0].diffStats).toBeNull();
  expect(comparison).not.toHaveBeenCalled();
  const counts = { fileCount: 2, additions: 9, deletions: 3 };
  store.setDiffStats(pins, counts, "structural");
  await store.close();
  store = new ReviewStore(database, providers);
  expect(store.list()[0].diffStats).toEqual(counts);
  expect(store.list("textual")[0].diffStats).toBeNull();
  await store.execute(request({ type: "repin", reviewId, pins: { ...pins, head: "new-head" } }));
  expect(store.list()[0].diffStats).toBeNull();
  await store.execute(request({ type: "repin", reviewId, pins }));
  expect(store.list()[0].diffStats).toEqual(counts);
});

it("shares pending comparison work even when more than 32 reviews are opened", async () => {
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  vi.spyOn(data, "structuralChanges").mockImplementation(async function* () {
    await gate;
    yield {
      type: "start",
      version: 4,
      lhs: { type: "revision", rev: "base" },
      rhs: { type: "revision", rev: "head" },
      files: [],
    };
    yield { type: "complete", succeeded: 0, failed: 0 };
  });
  const first = data.coverage(reviewId, pins, "structural");

  const others = Array.from({ length: 33 }, (_, i) =>
    data.coverage(reviewId, { ...pins, head: `head-${i}` }, "structural"),
  );

  expect(data.coverage(reviewId, pins, "structural")).toBe(first);
  release();
  await Promise.all([first, ...others]);
});

/** A lens the Diff view can scope to; an unavailable one fails the test. */
function resolved(lens: ReviewProgress["lenses"][number]) {
  if (lens.state === "unavailable") throw new Error(lens.reason);
  return lens;
}
