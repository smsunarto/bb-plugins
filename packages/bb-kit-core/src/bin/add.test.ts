import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdd } from "./add.ts";

function pluginRoot(
  name = "bb-plugin-notes",
  bb: Record<string, unknown> = { server: "./server/server.ts" },
): string {
  const cwd = mkdtempSync(join(tmpdir(), "bb-kit-add-"));
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name, bb })}\n`);
  return cwd;
}

test("add query writes the unit and sibling test and prints the wiring", () => {
  const cwd = pluginRoot();
  const result = runAdd("query", "read-url", { cwd });
  assert.equal(result.exitCode, 0);
  const unit = readFileSync(join(cwd, "server/rpc/read-url.ts"), "utf8");
  assert.match(unit, /export const readUrl = defineQuery\(/);
  assert.match(unit, /handler: \(_context: Context\)/);
  const sibling = readFileSync(join(cwd, "server/rpc/read-url.test.ts"), "utf8");
  assert.match(sibling, /import { readUrl } from ".\/read-url.ts";/);
  assert.match(result.stdout, /wire it in server\/server.ts/);
  assert.match(result.stdout, /import { readUrl } from "\.\/rpc\/read-url.ts";/);
  assert.match(result.stdout, /readUrl,/);
  assert.match(result.stdout, /name: readUrl/);
});

test("add mutation takes an input and tests with one", () => {
  const cwd = pluginRoot();
  const result = runAdd("mutation", "save-2fa", { cwd });
  assert.equal(result.exitCode, 0);
  const unit = readFileSync(join(cwd, "server/rpc/save-2fa.ts"), "utf8");
  assert.match(unit, /export const save2fa = defineMutation\(/);
  assert.match(unit, /input: z.object\(/);
  const sibling = readFileSync(join(cwd, "server/rpc/save-2fa.test.ts"), "utf8");
  assert.match(sibling, /save2fa.handler\(stubHostContext\(\), { value: "x" }\)/);
  assert.match(result.stdout, /name: save2fa/);
});

test("add command wires by kebab key when the name is hyphenated", () => {
  const cwd = pluginRoot();
  const result = runAdd("command", "sync-all", { cwd });
  assert.equal(result.exitCode, 0);
  const unit = readFileSync(join(cwd, "server/cli/sync-all.ts"), "utf8");
  assert.match(unit, /export const syncAll = defineCommand\(/);
  const sibling = readFileSync(join(cwd, "server/cli/sync-all.test.ts"), "utf8");
  assert.match(sibling, /syncAll\.invoke\(\)/);
  assert.match(result.stdout, /"sync-all": syncAll,/);
  assert.match(result.stdout, /must stay "sync-all"/);
});

test("add command uses shorthand when the name has no hyphen", () => {
  const cwd = pluginRoot();
  const result = runAdd("command", "status", { cwd });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\n {2}status,\n/);
});

test("printed wiring is relative to bb.server at the package root", () => {
  const cwd = pluginRoot("bb-plugin-notes", { server: "./server.ts" });
  const result = runAdd("query", "read-url", { cwd });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /wire it in server.ts/);
  assert.match(result.stdout, /import { readUrl } from "\.\/rpc\/read-url.ts";/);
  assert.ok(existsSync(join(cwd, "rpc/read-url.ts")));
  assert.ok(!existsSync(join(cwd, "server/rpc/read-url.ts")));
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
  assert.ok(!existsSync(join(cwd, "server/rpc/ReadUrl.ts")));
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
  const before = readFileSync(join(cwd, "server/rpc/ping.ts"), "utf8");
  const again = runAdd("query", "ping", { cwd });
  assert.equal(again.exitCode, 1);
  assert.match(again.stderr, /already exists — add never overwrites/);
  assert.equal(readFileSync(join(cwd, "server/rpc/ping.ts"), "utf8"), before);
});

test("add tool writes the unit and prints the derived name", () => {
  const cwd = pluginRoot();
  const result = runAdd("tool", "beacon", { cwd });
  assert.equal(result.exitCode, 0);
  const unit = readFileSync(join(cwd, "server/tools/beacon.ts"), "utf8");
  assert.match(unit, /export const beacon = defineTool\(/);
  assert.match(unit, /parameters: z.object\(/);
  const sibling = readFileSync(join(cwd, "server/tools/beacon.test.ts"), "utf8");
  assert.match(sibling, /beacon\.execute\(context, { value: "x" }\)/);
  assert.match(sibling, /signal: new AbortController\(\)\.signal/);
  assert.match(result.stdout, /and the agents\.tools entry:/);
  assert.match(result.stdout, /\n {2}beacon,\n/);
  assert.match(result.stdout, /name: notes_beacon/);
});

test("add tool pins the underscored key when the name is hyphenated", () => {
  const cwd = pluginRoot();
  const result = runAdd("tool", "two-word", { cwd });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\n {2}two_word: twoWord,\n/);
  assert.match(result.stdout, /must stay "two_word"/);
  assert.match(result.stdout, /name: notes_two_word/);
});
