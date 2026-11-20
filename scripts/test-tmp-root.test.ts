import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(resolve(import.meta.dir, "test-tmp-root.mjs")).href;
const OWNER_FILE = ".bbt-owner";
const SEVEN_HOURS_AGO = new Date(Date.now() - 7 * 60 * 60 * 1000);

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "test-tmp-root-"));
  scratch.push(dir);
  return dir;
}

/** Makes `dir` look abandoned: written by `ownerPid` if given, last touched seven hours ago. */
function oldRoot(dir: string, ownerPid?: number): string {
  mkdirSync(dir);
  if (ownerPid !== undefined) writeFileSync(join(dir, OWNER_FILE), `${ownerPid}\n`);
  utimesSync(dir, SEVEN_HOURS_AGO, SEVEN_HOURS_AGO);
  return dir;
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (child.pid === undefined) throw new Error("no pid");
  return child.pid;
}

/** Claims and releases a root in a fresh node process; returns the root it claimed. */
function claimOnce(env: Record<string, string>, cwd: string): string {
  const script = `import(${JSON.stringify(moduleUrl)}).then((m) => {
    const release = m.claimTestTmpRoot();
    console.log(process.env.BB_TEST_TMP_ROOT);
    release();
  });`;
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  if (!("BB_TEST_TMP_ROOT" in env)) delete childEnv.BB_TEST_TMP_ROOT;
  const result = spawnSync("node", ["-e", script], { cwd, env: childEnv, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

test("a claim leaves an old bbt-* dir that no run owns", () => {
  const base = scratchDir();
  const notes = oldRoot(join(base, "bbt-notes"));

  claimOnce({ TMPDIR: base }, base);

  expect(existsSync(notes)).toBe(true);
});

test("a claim leaves an old root whose owner is still running", () => {
  const base = scratchDir();
  const idle = oldRoot(join(base, "bbt-idle"), process.pid);

  claimOnce({ TMPDIR: base }, base);

  expect(existsSync(idle)).toBe(true);
});

test("a claim removes an old root whose owner has exited", () => {
  const base = scratchDir();
  const abandoned = oldRoot(join(base, "bbt-abandoned"), deadPid());

  claimOnce({ TMPDIR: base }, base);

  expect(existsSync(abandoned)).toBe(false);
});

test("a claim writes its owner file and removes the root on release", () => {
  const base = scratchDir();

  const root = claimOnce({ TMPDIR: base }, base);

  expect(root.startsWith(join(base, "bbt-"))).toBe(true);
  expect(existsSync(root)).toBe(false);
});

test("an empty marker and TMPDIR claim under the system temp dir, not the cwd", () => {
  const cwd = scratchDir();
  const abandoned = oldRoot(join(cwd, "bbt-abandoned"), deadPid());

  const root = claimOnce({ BB_TEST_TMP_ROOT: "", TMPDIR: "" }, cwd);

  expect(isAbsolute(root)).toBe(true);
  expect(root.startsWith(cwd)).toBe(false);
  expect(existsSync(abandoned)).toBe(true);
});
