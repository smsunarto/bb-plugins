import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseCanvas } from "../src/server/parse.ts";
import { collectDiagnostics } from "../src/shared/document.ts";
import { componentNames } from "../src/shared/registry.ts";
import { examples, referencePath, renderReference } from "../scripts/reference.ts";

test("skills/canvas/reference.md matches the registry", async () => {
  const committed = await readFile(referencePath, "utf8");
  assert.equal(committed, renderReference(), "run `bun run reference` inside plugins/canvas");
});

test("every registry component has a heading and an example that parses clean", () => {
  const text = renderReference();
  for (const name of componentNames) {
    assert.ok(text.includes(`\n## ${name}\n`), `${name} heading`);
    const example = examples[name];
    assert.ok(text.includes(example), `${name} example is in the reference`);
    const wrapped = name === "Tab" ? `<Tabs id="x">\n${example}\n</Tabs>` : example;
    const parsed = parseCanvas(wrapped);
    assert.ok(parsed.ok, `${name} example parses`);
    if (parsed.ok) {
      assert.deepEqual(
        collectDiagnostics(parsed.document),
        [],
        `${name} example has no diagnostics`,
      );
    }
  }
});
