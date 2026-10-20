import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAdd } from "./add.ts";

function pluginRoot(
  name = "bb-plugin-notes",
  bb: Record<string, unknown> = { server: "./src/server/server.ts" },
): string {
  const cwd = mkdtempSync(join(tmpdir(), "bb-kit-add-"));
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name, bb })}\n`);
  mkdirSync(join(cwd, "node_modules"));
  symlinkSync(
    dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
    join(cwd, "node_modules/typescript"),
    "dir",
  );
  return cwd;
}

test("add query writes the unit and sibling test and prints the wiring", () => {
  const cwd = pluginRoot();
  const result = runAdd("query", "read-url", { cwd });
  assert.equal(result.exitCode, 0);
  const unit = readFileSync(join(cwd, "src/server/rpc/read-url.ts"), "utf8");
  assert.match(unit, /export const readUrl = defineQuery\(/);
  assert.match(unit, /async execute\(_ctx\)/);
  const sibling = readFileSync(join(cwd, "src/server/rpc/read-url.test.ts"), "utf8");
  assert.match(sibling, /import { readUrl } from ".\/read-url";/);
  assert.match(result.stdout, /wire it in src\/server\/server.ts/);
  assert.match(result.stdout, /import { readUrl } from "\.\/rpc\/read-url";/);
  assert.match(result.stdout, /readUrl,/);
  assert.match(result.stdout, /name: readUrl/);
});

test("add mutation takes an input and tests with one", () => {
  const cwd = pluginRoot();
  const result = runAdd("mutation", "save-2fa", { cwd });
  assert.equal(result.exitCode, 0);
  const unit = readFileSync(join(cwd, "src/server/rpc/save-2fa.ts"), "utf8");
  assert.match(unit, /export const save2fa = defineMutation\(/);
  assert.match(unit, /input: z.object\(/);
  const sibling = readFileSync(join(cwd, "src/server/rpc/save-2fa.test.ts"), "utf8");
  assert.match(sibling, /save2fa.execute\(\{ bb \}, { value: "x" }\)/);
  assert.match(result.stdout, /name: save2fa/);
});

test("add command wires by kebab key when the name is hyphenated", () => {
  const cwd = pluginRoot();
  const result = runAdd("command", "sync-all", { cwd });
  assert.equal(result.exitCode, 0);
  const unit = readFileSync(join(cwd, "src/server/command/sync-all.ts"), "utf8");
  assert.match(unit, /export const syncAll = defineCommand\(/);
  const sibling = readFileSync(join(cwd, "src/server/command/sync-all.test.ts"), "utf8");
  assert.match(sibling, /import { syncAll } from ".\/sync-all";/);
  assert.match(sibling, /syncAll\.execute\(\{ bb \}, input\)/);
  assert.match(result.stdout, /"sync-all": syncAll,/);
  assert.match(result.stdout, /must stay "sync-all"/);
});

test("add command uses shorthand when the name has no hyphen", () => {
  const cwd = pluginRoot();
  const result = runAdd("command", "status", { cwd });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\n {2}status,\n/);
});

test("add reports a parse failure and does not fall back to the scaffold layout", () => {
  const cwd = pluginRoot("bb-plugin-notes", { server: "./server.ts" });
  const result = runAdd("query", "read-url", { cwd });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /bb\.server must live under src\/server/);
  assert.ok(!existsSync(join(cwd, "rpc/read-url.ts")));
  assert.ok(!existsSync(join(cwd, "src/server/rpc/read-url.ts")));
});

test("an unknown kind is a usage error (exit 2)", () => {
  const cwd = pluginRoot();
  const result = runAdd("procedure", "ping", { cwd });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /unknown kind "procedure"/);
});

test("a non-kebab name exits 1", () => {
  const cwd = pluginRoot();
  const result = runAdd("query", "ReadUrl", { cwd });
  assert.equal(result.exitCode, 1);
  assert.ok(!existsSync(join(cwd, "src/server/rpc/ReadUrl.ts")));
});

test("add outside a plugin root exits 1", () => {
  const cwd = mkdtempSync(join(tmpdir(), "bb-kit-add-bare-"));
  const result = runAdd("query", "ping", { cwd });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /run add at the plugin root/);
});

test("add never overwrites an existing unit (ADR-0009)", () => {
  const cwd = pluginRoot();
  assert.equal(runAdd("query", "ping", { cwd }).exitCode, 0);
  const before = readFileSync(join(cwd, "src/server/rpc/ping.ts"), "utf8");
  const again = runAdd("query", "ping", { cwd });
  assert.equal(again.exitCode, 1);
  assert.match(again.stderr, /already exists — add never overwrites/);
  assert.equal(readFileSync(join(cwd, "src/server/rpc/ping.ts"), "utf8"), before);
});

test("add tool writes the unit and prints the derived name", () => {
  const cwd = pluginRoot();
  const result = runAdd("tool", "beacon", { cwd });
  assert.equal(result.exitCode, 0);
  const unit = readFileSync(join(cwd, "src/server/tools/beacon.ts"), "utf8");
  assert.match(unit, /export const beacon = defineTool\(/);
  assert.match(unit, /parameters: z.object\(/);
  const sibling = readFileSync(join(cwd, "src/server/tools/beacon.test.ts"), "utf8");
  assert.match(sibling, /import { beacon } from ".\/beacon";/);
  assert.match(sibling, /beacon\.execute\(ctx, { value: "x" }\)/);
  assert.match(sibling, /signal: new AbortController\(\)\.signal/);
  assert.match(result.stdout, /and the agents\.tools entry:/);
  assert.match(result.stdout, /\n {2}beacon,\n/);
  assert.match(result.stdout, /name: notes_beacon/);
  assert.equal(
    readFileSync(join(cwd, "instructions/tools/notes_beacon.md"), "utf8"),
    "TODO: describe notes_beacon for the agent.\n",
  );
  assert.match(result.stdout, /created instructions\/tools\/notes_beacon\.md/);
});

test("add tool pins the underscored key when the name is hyphenated", () => {
  const cwd = pluginRoot();
  const result = runAdd("tool", "two-word", { cwd });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\n {2}two_word: twoWord,\n/);
  assert.match(result.stdout, /must stay "two_word"/);
  assert.match(result.stdout, /name: notes_two_word/);
});

for (const [label, source] of [
  [
    "inline",
    'export default definePlugin({ pluginId: "notes", publicName: "field-notes", rpc: {} });',
  ],
  [
    "named definition",
    'import { definePlugin as plugin } from "@bb-kit/core/plugin"; const config = { pluginId: "notes", publicName: "field-notes", rpc: {} }; const entry = plugin(config); export default entry;',
  ],
] as const) {
  test(`add tool uses the ${label} public name for its contract and instruction file`, () => {
    const cwd = pluginRoot();
    mkdirSync(join(cwd, "src/server"), { recursive: true });
    writeFileSync(join(cwd, "src/server/server.ts"), source);
    const result = runAdd("tool", "beacon", { cwd });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /name: field_notes_beacon/);
    assert.ok(existsSync(join(cwd, "instructions/tools/field_notes_beacon.md")));
    assert.ok(!existsSync(join(cwd, "instructions/tools/notes_beacon.md")));
    assert.equal(readFileSync(join(cwd, "src/server/server.ts"), "utf8"), source);
  });
}

test("add tool refuses an unreadable public name before writing files", () => {
  const cwd = pluginRoot();
  mkdirSync(join(cwd, "src/server"), { recursive: true });
  writeFileSync(
    join(cwd, "src/server/server.ts"),
    'export default definePlugin({ pluginId: "notes", publicName: NAME, rpc: {} });',
  );
  const result = runAdd("tool", "beacon", { cwd });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /publicName must be a valid string literal/);
  assert.ok(!existsSync(join(cwd, "src/server/tools/beacon.ts")));
  assert.ok(!existsSync(join(cwd, "instructions/tools/notes_beacon.md")));
});

test("an isolated CLI reads TypeScript from the target plugin for renamed and ordinary tools", () => {
  const cliRoot = mkdtempSync(join(tmpdir(), "bb-kit-cli-"));
  const cli = join(cliRoot, "bb-kit.mjs");
  assert.throws(() => createRequire(cli).resolve("typescript"));
  execFileSync(
    "bun",
    [
      "build",
      fileURLToPath(new URL("./bin.ts", import.meta.url)),
      "--target=node",
      "--outfile",
      cli,
    ],
    { stdio: "pipe" },
  );
  for (const publicName of [undefined, "field-notes"]) {
    const cwd = pluginRoot();
    mkdirSync(join(cwd, "src/server"), { recursive: true });
    writeFileSync(
      join(cwd, "src/server/server.ts"),
      `export default definePlugin({ pluginId: "notes", ${publicName ? `publicName: "${publicName}",` : ""} rpc: {} });`,
    );
    const stdout = execFileSync("node", [cli, "add", "tool", "beacon"], { cwd, encoding: "utf8" });
    const name = `${(publicName ?? "notes").replaceAll("-", "_")}_beacon`;
    assert.ok(stdout.includes(`name: ${name}`));
    assert.ok(existsSync(join(cwd, `instructions/tools/${name}.md`)));
  }
});

test("add tool explains missing plugin TypeScript before generating files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "bb-kit-add-no-compiler-"));
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "bb-plugin-notes", bb: { server: "./src/server/server.ts" } }),
  );
  mkdirSync(join(cwd, "src/server"), { recursive: true });
  writeFileSync(
    join(cwd, "src/server/server.ts"),
    'export default definePlugin({ pluginId: "notes", rpc: {} });',
  );
  const result = runAdd("tool", "beacon", { cwd });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /could not resolve TypeScript from the plugin.*install devDependencies first/,
  );
  assert.ok(!existsSync(join(cwd, "src/server/tools/beacon.ts")));
});
