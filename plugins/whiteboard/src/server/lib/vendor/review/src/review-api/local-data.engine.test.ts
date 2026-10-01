// Vendored from dev.fast review/src/review-api/local-data.test.ts lines 1-22,24-26,28-327,383-529,647-669,713-996,1260-1421,2324-2976,3102-9999 @4ecc570 (MIT).
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  type FSWatcher,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { setLocalVcsCommandObserver } from "../../../../../../shared/node/vendor/local-vcs/src/index.ts";
import type { JsonValue } from "../../../../../../shared/vendor/review-protocol/src/index.ts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { selectSource } from "../../../../../../shared/vendor/review/src/lens-selection.ts";
import {
  type AuthoringTool,
  ToolText,
  callAuthoringTool,
} from "./agent-client.ts";
import { ReviewApiClient } from "../../../../../../shared/vendor/review/src/review-api/client.ts";
import type { Pins } from "../../../../../../shared/vendor/review/src/review-api/document.ts";
import { createReviewApi } from "./http.ts";
import { openLocalReviewStore } from "./local-data.ts";

let directory: string, repository: string, database: string, pins: Pins;

let local: ReturnType<typeof openLocalReviewStore>;

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

const spawns: string[][] = [];

const recordSpawns = () => {
  spawns.length = 0;
  setLocalVcsCommandObserver({
    start: ({ file, args }) => {
      spawns.push([file, ...args]);

      return () => {};
    },
  });
};

const batchProcesses = () =>
  spawnSync("pgrep", ["-P", String(process.pid), "-f", "cat-file"], {
    encoding: "utf8",
  })
    .stdout.split("\n")
    .filter(Boolean);

const isJjRootProbe = (spawn: string[] | undefined) =>
  spawn?.[0] === "jj" && spawn[3] === "root";

/** Detection = the jj probe followed by the git probe; a lone git probe is the fallback check. */
const detections = () =>
  spawns.filter(
    (spawn, index) =>
      isJjRootProbe(spawn) ||
      (spawn[0] === "git" &&
        spawn[4] === "--show-toplevel" &&
        isJjRootProbe(spawns[index - 1])),
  );

const detectionPair = (root: string) => [
  ["jj", "-R", root, "root", "--ignore-working-copy"],
  ["git", "-C", root, "rev-parse", "--show-toplevel"],
];

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
  writeFileSync(
    path.join(repository, source.file),
    "export const value = 1;\n",
  );
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
  writeFileSync(
    path.join(repository, source.file),
    "uncommitted text must never appear\n",
  );
  local = openLocalReviewStore(database, { watch });
  const registered = await local.data.register(repository);
  pins = await local.data.resolvePins(registered.id, "HEAD^", "HEAD");
});

afterEach(async () => {
  setLocalVcsCommandObserver(null);
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
  writeFileSync(
    path.join(other, "lib.ts"),
    "export const other = 1;\nexport const more = 2;\n",
  );
  otherGit("add", ".");
  otherGit("-c", "commit.gpgsign=false", "commit", "-qm", "Other");
  const registered = await local.data.register(other);

  const own = {
    repositoryId: registered.id,
    head: otherGit("rev-parse", "HEAD"),
  };

  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Two repositories", pins }),
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

  const app = createReviewApi(local.store, local.data);
  const anchor = `repositoryId=${own.repositoryId}&head=${own.head}`;

  expect(
    await (
      await app.request(`/${reviewId}/file?side=head&file=lib.ts&${anchor}`)
    ).json(),
  ).toMatchObject({
    commit: own.head,
    text: "export const other = 1;\nexport const more = 2;\n",
  });
  expect(
    await (
      await app.request(`/${reviewId}/file?side=head&file=${source.file}`)
    ).json(),
  ).toMatchObject({ commit: pins.head });
  expect(
    await (await app.request(`/${reviewId}/tree?side=head&${anchor}`)).json(),
  ).toEqual([{ path: "lib.ts", kind: "file" }]);
  expect(
    (
      await app.request(
        `/${reviewId}/file?side=head&file=lib.ts&head=${own.head}`,
      )
    ).status,
  ).toBe(400);

  const quoted = await app.request(`/${reviewId}/source`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: {
        side: "head",
        file: "lib.ts",
        fromLine: 2,
        toLine: 2,
        pins: own,
      },
    }),
  });

  expect(await quoted.json()).toMatchObject({
    commit: own.head,
    text: "export const more = 2;",
  });

  const progress = await (
    await app.request(`/${reviewId}/progress?mode=textual`)
  ).json();

  expect(
    progress.resolvedSelections[
      JSON.stringify([
        "lib.ts",
        "head",
        1,
        "head",
        2,
        `${own.repositoryId}::${own.head}`,
      ])
    ],
  ).toEqual([
    // Base-less pins compare the commit with itself, so both sides resolve.
    { file: "lib.ts", side: "base", fromLine: 1, toLine: 2 },
    { file: "lib.ts", side: "head", fromLine: 1, toLine: 2 },
  ]);
  // The other repository's file is not one of this review's changed files.
  expect(
    progress.files.map((file: { path: string }) => file.path),
  ).not.toContain("lib.ts");

  // The reference keeps its repository registered until it is gone.
  local.store.unregisterRepository(own.repositoryId);
  expect(local.store.repositoryPath(own.repositoryId)).toBe(
    realpathSync(other),
  );

  rmSync(other, { recursive: true, force: true });
  await local.store.refreshWorktrees();
  expect(local.store.read(reviewId).staleSources).toEqual([peek.targetId]);
  expect(local.store.read(reviewId).sourceUnavailable).toBeUndefined();
});

