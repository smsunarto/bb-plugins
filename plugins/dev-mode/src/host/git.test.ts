import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ArenaGit, command } from "./git.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "arena-git-"));
  directories.push(directory);
  const root = join(directory, "source");
  const worktree = join(directory, "synthesis");
  const state = join(directory, "state");
  await mkdir(root);
  const signal = new AbortController().signal;
  const git = (args: string[]) => command(root, ["git", ...args], signal);
  await git(["init", "--quiet"]);
  await git(["config", "user.name", "Arena test"]);
  await git(["config", "user.email", "arena-test@localhost"]);
  await writeFile(join(root, "result.txt"), "old\n");
  await writeFile(join(root, ".gitignore"), ".verification-count\n");
  await git(["add", "."]);
  await git(["commit", "--quiet", "-m", "fixture"]);
  const runId = randomUUID();
  const arena = new ArenaGit(state);
  const pin = await arena.snapshot({ runId, path: root }, signal);
  await git(["worktree", "add", "--quiet", "--detach", worktree, pin.base]);
  const identity = { runId, round: 1 };
  const input = {
    ...identity,
    snapshotId: randomUUID(),
    root,
    base: pin.base,
    synthesisPath: worktree,
  };
  async function check(script = 'test "$(cat result.txt)" = new') {
    // Verification belongs to the worker. The host receives its structured results.
    const result = await command(worktree, ["/bin/sh", "-c", script], signal, {
      acceptFailure: true,
    });
    return [{ command: script, exitCode: result.exitCode, output: result.output.slice(-12000) }];
  }
  async function integrate(script?: string) {
    const preparation = await arena.prepare(input, signal);
    if (preparation.status !== "prepared") return preparation;
    return arena.integrate({ ...identity, checks: await check(script) }, signal);
  }
  return {
    directory,
    state,
    root,
    worktree,
    signal,
    git,
    runId,
    arena,
    input,
    identity,
    check,
    integrate,
  };
}

test("snapshots dirty and untracked files without changing the source index", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "result.txt"), "local edit\n");
  await writeFile(join(f.root, "untracked.txt"), "preserve\n");
  const before = (await f.git(["diff", "--cached", "--binary"])).stdout;
  const pinned = await f.arena.snapshot({ runId: randomUUID(), path: f.root }, f.signal);
  expect((await f.git(["show", `${pinned.base}:result.txt`])).stdout).toBe("local edit\n");
  expect((await f.git(["show", `${pinned.base}:untracked.txt`])).stdout).toBe("preserve\n");
  expect((await f.git(["diff", "--cached", "--binary"])).stdout).toBe(before);
  expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("local edit\n");
  expect((await f.git(["rev-parse", `${pinned.base}^`])).stdout).toBe(
    (await f.git(["rev-parse", "HEAD"])).stdout,
  );
});

// Simulates what GitButler leaves in a repository: stacks on the target, an octopus workspace
// commit on gitbutler/workspace checked out through HEAD, and the target recorded in git config.
async function gitbutler() {
  const directory = await mkdtemp(join(tmpdir(), "arena-gitbutler-"));
  directories.push(directory);
  const root = join(directory, "workspace");
  await mkdir(root);
  const signal = new AbortController().signal;
  const git = async (args: string[], cwd = root) =>
    (await command(cwd, ["git", ...args], signal)).stdout.trim();
  await git(["init", "--quiet", "--initial-branch=main"]);
  await git(["config", "user.name", "Arena test"]);
  await git(["config", "user.email", "arena-test@localhost"]);
  await writeFile(join(root, "a.txt"), "a1\n");
  await writeFile(join(root, "b.txt"), "b1\n");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await git(["add", "."]);
  await git(["commit", "--quiet", "-m", "target"]);
  const target = await git(["rev-parse", "HEAD"]);
  await git(["update-ref", "refs/remotes/origin/main", target]);
  const stack = async (name: string, file: string) => {
    await git(["checkout", "--quiet", "-b", name, target]);
    await writeFile(join(root, file), `${name}\n`);
    await git(["commit", "--quiet", "-am", name]);
    return git(["rev-parse", "HEAD"]);
  };
  const stacks = [await stack("stack-a", "a.txt"), await stack("stack-b", "b.txt")];
  const tree = (await git(["merge-tree", "--write-tree", ...stacks])).split("\n")[0]!;
  const workspace = (
    await command(
      root,
      ["git", "commit-tree", tree, ...stacks.flatMap((commit) => ["-p", commit])],
      signal,
      {
        input: "GitButler Workspace Commit\n",
        env: {
          GIT_AUTHOR_NAME: "GitButler",
          GIT_AUTHOR_EMAIL: "gitbutler@gitbutler.com",
          GIT_COMMITTER_NAME: "GitButler",
          GIT_COMMITTER_EMAIL: "gitbutler@gitbutler.com",
        },
      },
    )
  ).stdout.trim();
  await git(["update-ref", "refs/heads/gitbutler/workspace", workspace]);
  await git(["symbolic-ref", "HEAD", "refs/heads/gitbutler/workspace"]);
  await git(["reset", "--quiet", "--hard", workspace]);
  await git(["config", "gitbutler.project.targetref", "refs/remotes/origin/main"]);
  await git(["config", "gitbutler.project.targetcommitid", target]);
  const managed = [workspace, ...stacks];
  async function ancestry(commit: string) {
    return (await git(["rev-list", commit])).split("\n");
  }
  return { directory, root, signal, git, target, managed, ancestry };
}

