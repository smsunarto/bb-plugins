import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./cli.ts";
import { readBaseHistory } from "./history.ts";

const signal = new AbortController().signal;
let repository = "";

/** Four commits, newest last: the panel reads them newest first. */
const SUBJECTS = ["first", "second", "third", "fourth"] as const;

beforeAll(async () => {
  repository = await mkdtemp(join(tmpdir(), "gitbutler-history-"));
  await runGit(repository, ["init", "--quiet", "--initial-branch=main", "."], signal);
  await runGit(repository, ["config", "user.email", "test@example.com"], signal);
  await runGit(repository, ["config", "user.name", "Test Person"], signal);
  await runGit(repository, ["config", "commit.gpgsign", "false"], signal);
  for (const subject of SUBJECTS) {
    await writeFile(join(repository, "file.txt"), `${subject}\n`);
    await runGit(repository, ["add", "file.txt"], signal);
    await runGit(repository, ["commit", "--quiet", "-m", subject], signal);
  }
});

afterAll(async () => {
  await rm(repository, { recursive: true, force: true });
});

test("history starts below the base, which already has its own row", async () => {
  const page = await readBaseHistory(repository, "HEAD", 0, 10, signal);
  expect(page.commits.map((commit) => commit.message)).toEqual(["third", "second", "first"]);
  expect(page.hasMore).toBe(false);
});

test("paging walks further down without repeating a commit", async () => {
  const first = await readBaseHistory(repository, "HEAD", 0, 2, signal);
  expect(first.commits.map((commit) => commit.message)).toEqual(["third", "second"]);
  expect(first.hasMore).toBe(true);

  const second = await readBaseHistory(repository, "HEAD", 2, 2, signal);
  expect(second.commits.map((commit) => commit.message)).toEqual(["first"]);
  expect(second.hasMore).toBe(false);
});

test("history carries the author and an ISO date the panel can format", async () => {
  const [newest] = (await readBaseHistory(repository, "HEAD", 0, 1, signal)).commits;
  expect(newest?.authorName).toBe("Test Person");
  expect(Number.isNaN(Date.parse(newest?.createdAt ?? ""))).toBe(false);
  expect(newest?.commitId).toMatch(/^[0-9a-f]{40}$/);
});

test("the oldest commit has nothing below it", async () => {
  const oldest = await runGit(repository, ["rev-list", "--max-parents=0", "HEAD"], signal);
  const page = await readBaseHistory(repository, oldest.trim(), 0, 10, signal);
  expect(page.commits).toEqual([]);
  expect(page.hasMore).toBe(false);
});
