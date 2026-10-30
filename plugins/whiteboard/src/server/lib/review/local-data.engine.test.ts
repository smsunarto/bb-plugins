import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  type FSWatcher,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { copyContextInput } from "../../../shared/contracts/rpc.ts";
import type { AgentSelection } from "../../../shared/review/agent-selection.ts";
import { selectSource } from "../../../shared/review/lens-selection.ts";
import type { Pins } from "../../../shared/review/document.ts";
import { type CommandInput, type DiffInput, createReviewApi } from "./api.ts";
import { openLocalReviewStore, uploadSchema } from "./local-data.ts";

let directory: string, repository: string, database: string, pins: Pins;

let local: ReturnType<typeof openLocalReviewStore>;

const signal = new AbortController().signal;

type ReviewApi = ReturnType<typeof createReviewApi>;

/** The operations over this test's store, as the engine builds them. */
const reviewApi = (deps: Omit<Parameters<typeof createReviewApi>[0], "store" | "data"> = {}) =>
  createReviewApi({ store: local.store, data: local.data, ...deps });

/** One store command through the operation, with a fresh command ID. */
const execute = (api: ReviewApi, operation: CommandInput["operation"], open?: boolean) =>
  api.command({ commandId: randomUUID(), operation }, { signal, open });

/** A diff read's patch text. */
function patchText(diff: Awaited<ReturnType<ReviewApi["diff"]>>): string {
  if (diff.format !== "patch") throw new Error(`Expected a patch, got ${diff.format}.`);
  return diff.text;
}

const command = <Operation>(operation: Operation) => ({
  commandId: randomUUID(),
  operation,
});

const source = {
  side: "head" as const,
  file: "example.ts",
  fromLine: 1,
  toLine: 2,
};

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();

const insert = <Content>(reviewId: string, content: Content) =>
  local.store.execute(
    command({
      type: "edit",
      reviewId,
      edit: { type: "insert", content },
    }),
  );

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "review-local-data-"));
  repository = path.join(directory, "repository");
  database = path.join(directory, "reviews.db");
  vi.stubEnv("DEV_REVIEW_HOME", directory);
  mkdirSync(repository);
  git("init", "-q");
  git("config", "user.name", "Review Test");
  git("config", "user.email", "review-test@example.invalid");
  writeFileSync(path.join(repository, source.file), "export const value = 1;\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Base");
  writeFileSync(
    path.join(repository, source.file),
    "export const value = 2;\nexport const saved = true;\n",
  );
  writeFileSync(path.join(repository, "literal[1].ts"), "exact filename\n");
  writeFileSync(path.join(repository, "literal1.ts"), "wrong pattern match\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Head");
  writeFileSync(path.join(repository, source.file), "uncommitted text must never appear\n");
  local = openLocalReviewStore(database, { watch });
  const registered = await local.data.register(repository);
  pins = await local.data.resolvePins(registered.id, "HEAD^", "HEAD");
});