test("GitButler workspace snapshots branch from its target with the full working state", async () => {
  const g = await gitbutler();
  await writeFile(join(g.root, "a.txt"), "uncommitted\n");
  await writeFile(join(g.root, "untracked.txt"), "preserve\n");
  await writeFile(join(g.root, "ignored.txt"), "skip\n");
  const index = await readFile(join(g.root, ".git", "index"));
  const arena = new ArenaGit(join(g.directory, "state"));
  const { base } = await arena.snapshot({ runId: randomUUID(), path: g.root }, g.signal);
  expect(await g.git(["show", `${base}:a.txt`])).toBe("uncommitted");
  expect(await g.git(["show", `${base}:b.txt`])).toBe("stack-b");
  expect(await g.git(["show", `${base}:untracked.txt`])).toBe("preserve");
  expect(await g.git(["ls-tree", "--name-only", base, "ignored.txt"])).toBe("");
  expect(await readFile(join(g.root, ".git", "index"))).toEqual(index);
  expect(await g.git(["rev-parse", `${base}^`])).toBe(g.target);
  for (const commit of g.managed) expect(await g.ancestry(base)).not.toContain(commit);
  expect(await g.git(["symbolic-ref", "HEAD"])).toBe("refs/heads/gitbutler/workspace");
  expect(await readFile(join(g.root, "a.txt"), "utf8")).toBe("uncommitted\n");
});

test("a linked checkout of an applied stack branches from GitButler's target", async () => {
  const g = await gitbutler();
  const checkout = join(g.directory, "stack-a");
  await g.git(["worktree", "add", "--quiet", checkout, "stack-a"]);
  await writeFile(join(checkout, "b.txt"), "dirty\n");
  const arena = new ArenaGit(join(g.directory, "state"));
  const { base } = await arena.snapshot({ runId: randomUUID(), path: checkout }, g.signal);
  expect(await g.git(["show", `${base}:a.txt`])).toBe("stack-a");
  expect(await g.git(["show", `${base}:b.txt`])).toBe("dirty");
  expect(await g.git(["rev-parse", `${base}^`])).toBe(g.target);
  for (const commit of g.managed) expect(await g.ancestry(base)).not.toContain(commit);
});

test("a linked branch with its own commits branches from GitButler's target", async () => {
  // The branch is outside the workspace today, but applying it later must not adopt workers.
  const g = await gitbutler();
  const checkout = join(g.directory, "feature");
  await g.git(["worktree", "add", "--quiet", "-b", "feature", checkout, g.target]);
  await writeFile(join(checkout, "feature.txt"), "feature\n");
  await g.git(["add", "."], checkout);
  await g.git(["commit", "--quiet", "-m", "feature"], checkout);
  const head = await g.git(["rev-parse", "HEAD"], checkout);
  const arena = new ArenaGit(join(g.directory, "state"));
  const { base } = await arena.snapshot({ runId: randomUUID(), path: checkout }, g.signal);
  expect(await g.git(["show", `${base}:feature.txt`])).toBe("feature");
  expect(await g.git(["rev-parse", `${base}^`])).toBe(g.target);
  expect(await g.ancestry(base)).not.toContain(head);
});

