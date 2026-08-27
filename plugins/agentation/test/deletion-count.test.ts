import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";

import { expectedDeletionCounts, runDeletionCountContract } from "./deletion-count-contract";

test("deletion counts describe annotation rows under strict Bun SQLite", () => {
  assert.deepEqual(runDeletionCountContract(Database), expectedDeletionCounts);
});

test("deletion counts describe annotation rows under Node better-sqlite3", () => {
  const child = spawnSync(
    "node",
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("./deletion-count-node.ts", import.meta.url)),
    ],
    { encoding: "utf8" },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), expectedDeletionCounts);
});
