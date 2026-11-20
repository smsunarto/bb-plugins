// Preload for bun test and node --test; see test-tmp-root.mjs.
//
// bun test fires no `exit` or `beforeExit` event, so the root goes in a global
// afterAll. With --isolate bun reloads this file for each test file in the same
// process: each load claims a root and its afterAll removes it and clears the
// marker, so the next file claims a fresh one.
import { claimTestTmpRoot } from "./test-tmp-root.mjs";

const release = claimTestTmpRoot();

if (release !== undefined) {
  if (process.versions.bun === undefined) {
    process.on("exit", release);
  } else {
    const { afterAll } = await import("bun:test");
    afterAll(release);
  }
}
