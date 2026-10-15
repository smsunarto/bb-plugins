import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runGit } from "./cli.ts";
import {
  findBranchCheckouts,
  findCheckouts,
  isKnownWorkspace,
  listRepositories,
  NoRepositoryError,
  resolveRepository,
} from "./repositories.ts";

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

test("machine discovery follows registered named worktrees outside known environments only", async () => {
  const root = join(scratch, "registered", "main");
  await mkdir(root, { recursive: true });
  await runGit(root, ["init", "--quiet", "--initial-branch=gitbutler/workspace", "."], signal);
  await runGit(root, ["config", "user.email", "test@example.com"], signal);
  await runGit(root, ["config", "user.name", "Test Person"], signal);
  await runGit(root, ["config", "commit.gpgsign", "false"], signal);
  await runGit(root, ["remote", "add", "origin", "git@github.com:Acme/App.git"], signal);
  await writeFile(join(root, "base.txt"), "base\n");
  await runGit(root, ["add", "base.txt"], signal);
  await runGit(root, ["commit", "--quiet", "-m", "base"], signal);

  const linked = join(scratch, "external", "performance\ncheckout");
  const detached = join(scratch, "external", "detached");
  const stale = join(scratch, "external", "stale");
  const foreign = join(scratch, "external", "foreign");
  await runGit(root, ["worktree", "add", "--quiet", "-b", "scott/performance", linked], signal);
  await runGit(root, ["worktree", "add", "--quiet", "--detach", detached], signal);
  await runGit(root, ["worktree", "add", "--quiet", "-b", "scott/stale", stale], signal);
  await runGit(root, ["worktree", "add", "--quiet", "-b", "scott/foreign", foreign], signal);
  await rm(stale, { recursive: true });
  await runGit(root, ["config", "extensions.worktreeConfig", "true"], signal);
  await runGit(
    foreign,
    ["config", "--worktree", "remote.origin.url", "git@github.com:Acme/Other.git"],
    signal,
  );
  const unrelated = join(scratch, "external", "unregistered-sibling");
  await runGit(root, ["init", "--quiet", "--initial-branch=main", unrelated], signal);
  await runGit(unrelated, ["remote", "add", "origin", "git@github.com:Acme/App.git"], signal);
  const bare = join(scratch, "external", "bare.git");
  await runGit(root, ["init", "--quiet", "--bare", bare], signal);
  const alias = join(scratch, "registered", "alias");
  await symlink(root, alias);
  const realRoot = await realpath(root);
  const realLinked = await realpath(linked);

  const summarize = async (known: string[]) =>
    (await findBranchCheckouts(known, "github.com/acme/app", signal)).map((repository) => ({
      path: repository.path,
      kind: repository.kind,
      branch: repository.kind === "git" ? repository.branch : null,
    }));
  const expected = [
    { path: realLinked, kind: "git" as const, branch: "scott/performance" },
    { path: realRoot, kind: "gitbutler" as const, branch: null },
  ].sort((a, b) => a.path.localeCompare(b.path));

  // The linked path itself is not registered with bb.
  expect(await summarize([root, alias, join(root, "nested"), bare])).toEqual(expected);
  // Reaching it through several known paths still gives one row.
  expect(await summarize([root, alias, linked, root])).toEqual(expected);
  // Review authorization remains limited to known GitButler workspaces.
  expect(
    (await findCheckouts([root, linked], "github.com/acme/app", signal)).map(({ path }) => path),
  ).toEqual([realRoot]);
  expect(await isKnownWorkspace([root, linked], realRoot, signal)).toBe(true);
  expect(await isKnownWorkspace([root, linked], realLinked, signal)).toBe(false);
});

test("GitButler resolution checkouts remain managed in discovery and authorization", async () => {
  const root = join(scratch, "resolving");
  await mkdir(root);
  await runGit(root, ["init", "--quiet", "--initial-branch=gitbutler/edit", "."], signal);
  await runGit(root, ["remote", "add", "origin", "git@github.com:Acme/App.git"], signal);
  const path = await realpath(root);

  expect(await findBranchCheckouts([root], "github.com/acme/app", signal)).toEqual([
    { key: ".", name: "resolving", path, origin: "github.com/acme/app", kind: "gitbutler" },
  ]);
  expect(await findCheckouts([root], "github.com/acme/app", signal)).toEqual([
    { key: ".", name: "resolving", path, origin: "github.com/acme/app" },
  ]);
  expect(await isKnownWorkspace([root], path, signal)).toBe(true);
});
