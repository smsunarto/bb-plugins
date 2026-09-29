import { test } from "bun:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("../src/app", import.meta.url));

// Plugin CSS loads on every bb page. A :has() rule there makes Blink re-check
// its subjects on every DOM change, even with no canvas open. Tag the element
// from React instead (see render.tsx and comments.tsx).
test("canvas stylesheets contain no :has() rules", async () => {
  const entries = await readdir(appDir, { recursive: true });
  const sheets = entries.filter((name) => name.endsWith(".css")).sort();
  assert.ok(sheets.length > 0);
  const offenders: string[] = [];
  for (const name of sheets) {
    const lines = (await readFile(join(appDir, name), "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (line.includes(":has(")) offenders.push(`${name}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
