import { test } from "bun:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCanvas } from "../server/parse.ts";
import { collectDiagnostics } from "../shared/document.ts";

const templatesDir = fileURLToPath(new URL("../skills/canvas/templates/", import.meta.url));
const expectedTemplates = ["issue.canvas.mdx", "pull-request.canvas.mdx"];

test("skills/canvas/templates holds exactly the two documented templates", async () => {
  const names = (await readdir(templatesDir)).sort();
  assert.deepEqual(names, expectedTemplates, "a stray file in templates/ is not a template");
});

test("every template parses clean in the github style", async () => {
  const names = (await readdir(templatesDir)).filter((name) => name.endsWith(".canvas.mdx"));
  assert.ok(names.length > 0, "no templates found");
  for (const name of names) {
    const parsed = parseCanvas(await readFile(join(templatesDir, name), "utf8"));
    assert.ok(parsed.ok, `${name} parses`);
    if (!parsed.ok) continue;
    assert.deepEqual(collectDiagnostics(parsed.document), [], `${name} has no diagnostics`);
    assert.equal(parsed.document.style, "github", `${name} declares the github style`);
  }
});
