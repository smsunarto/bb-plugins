import assert from "node:assert/strict";
import { test } from "bun:test";
import { installStderrGuard } from "../src/stderr-guard.ts";

// Bridge tests call start() in the shared test process, and React's dev build
// decides at load whether to call console.timeStamp. A guard that dropped a
// method broke every later React render in that process.
test("the stderr guard keeps every method the global console had callable", () => {
  const original = globalThis.console;
  try {
    installStderrGuard();
    assert.notEqual(globalThis.console, original);
    for (const [name, method] of Object.entries(original)) {
      if (typeof method !== "function" || name === "Console") continue;
      const guarded = (globalThis.console as unknown as Record<string, unknown>)[name];
      assert.equal(typeof guarded, "function", `console.${name} survives the guard`);
    }
    assert.doesNotThrow(() => console.timeStamp("Blocking Track", 0, 0));
  } finally {
    globalThis.console = original;
  }
});
