import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the shipped NanoCodex provider never spawns a CLI or child process", async () => {
  const violations: string[] = [];
  for (const path of await sourceFiles(ROOT)) {
    const text = await readFile(path, "utf8");
    if (/node:child_process|from\s+["']child_process|\bexecFile\s*\(|\bspawn\s*\(/.test(text)) {
      violations.push(relative(ROOT, path));
    }
  }
  assert.deepEqual(violations, []);
});

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "test" || entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts") || entry.name === "package.json") files.push(path);
  }
  return files;
}