afterEach(async () => {
  await local.store.close();
  await local.data.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("reads, resolves and retires a reference at its own pins in another repository", async () => {
  const other = path.join(directory, "other");
  mkdirSync(other);

  const otherGit = (...args: string[]) =>
    execFileSync("git", args, { cwd: other, encoding: "utf8" }).trim();

  otherGit("init", "-q");
  otherGit("config", "user.name", "Review Test");
  otherGit("config", "user.email", "review-test@example.invalid");
  writeFileSync(path.join(other, "lib.ts"), "export const other = 1;\nexport const more = 2;\n");
  otherGit("add", ".");
  otherGit("-c", "commit.gpgsign=false", "commit", "-qm", "Other");
  const registered = await local.data.register(other);

  const own = {
    repositoryId: registered.id,
    head: otherGit("rev-parse", "HEAD"),
  };

  const { reviewId } = await local.store.execute(
    command({ type: "create", source: "pins", title: "Two repositories", pins }),
  );

  const peek = await insert(reviewId, {
    type: "code_peek",
    source: {
      file: "lib.ts",
      start: { side: "head", line: 1 },
      end: { side: "head", line: 2 },
      pins: own,
    },
  });

  // A branch name is not a pin, even for a reference's own pins.
  await expect(
    insert(reviewId, {
      type: "code_peek",
      source: {
        file: "lib.ts",
        start: { side: "head", line: 1 },
        end: { side: "head", line: 1 },
        pins: { ...own, head: "HEAD" },
      },
    }),
  ).rejects.toThrow(/resolved commit IDs/);

  const api = reviewApi();

  expect(await api.file({ reviewId, side: "head", file: "lib.ts", ...own })).toMatchObject({
    commit: own.head,
    text: "export const other = 1;\nexport const more = 2;\n",
  });
  expect(await api.file({ reviewId, side: "head", file: source.file })).toMatchObject({
    commit: pins.head,
  });
  expect(await api.tree({ reviewId, side: "head", ...own })).toEqual([
    { path: "lib.ts", kind: "file" },
  ]);
  await expect(
    api.file({ reviewId, side: "head", file: "lib.ts", head: own.head }),
  ).rejects.toMatchObject({
    status: 400,
    message: "Reading at explicit pins needs both repositoryId and head.",
  });

  expect(
    await api.source({
      reviewId,
      source: { side: "head", file: "lib.ts", fromLine: 2, toLine: 2, pins: own },
    }),
  ).toMatchObject({
    commit: own.head,
    text: "export const more = 2;",
  });

  const progress = await api.progress({ reviewId, mode: "textual" }, { signal });

  expect(
    progress.resolvedSelections[
      JSON.stringify(["lib.ts", "head", 1, "head", 2, `${own.repositoryId}::${own.head}`])
    ],
  ).toEqual([
    // Base-less pins compare the commit with itself, so both sides resolve.
    { file: "lib.ts", side: "base", fromLine: 1, toLine: 2 },
    { file: "lib.ts", side: "head", fromLine: 1, toLine: 2 },
  ]);
  // The other repository's file is not one of this review's changed files.
  expect(progress.files.map((file) => file.path)).not.toContain("lib.ts");

  // The reference keeps its repository registered until it is gone.
  local.store.unregisterRepository(own.repositoryId);
  expect(local.store.repositoryPath(own.repositoryId)).toBe(realpathSync(other));

  rmSync(other, { recursive: true, force: true });
  await local.store.refreshWorktrees();
  expect(local.store.read(reviewId).live).toEqual({
    kind: "available",
    unavailableAnchors: [peek.targetId],
  });
  expect(local.store.read(reviewId).staleSources).toBeUndefined();
});

type OpenDesktop = NonNullable<Parameters<typeof createReviewApi>[0]["open"]>;

it("opens a created review in Desktop unless the author opts out", async () => {
  const opened: string[] = [];

  const api = reviewApi({
    open: async ({ reviewId }) => {
      opened.push(reviewId);

      return { softwareMapEnabled: true };
    },
  });

  const shownReview = await execute(api, { type: "create", source: "pins", title: "Shown", pins });

  expect(shownReview).toMatchObject({
    opened: true,
    softwareMapEnabled: true,
  });
  expect(opened).toEqual([shownReview.reviewId]);

  const background = {
    commandId: randomUUID(),
    operation: { type: "create", source: "pins", title: "Background", pins },
  } satisfies CommandInput;

  const quietReview = await api.command(background, { signal, open: false });

  expect(quietReview).toMatchObject({ opened: false });
  expect(opened).toEqual([shownReview.reviewId]);

  // Opening is not part of the saved command: a retry may choose to show it.
  expect(await api.command(background, { signal })).toMatchObject({
    reviewId: quietReview.reviewId,
    opened: true,
  });
  expect(opened).toEqual([shownReview.reviewId, quietReview.reviewId]);
});

it("opens the PR's existing review that create returns instead of a new one", async () => {
  const opened: string[] = [];

  const api = reviewApi({
    open: async ({ reviewId }) => {
      opened.push(reviewId);

      return { softwareMapEnabled: false };
    },
  });

  const pullRequestUrl = "https://github.com/devdotfast/review/pull/452";

  const first = await execute(api, {
    type: "create",
    source: "pins",
    title: "PR",
    pins,
    pullRequestUrl,
  });

  const body = await execute(api, {
    type: "create",
    source: "pins",
    title: "PR again",
    pins,
    pullRequestUrl,
  });

  expect(body).toMatchObject({
    created: false,
    reviewId: first.reviewId,
    opened: true,
  });
  expect(body.note).toEqual(expect.any(String));
  expect(Object.keys(body).slice(0, 2)).toEqual(["created", "note"]);
  expect(opened).toEqual([first.reviewId, first.reviewId]);
});

it("does not open a created review when Desktop is not attached", async () => {
  const open = vi.fn<OpenDesktop>(async () => ({ softwareMapEnabled: false }));

  const api = reviewApi({
    open,
    capabilities: () => ({ desktopAvailable: false, softwareMapEnabled: false }),
  });

  expect(
    await execute(api, { type: "create", source: "pins", title: "Headless", pins }),
  ).toMatchObject({ opened: false });
  expect(open).not.toHaveBeenCalled();
  // `open` is a create option, never part of a command.
  await expect(
    api.command(command({ type: "rename", reviewId: "x", title: "y", open: false }) as never, {
      signal,
    }),
  ).rejects.toBeInstanceOf(z.ZodError);
});

it("keeps a created review when Desktop fails to open it", async () => {
  const api = reviewApi({
    open: async () => {
      throw new Error("Desktop window closed.");
    },
  });

  const created = await execute(api, {
    type: "create",
    source: "pins",
    title: "Saved anyway",
    pins,
  });

  expect(created).toMatchObject({
    opened: false,
    openError: expect.stringContaining("Desktop window closed."),
  });
  expect(local.store.read(created.reviewId).title).toBe("Saved anyway");
});

it("lists the full repository path and hydrates diff counts from pinned commits", async () => {
  await local.store.execute(
    command({ type: "create", source: "pins", title: "Home metadata", pins }),
  );
  const api = reviewApi();
  const first = await api.catalog({ mode: "textual" });
  expect(first[0].repositoryPath).toBe(realpathSync(repository));
  expect(first[0].diffStats).toBeNull();
  await local.data.coverage(first[0].reviewId, pins, "textual");
  const ready = await api.catalog({ mode: "textual" });
  expect(ready[0].diffStats).toEqual({
    fileCount: 3,
    additions: 4,
    deletions: 1,
  });
  // Working-tree edits and attention changes cannot alter an immutable pinned diff.
  await local.store.execute(
    command({ type: "attention", reviewId: ready[0].reviewId, action: "view" }),
  );
  await local.data.coverage(first[0].reviewId, pins, "textual");
  expect(local.store.list("textual")[0]?.diffStats).toEqual(ready[0].diffStats);
});

it("returns map endpoint locations through an upload and allows correcting a rejected one", async () => {
  const api = reviewApi();
  const edge = { kind: "semantic", from: "api", to: "missing" };

  const upload = {
    id: randomUUID(),
    repositoryId: pins.repositoryId,
    kind: "map",
    pins,
    side: "head",
    model: {
      systems: {
        app: {
          containers: { api: { components: { handler: {} } }, db: {} },
          relationships: [edge],
        },
      },
      relationships: [{ kind: "semantic", from: "app.api.handler", to: "app.db" }],
    },
  };

  // As the tool boundary hands it over: parsed, not yet checked against the model.
  const send = () => api.upload(uploadSchema.parse(upload));

  const rejected = await send().catch((error: unknown) => error);
  expect(rejected).toMatchObject({ status: 400 });
  const error = (rejected as Error).message;
  expect(error).toContain("relationships[0] at app.to");
  expect(error).toContain('"missing"');
  expect(error).toContain("does not match an element path");
  expect(() => local.store.resource(upload.id)).toThrow(/not found/);

  edge.to = "db";
  expect(await send()).toMatchObject({ id: upload.id });

  const saved = JSON.parse(Buffer.from(local.store.resource(upload.id).data).toString());

  expect(saved.relationships).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ from: "app.api", to: "app.db" }),
      expect.objectContaining({ from: "app.api.handler", to: "app.db" }),
    ]),
  );
});

