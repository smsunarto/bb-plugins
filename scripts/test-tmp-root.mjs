// Gives one test run a private temp root and removes it when the run ends.
//
// Test helpers create temp dirs and never remove them: the Plugin SDK's
// `createFakePluginHost` makes a `bb-fake-plugin-host-*` dir for every host, and
// only `harness.dispose()` removes it. Tens of thousands of those filled the
// user-quota /tmp. Pointing TMPDIR at a per-run root collects every such dir,
// whoever creates it, and one rm at the end removes them all.
//
// Wire it in once per runner:
// - vitest: `test.globalSetup: ["../../scripts/test-tmp-root.mjs"]`
// - bun test: `[test] preload = ["../../scripts/test-tmp-root-preload.mjs"]` in the
//   bunfig.toml of each directory bun test starts from, the repo root included
// - node --test: `--import ../../scripts/test-tmp-root-preload.mjs` in the test script
//
// Runners start workers and child processes that inherit the environment. Only
// a process that finds no live BB_TEST_TMP_ROOT creates a root, and only that
// process removes it, so a finishing worker never deletes its siblings' files.
// node --test loads `--import` in each test-file child, not in the runner, so
// each test file there claims and removes its own root.
//
// Limits:
// - A direct `node --test` without the `--import` flag is not covered; node has
//   no per-directory config to load it from.
// - bun removes the root in `afterAll`, which does not run after `bun test
//   --bail` stops on a failure or after `process.exit()` in a test. Those runs,
//   and killed ones, leave one bbt-* root behind. Each new claim removes such
//   a root from the same temp dir once it is older than STALE_MS and the pid
//   in its OWNER_FILE has exited; a dir without that file is never removed.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MARKER = "BB_TEST_TMP_ROOT";
const PREFIX = "bbt-";
/** Holds the pid of the process that claimed the root. */
const OWNER_FILE = ".bbt-owner";
/** No test run lasts this long, so an older root belongs to a run that never cleaned up. */
const STALE_MS = 6 * 60 * 60 * 1000;

/**
 * Points TMPDIR at a new root under the current temp dir. Returns the function
 * that removes the root and restores the environment, or undefined when an
 * outer process already owns a live root.
 */
export function claimTestTmpRoot() {
  const inherited = process.env[MARKER];
  const previousTmpdir = process.env.TMPDIR;
  // An empty value counts as unset; dirname("") would put the root in the cwd.
  const marked = inherited || undefined;
  if (marked !== undefined && existsSync(marked)) return undefined;
  // A marker whose root is gone usually came with a TMPDIR that points at it.
  const base = marked !== undefined && previousTmpdir === marked ? dirname(marked) : tmpdir();
  sweepStaleRoots(base);
  const root = mkdtempSync(join(base, PREFIX));
  writeFileSync(join(root, OWNER_FILE), `${process.pid}\n`);
  process.env[MARKER] = root;
  process.env.TMPDIR = root;
  let released = false;
  return () => {
    if (released) return;
    try {
      released = removeTree(root);
    } finally {
      restoreEnv("TMPDIR", previousTmpdir);
      restoreEnv(MARKER, inherited);
    }
  };
}

/** vitest globalSetup; vitest calls the returned function after the last test file. */
export function setup() {
  return claimTestTmpRoot();
}

function sweepStaleRoots(base) {
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
    const path = join(base, entry.name);
    try {
      if (statSync(path).mtimeMs >= cutoff) continue;
      const owner = Number.parseInt(readFileSync(join(path, OWNER_FILE), "utf8"), 10);
      if (Number.isInteger(owner) && !isRunning(owner)) removeTree(path);
    } catch {
      // No owner file, so not a root of ours, or another run removed it first.
    }
  }
}

/** Removes `path`, making read-only dirs writable when a plain rm fails. Warns instead of throwing. */
function removeTree(path) {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    makeWritable(path);
  }
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.warn(`test-tmp-root: could not remove ${path}: ${error.message}`);
    return false;
  }
}

function makeWritable(dir) {
  try {
    chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) makeWritable(join(dir, entry.name));
    }
  } catch {
    // Not ours to change; the second rm reports what is left.
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to another user.
    return error.code === "EPERM";
  }
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