test("a worker checkout on an Arena base keeps its own history", async () => {
  const g = await gitbutler();
  const arena = new ArenaGit(join(g.directory, "state"));
  const { base } = await arena.snapshot({ runId: randomUUID(), path: g.root }, g.signal);
  const worker = join(g.directory, "worker");
  await g.git(["worktree", "add", "--quiet", "-b", "arena-candidate", worker, base]);
  await writeFile(join(worker, "worker.txt"), "worker\n");
  await g.git(["add", "."], worker);
  await g.git(["commit", "--quiet", "-m", "worker"], worker);
  const head = await g.git(["rev-parse", "HEAD"], worker);
  await writeFile(join(worker, "dirty.txt"), "dirty\n");
  const pinned = await arena.snapshot({ runId: randomUUID(), path: worker }, g.signal);
  expect(await g.git(["show", `${pinned.base}:dirty.txt`])).toBe("dirty");
  expect(await g.git(["rev-parse", `${pinned.base}^`])).toBe(head);
});

test("a snapshot after leaving GitButler mode keeps its own history", async () => {
  const g = await gitbutler();
  // `but teardown` checks out a stack but leaves the workspace ref and target config behind.
  await g.git(["checkout", "--quiet", "stack-a"]);
  const arena = new ArenaGit(join(g.directory, "state"));
  const { base } = await arena.snapshot({ runId: randomUUID(), path: g.root }, g.signal);
  expect(await g.git(["rev-parse", `${base}^`])).toBe(g.managed[1]!);
});

test("a target ahead of the workspace falls back to their shared history", async () => {
  const g = await gitbutler();
  const tree = await g.git(["rev-parse", `${g.target}^{tree}`]);
  const upstream = await g.git(["commit-tree", tree, "-p", g.target, "-m", "upstream"]);
  await g.git(["update-ref", "refs/remotes/origin/main", upstream]);
  await g.git(["config", "gitbutler.project.targetcommitid", upstream]);
  const arena = new ArenaGit(join(g.directory, "state"));
  const { base } = await arena.snapshot({ runId: randomUUID(), path: g.root }, g.signal);
  expect(await g.git(["rev-parse", `${base}^`])).toBe(g.target);
});

test.each([
  ["no target commit", ["--unset", "gitbutler.project.targetcommitid"]],
  ["an unknown target commit", ["gitbutler.project.targetcommitid", "f".repeat(40)]],
  ["a stack commit as its target", ["gitbutler.project.targetcommitid", "stack-a"]],
  ["no target branch", ["--unset", "gitbutler.project.targetref"]],
  ["a missing target branch", ["gitbutler.project.targetref", "refs/remotes/origin/missing"]],
])("a GitButler workspace with %s fails without pinning a snapshot", async (_case, config) => {
  const g = await gitbutler();
  await g.git(["config", ...config]);
  const arena = new ArenaGit(join(g.directory, "state"));
  await expect(arena.snapshot({ runId: randomUUID(), path: g.root }, g.signal)).rejects.toThrow(
    "GitButler's target commit",
  );
  expect(await g.git(["for-each-ref", "refs/arena/"])).toBe("");
});

test("GitButler edit mode fails without pinning a snapshot", async () => {
  const g = await gitbutler();
  await g.git(["checkout", "--quiet", "-b", "gitbutler/edit", "stack-a"]);
  const arena = new ArenaGit(join(g.directory, "state"));
  await expect(arena.snapshot({ runId: randomUUID(), path: g.root }, g.signal)).rejects.toThrow(
    "Exit GitButler edit mode",
  );
  expect(await g.git(["for-each-ref", "refs/arena/"])).toBe("");
});

