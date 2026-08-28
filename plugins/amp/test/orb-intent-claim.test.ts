import assert from "node:assert/strict";
import { test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armOrbIntent, consumeOrbIntent } from "../src/orb-intent.ts";

const CONSUMERS = 8;

const WORKER = `
import { consumeOrbIntent } from ${JSON.stringify(join(import.meta.dir, "../src/orb-intent.ts"))};
import { existsSync, writeFileSync } from "node:fs";
const [dir, gate, ready] = process.argv.slice(2);
writeFileSync(ready, "");
while (!existsSync(gate)) {}
process.stdout.write(consumeOrbIntent(dir) ? "won" : "lost");
`;

/** A guard, not a reproduction. The single-process interleave this protects
 *  against cannot happen: `consumeOrbIntent` has no await between reading the
 *  file and removing it, so the event loop cannot run another consumer in
 *  between. Across processes it can, which is what the rename closes. Process
 *  start-up jitter still serializes these eight most of the time, so the old
 *  read-then-delete also passes this. It is here to catch a future rewrite,
 *  not to prove the current one. */
test("concurrent consumers of one armed intent produce exactly one winner", async () => {
  const root = mkdtempSync(join(tmpdir(), "amp-claim-"));
  try {
    const worker = join(root, "consume.ts");
    const gate = join(root, "go");
    writeFileSync(worker, WORKER);
    armOrbIntent(root);
    const running = Array.from({ length: CONSUMERS }, (_unused, i) =>
      Bun.spawn(["bun", worker, root, gate, join(root, `ready.${i}`)], {
        stdout: "pipe",
        stderr: "pipe",
      })
    );
    while (running.some((_unused, i) => !existsSync(join(root, `ready.${i}`)))) {
      await Bun.sleep(1);
    }
    writeFileSync(gate, "");
    const all = await Promise.all(
      running.map(async (child) => {
        const [out, err] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        if (err.length > 0) throw new Error(err);
        return out;
      })
    );
    assert.equal(
      all.filter((result) => result === "won").length,
      1,
      `exactly one consumer must win, got ${all.join(",")}`
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("consuming leaves no intent file and no claim residue", () => {
  const root = mkdtempSync(join(tmpdir(), "amp-claim-"));
  try {
    armOrbIntent(root);
    assert.equal(consumeOrbIntent(root), true);
    assert.deepEqual(readdirSync(root), []);
    writeFileSync(join(root, "orb-intent.json"), "not json");
    assert.equal(consumeOrbIntent(root), false);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
