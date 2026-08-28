/**
 * Unit tests for `src/bridge/options.ts` — the native execution-option → Amp
 * vocabulary mapping (U3). The enums asserted here mirror the verified
 * `BridgeExecutionOptions` schema, not the architect sketch's vocabulary.
 */
import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  readProviderOptions,
  toAmpPermissions,
  toMessageOptions,
  toSessionShape,
} from "../src/bridge/options.ts";

const baseArgs = {
  cwd: "/work/repo",
  disallowedTools: [] as readonly string[],
  mcpConfigDigest: "digest-1",
  firstExecution: true,
};

function shapeFor(options: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return toSessionShape({ ...baseArgs, options, ...extra } as Parameters<typeof toSessionShape>[0]);
}

test("readProviderOptions accepts an absent bag", () => {
  assert.deepEqual(readProviderOptions(undefined), {});
  assert.deepEqual(readProviderOptions(null), {});
});

test("readProviderOptions falls back to defaults on a malformed bag", () => {
  assert.deepEqual(readProviderOptions({ ampCliPath: 42 }), {});
  assert.deepEqual(readProviderOptions("nope"), {});
});

test("readProviderOptions passes valid knobs through", () => {
  const bag = { ampCliPath: "/shim", ampRealCliPath: "/real", orbProject: "acme/site" };
  assert.deepEqual(readProviderOptions(bag), bag);
});

test("toSessionShape maps permissionMode full to dangerouslyAllowAll", () => {
  assert.equal(shapeFor({ permissionMode: "full" }).dangerouslyAllowAll, true);
  assert.equal(shapeFor({ permissionMode: "accept-edits" }).dangerouslyAllowAll, false);
  assert.equal(shapeFor({ permissionMode: "auto" }).dangerouslyAllowAll, false);
});

test("toSessionShape gates fast on the first execution", () => {
  assert.equal(shapeFor({ serviceTier: "fast" }).fast, true);
  assert.equal(shapeFor({ serviceTier: "fast" }, { firstExecution: false }).fast, false);
  assert.equal(shapeFor({ serviceTier: "default" }).fast, false);
  assert.equal(shapeFor({}).fast, false);
});

test("toSessionShape maps the reasoning ladder onto Amp's four modes", () => {
  const expectations: ReadonlyArray<readonly [string | undefined, string]> = [
    ["none", "low"],
    ["low", "low"],
    [undefined, "medium"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "high"],
    ["max", "ultra"],
    ["ultra", "ultra"],
    ["ultracode", "ultra"],
  ];
  for (const [level, mode] of expectations) {
    assert.equal(shapeFor({ reasoningLevel: level }).mode, mode, `reasoningLevel ${String(level)}`);
  }
});

test("toSessionShape copies the pass-through fields", () => {
  const shape = shapeFor({}, { disallowedTools: ["hammer", "drill"] });
  assert.equal(shape.cwd, "/work/repo");
  assert.equal(shape.mcpConfigDigest, "digest-1");
  assert.deepEqual(shape.denied, ["hammer", "drill"]);
});

test("toMessageOptions defaults both knobs to null", () => {
  const empty = toMessageOptions({} as Parameters<typeof toMessageOptions>[0]);
  assert.deepEqual(empty, { model: null, instructions: null });
  const full = toMessageOptions({ model: "smart-one", instructions: "be terse" } as Parameters<
    typeof toMessageOptions
  >[0]);
  assert.deepEqual(full, { model: "smart-one", instructions: "be terse" });
});

test("toAmpPermissions rejects every disallowed tool", () => {
  assert.deepEqual(toAmpPermissions([]), []);
  assert.deepEqual(toAmpPermissions(["a", "b"]), [
    { tool: "a", action: "reject" },
    { tool: "b", action: "reject" },
  ]);
});