it("preserves map element and range details in upload errors", async () => {
  await expect(
    local.data.upload({
      id: randomUUID(),
      repositoryId: pins.repositoryId,
      kind: "map",
      pins,
      side: "head",
      model: {
        systems: {
          app: {
            containers: {
              api: {
                components: {
                  handler: {
                    codeElements: {
                      save: {
                        sourceRanges: [{ file: source.file, fromLine: 2, toLine: 1 }],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ).rejects.toThrow(/app\.api\.handler\.save.*sourceRanges\[0\].*fromLine <= toLine/);
});

it("validates Markdown source links against the pinned files before saving", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", source: "pins", title: "Links", pins }),
  );

  await insert(reviewId, {
    type: "markdown",
    markdown:
      "[base](review-source:base/example.ts#L1) and [head](review-source:head/example.ts#L1-L2)",
  });
  const saved = local.store.read(reviewId);

  for (const href of [
    "review-source:base/example.ts#L3",
    "review-source:head/missing.ts#L1",
    "review-source:head/../secret.ts#L1",
    "review-source:head/%2Fetc%2Fpasswd#L1",
  ]) {
    await expect(
      insert(reviewId, { type: "markdown", markdown: `[bad](${href})` }),
    ).rejects.toThrow(Error);
    expect(local.store.read(reviewId)).toEqual(saved);
  }
});

it("lists the version's commits and reads a selected commit's diff against its parent", async () => {
  const firstHead = pins.head;
  writeFileSync(path.join(repository, source.file), "export const value = 3;\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Second head");

  const updatedPins = await local.data.resolvePins(pins.repositoryId, pins.base, "HEAD");

  const review = await local.store.execute(
    command({ type: "create", source: "pins", title: "Two commits", pins: updatedPins }),
  );

  const api = reviewApi();
  const { reviewId } = review;

  const commits = await api.commits({ reviewId, version: 0 });

  expect(commits.map((item) => item.commit)).toEqual([updatedPins.head, firstHead]);
  const selected = { reviewId, version: 0, commit: firstHead };

  for (const side of ["base", "head"] as const) {
    const quoted = await api.source({
      ...selected,
      source: { side, file: "example.ts", fromLine: 1, toLine: 1 },
    });

    expect(quoted.text).toContain(side === "base" ? "value = 1" : "value = 2");
  }

  const file = await api.file({ ...selected, side: "head", file: "example.ts" });

  expect(file.text).toContain("value = 2");

  const patch = patchText(await api.diff({ ...selected, file: "example.ts" }));

  expect(patch).toContain("-export const value = 1;");
  expect(patch).toContain("+export const value = 2;");
  expect(patch).not.toContain("value = 3");
  await expect(api.diff({ reviewId, commit: pins.base })).rejects.toMatchObject({ status: 404 });
  await local.store.execute(
    command({
      type: "repin",
      reviewId,
      pins: { ...updatedPins, base: firstHead },
    }),
  );
  await expect(api.diff({ reviewId, commit: firstHead })).rejects.toMatchObject({ status: 404 });
  expect(await api.diff(selected)).toMatchObject({ format: "files" });
});

it("reads each version of one review at its own pins", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", source: "pins", title: "Versions", pins }),
  );

  writeFileSync(path.join(repository, source.file), "export const value = 3;\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Third");

  const later = await local.data.resolvePins(pins.repositoryId, pins.head, "HEAD");

  await local.store.execute(command({ type: "repin", reviewId, pins: later }));
  const first = local.store.read(reviewId, 0).source!.pins;
  const second = local.store.read(reviewId, 1).source!.pins;

  expect([first, second]).toEqual([pins, later]);
  expect((await local.data.commits(first)).map((item) => item.commit)).toEqual([pins.head]);
  expect((await local.data.commits(second)).map((item) => item.commit)).toEqual([later.head]);
  expect(await local.data.comparison(first, pins.head)).toEqual(pins);
  await expect(local.data.comparison(second, pins.head)).rejects.toThrow(
    "The selected commit is not part of this review version.",
  );
  expect(await local.data.file(first, "head", source.file)).toMatchObject({
    commit: pins.head,
    text: "export const value = 2;\nexport const saved = true;\n",
  });
  expect(await local.data.file(second, "head", source.file)).toMatchObject({
    commit: later.head,
    text: "export const value = 3;\n",
  });
});

it("serves a historical version's file at the pins that version was saved with", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", source: "pins", title: "Snapshot", pins }),
  );

  await insert(reviewId, { type: "code_peek", source: selectSource(source) });
  writeFileSync(path.join(repository, source.file), "export const value = 3;\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Third");

  const later = await local.data.resolvePins(pins.repositoryId, pins.head, "HEAD");

  await local.store.execute(command({ type: "repin", reviewId, pins: later }));
  expect(local.store.read(reviewId).version).toBe(2);

  const api = reviewApi();

  expect(await api.file({ reviewId, side: "head", version: 1, file: source.file })).toEqual({
    file: source.file,
    side: "head",
    commit: pins.head,
    text: "export const value = 2;\nexport const saved = true;\n",
  });
  expect(await api.file({ reviewId, side: "head", file: source.file })).toEqual({
    file: source.file,
    side: "head",
    commit: later.head,
    text: "export const value = 3;\n",
  });
});

it("browses committed directories, including history, without listing untracked files", async () => {
  mkdirSync(path.join(repository, "nested", "deeper"), { recursive: true });
  writeFileSync(path.join(repository, "nested", "deeper", "file.ts"), "pinned text\n");
  git("add", "nested");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Nested file");

  const nestedPins = await local.data.resolvePins(pins.repositoryId, pins.base, "HEAD");

  const { reviewId } = await local.store.execute(
    command({ type: "create", source: "pins", title: "Tree", pins: nestedPins }),
  );

  writeFileSync(path.join(repository, "untracked.ts"), "Not in the review\n");
  writeFileSync(path.join(repository, "nested", "deeper", "file.ts"), "dirty text\n");

  const api = reviewApi();

  const root = await api.tree({ reviewId });
  expect(root).toContainEqual({ path: "nested", kind: "directory" });
  expect(root).not.toContainEqual(expect.objectContaining({ path: "untracked.ts" }));
  expect(await api.tree({ reviewId, path: "nested" })).toEqual([
    { path: "nested/deeper", kind: "directory" },
  ]);
  expect(await api.tree({ reviewId, path: "nested/deeper" })).toEqual([
    { path: "nested/deeper/file.ts", kind: "file" },
  ]);
  expect(await local.data.file(nestedPins, "head", "nested/deeper/file.ts")).toMatchObject({
    text: "pinned text\n",
  });
  await expect(api.tree({ reviewId, side: "base", path: "nested" })).rejects.toMatchObject({
    status: 404,
  });
  await expect(api.tree({ reviewId, path: "../outside" })).rejects.toMatchObject({ status: 400 });
  await expect(api.tree({ reviewId, path: "example.ts" })).rejects.toMatchObject({ status: 404 });
  await local.store.execute(command({ type: "repin", reviewId, pins }));
  await expect(api.tree({ reviewId, path: "nested" })).rejects.toMatchObject({ status: 404 });
  expect(await api.tree({ reviewId, version: 0, path: "nested" })).toEqual([
    { path: "nested/deeper", kind: "directory" },
  ]);
});

it("reads pinned Git objects, rejects invalid evidence before saving, and retains registrations across restart", async () => {
  const review = await local.store.execute(
    command({ type: "create", source: "pins", title: "Pinned", pins }),
  );

  await insert(review.reviewId, {
    type: "code_peek",
    source: selectSource(source),
  });
  expect(await local.data.quote(pins, source)).toMatchObject({
    commit: pins.head,
    text: "export const value = 2;\nexport const saved = true;",
  });
  expect(await local.data.file(pins, "base", source.file)).toMatchObject({
    text: "export const value = 1;\n",
  });
  const diff = await local.data.changes(pins, source.file);
  expect(diff).toContain("+export const value = 2;");
  expect(diff).not.toContain("uncommitted");
  const literal = await local.data.changes(pins, "literal[1].ts");
  expect(literal).toContain("+exact filename");
  expect(literal).not.toContain("wrong pattern match");
  await expect(
    insert(review.reviewId, {
      type: "code_peek",
      source: selectSource({ ...source, toLine: 4 }),
    }),
  ).rejects.toThrow(/exceeds/);
  await expect(local.data.file(pins, "head", "../outside.ts")).rejects.toThrow(/relative/);
  await expect(
    local.store.execute(
      command({
        type: "repin",
        reviewId: review.reviewId,
        pins: { ...pins, head: "HEAD" },
      }),
    ),
  ).rejects.toThrow(/resolved commit/);
  expect(local.store.read(review.reviewId).version).toBe(1);
  await local.store.close();
  await local.data.close();
  local = openLocalReviewStore(database, { watch });
  expect((await local.data.register(repository)).id).toBe(pins.repositoryId);
  expect(local.store.read(review.reviewId).document).toHaveLength(1);
  expect(await local.data.quote(pins, source)).toMatchObject({
    commit: pins.head,
  });
});

it("refuses a committed binary file as a code reference", async () => {
  writeFileSync(path.join(repository, "binary.bin"), "text\u0000more\n");
  git("add", "binary.bin");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Binary");

  const binaryPins = await local.data.resolvePins(pins.repositoryId, pins.head, "HEAD");

  await expect(local.data.file(binaryPins, "head", "binary.bin")).rejects.toThrow(
    "Binary files cannot be used as code references.",
  );
});

it("reads a committed empty file as empty text, not a missing file", async () => {
  writeFileSync(path.join(repository, "blank.ts"), "");
  git("add", "blank.ts");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Blank");

  const blankPins = await local.data.resolvePins(pins.repositoryId, pins.head, "HEAD");

  expect(await local.data.file(blankPins, "head", "blank.ts")).toMatchObject({
    text: "",
  });
});

it("reads a committed symlink as its target path, not the file it points at", async () => {
  const outside = path.join(directory, "outside.txt");

  writeFileSync(outside, "text outside the repository\n");
  symlinkSync(outside, path.join(repository, "link.ts"));
  git("add", "link.ts");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Symlink");

  const linkPins = await local.data.resolvePins(pins.repositoryId, pins.head, "HEAD");

  expect(await local.data.file(linkPins, "head", "link.ts")).toEqual({
    file: "link.ts",
    side: "head",
    commit: linkPins.head,
    text: outside,
  });
});

it("rejects a code peek on blank lines but accepts a prose link to them", async () => {
  mkdirSync(path.join(repository, "src"));
  writeFileSync(path.join(repository, "src/blank.ts"), "export const a = 1;\n\n\n// end\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Blank lines");

  const blankPins = await local.data.resolvePins(pins.repositoryId, "HEAD^", "HEAD");

  const blank = {
    side: "head",
    file: "src/blank.ts",
    fromLine: 2,
    toLine: 3,
  } as const;

  await expect(local.data.validateSource(blankPins, blank, { peek: true })).rejects.toThrow(
    "src/blank.ts:2-3 contains only whitespace",
  );
  await expect(
    local.data.validateSource(blankPins, blank, { peek: false }),
  ).resolves.toBeUndefined();
});

it("copies prose with the displayed version's title and immutable review identity", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", source: "pins", title: "Original title", pins }),
  );

  await local.store.execute(command({ type: "rename", reviewId, title: "Latest title" }));
  const api = reviewApi();

  const copied = await api.copyContext({
    reviewId,
    version: 0,
    selection: { target: { kind: "text", quote: "First line\nSecond line" }, title: "Selection" },
  });

  expect(copied).toEqual({
    text: `Selected text from Whiteboard: Original title\nSession ID: ${reviewId}\nVersion: 0\nRepository ID: ${pins.repositoryId}\nSession base: ${pins.base}\nSession head: ${pins.head}\nRead this version with whiteboard_session_get({"sessionId":"${reviewId}","version":0,"full":true}).\n\n> First line\n> Second line\n\n`,
    handoff: {
      quote: "First line\nSecond line",
      sessionId: reviewId,
      version: 0,
      title: "Original title",
    },
  });
});

it("copies code from historical pins after a repin, never from working-tree contents", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", source: "pins", title: "Code", pins }),
  );

  await local.store.execute(
    command({ type: "repin", reviewId, pins: { ...pins, head: pins.base } }),
  );
  const api = reviewApi();

  const selection: AgentSelection = {
    target: {
      kind: "code",
      path: source.file,
      side: "head",
      startLine: 1,
      endLine: 1,
    },
    title: "Value",
    detail: "Selected source",
  };

  expect(await api.copyContext({ reviewId, version: 0, selection })).toEqual({
    text: `Selected code from Whiteboard: Code\nSession ID: ${reviewId}\nVersion: 0\nRepository ID: ${pins.repositoryId}\nSession base: ${pins.base}\nSession head: ${pins.head}\nRead this version with whiteboard_session_get({"sessionId":"${reviewId}","version":0,"full":true}).\n\n## Value\n\nSelected source\n\n## head: example.ts:1-1 (${pins.head})\n    export const value = 2;\n\n`,
    handoff: {
      quote: `## Value\n\nSelected source\n\n## head: example.ts:1-1 (${pins.head})\n    export const value = 2;`,
      sessionId: reviewId,
      version: 0,
      title: "Code",
    },
  });

  const latest = await api.copyContext({ reviewId, selection });

  expect(latest.text).toContain("    export const value = 1;");
});

it("copies a diff selection from its pinned version and selected commit, and rejects another review", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", source: "pins", title: "Code", pins }),
  );

  await local.store.execute(
    command({ type: "repin", reviewId, pins: { ...pins, head: pins.base } }),
  );
  const api = reviewApi();

  const selection = {
    target: {
      kind: "code",
      path: source.file,
      side: "base",
      startLine: 1,
      endLine: 1,
    },
    title: "Selected parent",
    apiSource: { reviewId, version: 0, commit: pins.head },
  } satisfies AgentSelection;

  const copy = (payload: AgentSelection) => api.copyContext({ reviewId, selection: payload });

  const { text } = await copy(selection);
  expect(text).toContain("Version: 0");
  expect(text).toContain(`Selected commit: ${pins.head}`);
  expect(text).toContain(`base: example.ts:1-1 (${pins.base})`);
  expect(text).toContain("export const value = 1;");
  expect(text).not.toContain("export const value = 2;");
  await expect(
    copy({
      ...selection,
      apiSource: { ...selection.apiSource, reviewId: "another-review" },
    }),
  ).rejects.toMatchObject({ status: 400, message: "Selection belongs to another review." });
  await expect(
    copy({
      ...selection,
      apiSource: { ...selection.apiSource, version: 999 },
    }),
  ).rejects.toMatchObject({ status: 404 });
});

