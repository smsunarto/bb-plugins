import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdd } from "./bin-add.ts";

function pluginRoot(name = "bb-plugin-notes"): string {
  const cwd = mkdtempSync(join(tmpdir(), "bb-kit-add-"));
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name })}\n`);
  return cwd;
}

test("add query writes the unit and sibling test and prints the wiring", () => {
  const cwd = pluginRoot();
  const result = runAdd("query", "read-url", { cwd });
  assert.equal(result.exitCode, 0);
  const unit = readFileSync(join(cwd, "rpc/read-url.ts"), "utf8");
  assert.match(unit, /export const readUrl = defineQuery\(/);
  assert.match(unit, /handler: \(_context: Context\)/);
  const sibling = readFileSync(join(cwd, "rpc/read-url.test.ts"), "utf8");
  assert.match(sibling, /import { readUrl } from ".\/read-url.ts";/);
  assert.match(result.stdout, /import { readUrl } from ".\/rpc\/read-url.ts";/);
  assert.match(result.stdout, /readUrl,/);
  assert.match(result.stdout, /wire name: notes_read_url/);
});

test("add mutation takes an input and tests with one", () => {
  const cwd = pluginRoot();
  const result = runAdd("mutation", "save-2fa", { cwd });
  assert.equal(result.exitCode, 0);
  const unit = readFileSync(join(cwd, "rpc/save-2fa.ts"), "utf8");
  assert.match(unit, /export const save2fa = defineMutation\(/);
  assert.match(unit, /input: z.object\(/);
  const sibling = readFileSync(join(cwd, "rpc/save-2fa.test.ts"), "utf8");
  assert.match(sibling, /save2fa.handler\({} as Context, { value: "x" }\)/);
  // camelName("save-2fa") = save2fa; snake reinserts "_" only before an
  // uppercase, so the pinned derivation gives notes_save2fa (not save_2fa).
  assert.match(result.stdout, /wire name: notes_save2fa/);
});

test("add command wires by kebab key when the name is hyphenated", () => {
  const cwd = pluginRoot();
  const result = runAdd("command", "sync-all", { cwd });
  assert.equal(result.exitCode, 0);
  const unit = readFileSync(join(cwd, "cli/sync-all.ts"), "utf8");
  assert.match(unit, /export const syncAll = defineCommand\(/);
  assert.match(result.stdout, /"sync-all": syncAll,/);
  assert.match(result.stdout, /must stay "sync-all"/);
});

test("add command uses shorthand when the name has no hyphen", () => {
  const cwd = pluginRoot();
  const result = runAdd("command", "status", { cwd });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\n {2}status,\n/);
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
  assert.ok(!existsSync(join(cwd, "rpc/ReadUrl.ts")));
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
  const before = readFileSync(join(cwd, "rpc/ping.ts"), "utf8");
  const again = runAdd("query", "ping", { cwd });
  assert.equal(again.exitCode, 1);
  assert.match(again.stderr, /already exists — add never overwrites/);
  assert.equal(readFileSync(join(cwd, "rpc/ping.ts"), "utf8"), before);
});

test("a package name deriving an empty id exits 1", () => {
  const cwd = pluginRoot("bb-plugin-");
  const result = runAdd("query", "ping", { cwd });
  assert.equal(result.exitCode, 1);
});