it("resolves saved branch names and fork links for the requested review version", async () => {
  git("remote", "add", "origin", "https://github.com/devdotfast/review.git");
  git("remote", "add", "fork", "git@github.com:contributor/review.git");
  git("update-ref", "refs/remotes/origin/main", pins.base);
  git("update-ref", "refs/remotes/fork/feature", pins.head);
  const reviewId = randomUUID();

  const saved = {
    reviewId,
    title: "Branch labels",
    pins,
    document: [],
    createdAt: new Date().toISOString(),
  };

  const first = await local.store.importVersion({
    ...saved,
    origin: { baseRef: "main", branch: "feature", revision: "first" },
  });

  await local.store.importVersion({
    ...saved,
    origin: { baseRef: "main", branch: "local-work", revision: "second" },
  });
  const app = createReviewApi(local.store, local.data);
  const current = await app.request(`/${reviewId}/branch-links`);
  expect(current.status).toBe(200);
  expect(await current.json()).toEqual({
    ok: true,
    baseRef: "main",
    headRef: "local-work",
    baseUrl: "https://github.com/devdotfast/review/tree/main",
    headUrl: null,
  });

  const historical = await app.request(
    `/${reviewId}/branch-links?version=${first.version}`,
  );

  expect(historical.status).toBe(200);
  expect(await historical.json()).toEqual({
    ok: true,
    baseRef: "main",
    headRef: "feature",
    baseUrl: "https://github.com/devdotfast/review/tree/main",
    headUrl: "https://github.com/contributor/review/tree/feature",
  });
  const missing = await app.request(`/${randomUUID()}/branch-links`);
  expect(missing.status).toBe(404);
});


type OpenDesktop = NonNullable<Parameters<typeof createReviewApi>[2]>;

const postJson = (app: Hono, route: string, body: JsonValue) =>
  app.request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

it("opens a created review in Desktop unless the author opts out", async () => {
  const opened: string[] = [];

  const app = createReviewApi(local.store, local.data, async ({ reviewId }) => {
    opened.push(reviewId);

    return { softwareMapEnabled: true };
  });

  const shown = await postJson(
    app,
    "/commands",
    command({ type: "create", title: "Shown", pins }),
  );

  expect(shown.status).toBe(200);
  const shownReview = await shown.json();
  expect(shownReview).toMatchObject({
    opened: true,
    softwareMapEnabled: true,
  });
  expect(opened).toEqual([shownReview.reviewId]);

  const background = command({
    type: "create",
    title: "Background",
    pins,
    open: false,
  });

  const quiet = await postJson(app, "/commands", background);

  expect(quiet.status).toBe(200);
  const quietReview = await quiet.json();
  expect(quietReview).toMatchObject({ opened: false });
  expect(opened).toEqual([shownReview.reviewId]);

  // Opening is not part of the saved command: a retry may choose to show it.
  const { open: _open, ...retried } = background.operation;

  const retry = await postJson(app, "/commands", {
    ...background,
    operation: retried,
  });

  expect(await retry.json()).toMatchObject({
    reviewId: quietReview.reviewId,
    opened: true,
  });
  expect(opened).toEqual([shownReview.reviewId, quietReview.reviewId]);
});

it("opens the PR's existing review that create returns instead of a new one", async () => {
  const opened: string[] = [];

  const app = createReviewApi(local.store, local.data, async ({ reviewId }) => {
    opened.push(reviewId);

    return { softwareMapEnabled: false };
  });

  const pullRequestUrl = "https://github.com/devdotfast/review/pull/452";

  const first = await (
    await postJson(
      app,
      "/commands",
      command({ type: "create", title: "PR", pins, pullRequestUrl }),
    )
  ).json();

  const again = await postJson(
    app,
    "/commands",
    command({ type: "create", title: "PR again", pins, pullRequestUrl }),
  );

  expect(again.status).toBe(200);
  const body = await again.json();
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

  const app = createReviewApi(local.store, local.data, open, undefined, () => ({
    desktopAvailable: false,
    softwareMapEnabled: false,
  }));

  const response = await postJson(
    app,
    "/commands",
    command({ type: "create", title: "Headless", pins }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ opened: false });
  expect(open).not.toHaveBeenCalled();
  expect(
    (
      await postJson(
        app,
        "/commands",
        command({ type: "rename", reviewId: "x", title: "y", open: false }),
      )
    ).status,
  ).toBe(400);
});

it("keeps a created review when Desktop fails to open it", async () => {
  const app = createReviewApi(local.store, local.data, async () => {
    throw new Error("Desktop window closed.");
  });

  const response = await postJson(
    app,
    "/commands",
    command({ type: "create", title: "Saved anyway", pins }),
  );

  expect(response.status).toBe(200);
  const created = await response.json();
  expect(created).toMatchObject({
    opened: false,
    openError: expect.stringContaining("Desktop window closed."),
  });
  expect(local.store.read(created.reviewId).title).toBe("Saved anyway");
});

