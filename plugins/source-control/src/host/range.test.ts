/** A Change's range on a real repository: files with sizes, a rename and a binary, patches and commits. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { isolate } from "../../test/isolate.ts";
import { git } from "../../test/repos.ts";
import { rangeCommits, rangeFiles, rangePatches, resolveBase } from "./range.ts";

await isolate("source-control-range");
const signal = new AbortController().signal;
let repo = "",
  base = "",
  head = "";

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "sc-range-"));
  git(repo, "init", "--quiet", "-b", "main");
  await writeFile(
    join(repo, "old.ts"),
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
  );
  await writeFile(join(repo, "keep.ts"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "base");
  base = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "mv", "old.ts", "new.ts");
  await writeFile(join(repo, "keep.ts"), "one\ntwo\nthree\n");
  await writeFile(join(repo, "logo.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "Rename and grow");
  head = git(repo, "rev-parse", "HEAD").trim();
});
afterAll(() => rm(repo, { recursive: true, force: true }));

test("files say their kind, old path and size; a binary counts nothing", async () => {
  const files = await rangeFiles(repo, base, head, signal);
  expect(files.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
    {
      path: "keep.ts",
      kind: "modified",
      previousPath: null,
      additions: 2,
      deletions: 0,
      binary: false,
    },
    {
      path: "logo.bin",
      kind: "added",
      previousPath: null,
      additions: 0,
      deletions: 0,
      binary: true,
    },
    {
      path: "new.ts",
      kind: "renamed",
      previousPath: "old.ts",
      additions: 0,
      deletions: 0,
      binary: false,
    },
  ]);
});

test("patches for the asked paths only, with a rename paired by its old path", async () => {
  const { files } = await rangePatches(repo, base, head, ["new.ts", "old.ts", "keep.ts"], signal);
  expect(files.map((file) => [file.path, file.kind, file.previousPath])).toEqual([
    ["keep.ts", "modified", null],
    ["new.ts", "renamed", "old.ts"],
  ]);
  expect(files[0]!.patch).toContain("+two");
});

test("commits newest first", async () => {
  expect((await rangeCommits(repo, base, head, signal)).map((commit) => commit.subject)).toEqual([
    "Rename and grow",
  ]);
});

test("one commit's own files, read against its first parent", async () => {
  const files = await rangeFiles(repo, `${head}^`, head, signal);
  expect(files.map((file) => file.path).toSorted()).toEqual(["keep.ts", "logo.bin", "new.ts"]);
});

test("a base named by branch is that branch on the remote, else the remote's default", async () => {
  const remote = await mkdtemp(join(tmpdir(), "sc-range-remote-"));
  try {
    git(remote, "init", "--quiet", "--bare", "-b", "main");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "--quiet", "origin", `${base}:refs/heads/main`, `${head}:refs/heads/next`);
    git(repo, "fetch", "--quiet", "origin");
    // A remote added by hand has no HEAD: `main` stands in for the default.
    expect(await resolveBase(repo, "branch:", signal)).toBe(base);
    expect(await resolveBase(repo, "branch:next", signal)).toBe(head);
    expect(await resolveBase(repo, "branch:gone", signal)).toBe(base);
    expect(await resolveBase(repo, base, signal)).toBe(base);
  } finally {
    git(repo, "remote", "remove", "origin");
    await rm(remote, { recursive: true, force: true });
  }
});
