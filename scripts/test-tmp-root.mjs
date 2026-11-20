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
// - bun test: `[test] preload = ["../../scripts/test-tmp-root-preload.mjs"]` in bunfig.toml
// - node --test: `--import ../../scripts/test-tmp-root-preload.mjs`
//
// Runners start workers and child processes that inherit the environment, and
// node --test loads the preload again in each child. Only a process that finds
// no BB_TEST_TMP_ROOT creates a root, and only that process removes it, so a
// finishing child never deletes its siblings' files. An interrupted run leaves
// one root behind instead of thousands of dirs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MARKER = "BB_TEST_TMP_ROOT";

/**
 * Points TMPDIR at a new root under the current temp dir. Returns the function
 * that removes the root and restores TMPDIR, or undefined when an outer process
 * already owns a root.
 */
export function claimTestTmpRoot() {
  if (process.env[MARKER] !== undefined) return undefined;
  const previous = process.env.TMPDIR;
  const root = mkdtempSync(join(tmpdir(), "bbt-"));
  process.env[MARKER] = root;
  process.env.TMPDIR = root;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    delete process.env[MARKER];
  };
}

/** vitest globalSetup; vitest calls the returned function after the last test file. */
export function setup() {
  return claimTestTmpRoot();
}
