import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, forget, turnPatch } from "../src/host/snapshots.ts";
import type { CaptureKind, TurnWindow } from "../src/shared/host-contract.ts";

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

/** Captures run in real time, so space the fake clock well past any capture's duration. */
const T = (seconds: number) => seconds * 10_000;
function turn(started: number, completed: number, extra: Partial<TurnWindow> = {}): TurnWindow {
  return {
    prevCompletedAt: 0,
    startedAt: T(started),
    completedAt: T(completed),
    nextStartedAt: null,
    ...extra,
  };
}
const snap = (dir: string, thread: string, at: number, kind: CaptureKind) =>
  capture(dir, thread, T(at), kind, signal);
const diff = (dir: string, thread: string, window: TurnWindow, recorded: string[] = []) =>
  turnPatch(dir, thread, window, recorded, undefined, signal);

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a turn's patch holds every file the checkout gained, however it was written", async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.ts"), "a before the turn\n");
  sh(dir, "add", "a.ts"); // A staged change the user made before the turn.

  await snap(dir, "thr_a", 1, "start");
  writeFileSync(join(dir, "a.ts"), "a from the agent\n");
  writeFileSync(join(dir, "new.ts"), "created by a shell command\n");
  writeFileSync(join(dir, "ignored.log"), "noise\n");
  await snap(dir, "thr_a", 3, "end");

  const result = await diff(dir, "thr_a", turn(2, 2.5));
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
  await snap(dir, "thr_a", 1, "start");
  writeFileSync(join(dir, "a.ts"), "committed during the turn\n");
  sh(dir, "commit", "-qam", "agent commit");
  await snap(dir, "thr_a", 3, "end");

  expect(files((await diff(dir, "thr_a", turn(2, 2.5)))?.patch)).toEqual(["a.ts"]);
});

test("another agent's edits in the same checkout are split out", async () => {
  const dir = repo();
  await snap(dir, "thr_a", 1, "open");
  await snap(dir, "thr_b", 2, "open");
  writeFileSync(join(dir, "b.ts"), "b from agent B\n");
  writeFileSync(join(dir, "a.ts"), "a from agent A\n");
  writeFileSync(join(dir, "fmt.ts"), "shell output while both ran\n");
  await snap(dir, "thr_b", 3, "end");
  writeFileSync(join(dir, "solo.ts"), "shell output after B finished\n");
  await snap(dir, "thr_a", 4, "end");

  const a = await diff(dir, "thr_a", turn(1.5, 3.5), [join(dir, "a.ts")]);
  expect(files(a?.patch)).toEqual(["a.ts", "solo.ts"]);
  expect(files(a?.otherPatch)).toEqual(["b.ts", "fmt.ts"]);
  expect(a?.root).toBe(realpathSync(dir));

  const b = await diff(dir, "thr_b", turn(2.5, 2.9), ["b.ts"]);
  expect(files(b?.patch)).toEqual(["b.ts"]);
  expect(files(b?.otherPatch)).toEqual(["a.ts", "fmt.ts"]);
});

test("a dispatch baseline that never became a running turn does not contest the window", async () => {
  const dir = repo();
  await snap(dir, "thr_b", 0.5, "start"); // Queued by another plugin; never opened.
  await snap(dir, "thr_a", 1, "open");
  writeFileSync(join(dir, "fmt.ts"), "shell output\n");
  await snap(dir, "thr_a", 3, "end");

  const result = await diff(dir, "thr_a", turn(1.5, 2.5));
  expect(files(result?.patch)).toEqual(["fmt.ts"]);
  expect(result?.otherPatch).toBeNull();
});

test("an attribution, once known, survives the other thread's captures being dropped", async () => {
  const dir = repo();
  await snap(dir, "thr_a", 1, "open");
  await snap(dir, "thr_b", 2, "open");
  writeFileSync(join(dir, "b.ts"), "b from agent B\n");
  await snap(dir, "thr_b", 3, "end");
  await snap(dir, "thr_a", 4, "end");
  const first = await diff(dir, "thr_a", turn(1.5, 3.5));
  expect(files(first?.otherPatch)).toEqual(["b.ts"]);

  await forget(dir, "thr_b", signal);
  const again = await turnPatch(dir, "thr_a", turn(1.5, 3.5), [], first!.attribution, signal);
  expect(files(again?.otherPatch)).toEqual(["b.ts"]);
  // Without the remembered answer, B's edit would now be claimed by A.
  expect(files((await diff(dir, "thr_a", turn(1.5, 3.5)))?.patch)).toEqual(["b.ts"]);
});

test("paths are relative to an environment inside the repository", async () => {
  const dir = repo();
  const app = join(dir, "packages/app");
  mkdirSync(app, { recursive: true });
  await snap(app, "thr_a", 1, "start");
  writeFileSync(join(app, "main.ts"), "main\n");
  writeFileSync(join(dir, "outside.ts"), "outside the environment\n");
  await snap(app, "thr_a", 3, "end");

  expect(files((await diff(app, "thr_a", turn(2, 2.5)))?.patch)).toEqual(["main.ts"]);
});

