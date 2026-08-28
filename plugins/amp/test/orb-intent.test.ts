import assert from "node:assert/strict";
import { test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armOrbIntent,
  consumeOrbIntent,
  disarmOrbIntent,
  ORB_INTENT_FILE,
  ORB_INTENT_TTL_MS,
  readOrbIntent,
} from "../src/orb-intent.ts";

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "amp-orb-intent-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("arming makes the intent readable without consuming it", () => {
  withDir((dir) => {
    assert.equal(readOrbIntent(dir), false);
    armOrbIntent(dir);
    assert.equal(readOrbIntent(dir), true);
    assert.equal(readOrbIntent(dir), true);
  });
});

test("consuming returns the armed state exactly once", () => {
  withDir((dir) => {
    assert.equal(consumeOrbIntent(dir), false);
    armOrbIntent(dir);
    assert.equal(consumeOrbIntent(dir), true);
    assert.equal(consumeOrbIntent(dir), false);
  });
});

test("disarming removes an armed intent and tolerates a missing file", () => {
  withDir((dir) => {
    armOrbIntent(dir);
    disarmOrbIntent(dir);
    assert.equal(readOrbIntent(dir), false);
    disarmOrbIntent(dir);
  });
});

test("a stale intent expires and is cleaned up", () => {
  withDir((dir) => {
    const armedAt = 1_000_000;
    armOrbIntent(dir, armedAt);
    assert.equal(readOrbIntent(dir, armedAt + ORB_INTENT_TTL_MS - 1), true);
    assert.equal(readOrbIntent(dir, armedAt + ORB_INTENT_TTL_MS), false);
    assert.equal(existsSync(join(dir, ORB_INTENT_FILE)), false);
  });
});

test("a corrupt intent file reads as disarmed and is removed", () => {
  withDir((dir) => {
    writeFileSync(join(dir, ORB_INTENT_FILE), "not json", "utf8");
    assert.equal(readOrbIntent(dir), false);
    assert.equal(existsSync(join(dir, ORB_INTENT_FILE)), false);
    writeFileSync(join(dir, ORB_INTENT_FILE), '{"armedAt":"soon"}', "utf8");
    assert.equal(consumeOrbIntent(dir), false);
  });
});