it("lists the full repository path and hydrates diff counts from pinned commits", async () => {
  await local.store.execute(
    command({ type: "create", title: "Home metadata", pins }),
  );
  const app = createReviewApi(local.store, local.data);
  const first = await (await app.request("/?mode=textual")).json();
  expect(first[0].repositoryPath).toBe(realpathSync(repository));
  expect(first[0].diffStats).toBeNull();
  await local.data.coverage(first[0].reviewId, pins, "textual");
  const ready = await (await app.request("/?mode=textual")).json();
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

it("returns map endpoint locations through HTTP and allows correcting a rejected upload", async () => {
  const app = createReviewApi(local.store, local.data);
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
      relationships: [
        { kind: "semantic", from: "app.api.handler", to: "app.db" },
      ],
    },
  };

  const send = () =>
    app.request("/resources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(upload),
    });

  const rejected = await send();
  expect(rejected.status).toBe(400);
  const { error } = await rejected.json();
  expect(error).toContain("relationships[0] at app.to");
  expect(error).toContain('"missing"');
  expect(error).toContain("does not match an element path");
  expect(() => local.store.resource(upload.id)).toThrow(/not found/);

  edge.to = "db";
  expect((await send()).status).toBe(200);

  const saved = JSON.parse(
    Buffer.from(local.store.resource(upload.id).data).toString(),
  );

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
                        sourceRanges: [
                          { file: source.file, fromLine: 2, toLine: 1 },
                        ],
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
  ).rejects.toThrow(
    /app\.api\.handler\.save.*sourceRanges\[0\].*fromLine <= toLine/,
  );
});

