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
