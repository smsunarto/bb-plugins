import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeBlob, parseLfsPointer, readBlobChunk } from "./blobs.ts";
import { runGit, runGitCommand } from "./cli.ts";

const signal = new AbortController().signal;
let root = "";
let repository = "";
let head = "";
const image = Buffer.from(Array.from({ length: 300_000 }, (_, index) => index % 251));
const model = Buffer.from("glTF binary bytes stored in LFS");
const modelOid = createHash("sha256").update(model).digest("hex");
const pointer = (oid: string, size: number) =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

async function git(cwd: string, args: string[]) {
  return runGit(cwd, args, signal);
}

// Spools this file's reads make. A test process ends without the worker's exit cleanup.
const spools = () =>
  readdir(tmpdir()).then((names) => names.filter((name) => name.startsWith("bb-gitbutler-blobs-")));
let spoolsBefore: string[] = [];

beforeAll(async () => {
  spoolsBefore = await spools();
  root = await mkdtemp(join(tmpdir(), "gitbutler-blobs-"));
  repository = join(root, "repo");
  await mkdir(join(repository, "Assets"), { recursive: true });
  await git(repository, ["init", "--quiet", "--initial-branch=main", "."]);
  await git(repository, ["config", "user.email", "test@example.com"]);
  await git(repository, ["config", "user.name", "Test Person"]);
  await git(repository, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(repository, "Assets", "hero image.png"), image);
  await writeFile(join(repository, "Assets", "hero.glb"), pointer(modelOid, model.length));
  await writeFile(join(repository, "Assets", "fake.glb"), pointer("../../../../etc/passwd", 10));
  await symlink("hero image.png", join(repository, "Assets", "link.png"));
  await git(repository, ["add", "--all"]);
  await git(repository, ["commit", "--quiet", "-m", "assets"]);
  head = (await git(repository, ["rev-parse", "HEAD"])).trim();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  for (const name of await spools()) {
    if (!spoolsBefore.includes(name))
      await rm(join(tmpdir(), name), { recursive: true, force: true });
  }
});

test("only a well-formed pointer with a sha256 oid counts as Git LFS", () => {
  expect(parseLfsPointer(pointer(modelOid, 9))).toEqual({ oid: modelOid, size: 9 });
  expect(parseLfsPointer(pointer("../../etc/passwd", 9))).toBeNull();
  expect(parseLfsPointer(pointer(modelOid.toUpperCase(), 9))).toBeNull();
  expect(parseLfsPointer("version https://git-lfs.github.com/spec/v1\nsize 3\n")).toBeNull();
  expect(parseLfsPointer("hello")).toBeNull();
});

test("descriptors name blobs, pointers, symlinks, and missing paths without reading content", async () => {
  const png = await describeBlob(repository, head, "Assets/hero image.png", signal);
  expect(png).toMatchObject({ kind: "blob", size: image.length, lfs: null });
  expect(await describeBlob(repository, head, "Assets/hero.glb", signal)).toMatchObject({
    kind: "blob",
    lfs: { oid: modelOid, size: model.length, local: false },
  });
  // A pointer naming a path outside the store is not a pointer at all.
  expect(await describeBlob(repository, head, "Assets/fake.glb", signal)).toMatchObject({
    kind: "blob",
    lfs: null,
  });
  expect(await describeBlob(repository, head, "Assets/link.png", signal)).toEqual({
    kind: "symlink",
    target: "hero image.png",
  });
  expect(await describeBlob(repository, head, "Assets/gone.png", signal)).toEqual({
    kind: "missing",
  });
  // A glob is a name, not a pattern.
  expect(await describeBlob(repository, head, "Assets/*.png", signal)).toEqual({ kind: "missing" });
});

test("paths outside the repository are refused", async () => {
  for (const path of ["../secret", "/etc/passwd", "Assets//x", "Assets/../x"]) {
    await expect(describeBlob(repository, head, path, signal)).rejects.toThrow();
  }
});