it("validates Markdown source links against the pinned files before saving", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Links", pins }),
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
  writeFileSync(
    path.join(repository, source.file),
    "export const value = 3;\n",
  );
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Second head");

  const updatedPins = await local.data.resolvePins(
    pins.repositoryId,
    pins.base,
    "HEAD",
  );

  const review = await local.store.execute(
    command({ type: "create", title: "Two commits", pins: updatedPins }),
  );

  const app = new Hono().route(
    "/reviews-api",
    createReviewApi(local.store, local.data),
  );

  const route = `/reviews-api/${review.reviewId}`;

  const commits = await (
    await app.request(`${route}/commits?version=0`)
  ).json();

  expect(commits.map((item: { commit: string }) => item.commit)).toEqual([
    updatedPins.head,
    firstHead,
  ]);
  const selected = `version=0&commit=${firstHead}`;

  for (const side of ["base", "head"] as const) {
    const response = await app.request(`${route}/source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 0,
        commit: firstHead,
        source: { side, file: "example.ts", fromLine: 1, toLine: 1 },
      }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).text).toContain(
      side === "base" ? "value = 1" : "value = 2",
    );
  }

  const file = await (
    await app.request(`${route}/file?${selected}&side=head&file=example.ts`)
  ).json();

  expect(file.text).toContain("value = 2");

  const patch = await (
    await app.request(`${route}/diff?${selected}&file=example.ts`)
  ).text();

  expect(patch).toContain("-export const value = 1;");
  expect(patch).toContain("+export const value = 2;");
  expect(patch).not.toContain("value = 3");
  expect((await app.request(`${route}/diff?commit=${pins.base}`)).status).toBe(
    404,
  );
  await local.store.execute(
    command({
      type: "repin",
      reviewId: review.reviewId,
      pins: { ...updatedPins, base: firstHead },
    }),
  );
  expect((await app.request(`${route}/diff?commit=${firstHead}`)).status).toBe(
    404,
  );
  expect((await app.request(`${route}/diff?${selected}`)).status).toBe(200);
});

it("reads each version of one review at its own pins", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Versions", pins }),
  );

  writeFileSync(
    path.join(repository, source.file),
    "export const value = 3;\n",
  );
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Third");

  const later = await local.data.resolvePins(
    pins.repositoryId,
    pins.head,
    "HEAD",
  );

  await local.store.execute(command({ type: "repin", reviewId, pins: later }));
  const first = local.store.read(reviewId, 0).pins!;
  const second = local.store.read(reviewId, 1).pins!;

  expect([first, second]).toEqual([pins, later]);
  expect((await local.data.commits(first)).map((item) => item.commit)).toEqual([
    pins.head,
  ]);
  expect((await local.data.commits(second)).map((item) => item.commit)).toEqual(
    [later.head],
  );
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
    command({ type: "create", title: "Snapshot", pins }),
  );

  await insert(reviewId, { type: "code_peek", source: selectSource(source) });
  writeFileSync(
    path.join(repository, source.file),
    "export const value = 3;\n",
  );
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Third");

  const later = await local.data.resolvePins(
    pins.repositoryId,
    pins.head,
    "HEAD",
  );

  await local.store.execute(command({ type: "repin", reviewId, pins: later }));
  expect(local.store.read(reviewId).version).toBe(2);

  const app = new Hono().route(
    "/reviews-api",
    createReviewApi(local.store, local.data),
  );

  const read = async (query: string) =>
    (
      await app.request(`/reviews-api/${reviewId}/file?side=head&${query}`)
    ).json();

  expect(await read(`version=1&file=${source.file}`)).toEqual({
    file: source.file,
    side: "head",
    commit: pins.head,
    text: "export const value = 2;\nexport const saved = true;\n",
  });
  expect(await read(`file=${source.file}`)).toEqual({
    file: source.file,
    side: "head",
    commit: later.head,
    text: "export const value = 3;\n",
  });
});

it("browses committed directories, including history, without listing untracked files", async () => {
  mkdirSync(path.join(repository, "nested", "deeper"), { recursive: true });
  writeFileSync(
    path.join(repository, "nested", "deeper", "file.ts"),
    "pinned text\n",
  );
  git("add", "nested");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Nested file");

  const nestedPins = await local.data.resolvePins(
    pins.repositoryId,
    pins.base,
    "HEAD",
  );

  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Tree", pins: nestedPins }),
  );

  writeFileSync(path.join(repository, "untracked.ts"), "Not in the review\n");
  writeFileSync(
    path.join(repository, "nested", "deeper", "file.ts"),
    "dirty text\n",
  );

  const app = new Hono().route(
    "/reviews-api",
    createReviewApi(local.store, local.data),
  );

  const route = `/reviews-api/${reviewId}/tree`;
  const root = await (await app.request(route)).json();
  expect(root).toContainEqual({ path: "nested", kind: "directory" });
  expect(root).not.toContainEqual(
    expect.objectContaining({ path: "untracked.ts" }),
  );
  expect(await (await app.request(`${route}?path=nested`)).json()).toEqual([
    { path: "nested/deeper", kind: "directory" },
  ]);
  expect(
    await (await app.request(`${route}?path=nested/deeper`)).json(),
  ).toEqual([{ path: "nested/deeper/file.ts", kind: "file" }]);
  expect(
    await local.data.file(nestedPins, "head", "nested/deeper/file.ts"),
  ).toMatchObject({ text: "pinned text\n" });
  expect((await app.request(`${route}?side=base&path=nested`)).status).toBe(
    404,
  );
  expect((await app.request(`${route}?path=../outside`)).status).toBe(400);
  expect((await app.request(`${route}?path=example.ts`)).status).toBe(404);
  await local.store.execute(command({ type: "repin", reviewId, pins }));
  expect((await app.request(`${route}?path=nested`)).status).toBe(404);
  expect((await app.request(`${route}?version=0&path=nested`)).status).toBe(
    200,
  );
});

it("reads pinned Git objects, rejects invalid evidence before saving, and retains registrations across restart", async () => {
  const review = await local.store.execute(
    command({ type: "create", title: "Pinned", pins }),
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
  await expect(local.data.file(pins, "head", "../outside.ts")).rejects.toThrow(
    /relative/,
  );
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

  const binaryPins = await local.data.resolvePins(
    pins.repositoryId,
    pins.head,
    "HEAD",
  );

  await expect(
    local.data.file(binaryPins, "head", "binary.bin"),
  ).rejects.toThrow("Binary files cannot be used as code references.");
});

it("reads a committed empty file as empty text, not a missing file", async () => {
  writeFileSync(path.join(repository, "blank.ts"), "");
  git("add", "blank.ts");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Blank");

  const blankPins = await local.data.resolvePins(
    pins.repositoryId,
    pins.head,
    "HEAD",
  );

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

  const linkPins = await local.data.resolvePins(
    pins.repositoryId,
    pins.head,
    "HEAD",
  );

  expect(await local.data.file(linkPins, "head", "link.ts")).toEqual({
    file: "link.ts",
    side: "head",
    commit: linkPins.head,
    text: outside,
  });
});

it("rejects a code peek on blank lines but accepts a prose link to them", async () => {
  mkdirSync(path.join(repository, "src"));
  writeFileSync(
    path.join(repository, "src/blank.ts"),
    "export const a = 1;\n\n\n// end\n",
  );
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Blank lines");

  const blankPins = await local.data.resolvePins(
    pins.repositoryId,
    "HEAD^",
    "HEAD",
  );

  const blank = {
    side: "head",
    file: "src/blank.ts",
    fromLine: 2,
    toLine: 3,
  } as const;

  await expect(
    local.data.validateSource(blankPins, blank, { peek: true }),
  ).rejects.toThrow("src/blank.ts:2-3 contains only whitespace");
  await expect(
    local.data.validateSource(blankPins, blank, { peek: false }),
  ).resolves.toBeUndefined();
});

it("copies prose with the displayed version's title and immutable review identity", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Original title", pins }),
  );

  await local.store.execute(
    command({ type: "rename", reviewId, title: "Latest title" }),
  );
  const app = createReviewApi(local.store, local.data);

  const response = await app.request(`/${reviewId}/copy-context?version=0`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target: { kind: "text", quote: "First line\nSecond line" },
      title: "Selection",
    }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    text: `Selected text from Whiteboard: Original title\nSession ID: ${reviewId}\nVersion: 0\nRepository ID: ${pins.repositoryId}\nSession base: ${pins.base}\nSession head: ${pins.head}\nRead this version with whiteboard_session_get({"sessionId":"${reviewId}","version":0,"full":true}).\n\n> First line\n> Second line\n\n`,
  });
});

it("copies code from historical pins after a repin, never from working-tree contents", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Code", pins }),
  );

  await local.store.execute(
    command({ type: "repin", reviewId, pins: { ...pins, head: pins.base } }),
  );
  const app = createReviewApi(local.store, local.data);

  const body = JSON.stringify({
    target: {
      kind: "code",
      path: source.file,
      side: "head",
      startLine: 1,
      endLine: 1,
    },
    title: "Value",
    detail: "Selected source",
  });

  const historical = await app.request(`/${reviewId}/copy-context?version=0`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  expect(historical.status).toBe(200);
  expect(await historical.json()).toEqual({
    text: `Selected code from Whiteboard: Code\nSession ID: ${reviewId}\nVersion: 0\nRepository ID: ${pins.repositoryId}\nSession base: ${pins.base}\nSession head: ${pins.head}\nRead this version with whiteboard_session_get({"sessionId":"${reviewId}","version":0,"full":true}).\n\n## Value\n\nSelected source\n\n## head: example.ts:1-1 (${pins.head})\n    export const value = 2;\n\n`,
  });

  const latest = await app.request(`/${reviewId}/copy-context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  expect(latest.status).toBe(200);
  expect((await latest.json()).text).toContain("    export const value = 1;");
});

it("copies a diff selection from its pinned version and selected commit, and rejects another review", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Code", pins }),
  );

  await local.store.execute(
    command({ type: "repin", reviewId, pins: { ...pins, head: pins.base } }),
  );
  const app = createReviewApi(local.store, local.data);

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
  };

  const copy = (payload: typeof selection) =>
    app.request(`/${reviewId}/copy-context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

  const response = await copy(selection);
  expect(response.status).toBe(200);
  const { text } = await response.json();
  expect(text).toContain("Version: 0");
  expect(text).toContain(`Selected commit: ${pins.head}`);
  expect(text).toContain(`base: example.ts:1-1 (${pins.base})`);
  expect(text).toContain("export const value = 1;");
  expect(text).not.toContain("export const value = 2;");
  expect(
    (
      await copy({
        ...selection,
        apiSource: { ...selection.apiSource, reviewId: "another-review" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await copy({
        ...selection,
        apiSource: { ...selection.apiSource, version: 999 },
      })
    ).status,
  ).toBe(404);
});

it("copies selected diff rows with rename paths without resolving an unavailable source", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Rename", pins }),
  );

  // Use selected diff rows; the new path may not exist on the base commit.
  const app = createReviewApi(local.store);

  const response = await app.request(`/${reviewId}/copy-context?version=0`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
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
    }),
  });

  expect(response.status).toBe(200);
  expect((await response.json()).text).toContain(
    "Base: a/old.md\nHead: b/new.md\nRange: -4,2 +7,2\n\n````diff\n-before\n+```typescript\n context\n````\n\n",
  );
});