test("every Arena pin of a GitButler run stays outside the workspace and still integrates", async () => {
  const g = await gitbutler();
  await writeFile(join(g.root, "ongoing.txt"), "keep ongoing work\n");
  const arena = new ArenaGit(join(g.directory, "state"));
  const runId = randomUUID();
  const { base } = await arena.snapshot({ runId, path: g.root }, g.signal);
  const synthesis = join(g.directory, "synthesis");
  await g.git(["worktree", "add", "--quiet", "-b", "arena-synthesis", synthesis, base]);
  await writeFile(join(synthesis, "a.txt"), "synthesized\n");
  const identity = { runId, round: 1 };
  const prepared = await arena.prepare(
    { ...identity, snapshotId: randomUUID(), root: g.root, base, synthesisPath: synthesis },
    g.signal,
  );
  if (prepared.status !== "prepared") throw new Error(prepared.summary);
  // The proposal pin keeps the synthesis HEAD, so it shows only the worker's change on the base.
  expect(await g.git(["rev-parse", `${prepared.proposalCommit}^`])).toBe(base);
  const checks = [{ command: "true", exitCode: 0, output: "" }];
  expect((await arena.integrate({ ...identity, checks }, g.signal)).status).toBe("integrated");
  expect(await readFile(join(g.root, "a.txt"), "utf8")).toBe("synthesized\n");
  expect(await readFile(join(g.root, "ongoing.txt"), "utf8")).toBe("keep ongoing work\n");
  const pins = (await g.git(["for-each-ref", "--format=%(objectname)", "refs/arena/"])).split("\n");
  expect(pins).toHaveLength(3);
  for (const pin of pins) {
    expect(await g.ancestry(pin)).toContain(g.target);
    for (const commit of g.managed) expect(await g.ancestry(pin)).not.toContain(commit);
  }
});

test("integrates the verified combined tree and preserves ongoing source work", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "result.txt"), "new\n");
  await writeFile(join(f.root, "ongoing.txt"), "keep ongoing work\n");
  const result = await f.integrate('test "$(cat result.txt)" = new && test -f ongoing.txt');
  expect(result.status).toBe("integrated");
  expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("new\n");
  expect(await readFile(join(f.root, "ongoing.txt"), "utf8")).toBe("keep ongoing work\n");
  expect((await f.git(["diff", "--cached", "--stat"])).stdout).toBe("");
});

test("failed checks leave the source untouched", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "result.txt"), "incorrect\n");
  const result = await f.integrate();
  expect(result.status).toBe("verification-failed");
  expect(result.checks[0]?.exitCode).not.toBe(0);
  expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("old\n");
});

test("conflicts preserve source files and include actionable Git output", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "result.txt"), "new\n");
  await writeFile(join(f.root, "result.txt"), "user edit\n");
  const result = await f.integrate();
  expect(result.status).toBe("conflict");
  expect(result.checks[0]?.output).toContain("result.txt");
  expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("user edit\n");
});

test("repeated integration reuses its receipt without executing supplied shell", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "result.txt"), "new\n");
  expect((await f.integrate()).status).toBe("integrated");
  const result = await f.arena.integrate(
    { ...f.identity, checks: [{ command: "touch bypass.txt", exitCode: 0, output: "" }] },
    f.signal,
  );
  expect(result.status).toBe("integrated");
  await expect(readFile(join(f.root, "bypass.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.arena.receipt(f.identity, f.signal)).toEqual(result);
});

test("patches larger than 8 MiB and binary files integrate without truncation", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "result.txt"), "new\n");
  const content = Array.from(
    { length: 130000 },
    (_, i) => `${i} ${"preserve spaces ".repeat(6)}\n`,
  ).join("");
  const binary = Buffer.from(Array.from({ length: 10000 }, (_, i) => i % 256));
  expect(Buffer.byteLength(content)).toBeGreaterThan(8 * 1024 * 1024);
  await writeFile(join(f.worktree, "large.txt"), content);
  await writeFile(join(f.worktree, "asset.bin"), binary);
  expect((await f.integrate()).status).toBe("integrated");
  expect(await readFile(join(f.root, "large.txt"), "utf8")).toBe(content);
  expect(await readFile(join(f.root, "asset.bin"))).toEqual(binary);
});

test("an aborted call before apply never changes source files", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "result.txt"), "new\n");
  await f.arena.prepare(f.input, f.signal);
  const checks = await f.check();
  const controller = new AbortController();
  controller.abort();
  await expect(f.arena.integrate({ ...f.identity, checks }, controller.signal)).rejects.toThrow();
  expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("old\n");
  expect(await f.arena.receipt(f.identity, f.signal)).toBeNull();
});

test("source edits after preparation prevent integration", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "result.txt"), "new\n");
  await f.arena.prepare(f.input, f.signal);
  const checks = await f.check();
  await writeFile(join(f.root, "concurrent.txt"), "preserve\n");
  expect((await f.arena.integrate({ ...f.identity, checks }, f.signal)).status).toBe("changed");
  expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("old\n");
  expect(await readFile(join(f.root, "concurrent.txt"), "utf8")).toBe("preserve\n");
});