it("copies selected diff rows with rename paths without resolving an unavailable source", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", source: "pins", title: "Rename", pins }),
  );

  // Use selected diff rows; the new path may not exist on the base commit.
  const resolve = vi.spyOn(local.data, "resolveSource");
  const quote = vi.spyOn(local.data, "quote");

  const copied = await reviewApi().copyContext({
    reviewId,
    version: 0,
    selection: {
      target: {
        kind: "code",
        path: "new.md",
        side: "base",
        startLine: 4,
        endLine: 5,
      },
      title: "Renamed source",
      selectedDiff: {
        oldPath: "old.md",
        newPath: "new.md",
        oldStart: 4,
        newStart: 7,
        rows: [
          { kind: "deleted", text: "before" },
          { kind: "added", text: "```typescript" },
          { kind: "unchanged", text: "context" },
        ],
      },
    },
  });

  expect(resolve).not.toHaveBeenCalled();
  expect(quote).not.toHaveBeenCalled();
  expect(copied.text).toContain(
    "Base: a/old.md\nHead: b/new.md\nRange: -4,2 +7,2\n\n````diff\n-before\n+```typescript\n context\n````\n\n",
  );
});

it("refuses invalid copy requests, unavailable versions, and missing source files", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", source: "pins", title: "Errors", pins }),
  );

  const api = reviewApi();

  const selection: AgentSelection = {
    target: {
      kind: "code",
      path: "missing.ts",
      side: "head",
      startLine: 1,
      endLine: 1,
    },
    title: "Missing source",
  };

  // The RPC boundary refuses malformed selections and versions before any operation runs.
  expect(
    copyContextInput.safeParse({ sessionId: reviewId, selection: { title: "Invalid" } }).success,
  ).toBe(false);
  expect(
    copyContextInput.safeParse({ sessionId: reviewId, version: "nope", selection }).success,
  ).toBe(false);

  for (const [input, message] of [
    [{ reviewId, version: 99 }, "Review or version not found."],
    [{ reviewId: "missing" }, "Review or version not found."],
    [{ reviewId }, "File is unavailable at the pinned commit."],
  ] as const)
    await expect(api.copyContext({ ...input, selection })).rejects.toMatchObject({
      status: 404,
      message,
    });
});

