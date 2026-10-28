import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fill, instructionFiles, placeholders } from "./instructions.ts";

function plugin(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "bb-plugins-instructions-"));
  writeFileSync(join(root, "package.json"), '{"name":"fixture"}');
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, "instructions", `${name}.md`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  mkdirSync(join(root, "src", "server"), { recursive: true });
  return {
    root,
    files: instructionFiles(pathToFileURL(join(root, "src", "server", "server.ts")).href),
  };
}

test("files resolve from a nested module to the plugin root", () => {
  const { root, files } = plugin({});
  assert.equal(files.root, root);
  assert.equal(files.dir, join(root, "instructions"));
});

test("a built module skips the dist module marker", () => {
  const { root } = plugin({ greeting: "hi" });
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "package.json"), '{"type":"module"}');
  const files = instructionFiles(pathToFileURL(join(root, "dist", "server.js")).href);
  assert.equal(files.root, root);
  assert.equal(files.read("greeting"), "hi");
});

test("read trims, fills placeholders, and rereads after an edit", () => {
  const { root, files } = plugin({ greeting: "\nHello {{ name }}, {{count}} left.\n" });
  assert.equal(files.read("greeting"), "Hello {{ name }}, {{count}} left.");
  assert.equal(files.read("greeting", { name: "Ada", count: 2 }), "Hello Ada, 2 left.");
  writeFileSync(join(root, "instructions", "greeting.md"), "Bye {{name}}.");
  assert.equal(files.read("greeting", { name: "Ada" }), "Bye Ada.");
});

test("an unfilled placeholder names the file and the missing key", () => {
  const { files } = plugin({ greeting: "Hello {{name}} from {{place}}." });
  assert.throws(
    () => files.read("greeting", { name: "Ada" }),
    /instructions\/greeting\.md: no value for {{place}}/,
  );
});

test("names cannot escape the instructions directory", () => {
  const { files } = plugin({});
  assert.throws(() => files.read("../package"), /outside/);
});

test("tool reads the description and its optional snippet", () => {
  const { files } = plugin({
    "tools/demo_search": "Search the docs.\n",
    "tools/demo_search.instructions": "Prefer demo_search.",
    "tools/demo_plain": "Plain tool.",
  });
  assert.deepEqual(files.tool("demo_search"), {
    description: "Search the docs.",
    instructions: "Prefer demo_search.",
  });
  assert.deepEqual(files.tool("demo_plain"), { description: "Plain tool." });
  assert.throws(() => files.tool("demo_missing"), /ENOENT/);
});

test("an empty description is rejected", () => {
  const { files } = plugin({ "tools/demo_blank": "  \n" });
  assert.throws(() => files.tool("demo_blank"), /demo_blank\.md is empty/);
});

test("placeholders lists unique keys and fill substitutes them", () => {
  assert.deepEqual(placeholders("{{a}} {{ b }} {{a}} {{1x}}"), ["a", "b"]);
  assert.equal(fill("{{a}}+{{a}}", { a: 1 }), "1+1");
});