test("verification output cannot become a new synthesis input on retry", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "result.txt"), "new\n");
  await writeFile(join(f.root, "ongoing.txt"), "temporary user edit\n");
  const first = await f.arena.prepare(f.input, f.signal);
  await writeFile(join(f.worktree, "coverage-report.txt"), "generated\n");
  await rm(join(f.root, "ongoing.txt"));
  const second = await f.arena.prepare(f.input, f.signal);
  expect(second).toEqual(first);
  expect(second.status).toBe("prepared");
  if (second.status !== "prepared") throw new Error("Expected preparation");
  await expect(f.git(["show", `${second.proposalCommit}:ongoing.txt`])).rejects.toThrow();
  await expect(f.git(["show", `${second.proposalCommit}:coverage-report.txt`])).rejects.toThrow();
  expect(
    (await f.arena.integrate({ ...f.identity, checks: await f.check() }, f.signal)).status,
  ).toBe("verification-failed");
  await expect(readFile(join(f.root, "ongoing.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(f.root, "coverage-report.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("checks that modify nonignored files require a new round", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "result.txt"), "new\n");
  expect((await f.integrate("echo changed > result.txt")).status).toBe("verification-failed");
  expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("old\n");
});

test("ignored build output is allowed", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "result.txt"), "new\n");
  expect(
    (await f.integrate('test "$(cat result.txt)" = new; echo checked > .verification-count'))
      .status,
  ).toBe("integrated");
});

test("Stop after the apply journal preserves a successful receipt", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "result.txt"), "new\n");
  await writeFile(join(f.worktree, "large.txt"), "big patch contents\n".repeat(700000));
  await f.arena.prepare(f.input, f.signal);
  const controller = new AbortController();
  // The journal is written to a temporary file and renamed into place. Bun's
  // fs.watch on Linux reports only the temporary name, so match its prefix.
  const watcher = watch(f.state, (_event, filename) => {
    if (filename?.startsWith(`${f.runId}-1.json`)) controller.abort();
  });
  try {
    const result = await f.arena.integrate(
      { ...f.identity, checks: await f.check() },
      controller.signal,
    );
    expect(controller.signal.aborted).toBe(true);
    expect(result.status).toBe("integrated");
    expect((await f.arena.receipt(f.identity, f.signal))?.status).toBe("integrated");
    expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("new\n");
  } finally {
    watcher.close();
  }
});

test("restart recovers a completed apply from its journal", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "result.txt"), "new\n");
  await f.arena.prepare(f.input, f.signal);
  const prepared = JSON.parse(await readFile(join(f.state, `${f.runId}-1.prepared.json`), "utf8"));
  const checks = await f.check();
  await f.arena.integrate({ ...f.identity, checks }, f.signal);
  await writeFile(
    join(f.state, `${f.runId}-1.json`),
    JSON.stringify({ phase: "applying", prepared, checks }),
  );
  const restarted = new ArenaGit(f.state);
  expect((await restarted.receipt(f.identity, f.signal))?.status).toBe("integrated");
});

test("an uncertain apply reports interruption instead of reapplying", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "result.txt"), "new\n");
  await f.arena.prepare(f.input, f.signal);
  const prepared = JSON.parse(await readFile(join(f.state, `${f.runId}-1.prepared.json`), "utf8"));
  const checks = await f.check();
  await writeFile(
    join(f.state, `${f.runId}-1.json`),
    JSON.stringify({ phase: "applying", prepared, checks }),
  );
  expect((await f.arena.integrate({ ...f.identity, checks }, f.signal)).status).toBe("interrupted");
  expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("old\n");
});

test("a reverted apply with a lost receipt is not mistaken for permission to apply again", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "result.txt"), "new\n");
  await f.arena.prepare(f.input, f.signal);
  const prepared = JSON.parse(await readFile(join(f.state, `${f.runId}-1.prepared.json`), "utf8"));
  const checks = await f.check();
  await f.arena.integrate({ ...f.identity, checks }, f.signal);
  // The receipt was lost at a crash; meanwhile the user reverted the applied file.
  await writeFile(
    join(f.state, `${f.runId}-1.json`),
    JSON.stringify({ phase: "applying", prepared, checks }),
  );
  await writeFile(join(f.root, "result.txt"), "old\n");
  const restarted = new ArenaGit(f.state);
  expect((await restarted.integrate({ ...f.identity, checks }, f.signal)).status).toBe(
    "interrupted",
  );
  expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("old\n");
});