test("a git blob reads back exactly, one range at a time", async () => {
  const described = await describeBlob(repository, head, "Assets/hero image.png", signal);
  if (described.kind !== "blob") throw new Error("not a blob");
  const object = { kind: "git" as const, oid: described.oid };
  const first = await readBlobChunk(repository, object, 0, 100_000, signal);
  const rest = await readBlobChunk(repository, object, 100_000, 400_000, signal);
  expect(first.size).toBe(image.length);
  expect(
    Buffer.concat([Buffer.from(first.content, "base64"), Buffer.from(rest.content, "base64")]),
  ).toEqual(image);
  const past = await readBlobChunk(repository, object, image.length, 10, signal);
  expect(past.content).toBe("");
  // The copy read from is this user's alone, so a shared machine cannot read a private repository through it.
  const spool = await Promise.any(
    (await spools()).map(async (name) => {
      const directory = join(tmpdir(), name);
      await stat(join(directory, described.oid));
      return directory;
    }),
  );
  expect((await stat(spool)).mode & 0o077).toBe(0);
  expect((await stat(join(spool, described.oid))).mode & 0o077).toBe(0);
  await rm(spool, { recursive: true, force: true });
});

test("an object id from another repository is not read from the shared spool", async () => {
  const other = join(root, "other");
  await mkdir(other);
  await git(other, ["init", "--quiet", "."]);
  const oid = (
    await runGitCommand(other, ["hash-object", "-w", "--stdin"], signal, "only in other\n")
  ).stdout.trim();
  await readBlobChunk(other, { kind: "git", oid }, 0, 10, signal);
  await expect(readBlobChunk(repository, { kind: "git", oid }, 0, 10, signal)).rejects.toThrow();
});

test("an LFS object already in the store is read from it", async () => {
  const store = join(
    repository,
    ".git",
    "lfs",
    "objects",
    modelOid.slice(0, 2),
    modelOid.slice(2, 4),
  );
  await mkdir(store, { recursive: true });
  await writeFile(join(store, modelOid), model);
  const read = await readBlobChunk(
    repository,
    { kind: "lfs", oid: modelOid, size: model.length },
    0,
    1024,
    signal,
  );
  expect(Buffer.from(read.content, "base64")).toEqual(model);
  expect(await describeBlob(repository, head, "Assets/hero.glb", signal)).toMatchObject({
    lfs: { local: true },
  });
  await rm(join(store, modelOid));
});

const hasLfs =
  (await runGitCommand(tmpdir(), ["lfs", "version"], signal).catch(() => null))?.code === 0;

test.skipIf(!hasLfs)(
  "a missing LFS object downloads from the checkout's own LFS remote, even when smudging is skipped",
  async () => {
    // A second checkout holds the object; the first fetches it from that file:// remote.
    const upstream = join(root, "upstream");
    await mkdir(upstream);
    await git(upstream, ["init", "--quiet", "."]);
    const objects = join(
      upstream,
      ".git",
      "lfs",
      "objects",
      modelOid.slice(0, 2),
      modelOid.slice(2, 4),
    );
    await mkdir(objects, { recursive: true });
    await writeFile(join(objects, modelOid), model);
    await git(repository, ["remote", "add", "origin", `file://${upstream}`]);
    await git(repository, ["config", "lfs.fetchexclude", "*"]);
    const read = await readBlobChunk(
      repository,
      { kind: "lfs", oid: modelOid, size: model.length },
      0,
      1024,
      signal,
    );
    expect(Buffer.from(read.content, "base64")).toEqual(model);
  },
);

test("an LFS object nobody has fails with a reason", async () => {
  const oid = createHash("sha256").update("nowhere").digest("hex");
  await expect(
    readBlobChunk(repository, { kind: "lfs", oid, size: 7 }, 0, 10, signal),
  ).rejects.toThrow(/Git LFS/);
});
