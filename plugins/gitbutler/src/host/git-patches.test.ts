import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSingularPatch } from "@pierre/diffs";
import { runGit } from "./cli.ts";
import { readBaseHistory } from "./history.ts";
import { patchesFromGit } from "./parse.ts";

const signal = new AbortController().signal;
let repository = "";

async function commit(message: string): Promise<string> {
  await runGit(repository, ["add", "--all"], signal);
  await runGit(repository, ["commit", "--quiet", "-m", message], signal);
  return (await runGit(repository, ["rev-parse", "HEAD"], signal)).trim();
}

/** The commit's patches the way the host's fallback reads them. */
async function show(commitId: string) {
  const output = await runGit(
    repository,
    ["-c", "core.quotePath=false", "show", "--format=", "--no-color", "-M", commitId, "--"],
    signal,
  );
  return patchesFromGit(output, 1_000_000);
}

beforeAll(async () => {
  repository = await mkdtemp(join(tmpdir(), "gitbutler-git-patches-"));
  await runGit(repository, ["init", "--quiet", "--initial-branch=main", "."], signal);
  await runGit(repository, ["config", "user.email", "test@example.com"], signal);
  await runGit(repository, ["config", "user.name", "Test Person"], signal);
  await runGit(repository, ["config", "commit.gpgsign", "false"], signal);
  await writeFile(join(repository, "target.txt"), "target\n");
  await writeFile(join(repository, "swap"), "a regular file\n");
  await commit("chore: start");
});

afterAll(async () => {
  await rm(repository, { recursive: true, force: true });
});

test("a file name git has to quote keeps its real name", async () => {
  await writeFile(join(repository, 'say "hi".txt'), "hi\n");
  await writeFile(join(repository, "back\\slash.txt"), "slash\n");
  await writeFile(join(repository, "tab\there.txt"), "tab\n");
  await writeFile(join(repository, "café.txt"), "café\n");
  const patches = await show(await commit("feat: awkward names"));
  expect(patches.files.map((file) => [file.path, file.kind])).toEqual([
    ["back\\slash.txt", "added"],
    ["café.txt", "added"],
    ['say "hi".txt', "added"],
    ["tab\there.txt", "added"],
  ]);
});

test("a newline in a file name stays in its name, not in its patch", async () => {
  const name = "line\n@@ -1 +1 @@\nbreak.ts";
  await writeFile(join(repository, name), "one line\n");
  const patches = await show(await commit("chore: hostile name"));
  expect(patches.files.map((file) => file.path)).toEqual([name]);
  const parsed = getSingularPatch(patches.files[0]!.patch);
  expect(parsed.hunks).toHaveLength(1);
  expect(parsed.hunks[0]?.additionLines).toBe(1);
  expect(parsed.hunks[0]?.deletionLines).toBe(0);
});

test("a rename to a name starting with U+FEFF keeps it apart from the same name without", async () => {
  // Rename lines carry no a/ or b/ prefix, so the mark is the first thing decoded.
  await writeFile(join(repository, "plain.ts"), "plain\n");
  await writeFile(join(repository, "marked.ts"), "marked\n");
  await commit("chore: two files");
  await runGit(repository, ["mv", "plain.ts", '"bom".ts'], signal);
  await runGit(repository, ["mv", "marked.ts", '\uFEFF"bom".ts'], signal);
  const patches = await show(await commit("refactor: byte order marks"));
  expect(patches.files.map((file) => [file.path, file.kind, file.previousPath])).toEqual([
    ['"bom".ts', "renamed", "plain.ts"],
    ['\uFEFF"bom".ts', "renamed", "marked.ts"],
  ]);
});

test("a rename to a quoted name names both sides plainly", async () => {
  await runGit(repository, ["mv", 'say "hi".txt', 'say "bye".txt'], signal);
  const patches = await show(await commit("refactor: rename"));
  expect(patches.files.map((file) => [file.path, file.kind, file.previousPath])).toEqual([
    ['say "bye".txt', "renamed", 'say "hi".txt'],
  ]);
});

test("a file that becomes a symlink, and back, is one card showing what is there now", async () => {
  await rm(join(repository, "swap"));
  await symlink("target.txt", join(repository, "swap"));
  const toLink = await show(await commit("chore: link it"));
  expect(toLink.files.map((file) => [file.path, file.kind])).toEqual([["swap", "modified"]]);
  expect(getSingularPatch(toLink.files[0]!.patch).hunks[0]?.additionLines).toBe(1);
  expect(toLink.files[0]!.patch).toContain("+target.txt");

  await rm(join(repository, "swap"));
  await writeFile(join(repository, "swap"), "a regular file again\n");
  const toFile = await show(await commit("chore: unlink it"));
  expect(toFile.files.map((file) => [file.path, file.kind])).toEqual([["swap", "modified"]]);
  expect(toFile.files[0]!.patch).toContain("+a regular file again");
});

test("history carries the whole message, so a commit's detail can show its body", async () => {
  await writeFile(join(repository, "target.txt"), "moved\n");
  await commit("fix: subject line\n\nWhy it changed.\nAnd more.");
  await writeFile(join(repository, "target.txt"), "moved again\n");
  await commit("chore: on top");
  const [below] = (await readBaseHistory(repository, "HEAD", 0, 1, signal)).commits;
  expect(below?.message).toBe("fix: subject line\n\nWhy it changed.\nAnd more.");
});
