import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runGit } from "./cli.ts";
import { listRepositories, NoRepositoryError, resolveRepository } from "./repositories.ts";

const signal = new AbortController().signal;
let scratch = "";

/**
 * A single-repository environment, and a `repos/` one holding two worktrees,
 * a plain directory, and a symlink out to a worktree outside the environment.
 */
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "gitbutler-repositories-"));
  for (const path of ["single", "multi/repos/b", "multi/repos/a", "outside"]) {
    await mkdir(join(scratch, path), { recursive: true });
    await runGit(join(scratch, path), ["init", "--quiet", "."], signal);
  }
  await mkdir(join(scratch, "multi/repos/notes"));
  await symlink(join(scratch, "outside"), join(scratch, "multi/repos/escape"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("a worktree at the environment root is the only repository", async () => {
  const root = join(scratch, "single");
  expect(await listRepositories(root, signal)).toEqual([
    { key: ".", name: basename(await realpath(root)) },
  ]);
});

test("without one, the worktrees directly under repos/ are listed in name order", async () => {
  // The plain directory and the symlink out of the environment are left out.
  expect(await listRepositories(join(scratch, "multi"), signal)).toEqual([
    { key: "repos/a", name: "a" },
    { key: "repos/b", name: "b" },
  ]);
});

test("a key that leads outside the environment is refused", async () => {
  const failure = await resolveRepository(join(scratch, "multi"), "repos/escape", signal).catch(
    (error) => error,
  );
  expect(failure).toBeInstanceOf(NoRepositoryError);
  expect((failure as Error).message).toBe("That repository is no longer available.");
});