it("resolves omitted commit base once and preserves explicit parent comparisons", async () => {
  const repositoryId = pins.repositoryId;

  const result = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "Single commit",
      target: { kind: "commits", repositoryId, head: "HEAD" },
    }),
  );

  const snapshot = local.store.read(result.reviewId);
  expect(snapshot.source?.pins).toEqual({
    repositoryId,
    base: pins.head,
    head: pins.head,
  });
  expect(await local.data.changes(snapshot.source!.pins)).toEqual([]);
  expect(await local.data.file(snapshot.source!.pins, "head", "example.ts")).toEqual(
    await local.data.file(pins, "head", "example.ts"),
  );

  const explicit = await local.data.resolveTarget({
    kind: "commits",
    repositoryId,
    head: "HEAD",
    base: "HEAD",
  });

  expect(explicit.pins).toEqual(snapshot.source?.pins);

  const comparison = await local.data.resolveTarget({
    kind: "commits",
    repositoryId,
    head: pins.head,
    base: pins.base,
  });

  expect(await local.data.changes(comparison.pins)).not.toEqual([]);
});

it("retains working source across authored versions, commits and retargeting", async () => {
  const beforeIndex = git("diff", "--cached");
  const repositoryId = pins.repositoryId;
  writeFileSync(path.join(repository, "example.ts"), "export const live = 1;\n");
  writeFileSync(path.join(repository, "untracked.ts"), "export const fresh = true;\n");

  const request = command({
    type: "create",
    source: "target",
    title: "Working files",
    target: { kind: "worktree", repositoryId },
  });

  const result = await local.store.execute(request);
  const original = local.store.read(result.reviewId, 0);
  expect((await local.data.file(original.source!.pins, "head", "example.ts")).text).toContain(
    "live = 1",
  );
  expect(await local.data.tree(original.source!.pins, "head", "")).toContainEqual({
    path: "untracked.ts",
    kind: "file",
  });
  expect(await local.data.changes(original.source!.pins)).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: "untracked.ts", status: "added" })]),
  );
  writeFileSync(path.join(repository, "example.ts"), "export const live = 2;\n");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await local.store.refreshWorktrees();
  const current = local.store.read(result.reviewId);
  expect((await local.data.file(current.source!.pins, "head", "example.ts")).text).toContain(
    "live = 2",
  );
  expect(
    (await local.data.file(local.store.read(result.reviewId, 0).source!.pins, "head", "example.ts"))
      .text,
  ).toContain("live = 1");
  expect(local.store.history(result.reviewId)).toHaveLength(1);
  expect(await local.store.execute(request)).toEqual(result);
  expect(git("diff", "--cached")).toBe(beforeIndex);
  git("add", ".");
  git("commit", "-qm", "Save changes");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await local.store.refreshWorktrees();
  expect(await local.data.changes(local.store.read(result.reviewId).source!.pins)).toEqual([]);
  await local.store.execute(
    command({
      type: "set_target",
      reviewId: result.reviewId,
      target: { kind: "commits", repositoryId, head: pins.head },
    }),
  );
  expect(local.store.read(result.reviewId).source?.target.kind).toBe("commits");
  expect((await local.data.file(original.source!.pins, "head", "example.ts")).text).toContain(
    "live = 1",
  );
});

it("reads symlink text and an unborn repository without following external links or pinning", async () => {
  const root = path.join(directory, "unborn");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root]);
  const repo = await local.data.register(root);
  const outside = path.join(directory, "private.ts");
  writeFileSync(outside, "secret\n");
  symlinkSync(outside, path.join(root, "external.ts"));
  writeFileSync(path.join(root, "first.ts"), "export const first = 1;\n");

  const result = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "Unborn",
      target: { kind: "worktree", repositoryId: repo.id },
    }),
  );

  const snapshot = local.store.read(result.reviewId);
  expect((await local.data.file(snapshot.source!.pins, "head", "first.ts")).text).toContain(
    "first = 1",
  );
  expect((await local.data.file(snapshot.source!.pins, "head", "external.ts")).text).toBe(outside);
  expect(await local.data.changes(snapshot.source!.pins)).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: "first.ts", status: "added" })]),
  );
  expect(
    execFileSync("git", ["-C", root, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    }).match(/^worktree /gm),
  ).toHaveLength(1);
});

it("keeps authored coordinates fixed as live source changes and warns only on unavailable ranges", async () => {
  writeFileSync(
    path.join(repository, "range.ts"),
    "const first = 1;\nconst second = 2;\nconst third = 3;\n",
  );

  const result = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "Ranges",
      target: {
        kind: "worktree",
        repositoryId: pins.repositoryId,
        base: pins.base,
      },
    }),
  );

  await insert(result.reviewId, {
    type: "code_peek",
    source: selectSource({
      side: "head",
      file: "range.ts",
      fromLine: 2,
      toLine: 2,
    }),
  });
  const saved = local.store.read(result.reviewId);
  writeFileSync(
    path.join(repository, "range.ts"),
    "// inserted\nconst first = 1;\nconst second = 2;\nconst third = 3;\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  await local.store.refreshWorktrees();
  expect(local.store.read(result.reviewId).document[0]).toMatchObject({
    source: { start: { line: 2 }, end: { line: 2 } },
  });
  expect(local.store.read(result.reviewId, saved.version).document[0]).toMatchObject({
    source: { start: { line: 2 }, end: { line: 2 } },
  });
  writeFileSync(path.join(repository, "range.ts"), "const first = 99;\n");
  await vi.waitFor(
    async () => {
      await local.store.refreshWorktrees();
      expect(local.store.read(result.reviewId).staleSources).toEqual([saved.document[0]!.id]);
    },
    { timeout: 5_000 },
  );
});

it("reads retained checkout for an older authored version", async () => {
  const api = reviewApi();
  writeFileSync(path.join(repository, "example.ts"), "const generation = 1;\n");

  const result = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "Coherence",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  writeFileSync(path.join(repository, "example.ts"), "const generation = 2;\n");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const read = (version?: number) =>
    api.file({ reviewId: result.reviewId, side: "head", file: "example.ts", version });

  expect(await read()).toMatchObject({ text: "const generation = 2;\n" });

  expect(await read(0)).toMatchObject({
    text: "const generation = 1;\n",
  });
  expect(await read()).toMatchObject({
    localPath: realpathSync(path.join(repository, "example.ts")),
  });
  expect(await read(0)).not.toHaveProperty("localPath");
});