it("reports invalid copy requests, unavailable versions, and missing source files as JSON errors", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Errors", pins }),
  );

  const app = createReviewApi(local.store, local.data);

  const selection = {
    target: {
      kind: "code",
      path: "missing.ts",
      side: "head",
      startLine: 1,
      endLine: 1,
    },
    title: "Missing source",
  };

  for (const [route, body, status] of [
    [`/${reviewId}/copy-context`, "{", 400],
    [`/${reviewId}/copy-context`, JSON.stringify({ title: "Invalid" }), 400],
    [`/${reviewId}/copy-context?version=nope`, JSON.stringify(selection), 400],
    [`/${reviewId}/copy-context?version=99`, JSON.stringify(selection), 404],
    ["/missing/copy-context", JSON.stringify(selection), 404],
    [`/${reviewId}/copy-context`, JSON.stringify(selection), 404],
  ] as const) {
    const response = await app.request(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
  }
});

it("resolves omitted commit base once and preserves explicit parent comparisons", async () => {
  const repositoryId = pins.repositoryId;

  const result = await local.store.execute(
    command({
      type: "create",
      title: "Single commit",
      target: { kind: "commits", repositoryId, head: "HEAD" },
    }),
  );

  const snapshot = local.store.read(result.reviewId);
  expect(snapshot.pins).toEqual({
    repositoryId,
    base: pins.head,
    head: pins.head,
  });
  expect(await local.data.changes(snapshot.pins!)).toEqual([]);
  expect(await local.data.file(snapshot.pins!, "head", "example.ts")).toEqual(
    await local.data.file(pins, "head", "example.ts"),
  );

  const explicit = await local.data.resolveTarget({
    kind: "commits",
    repositoryId,
    head: "HEAD",
    base: "HEAD",
  });

  expect(explicit.pins).toEqual(snapshot.pins);

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
  writeFileSync(
    path.join(repository, "example.ts"),
    "export const live = 1;\n",
  );
  writeFileSync(
    path.join(repository, "untracked.ts"),
    "export const fresh = true;\n",
  );

  const request = command({
    type: "create",
    title: "Working files",
    target: { kind: "worktree", repositoryId },
  });

  const result = await local.store.execute(request);
  const original = local.store.read(result.reviewId, 0);
  expect(
    (await local.data.file(original.pins!, "head", "example.ts")).text,
  ).toContain("live = 1");
  expect(await local.data.tree(original.pins!, "head", "")).toContainEqual({
    path: "untracked.ts",
    kind: "file",
  });
  expect(await local.data.changes(original.pins!)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "untracked.ts", status: "added" }),
    ]),
  );
  writeFileSync(
    path.join(repository, "example.ts"),
    "export const live = 2;\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  await local.store.refreshWorktrees();
  const current = local.store.read(result.reviewId);
  expect(
    (await local.data.file(current.pins!, "head", "example.ts")).text,
  ).toContain("live = 2");
  expect(
    (
      await local.data.file(
        local.store.read(result.reviewId, 0).pins!,
        "head",
        "example.ts",
      )
    ).text,
  ).toContain("live = 1");
  expect(local.store.history(result.reviewId)).toHaveLength(1);
  expect(await local.store.execute(request)).toEqual(result);
  expect(git("diff", "--cached")).toBe(beforeIndex);
  git("add", ".");
  git("commit", "-qm", "Save changes");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await local.store.refreshWorktrees();
  expect(
    await local.data.changes(local.store.read(result.reviewId).pins!),
  ).toEqual([]);
  await local.store.execute(
    command({
      type: "set_target",
      reviewId: result.reviewId,
      target: { kind: "commits", repositoryId, head: pins.head },
    }),
  );
  expect(local.store.read(result.reviewId).target?.kind).toBe("commits");
  expect(
    (await local.data.file(original.pins!, "head", "example.ts")).text,
  ).toContain("live = 1");
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
      title: "Unborn",
      target: { kind: "worktree", repositoryId: repo.id },
    }),
  );

  const snapshot = local.store.read(result.reviewId);
  expect(
    (await local.data.file(snapshot.pins!, "head", "first.ts")).text,
  ).toContain("first = 1");
  expect(
    (await local.data.file(snapshot.pins!, "head", "external.ts")).text,
  ).toBe(outside);
  expect(await local.data.changes(snapshot.pins!)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "first.ts", status: "added" }),
    ]),
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
  expect(
    local.store.read(result.reviewId, saved.version).document[0],
  ).toMatchObject({ source: { start: { line: 2 }, end: { line: 2 } } });
  writeFileSync(path.join(repository, "range.ts"), "const first = 99;\n");
  await vi.waitFor(async () => {
    await local.store.refreshWorktrees();
    expect(local.store.read(result.reviewId).staleSources).toEqual([
      saved.document[0]!.id,
    ]);
  }, { timeout: 5_000 });
});

