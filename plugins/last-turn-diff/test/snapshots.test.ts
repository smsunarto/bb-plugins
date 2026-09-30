import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, forget, turnPatch } from "../src/host/snapshots.ts";

const signal = new AbortController().signal;
const repos: string[] = [];

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "last-turn-snapshots-"));
  repos.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@example.com");
  sh(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.ts"), "a\n");
  writeFileSync(join(dir, "b.ts"), "b\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

function files(patch: string | null | undefined): string[] {
  return [...(patch ?? "").matchAll(/^diff --git a\/(\S+)/gm)].map((match) => match[1]!);
}

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a turn's patch holds every file the checkout gained, however it was written", async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.ts"), "a before the turn\n");
  sh(dir, "add", "a.ts"); // A staged change the user made before the turn.

  await capture(dir, "thr_a", 1_000, "start", signal);
  writeFileSync(join(dir, "a.ts"), "a from the agent\n");
  writeFileSync(join(dir, "new.ts"), "created by a shell command\n");
  writeFileSync(join(dir, "ignored.log"), "noise\n");
  await capture(dir, "thr_a", 3_000, "end", signal);

  const result = await turnPatch(dir, "thr_a", 1_500, 2_500, [], signal);
  expect(files(result?.patch)).toEqual(["a.ts", "new.ts"]);
  expect(result?.patch).toContain("-a before the turn\n+a from the agent");
  expect(result?.otherPatch).toBeNull();
  // The user's index, branch, and HEAD are untouched.
  expect(sh(dir, "show", ":a.ts")).toBe("a before the turn\n");
  expect(sh(dir, "status", "--porcelain")).toBe("MM a.ts\n?? new.ts\n");
  expect(sh(dir, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main\n");
});

test("committing mid-turn, as `but commit` does, keeps the change in the turn", async () => {
  const dir = repo();
  await capture(dir, "thr_a", 1_000, "start", signal);
  writeFileSync(join(dir, "a.ts"), "committed during the turn\n");
  sh(dir, "commit", "-qam", "agent commit");
  await capture(dir, "thr_a", 3_000, "end", signal);

  const result = await turnPatch(dir, "thr_a", 1_500, 2_500, [], signal);
  expect(files(result?.patch)).toEqual(["a.ts"]);
});

test("another agent's edits in the same checkout are split out", async () => {
  const dir = repo();
  await capture(dir, "thr_a", 1_000, "start", signal);
  await capture(dir, "thr_b", 2_000, "start", signal);
  writeFileSync(join(dir, "b.ts"), "b from agent B\n");
  writeFileSync(join(dir, "a.ts"), "a from agent A\n");
  writeFileSync(join(dir, "fmt.ts"), "shell output while both ran\n");
  await capture(dir, "thr_b", 3_000, "end", signal);
  writeFileSync(join(dir, "solo.ts"), "shell output after B finished\n");
  await capture(dir, "thr_a", 4_000, "end", signal);

  const a = await turnPatch(dir, "thr_a", 1_500, 3_500, [join(dir, "a.ts")], signal);
  expect(files(a?.patch)).toEqual(["a.ts", "solo.ts"]);
  expect(files(a?.otherPatch)).toEqual(["b.ts", "fmt.ts"]);

  const b = await turnPatch(dir, "thr_b", 2_500, 2_900, ["b.ts"], signal);
  expect(a?.root).toBe(realpathSync(dir));
  expect(files(b?.patch)).toEqual(["b.ts"]);
  expect(files(b?.otherPatch)).toEqual(["a.ts", "fmt.ts"]);
});

test("paths are relative to an environment inside the repository", async () => {
  const dir = repo();
  const app = join(dir, "packages/app");
  mkdirSync(app, { recursive: true });
  await capture(app, "thr_a", 1_000, "start", signal);
  writeFileSync(join(app, "main.ts"), "main\n");
  writeFileSync(join(dir, "outside.ts"), "outside the environment\n");
  await capture(app, "thr_a", 3_000, "end", signal);

  const result = await turnPatch(app, "thr_a", 1_500, 2_500, [], signal);
  expect(files(result?.patch)).toEqual(["main.ts"]);
});

test("turns without a bracketing pair of captures have no snapshot", async () => {
  const dir = repo();
  await capture(dir, "thr_a", 1_000, "start", signal);
  expect(await turnPatch(dir, "thr_a", 1_500, 2_500, [], signal)).toBeNull();
  expect(await turnPatch(dir, "thr_b", 1_500, 2_500, [], signal)).toBeNull();
  const plain = mkdtempSync(join(tmpdir(), "last-turn-plain-"));
  repos.push(plain);
  expect(await capture(plain, "thr_a", 1_000, "start", signal)).toBe(false);
});

test("captures are bounded per thread and forgotten with it", async () => {
  const dir = repo();
  for (let at = 1; at <= 20; at++) await capture(dir, "thr_a", at * 1_000, "start", signal);
  const refs = () =>
    sh(dir, "for-each-ref", "--format=%(refname)", "refs/bb-last-turn").split("\n").filter(Boolean);
  expect(refs()).toHaveLength(16);
  expect(refs()[0]).toEndWith("/thr_a/000000000005000-start");
  await forget(dir, "thr_a", signal);
  expect(refs()).toEqual([]);
});

test("recorded paths match through a symlinked environment path", async () => {
  const dir = repo();
  const link = `${dir}-link`;
  symlinkSync(dir, link);
  repos.push(link);
  await capture(link, "thr_a", 1_000, "start", signal);
  await capture(link, "thr_b", 1_100, "start", signal);
  writeFileSync(join(dir, "a.ts"), "a from agent A\n");
  await capture(link, "thr_b", 3_000, "end", signal);
  await capture(link, "thr_a", 4_000, "end", signal);

  // Providers report the resolved path (macOS reports /tmp as /private/tmp).
  const resolved = join(realpathSync(dir), "a.ts");
  const result = await turnPatch(link, "thr_a", 1_500, 3_500, [resolved], signal);
  expect(files(result?.patch)).toEqual(["a.ts"]);
  expect(result?.otherPatch).toBeNull();
  expect(result?.root).toBe(realpathSync(dir));
});

test("a start capture just after the turn began outranks the previous turn's end", async () => {
  const dir = repo();
  await capture(dir, "thr_a", 1_000, "end", signal);
  writeFileSync(join(dir, "b.ts"), "edited between turns\n");
  // thread.active fired 6 ms after turn/started, as for a turn with no dispatch.
  await capture(dir, "thr_a", 5_006, "start", signal);
  writeFileSync(join(dir, "a.ts"), "edited by the turn\n");
  await capture(dir, "thr_a", 9_000, "end", signal);

  const result = await turnPatch(dir, "thr_a", 5_000, 8_000, [], signal);
  expect(files(result?.patch)).toEqual(["a.ts"]);
});