it("keeps multiple worktrees bound to their selected directory and survives reopening the store", async () => {
  const otherPath = path.join(directory, "other-worktree");
  git("worktree", "add", "--detach", otherPath, pins.head);
  writeFileSync(path.join(otherPath, "example.ts"), "const otherCheckout = true;\n");
  const other = await local.data.register(otherPath);

  const one = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "First",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  const two = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "Second",
      target: { kind: "worktree", repositoryId: other.id },
    }),
  );

  const retained = local.store.read(two.reviewId);
  await local.store.close();
  await local.data.close();
  local = openLocalReviewStore(database, { watch });
  await local.store.refreshWorktrees();
  expect(
    (await local.data.file(local.store.read(one.reviewId).source!.pins, "head", "example.ts")).text,
  ).toContain("uncommitted text");
  expect(
    (await local.data.file(local.store.read(two.reviewId).source!.pins, "head", "example.ts")).text,
  ).toContain("otherCheckout");
  expect(
    (
      await local.data.file(
        local.store.read(two.reviewId, retained.version).source!.pins,
        "head",
        "example.ts",
      )
    ).text,
  ).toContain("otherCheckout");
  expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2);
});

it("includes saved additions and deletions while keeping ignored and binary sources explicit", async () => {
  writeFileSync(path.join(repository, ".gitignore"), "ignored.ts\n");
  writeFileSync(path.join(repository, "ignored.ts"), "secret\n");
  writeFileSync(path.join(repository, "binary.dat"), Buffer.from([0, 1, 2]));
  writeFileSync(path.join(repository, "__proto__"), "legitimate filename\n");
  rmSync(path.join(repository, "example.ts"));

  const result = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "Files",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  const snapshot = local.store.read(result.reviewId);
  const files = await local.data.tree(snapshot.source!.pins, "head", "");
  expect(files).not.toContainEqual({ path: "ignored.ts", kind: "file" });
  expect(files).not.toContainEqual({ path: "example.ts", kind: "file" });
  expect((await local.data.file(snapshot.source!.pins, "head", "__proto__")).text).toBe(
    "legitimate filename\n",
  );
  await expect(local.data.file(snapshot.source!.pins, "head", "binary.dat")).rejects.toThrow(
    "Binary",
  );
  expect(await local.data.changes(snapshot.source!.pins)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "example.ts", status: "deleted" }),
      expect.objectContaining({ path: "binary.dat", status: "added" }),
    ]),
  );
});

it.skipIf(spawnSync("jj", ["--version"]).status !== 0)(
  "reads unsnapshotted jj working files without changing the operation or Git index",
  async () => {
    const root = path.join(directory, "jj-working");
    execFileSync("jj", ["git", "init", root]);

    const jj = (...args: string[]) =>
      execFileSync("jj", ["-R", root, ...args, "--ignore-working-copy"], {
        encoding: "utf8",
      }).trim();

    const repo = await local.data.register(root);
    const base = jj("log", "--no-graph", "-r", "@", "-T", "commit_id");
    const operation = jj("op", "log", "--no-graph", "--limit", "1", "-T", "id");
    writeFileSync(path.join(root, "new.ts"), "export const unsnapshotted = 1;\n");

    const result = await local.store.execute(
      command({
        type: "create",
        source: "target",
        title: "jj working",
        target: { kind: "worktree", repositoryId: repo.id, base },
      }),
    );

    expect(
      (await local.data.file(local.store.read(result.reviewId).source!.pins, "head", "new.ts"))
        .text,
    ).toContain("unsnapshotted");
    expect(await local.data.changes(local.store.read(result.reviewId).source!.pins)).toEqual([
      expect.objectContaining({ path: "new.ts", status: "added" }),
    ]);
    expect(jj("op", "log", "--no-graph", "--limit", "1", "-T", "id")).toBe(operation);
  },
);

it("retargets a live review without losing authored content or component IDs", async () => {
  const created = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "Retarget",
      target: {
        kind: "worktree",
        repositoryId: pins.repositoryId,
        base: pins.base,
      },
    }),
  );

  await insert(created.reviewId, {
    type: "code_peek",
    source: selectSource({
      side: "head",
      file: "example.ts",
      fromLine: 1,
      toLine: 1,
    }),
  });
  const before = local.store.read(created.reviewId);

  const result = await local.store.execute(
    command({
      type: "set_target",
      reviewId: created.reviewId,
      target: {
        kind: "commits",
        repositoryId: pins.repositoryId,
        head: pins.head,
      },
    }),
  );

  expect(local.store.read(created.reviewId).document).toEqual(before.document);
  expect(result.warnings?.length).toBeGreaterThan(0);
  expect(
    (
      await local.data.file(
        local.store.read(created.reviewId, before.version).source!.pins,
        "head",
        "example.ts",
      )
    ).text,
  ).toContain("uncommitted text");
});

it("leaves authored Markdown destinations unchanged when source lines move", async () => {
  const original = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";

  writeFileSync(path.join(repository, "links.ts"), original);

  const created = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "Links",
      target: {
        kind: "worktree",
        repositoryId: pins.repositoryId,
        base: pins.head,
      },
    }),
  );

  await insert(created.reviewId, {
    type: "markdown",
    markdown: "[one](review-source:head/links.ts#L1) [ten](review-source:head/links.ts#L10-L20)",
  });
  writeFileSync(path.join(repository, "links.ts"), "inserted\n" + original);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await local.store.refreshWorktrees();
  expect(local.store.read(created.reviewId).document[0]).toMatchObject({
    markdown: "[one](review-source:head/links.ts#L1) [ten](review-source:head/links.ts#L10-L20)",
  });
});

it("does not report clean tracked symlinks and submodules as modified", async () => {
  symlinkSync("example.ts", path.join(repository, "tracked-link.ts"));
  const modulePath = path.join(directory, "module");
  mkdirSync(modulePath);
  execFileSync("git", ["init", "-q", modulePath]);
  writeFileSync(path.join(modulePath, "file.txt"), "module\n");
  execFileSync("git", ["-C", modulePath, "add", "."]);
  execFileSync("git", [
    "-C",
    modulePath,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "Initial",
  ]);
  git("-c", "protocol.file.allow=always", "submodule", "add", modulePath, "module");
  git("add", ".");
  git("commit", "-qm", "Link and module");
  const head = git("rev-parse", "HEAD");

  const created = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "Clean modes",
      target: { kind: "worktree", repositoryId: pins.repositoryId, base: head },
    }),
  );

  expect(await local.data.changes(local.store.read(created.reviewId).source!.pins)).toEqual([]);
  expect(
    (
      await local.data.file(
        local.store.read(created.reviewId).source!.pins,
        "head",
        "tracked-link.ts",
      )
    ).text,
  ).toBe("example.ts");
  const snapshot = local.store.read(created.reviewId);
  await expect(local.data.file(snapshot.source!.pins, "head", "module")).rejects.toThrow(
    "not a regular file",
  );

  await expect(
    reviewApi().file({ reviewId: created.reviewId, side: "head", file: "module" }),
  ).rejects.toMatchObject({ status: 400, message: "Source is not a regular file." });
});

it("continues capturing after watchers fail and stop emitting changes", async () => {
  await local.data.close();
  await local.store.close();
  const watchers: FSWatcher[] = [];
  local = openLocalReviewStore(database, {
    watch: ((...args: Parameters<typeof watch>) => {
      const watcher = watch(...args);
      watchers.push(watcher);

      return watcher;
    }) as typeof watch,
  });

  const created = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "Watcher recovery",
      target: {
        kind: "worktree",
        repositoryId: pins.repositoryId,
        base: pins.head,
      },
    }),
  );

  for (const watcher of watchers)
    watcher.emit("error", Object.assign(new Error("Watch limit"), { code: "ENOSPC" }));

  for (const value of ["first change\n", "second change\n"]) {
    writeFileSync(path.join(repository, "example.ts"), value);
    await local.store.refreshWorktrees();
    expect(
      (await local.data.file(local.store.read(created.reviewId).source!.pins, "head", "example.ts"))
        .text,
    ).toBe(value);
  }
});

