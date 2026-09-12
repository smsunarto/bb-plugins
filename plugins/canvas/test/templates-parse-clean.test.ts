import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateCanvas, templateName } from "../src/server/lib/generate.ts";
import { parseCanvas } from "../src/shared/parse.ts";

test("all bundled Eta templates generate valid Canvas from their documented examples", async () => {
  for (const name of templateName.options) {
    const data = JSON.parse(
      await readFile(new URL(`../skills/canvas/examples/${name}.json`, import.meta.url), "utf8"),
    );
    const content = generateCanvas(name, data);
    const parsed = parseCanvas(content);
    assert.ok(parsed.ok);
    if (parsed.ok) assert.equal(parsed.document.style, "github");
    assert.ok(content.includes(data.title));
  }
});