it("reads retained checkout for an older authored version", async () => {
  const api = createReviewApi(local.store, local.data);
  writeFileSync(path.join(repository, "example.ts"), "const generation = 1;\n");

  const result = await local.store.execute(
    command({
      type: "create",
      title: "Coherence",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  writeFileSync(path.join(repository, "example.ts"), "const generation = 2;\n");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const read = async (query: string) =>
    (
      await api.request(
        `/${result.reviewId}/file?side=head&file=example.ts${query}`,
      )
    ).json();

  expect(await read("")).toMatchObject({ text: "const generation = 2;\n" });

  expect(await read("&version=0")).toMatchObject({
    text: "const generation = 1;\n",
  });
  expect(await read("")).toMatchObject({
    localPath: realpathSync(path.join(repository, "example.ts")),
  });
  expect(await read("&version=0")).not.toHaveProperty("localPath");
});

it("keeps multiple worktrees bound to their selected directory and survives reopening the store", async () => {
  const otherPath = path.join(directory, "other-worktree");
  git("worktree", "add", "--detach", otherPath, pins.head);
  writeFileSync(
    path.join(otherPath, "example.ts"),
    "const otherCheckout = true;\n",
  );
  const other = await local.data.register(otherPath);

  const one = await local.store.execute(
    command({
      type: "create",
      title: "First",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  const two = await local.store.execute(
    command({
      type: "create",
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
    (
      await local.data.file(
        local.store.read(one.reviewId).pins!,
        "head",
        "example.ts",
      )
    ).text,
  ).toContain("uncommitted text");
  expect(
    (
      await local.data.file(
        local.store.read(two.reviewId).pins!,
        "head",
        "example.ts",
      )
    ).text,
  ).toContain("otherCheckout");
  expect(
    (
      await local.data.file(
        local.store.read(two.reviewId, retained.version).pins!,
        "head",
        "example.ts",
      )
    ).text,
  ).toContain("otherCheckout");
  expect(
    git("worktree", "list", "--porcelain").match(/^worktree /gm),
  ).toHaveLength(2);
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
      title: "Files",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  const snapshot = local.store.read(result.reviewId);
  const files = await local.data.tree(snapshot.pins!, "head", "");
  expect(files).not.toContainEqual({ path: "ignored.ts", kind: "file" });
  expect(files).not.toContainEqual({ path: "example.ts", kind: "file" });
  expect(
    (await local.data.file(snapshot.pins!, "head", "__proto__")).text,
  ).toBe("legitimate filename\n");
  await expect(
    local.data.file(snapshot.pins!, "head", "binary.dat"),
  ).rejects.toThrow("Binary");
  expect(await local.data.changes(snapshot.pins!)).toEqual(
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
    writeFileSync(
      path.join(root, "new.ts"),
      "export const unsnapshotted = 1;\n",
    );

    const result = await local.store.execute(
      command({
        type: "create",
        title: "jj working",
        target: { kind: "worktree", repositoryId: repo.id, base },
      }),
    );

    expect(
      (
        await local.data.file(
          local.store.read(result.reviewId).pins!,
          "head",
          "new.ts",
        )
      ).text,
    ).toContain("unsnapshotted");
    expect(
      await local.data.changes(local.store.read(result.reviewId).pins!),
    ).toEqual([expect.objectContaining({ path: "new.ts", status: "added" })]);
    expect(jj("op", "log", "--no-graph", "--limit", "1", "-T", "id")).toBe(
      operation,
    );
  },
);

it("retargets a live review without losing authored content or component IDs", async () => {
  const created = await local.store.execute(
    command({
      type: "create",
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
        local.store.read(created.reviewId, before.version).pins!,
        "head",
        "example.ts",
      )
    ).text,
  ).toContain("uncommitted text");
});

it("leaves authored Markdown destinations unchanged when source lines move", async () => {
  const original =
    Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n") +
    "\n";

  writeFileSync(path.join(repository, "links.ts"), original);

  const created = await local.store.execute(
    command({
      type: "create",
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
    markdown:
      "[one](review-source:head/links.ts#L1) [ten](review-source:head/links.ts#L10-L20)",
  });
  writeFileSync(path.join(repository, "links.ts"), "inserted\n" + original);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await local.store.refreshWorktrees();
  expect(local.store.read(created.reviewId).document[0]).toMatchObject({
    markdown:
      "[one](review-source:head/links.ts#L1) [ten](review-source:head/links.ts#L10-L20)",
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
  git(
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    modulePath,
    "module",
  );
  git("add", ".");
  git("commit", "-qm", "Link and module");
  const head = git("rev-parse", "HEAD");

  const created = await local.store.execute(
    command({
      type: "create",
      title: "Clean modes",
      target: { kind: "worktree", repositoryId: pins.repositoryId, base: head },
    }),
  );

  expect(
    await local.data.changes(local.store.read(created.reviewId).pins!),
  ).toEqual([]);
  expect(
    (
      await local.data.file(
        local.store.read(created.reviewId).pins!,
        "head",
        "tracked-link.ts",
      )
    ).text,
  ).toBe("example.ts");
  const snapshot = local.store.read(created.reviewId);
  await expect(
    local.data.file(snapshot.pins!, "head", "module"),
  ).rejects.toThrow("not a regular file");

  const response = await createReviewApi(local.store, local.data).request(
    `/${created.reviewId}/file?side=head&file=module`,
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: "Source is not a regular file.",
  });
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
      title: "Watcher recovery",
      target: {
        kind: "worktree",
        repositoryId: pins.repositoryId,
        base: pins.head,
      },
    }),
  );

  for (const watcher of watchers)
    watcher.emit(
      "error",
      Object.assign(new Error("Watch limit"), { code: "ENOSPC" }),
    );

  for (const value of ["first change\n", "second change\n"]) {
    writeFileSync(path.join(repository, "example.ts"), value);
    await local.store.refreshWorktrees();
    expect(
      (
        await local.data.file(
          local.store.read(created.reviewId).pins!,
          "head",
          "example.ts",
        )
      ).text,
    ).toBe(value);
  }
});

it("keeps live language identity across edits but replaces it with a checkout at the same path", async () => {
  const created = await local.store.execute(
    command({
      type: "create",
      title: "Environment identity",
      target: {
        kind: "worktree",
        repositoryId: pins.repositoryId,
        base: pins.base,
      },
    }),
  );

  const saved = local.store.read(created.reviewId, created.version);
  const before = await local.data.languageEnvironment(saved, "head");
  const retained = await local.data.file(saved.pins!, "head", source.file);
  writeFileSync(path.join(repository, "identity.ts"), "const changed = true;");
  expect(await local.data.languageEnvironment(saved, "head")).toEqual(before);
  const moved = `${repository}-previous`;
  renameSync(repository, moved);

  try {
    expect(
      (await local.data.languageEnvironment(saved, "head")).rootPath,
    ).toBeNull();
    mkdirSync(repository);
    execFileSync("git", ["clone", "--quiet", moved, repository]);
    const replacement = await local.data.languageEnvironment(saved, "head");
    expect(replacement.rootPath).toBe(before.rootPath);
    expect(replacement.identity).not.toBe(before.identity);
    expect(local.data.workspaces.list(created.reviewId)).toEqual([]);
    expect(retained.text).toBeTruthy();
    await expect(local.data.file(saved.pins!, "head", source.file)).rejects.toThrow("retained working source is unavailable");
  } finally {
    rmSync(moved, { recursive: true, force: true });
  }
});

it("marks a commit-pinned review unavailable while its repository is gone", async () => {
  const review = await local.store.execute(
    command({ type: "create", title: "Moved repository", pins }),
  );

  const app = createReviewApi(local.store, local.data);
  const moved = `${repository}-moved`;
  renameSync(repository, moved);

  const degraded = await app.request(`/${review.reviewId}?full=true`);

  expect(degraded.status).toBe(200);
  expect(await degraded.json()).toMatchObject({
    title: "Moved repository",
    sourceUnavailable: true,
  });
  // The canvas follows the watch stream, which reads the store, not ?full=true.
  await local.store.refreshWorktrees();
  expect(local.store.read(review.reviewId).sourceUnavailable).toBe(true);
  // A pinned version bypasses both the refresh loop and the live overlay.
  expect(
    await (await app.request(`/${review.reviewId}?full=true&version=0`)).json(),
  ).toMatchObject({ sourceUnavailable: true });

  renameSync(moved, repository);
  await local.store.refreshWorktrees();

  expect(local.store.read(review.reviewId).sourceUnavailable).toBeUndefined();
});

it("never stores the unavailable flag on a version authored while degraded", async () => {
  const review = await local.store.execute(
    command({ type: "create", title: "Edited while gone", pins }),
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

  expect(
    local.store.read(review.reviewId, edited.version).sourceUnavailable,
  ).toBeUndefined();
});

it("answers a source read with 404 while the checkout is gone", async () => {
  const review = await local.store.execute(
    command({ type: "create", title: "Moved repository", pins }),
  );

  const app = createReviewApi(local.store, local.data);
  renameSync(repository, `${repository}-moved`);

  const response = await app.request(`/${review.reviewId}/commits`);

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: "The selected local checkout is unavailable.",
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
      title: "Moved worktree",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  renameSync(repository, `${repository}-moved`);
  await local.store.refreshWorktrees();

  expect(local.store.read(review.reviewId).sourceUnavailable).toBe(true);
});

it("validates grouped source ranges with one read per pinned file", async () => {
  const read = vi.spyOn(local.data, "file");

  try {
    await local.data.validateSources(pins, [
      source,
      { ...source, fromLine: 2 },
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(
      local.data.validateSources(pins, [source, { ...source, toLine: 100000 }]),
    ).rejects.toThrow("exceeds the pinned file");
    await expect(
      local.data.validateSources(pins, [{ ...source, file: "missing.ts" }]),
    ).rejects.toThrow("unavailable");
    read.mockClear();
    await local.data.validateSources(pins, [
      source,
      { ...source, side: "base", toLine: 1 },
    ]);
    expect(read).toHaveBeenCalledTimes(pins.base === pins.head ? 1 : 2);
  } finally {
    read.mockRestore();
  }
});

describe("review_diff", () => {
  const exampleLines = (changed: number) =>
    Array.from({ length: 12 }, (_, index) =>
      index + 1 === changed ? "changed line" : `line ${index + 1}`,
    ).join("\n") + "\n";

  let reviewId: string;
  let call: (input: Record<string, JsonValue>) => Promise<JsonValue>;

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
      Array.from({ length: 40 }, (_, index) => `big ${index}`).join("\n") +
        "\n",
    );
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "Change");

    const diffPins = await local.data.resolvePins(
      pins.repositoryId,
      base,
      "HEAD",
    );

    ({ reviewId } = await local.store.execute(
      command({ type: "create", title: "Diff", pins: diffPins }),
    ));

    const app = createReviewApi(local.store, local.data);

    const client = new ReviewApiClient(
      { serverUrl: "http://review.test", token: "test" },
      async (url, init) => app.request(url.replace("/reviews-api", ""), init),
    );

    const tools = await client.read<AuthoringTool[]>("/authoring");
    const tool = tools.find((item) => item.name === "review_diff")!;

    call = async (input) => {
      const result = await callAuthoringTool(client, tool, {
        reviewId,
        ...input,
      });

      return result instanceof ToolText ? result.text : result;
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
      (
        (await call({ paths: ["dir/", "literal1.ts"] })) as { path: string }[]
      ).map((file) => file.path),
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
    await expect(
      call({ file: "example.ts", paths: ["example.ts"] }),
    ).rejects.toThrow(/file cannot be combined with paths or format/);
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
    expect(
      await call({ format: "patch", paths: ["example.ts"], context: 0 }),
    ).toBe(
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
  const api = createReviewApi(local.store, local.data);

  const { reviewId } = await local.store.execute(
    command({
      type: "create",
      title: "Working",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  writeFileSync(path.join(repository, "fresh.ts"), "fresh\n");

  const list = await (await api.request(`/${reviewId}/diff`)).json();

  expect(list).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "fresh.ts", status: "added" }),
    ]),
  );

  const response = await api.request(
    `/${reviewId}/diff?format=patch&paths=fresh.ts&paths=${source.file}`,
  );

  expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
  const text = await response.text();

  expect(text).toContain("diff --git a/fresh.ts b/fresh.ts\nnew file mode");
  expect(text).toContain("  1 +fresh\n");
  expect(text).toContain("+uncommitted text must never appear");
  expect(text).not.toContain("literal");
});

it("saves the head branch for pinned reviews and preserves it across checkout changes", async () => {
  git("checkout", "-b", "feature/saved-head");

  const created = await local.store.execute(
    command({ type: "create", title: "Branch provenance", pins }),
  );

  expect(local.store.read(created.reviewId).origin?.branch).toBe(
    "feature/saved-head",
  );
  git("checkout", "-b", "feature/another");
  await local.store.execute(
    command({ type: "rename", reviewId: created.reviewId, title: "Renamed" }),
  );
  expect(
    local.store.list().find((review) => review.reviewId === created.reviewId)
      ?.origin?.branch,
  ).toBe("feature/saved-head");

  await local.store.close();
  await local.data.close();
  local = openLocalReviewStore(database, { watch });
  expect(local.store.read(created.reviewId).origin?.branch).toBe(
    "feature/saved-head",
  );
});

it("saves the requested head branch for commit and live worktree targets", async () => {
  git("branch", "feature/requested");

  const fixed = await local.store.execute(
    command({
      type: "create",
      title: "Named head",
      target: {
        kind: "commits",
        repositoryId: pins.repositoryId,
        head: "feature/requested",
        base: pins.base,
      },
    }),
  );

  expect(local.store.read(fixed.reviewId).origin?.branch).toBe(
    "feature/requested",
  );
  git("checkout", "-b", "feature/live");

  const live = await local.store.execute(
    command({
      type: "create",
      title: "Live head",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  expect(local.store.read(live.reviewId).origin?.branch).toBe("feature/live");

  const pinned = await local.store.execute(
    command({
      type: "create",
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
  expect(
    await local.data.headBranch({ ...pins, head: pins.base }),
  ).toBeUndefined();
  git("checkout", "--detach", pins.head);

  const created = await local.store.execute(
    command({ type: "create", title: "Detached", pins }),
  );

  expect(local.store.read(created.reviewId).origin?.branch).toBeUndefined();
});

