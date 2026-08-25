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
import { runCheck, isValidSemverRange } from "./check.ts";
import { runCreate } from "./create.ts";

/**
 * Fixtures are real `create` scaffolds in $TMPDIR. check parses with the
 * PLUGIN'S OWN typescript and reads the plugin's own SDK policy, so both
 * are symlinked from this repo's node_modules — the symlink's real path
 * makes the plugin's `typescript` module and the SDK's imports resolve
 * there.
 */

const REPO_MODULES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
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
  assert.match(result.stdout, /RPC names:\n {2}ping\n/);
  assert.match(result.stdout, /check passed\n$/);
});

test("an unwired unit file breaks the bijection (rule 1)", async () => {
  const root = makeFixture();
  writeFileSync(join(root, "server", "rpc", "extra.ts"), "export const extra = 1;\n");
  writeFileSync(join(root, "server", "rpc", "extra.test.ts"), "export {};\n");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /error: server\/rpc\/extra\.ts — not wired into server\/server.ts rpc — rule 1/);
});

test("a wrong unit export name fails rule 1", async () => {
  const root = makeFixture();
  edit(root, "server/rpc/ping.ts", "export const ping =", "export const pong =");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /server\/rpc\/ping\.ts:6 — must have exactly one value export named "ping" \(found: pong\)/,
  );
});

test("two keys wiring one unit file break the bijection (rule 1)", async () => {
  const root = makeFixture();
  edit(root, "server/server.ts", "rpc: { ping },", "rpc: { ping, pingAlias: ping },");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /RPC key "pingAlias" wires server\/rpc\/ping\.ts, which is already wired — rule 1/,
  );
});

test("a commands key that is not the unit basename fails rule 1", async () => {
  const root = makeFixture();
  edit(root, "server/server.ts", "cli: { status }", "cli: { stat: status }");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /commands key "stat" must equal the unit's kebab basename "status"/);
});

test("a definePlugin id that is not the derived plugin id fails rule 2", async () => {
  const root = makeFixture();
  edit(root, "server/server.ts", 'pluginId: "notes",', 'pluginId: "other",');
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /plugin id "other" must equal derivePluginID.* = "notes" — rule 2/);
});

test("a manifest path that does not exist fails rule 4", async () => {
  const root = makeFixture();
  edit(root, "package.json", '"server": "./server/server.ts",', '"server": "./missing.ts",');
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
  rmSync(join(root, "server", "rpc", "ping.test.ts"));
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 0);
  assert.match(
    result.stderr,
    /warning: server\/rpc\/ping\.ts — no sibling test server\/rpc\/ping\.test\.ts — rule 6/,
  );
  assert.match(result.stdout, /check passed with 1 warning\n$/);
});

test("a unit file the tsconfig include omits still parses via the composition root's import", async () => {
  const root = makeFixture();
  const tsconfigPath = join(root, "tsconfig.json");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as Record<string, unknown>;
  tsconfig["include"] = ["server/server.ts", "server/server.test.ts", "server/cli/**/*", "app/**/*"];
  writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
  const result = await runCheck({ cwd: root });
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /check passed\n$/);
});

test("an unparseable tsconfig.json is a toolchain failure, not a crash", async () => {
  const root = makeFixture();
  writeFileSync(join(root, "tsconfig.json"), "{{ broken\n");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /tsconfig\.json did not load as a TypeScript project: .* \(parse-dependent rules skipped\)/,
  );
});

test("a tsconfig config-level error (broken extends) fails check", async () => {
  const root = makeFixture();
  const tsconfigPath = join(root, "tsconfig.json");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as Record<string, unknown>;
  tsconfig["extends"] = "./missing-base.json";
  writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /tsconfig\.json has config errors: Cannot read file/);
});

test("a missing typescript is a toolchain failure, not a crash", async () => {
  const root = makeFixture("bb-plugin-notes", { link: false });
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /could not resolve TypeScript from the plugin/);
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
