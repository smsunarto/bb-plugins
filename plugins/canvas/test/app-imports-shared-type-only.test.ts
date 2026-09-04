import { test } from "bun:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("../src/app", import.meta.url));
const sharedDir = fileURLToPath(new URL("../src/shared", import.meta.url));

// Zod-free shared modules the browser bundle may import as values. Everything
// else in shared/ pulls zod into the app bundle and must stay type-only.
const valueSafeShared = new Set([
  "anchor.ts",
  "ids.ts",
  "ops.ts",
  "source.ts",
  "styles.ts",
  "suggest.ts",
  "walk.ts",
]);

const importPattern = /^import\s+(type\s+)?([^'"]+?)\s+from\s+["']([^"']+)["']/gm;

async function sourceFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir);
  return entries.filter((name) => /\.tsx?$/.test(name) && !name.includes(".test.")).sort();
}

test("src/app/ imports src/shared/document.ts and src/shared/registry.ts type-only", async () => {
  for (const file of await sourceFiles(appDir)) {
    const text = await readFile(join(appDir, file), "utf8");
    for (const match of text.matchAll(importPattern)) {
      const [, typeKeyword, clause, specifier] = match;
      if (!specifier?.startsWith("../shared/")) continue;
      const target = specifier.slice("../shared/".length);
      if (valueSafeShared.has(target)) continue;
      const typeOnly =
        typeKeyword !== undefined || /^\{\s*(type\s+[^,}]+,?\s*)+\}$/.test(clause?.trim() ?? "");
      assert.ok(typeOnly, `app/${file} imports ${specifier} as a value`);
    }
  }
});

test("app/ and shared/ never import node builtins", async () => {
  const builtins = new Set(builtinModules);
  for (const [dir, label] of [
    [appDir, "app"],
    [sharedDir, "shared"],
  ] as const) {
    for (const file of await sourceFiles(dir)) {
      const text = await readFile(join(dir, file), "utf8");
      for (const match of text.matchAll(importPattern)) {
        const specifier = match[3] ?? "";
        const bare = specifier.replace(/^node:/, "");
        assert.ok(
          !specifier.startsWith("node:") && !builtins.has(bare),
          `${label}/${file} imports ${specifier}`,
        );
      }
    }
  }
});

test("value-safe shared modules do not import zod", async () => {
  for (const file of valueSafeShared) {
    const text = await readFile(join(sharedDir, file), "utf8");
    for (const match of text.matchAll(importPattern)) {
      const [, typeKeyword, , specifier] = match;
      assert.ok(
        typeKeyword !== undefined ||
          !/^(zod|\.\/document\.ts|\.\/registry\.ts)$/.test(specifier ?? ""),
        `shared/${file} imports ${specifier} as a value`,
      );
    }
  }
});
