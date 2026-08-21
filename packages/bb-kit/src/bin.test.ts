import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const binPath = join(dirname(fileURLToPath(import.meta.url)), "bin.ts");
const bunOnPath = spawnSync("bun", ["--version"], { stdio: "ignore" }).error === undefined;

test(
  "the bin refuses to run under bun with one stderr line and exit 1",
  { skip: bunOnPath ? false : "bun is not on PATH" },
  () => {
    // The timeout bounds a regression: without the guard, a bun-run
    // `check` fails and then hangs on the orphaned TS 7 child.
    const result = spawnSync("bun", [binPath, "check"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^bb-kit must run under node, not bun — .*\n$/);
    assert.equal(result.stderr.split("\n").length, 2, "the refusal is exactly one line");
  },
);
