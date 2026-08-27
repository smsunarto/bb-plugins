import assert from "node:assert/strict";
import { test } from "bun:test";
import { threadLinkToOrbUsageView } from "../src/orb-usage.ts";

test("local execution hides the banner", () => {
  assert.deepEqual(
    threadLinkToOrbUsageView({ ampThreadId: "T-abc", executionTarget: "local", syncCommand: null }),
    { state: "hidden" },
  );
  assert.deepEqual(
    threadLinkToOrbUsageView({ ampThreadId: null, executionTarget: "local", syncCommand: null }),
    { state: "hidden" },
  );
});

test("an orb run without its Amp thread id is starting", () => {
  assert.deepEqual(
    threadLinkToOrbUsageView({ ampThreadId: null, executionTarget: "orb", syncCommand: null }),
    { state: "starting" },
  );
});

test("an active orb run carries the sync command", () => {
  assert.deepEqual(
    threadLinkToOrbUsageView({
      ampThreadId: "T-abc",
      executionTarget: "orb",
      syncCommand: "amp sync T-abc",
    }),
    { state: "active", ampThreadId: "T-abc", syncCommand: "amp sync T-abc" },
  );
});

test("a state written without a sync command still renders one", () => {
  assert.deepEqual(
    threadLinkToOrbUsageView({ ampThreadId: "T-abc", executionTarget: "orb", syncCommand: null }),
    { state: "active", ampThreadId: "T-abc", syncCommand: "amp sync T-abc" },
  );
});
