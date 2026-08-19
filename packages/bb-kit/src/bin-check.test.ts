import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck, isValidSemverRange } from "./bin-check.ts";
import { runCreate } from "./bin-create.ts";

/**
 * Fixtures are real `create` scaffolds in $TMPDIR. check parses with the
 * PLUGIN'S OWN typescript and reads the plugin's own SDK policy, so both
 * are symlinked from this repo's node_modules — the symlink's real path
 * makes the TS 7 native binary and the SDK's imports resolve there.
 */

const REPO_MODULES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "node_modules",
);

function makeFixture(name = "bb-plugin-notes", { link = true } = {}): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "bb-kit-check-")));
  const created = runCreate(name, { cwd: parent, install: () => ({ status: 0, output: "" }) });
  assert.equal(created.exitCode, 0, created.stderr);
  const dirName = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  const root = join(parent, dirName);
  mkdirSync(join(root, "node_modules", "@get-bb"), { recursive: true });
  symlinkSync(
    join(REPO_MODULES, "@get-bb", "plugin-sdk"),
    join(root, "node_modules", "@get-bb", "plugin-sdk"),
  );
  if (link) {
    symlinkSync(join(REPO_MODULES, "typescript"), join(root, "node_modules", "typescript"));
  }
  return root;
}

function edit(root: string, relative: string, from: string, to: string): void {
  const path = join(root, relative);
  const before = readFileSync(path, "utf8");
  const after = before.replace(from, to);
  assert.notEqual(after, before, `edit found nothing to replace in ${relative}`);
  writeFileSync(path, after);
}

test("a fresh scaffold passes with the wire table", async () => {
  const root = makeFixture();
  const result = await runCheck({ cwd: root });
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /wire names \(namespace "notes"\):\n {2}notes_ping {2}<- ping/);
  assert.match(result.stdout, /check passed\n$/);
});

test("an unwired unit file breaks the bijection (rule 1)", async () => {
  const root = makeFixture();
  writeFileSync(join(root, "rpc", "extra.ts"), "export const extra = 1;\n");
  writeFileSync(join(root, "rpc", "extra.test.ts"), "export {};\n");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /error: rpc\/extra\.ts — not wired into server\.ts procedures — rule 1/,
  );
});

test("a wrong unit export name fails rule 1", async () => {
  const root = makeFixture();
  edit(root, "rpc/ping.ts", "export const ping =", "export const pong =");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /rpc\/ping\.ts.*exactly one value export named "ping" \(found: pong\)/,
  );
});

test("two keys wiring one unit file break the bijection (rule 1)", async () => {
  const root = makeFixture();
  edit(root, "server.ts", "procedures: { ping },", "procedures: { ping, pingAlias: ping },");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /procedure key "pingAlias" wires rpc\/ping\.ts, which is already wired — rule 1/,
  );
});

test("a procedure key that kebab-cases to help fails rule 5", async () => {
  const root = makeFixture();
  edit(root, "server.ts", "procedures: { ping },", "procedures: { ping, help: ping },");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /procedure key "help" kebab-cases to "help"/);
});

test("two keys with one wire name fail rule 3", async () => {
  const root = makeFixture();
  edit(
    root,
    "server.ts",
    "procedures: { ping },",
    "procedures: { ping, readUrl: ping, read_url: ping },",
  );
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /procedures "readUrl" and "read_url" both produce wire name "notes_read_url" — rule 3/,
  );
});

test("a commands key that is not the unit basename fails rule 1", async () => {
  const root = makeFixture();
  edit(root, "server.ts", "commands: { status }", "commands: { stat: status }");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /commands key "stat" must equal the unit's kebab basename "status"/);
});

test("a namespace that is not the plugin id fails rule 2", async () => {
  const root = makeFixture();
  edit(root, "server.ts", 'namespace: "notes",', 'namespace: "other",');
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /RPC namespace "other" must equal derivePluginID.* = "notes" — rule 2/,
  );
});

test("a manifest path that does not exist fails rule 4", async () => {
  const root = makeFixture();
  edit(root, "package.json", '"server": "./server.ts",', '"server": "./missing.ts",');
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /bb\.server "\.\/missing\.ts" does not exist — rule 4/);
});

test("a reserved plugin CLI name fails rule 5", async () => {
  const root = makeFixture("bb-plugin-status");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /plugin CLI name "status" is reserved by bb — rule 5/);
});

test("a missing sibling test is a warning, not a failure (rule 6)", async () => {
  const root = makeFixture();
  rmSync(join(root, "rpc", "ping.test.ts"));
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 0);
  assert.match(
    result.stderr,
    /warning: rpc\/ping\.ts — no sibling test rpc\/ping\.test\.ts — rule 6/,
  );
  assert.match(result.stdout, /check passed with 1 warning\n$/);
});

test("a missing typescript is a toolchain failure, not a crash", async () => {
  const root = makeFixture("bb-plugin-notes", { link: false });
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /could not resolve TypeScript 7 from the plugin/);
});

test("isValidSemverRange accepts npm ranges and rejects junk", () => {
  for (const range of [
    ">=22.19.0",
    "^1.2.3",
    "~2.0",
    "1.2.x",
    "*",
    "1.0.0 - 2.0.0",
    "^1.0.0 || ^2.0.0",
    ">=1.2.3 <2.0.0",
  ]) {
    assert.ok(isValidSemverRange(range), range);
  }
  for (const range of ["not a version", ">=abc", "1.2.3.4.5"]) {
    assert.ok(!isValidSemverRange(range), range);
  }
});