test("recorded paths match through a symlinked environment path", async () => {
  const dir = repo();
  const link = `${dir}-link`;
  symlinkSync(dir, link);
  repos.push(link);
  await snap(link, "thr_a", 1, "open");
  await snap(link, "thr_b", 1.1, "open");
  writeFileSync(join(dir, "a.ts"), "a from agent A\n");
  await snap(link, "thr_b", 3, "end");
  await snap(link, "thr_a", 4, "end");

  // Providers report the resolved path (macOS reports /tmp as /private/tmp).
  const resolved = join(realpathSync(dir), "a.ts");
  const result = await diff(link, "thr_a", turn(1.5, 3.5), [resolved]);
  expect(files(result?.patch)).toEqual(["a.ts"]);
  expect(result?.otherPatch).toBeNull();
  expect(result?.root).toBe(realpathSync(dir));
});

test("only captures that provably bracket the turn are used", async () => {
  const dir = repo();
  await snap(dir, "thr_a", 1, "end"); // The previous turn's end.
  writeFileSync(join(dir, "b.ts"), "edited between turns\n");
  await snap(dir, "thr_a", 5, "open");
  writeFileSync(join(dir, "a.ts"), "edited by the turn\n");
  await snap(dir, "thr_a", 9, "end");
  const window = turn(4.9999, 8, { prevCompletedAt: T(0.9) });

  // thread.active landed just after turn/started: it still wins over the previous end.
  expect(files((await diff(dir, "thr_a", window))?.patch)).toEqual(["a.ts"]);
  // A baseline still being read well after the turn started may hold its first edits.
  expect(await diff(dir, "thr_a", { ...window, startedAt: T(4) })).toBeNull();
  // An end capture still being read after the next turn started may hold its edits.
  expect(await diff(dir, "thr_a", { ...window, nextStartedAt: T(8.5) })).toBeNull();
  // Without its own baseline, the previous turn's end is not borrowed.
  expect(await diff(dir, "thr_a", { ...window, prevCompletedAt: T(6) })).toBeNull();
});

test("changes hidden by index flags are still captured", async () => {
  const dir = repo();
  sh(dir, "update-index", "--assume-unchanged", "a.ts");
  sh(dir, "update-index", "--skip-worktree", "b.ts");
  await snap(dir, "thr_a", 1, "start");
  writeFileSync(join(dir, "a.ts"), "a behind assume-unchanged\n");
  writeFileSync(join(dir, "b.ts"), "b behind skip-worktree\n");
  await snap(dir, "thr_a", 3, "end");

  expect(files((await diff(dir, "thr_a", turn(2, 2.5)))?.patch)).toEqual(["a.ts", "b.ts"]);
  // The user's flags stay on the real index.
  expect(sh(dir, "ls-files", "-v", "a.ts", "b.ts")).toBe("h a.ts\nS b.ts\n");
});

test("an oversized patch is reported as limited instead of failing", async () => {
  const dir = repo();
  await snap(dir, "thr_a", 1, "start");
  writeFileSync(join(dir, "big.txt"), "line of generated text\n".repeat(80_000));
  await snap(dir, "thr_a", 3, "end");

  expect(await diff(dir, "thr_a", turn(2, 2.5))).toMatchObject({ patch: null, limited: true });
});

test("submodule roots are reported as outside snapshot coverage", async () => {
  const dir = repo();
  const inner = repo();
  sh(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "vendor/inner");
  sh(dir, "commit", "-qm", "add submodule");
  await snap(dir, "thr_a", 1, "start");
  writeFileSync(join(dir, "vendor/inner/a.ts"), "edited inside the submodule\n");
  await snap(dir, "thr_a", 3, "end");

  expect(await diff(dir, "thr_a", turn(2, 2.5))).toMatchObject({
    patch: "",
    uncovered: ["vendor/inner"],
  });
});

test("turns without a bracketing pair of captures have no snapshot", async () => {
  const dir = repo();
  await snap(dir, "thr_a", 1, "start");
  expect(await diff(dir, "thr_a", turn(2, 2.5))).toBeNull();
  expect(await diff(dir, "thr_b", turn(2, 2.5))).toBeNull();
  const plain = mkdtempSync(join(tmpdir(), "last-turn-plain-"));
  repos.push(plain);
  expect(await capture(plain, "thr_a", 1_000, "start", signal)).toBe(false);
});

test("captures are bounded per thread and forgotten with it", async () => {
  const dir = repo();
  for (let at = 1; at <= 30; at++) await snap(dir, "thr_a", at, "start");
  const refs = () =>
    sh(dir, "for-each-ref", "--format=%(refname)", "refs/bb-last-turn").split("\n").filter(Boolean);
  expect(refs()).toHaveLength(24);
  expect(refs()[0]).toMatch(/\/thr_a\/000000000070000-\d{15}-start$/);
  await forget(dir, "thr_a", signal);
  expect(refs()).toEqual([]);
});