it("keeps live language identity across edits but replaces it with a checkout at the same path", async () => {
  const created = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "Environment identity",
      target: {
        kind: "worktree",
        repositoryId: pins.repositoryId,
        base: pins.base,
      },
    }),
  );

  const saved = local.store.read(created.reviewId, created.version);
  const before = await local.data.languageEnvironment(saved);
  const retained = await local.data.file(saved.source!.pins, "head", source.file);
  writeFileSync(path.join(repository, "identity.ts"), "const changed = true;");
  expect(await local.data.languageEnvironment(saved)).toEqual(before);
  const moved = `${repository}-previous`;
  renameSync(repository, moved);

  try {
    expect((await local.data.languageEnvironment(saved)).rootPath).toBeNull();
    mkdirSync(repository);
    execFileSync("git", ["clone", "--quiet", moved, repository]);
    const replacement = await local.data.languageEnvironment(saved);
    expect(replacement.rootPath).toBe(before.rootPath);
    expect(replacement.identity).not.toBe(before.identity);
    expect(retained.text).toBeTruthy();
    await expect(local.data.file(saved.source!.pins, "head", source.file)).rejects.toThrow(
      "retained working source is unavailable",
    );
  } finally {
    rmSync(moved, { recursive: true, force: true });
  }
});

it("marks a commit-pinned review unavailable while its repository is gone", async () => {
  const review = await local.store.execute(
    command({ type: "create", source: "pins", title: "Moved repository", pins }),
  );

  const api = reviewApi();
  const moved = `${repository}-moved`;
  renameSync(repository, moved);

  // The live read refreshes the store first, so it sees the checkout gone.
  expect(await api.liveSession({ reviewId: review.reviewId })).toMatchObject({
    title: "Moved repository",
    live: { kind: "unavailable" },
  });
  await local.store.refreshWorktrees();
  expect(local.store.read(review.reviewId).live).toEqual({ kind: "unavailable" });
  // A pinned version bypasses both the refresh loop and the live overlay.
  expect(await api.sessionVersion({ reviewId: review.reviewId, version: 0 })).toMatchObject({
    live: { kind: "unavailable" },
  });

  renameSync(moved, repository);
  await local.store.refreshWorktrees();

  expect(local.store.read(review.reviewId).live.kind).toBe("available");
});

it("never stores the unavailable flag on a version authored while degraded", async () => {
  const review = await local.store.execute(
    command({ type: "create", source: "pins", title: "Edited while gone", pins }),
  );

  const moved = `${repository}-moved`;
  renameSync(repository, moved);
  await local.store.refreshWorktrees();

  const edited = await insert(review.reviewId, {
    type: "markdown",
    markdown: "Authored with no checkout.",
  });

  renameSync(moved, repository);
  await local.store.refreshWorktrees();

  expect(local.store.read(review.reviewId, edited.version)).not.toHaveProperty("live");
});

it("keeps an anchor whose own checkout is temporarily gone out of the stored stale list", async () => {
  const other = path.join(directory, "other");
  mkdirSync(other);

  const otherGit = (...args: string[]) =>
    execFileSync("git", args, { cwd: other, encoding: "utf8" }).trim();

  otherGit("init", "-q");
  otherGit("config", "user.name", "Review Test");
  otherGit("config", "user.email", "review-test@example.invalid");
  writeFileSync(path.join(other, "lib.ts"), "export const other = 1;\n");
  otherGit("add", ".");
  otherGit("-c", "commit.gpgsign=false", "commit", "-qm", "Other");
  const registered = await local.data.register(other);
  const own = { repositoryId: registered.id, head: otherGit("rev-parse", "HEAD") };

  const { reviewId } = await local.store.execute(
    command({ type: "create", source: "pins", title: "Anchored elsewhere", pins }),
  );
  const peek = await insert(reviewId, {
    type: "code_peek",
    source: {
      file: "lib.ts",
      start: { side: "head", line: 1 },
      end: { side: "head", line: 1 },
      pins: own,
    },
  });

  const moved = `${other}-moved`;
  renameSync(other, moved);
  await local.store.refreshWorktrees();

  const edited = await insert(reviewId, {
    type: "markdown",
    markdown: "Authored while the other checkout was away.",
  });

  renameSync(moved, other);
  await local.store.refreshWorktrees();

  // Unavailability is a live condition, never an authored stale range.
  expect(local.store.read(reviewId, edited.version).staleSources ?? []).not.toContain(
    peek.targetId,
  );
  expect(local.store.read(reviewId).staleSources ?? []).not.toContain(peek.targetId);
  expect(edited.warnings ?? []).toEqual([]);
});

it("answers a source read with 404 while the checkout is gone", async () => {
  const review = await local.store.execute(
    command({ type: "create", source: "pins", title: "Moved repository", pins }),
  );

  const api = reviewApi();
  renameSync(repository, `${repository}-moved`);

  await expect(api.commits({ reviewId: review.reviewId })).rejects.toMatchObject({
    status: 404,
    message: "The selected local checkout is unavailable.",
  });
  // Direct callers skip the snapshot check and reach the checkout itself.
  await expect(local.data.commits(pins)).rejects.toThrow(
    "The selected local checkout is unavailable.",
  );
});

it("marks a worktree review unavailable while its checkout is gone", async () => {
  const review = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "Moved worktree",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  renameSync(repository, `${repository}-moved`);
  await local.store.refreshWorktrees();

  expect(local.store.read(review.reviewId).live).toEqual({ kind: "unavailable" });
});

it("validates grouped source ranges with one read per pinned file", async () => {
  const read = vi.spyOn(local.data, "file");

  try {
    await local.data.validateSources(pins, [source, { ...source, fromLine: 2 }]);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(
      local.data.validateSources(pins, [source, { ...source, toLine: 100000 }]),
    ).rejects.toThrow("exceeds the pinned file");
    await expect(
      local.data.validateSources(pins, [{ ...source, file: "missing.ts" }]),
    ).rejects.toThrow("unavailable");
    read.mockClear();
    await local.data.validateSources(pins, [source, { ...source, side: "base", toLine: 1 }]);
    expect(read).toHaveBeenCalledTimes(pins.base === pins.head ? 1 : 2);
  } finally {
    read.mockRestore();
  }
});

describe("diff", () => {
  const exampleLines = (changed: number) =>
    Array.from({ length: 12 }, (_, index) =>
      index + 1 === changed ? "changed line" : `line ${index + 1}`,
    ).join("\n") + "\n";

  let reviewId: string;
  let call: (input: Omit<DiffInput, "reviewId">) => Promise<unknown>;

  beforeEach(async () => {
    writeFileSync(path.join(repository, source.file), exampleLines(0));
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "Twelve lines");
    const base = git("rev-parse", "HEAD");
    writeFileSync(path.join(repository, source.file), exampleLines(6));
    mkdirSync(path.join(repository, "dir"));
    git("mv", "literal1.ts", "dir/moved.ts");
    writeFileSync(
      path.join(repository, "dir/big.ts"),
      Array.from({ length: 40 }, (_, index) => `big ${index}`).join("\n") + "\n",
    );
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "Change");

    const diffPins = await local.data.resolvePins(pins.repositoryId, base, "HEAD");

    ({ reviewId } = await local.store.execute(
      command({ type: "create", source: "pins", title: "Diff", pins: diffPins }),
    ));

    const api = reviewApi();

    // Files as a list, patches as their text, as the diff tool shows them.
    call = async (input) => {
      const result = await api.diff({ reviewId, ...input });

      return result.format === "files" ? result.files : result.text;
    };
  });

  it("lists every changed file, or those a pathspec names", async () => {
    expect(await call({})).toEqual([
      { path: "dir/big.ts", status: "added", additions: 40, deletions: 0 },
      {
        path: "dir/moved.ts",
        previousPath: "literal1.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
      },
      { path: "example.ts", status: "modified", additions: 1, deletions: 1 },
    ]);
    expect(await call({ paths: ["example.ts"] })).toEqual([
      { path: "example.ts", status: "modified", additions: 1, deletions: 1 },
    ]);
    expect(
      ((await call({ paths: ["dir/", "literal1.ts"] })) as { path: string }[]).map(
        (file) => file.path,
      ),
    ).toEqual(["dir/big.ts", "dir/moved.ts"]);
  });

  it("returns every patch with base and head line numbers", async () => {
    const text = (await call({ format: "patch" })) as string;

    expect(text).toContain("diff --git a/dir/big.ts b/dir/big.ts\n");
    expect(text).toContain("   40 +big 39\n");
    expect(text).toContain(
      "diff --git a/literal1.ts b/dir/moved.ts\nsimilarity index 100%\nrename from literal1.ts\nrename to dir/moved.ts\n",
    );
    expect(text).toContain(
      [
        "diff --git a/example.ts b/example.ts",
        "@@ -3,7 +3,7 @@ line 2",
        " 3  3  line 3",
        " 4  4  line 4",
        " 5  5  line 5",
        " 6    -line 6",
        "    6 +changed line",
        " 7  7  line 7",
        " 8  8  line 8",
        " 9  9  line 9",
        "",
      ].join("\n"),
    );
  });

  it("returns only the patches a pathspec names, both sides of a rename included", async () => {
    const text = (await call({
      format: "patch",
      paths: ["dir/moved.ts", "missing.ts"],
    })) as string;

    expect(text).toContain("rename from literal1.ts\nrename to dir/moved.ts");
    expect(text).not.toContain("example.ts");
    expect(text).not.toContain("big.ts");
    expect(text).toContain('[No changes match paths:["missing.ts"].]');
  });

  it("reads a legacy file as its numbered patch and rejects mixing it with paths or format", async () => {
    expect(await call({ file: "example.ts" })).toBe(
      await call({ format: "patch", paths: ["example.ts"] }),
    );
    await expect(call({ file: "example.ts", paths: ["example.ts"] })).rejects.toThrow(
      /file cannot be combined with paths or format/,
    );
    await expect(call({ file: "example.ts", format: "patch" })).rejects.toThrow(
      /file cannot be combined/,
    );
  });

  it("lists patches past maxBytes with a paths hint", async () => {
    const text = (await call({ format: "patch", maxBytes: 400 })) as string;

    expect(text).toContain("diff --git a/dir/big.ts");
    expect(text).toContain("[dir/big.ts is cut at the 400-byte budget after");
    expect(text).toMatch(
      /\[2 more files over the 400-byte budget: dir\/moved\.ts, example\.ts \(\+1 -1\)\. Fetch them with paths:\["dir\/moved\.ts","example\.ts"\], format:"patch"\.\]\n$/,
    );

    const next = (await call({
      format: "patch",
      paths: ["dir/moved.ts", "example.ts"],
      maxBytes: 400,
    })) as string;

    expect(next).toContain("rename to dir/moved.ts");
    expect(next).toContain("diff --git a/example.ts b/example.ts");
    expect(next).not.toContain("budget");
  });

  it("applies context lines around each change", async () => {
    expect(await call({ format: "patch", paths: ["example.ts"], context: 0 })).toBe(
      [
        "diff --git a/example.ts b/example.ts",
        "@@ -6 +6 @@ line 5",
        "6   -line 6",
        "  6 +changed line",
        "",
      ].join("\n"),
    );
  });
});

it("patches working files of a worktree review, untracked files included", async () => {
  const api = reviewApi();

  const { reviewId } = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "Working",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  writeFileSync(path.join(repository, "fresh.ts"), "fresh\n");

  const list = await api.diff({ reviewId });

  expect(list).toEqual({
    format: "files",
    files: expect.arrayContaining([expect.objectContaining({ path: "fresh.ts", status: "added" })]),
  });

  const text = patchText(
    await api.diff({ reviewId, format: "patch", paths: ["fresh.ts", source.file] }),
  );

  expect(text).toContain("diff --git a/fresh.ts b/fresh.ts\nnew file mode");
  expect(text).toContain("  1 +fresh\n");
  expect(text).toContain("+uncommitted text must never appear");
  expect(text).not.toContain("literal");
});

it("saves the head branch for pinned reviews and preserves it across checkout changes", async () => {
  git("checkout", "-b", "feature/saved-head");

  const created = await local.store.execute(
    command({ type: "create", source: "pins", title: "Branch provenance", pins }),
  );

  expect(local.store.read(created.reviewId).origin?.branch).toBe("feature/saved-head");
  git("checkout", "-b", "feature/another");
  await local.store.execute(
    command({ type: "rename", reviewId: created.reviewId, title: "Renamed" }),
  );
  expect(
    local.store.list().find((review) => review.reviewId === created.reviewId)?.origin?.branch,
  ).toBe("feature/saved-head");

  await local.store.close();
  await local.data.close();
  local = openLocalReviewStore(database, { watch });
  expect(local.store.read(created.reviewId).origin?.branch).toBe("feature/saved-head");
});

it("saves the requested head branch for commit and live worktree targets", async () => {
  git("branch", "feature/requested");

  const fixed = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "Named head",
      target: {
        kind: "commits",
        repositoryId: pins.repositoryId,
        head: "feature/requested",
        base: pins.base,
      },
    }),
  );

  expect(local.store.read(fixed.reviewId).origin?.branch).toBe("feature/requested");
  git("checkout", "-b", "feature/live");

  const live = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "Live head",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  expect(local.store.read(live.reviewId).origin?.branch).toBe("feature/live");

  const pinned = await local.store.execute(
    command({
      type: "create",
      source: "target",
      title: "Resolved target",
      target: {
        kind: "commits",
        repositoryId: pins.repositoryId,
        base: pins.base,
        head: pins.head,
      },
    }),
  );

  expect(local.store.read(pinned.reviewId).origin?.branch).toBe("feature/live");
});

it("does not invent a head branch for detached or unrelated pinned commits", async () => {
  git("checkout", "-b", "feature/head");
  expect(await local.data.headBranch({ ...pins, head: pins.base })).toBeUndefined();
  git("checkout", "--detach", pins.head);

  const created = await local.store.execute(
    command({ type: "create", source: "pins", title: "Detached", pins }),
  );

  expect(local.store.read(created.reviewId).origin?.branch).toBeUndefined();
});
