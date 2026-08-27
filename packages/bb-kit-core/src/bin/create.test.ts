import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallOutcome } from "./create.ts";
import { runCreate } from "./create.ts";
import { SCAFFOLD_DEPENDENCIES, SCAFFOLD_DEV_DEPENDENCIES, scaffoldFiles } from "./scaffold.ts";

const okInstall = (): InstallOutcome => ({ status: 0, output: "" });
const freshDir = (): string => mkdtempSync(join(tmpdir(), "bb-kit-create-"));

test("create writes the full scaffold tree and prints the plugin id", () => {
  const cwd = freshDir();
  const result = runCreate("bb-plugin-hello-world", { cwd, install: okInstall });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /created bb-plugin-hello-world\/ \(plugin id: hello-world\)/);
  assert.match(result.stdout, /next:\n {2}cd bb-plugin-hello-world\n {2}npm test/);
  const expected = [
    "package.json",
    "tsconfig.json",
    "server/server.ts",
    "server/server.test.ts",
    "server/rpc/ping.ts",
    "server/rpc/ping.test.ts",
    "server/command/status.ts",
    "server/command/status.test.ts",
    "app/rpc.ts",
    "app/app.tsx",
    "app/app.test.ts",
    "assets/icon.svg",
    "README.md",
  ];
  for (const relative of expected) {
    assert.ok(
      existsSync(join(cwd, "bb-plugin-hello-world", relative)),
      `expected ${relative} on disk`,
    );
  }
  assert.deepEqual(
    Object.keys(scaffoldFiles("bb-plugin-hello-world").files).sort(),
    [...expected].sort(),
  );
});

test("the scaffold package.json carries the manifest and the exact pins", () => {
  const cwd = freshDir();
  runCreate("@acme/bb-plugin-notes", { cwd, install: okInstall });
  const pkg = JSON.parse(
    readFileSync(join(cwd, "bb-plugin-notes", "package.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(pkg["name"], "@acme/bb-plugin-notes");
  assert.equal(pkg["type"], "module");
  assert.equal(pkg["private"], true);
  assert.deepEqual(pkg["engines"], { node: ">=22.19.0" });
  assert.deepEqual(pkg["dependencies"], SCAFFOLD_DEPENDENCIES);
  assert.deepEqual(pkg["devDependencies"], SCAFFOLD_DEV_DEPENDENCIES);
  // The framework rides under dependencies — bb loads plugin source in
  // place, so @bb-kit/core imports resolve at run time (§8).
  assert.ok((pkg["dependencies"] as Record<string, string>)["@bb-kit/core"]);
  assert.ok(!(pkg["devDependencies"] as Record<string, string>)["@bb-kit/core"]);
  const bb = pkg["bb"] as Record<string, unknown>;
  assert.equal(bb["name"], "notes");
  assert.equal(bb["server"], "./server/server.ts");
  assert.equal(bb["app"], "./app/app.tsx");
  assert.deepEqual(bb["branding"], { icon: "./assets/icon.svg" });
  assert.deepEqual(bb["skills"], []);
  const scripts = pkg["scripts"] as Record<string, unknown>;
  assert.equal(scripts["check"], "bb-kit check");
  assert.equal(scripts["test"], "node --test --import tsx");
});

test("the scaffold templates bake the derived id into server, app, and tests", () => {
  const { id, files } = scaffoldFiles("@acme/bb-plugin-notes");
  assert.equal(id, "notes");
  assert.match(files["server/server.ts"] ?? "", /pluginId: "notes"/);
  assert.match(files["server/server.ts"] ?? "", /rpc: \{ ping \}/);
  assert.equal((files["server/server.ts"] ?? "").includes("export const rpc"), false);
  assert.equal((files["server/server.ts"] ?? "").includes("export type RPC"), false);
  assert.equal((files["server/server.ts"] ?? "").includes("ClientFor"), false);
  assert.equal((files["server/server.ts"] ?? "").includes("export type Client"), false);
  assert.match(files["server/server.ts"] ?? "", /from "\.\/rpc\/ping"/);
  assert.match(files["app/rpc.ts"] ?? "", /from "\.\.\/server\/server"/);
  assert.match(files["app/rpc.ts"] ?? "", /\["rpc"\]/);
  assert.match(files["app/rpc.ts"] ?? "", /createRPC<\(typeof plugin\)\["rpc"\]>\(\)/);
  assert.match(files["server/server.test.ts"] ?? "", /callRpc\("ping"\)/);
  assert.match(files["app/app.test.ts"] ?? "", /rpc: \{ ping: async/);
  assert.match(files["server/command/status.test.ts"] ?? "", /status\.execute\(stubHostContext\(\)\)/);
});

test("the scaffold uses Bun-compatible TypeScript module semantics", () => {
  const tsconfig = scaffoldFiles("@acme/bb-plugin-notes").files["tsconfig.json"] ?? "";
  assert.match(tsconfig, /"module": "preserve"/);
  assert.match(tsconfig, /"moduleDetection": "force"/);
  assert.match(tsconfig, /"moduleResolution": "bundler"/);
  assert.doesNotMatch(tsconfig, /allowImportingTsExtensions/);
  assert.match(tsconfig, /"verbatimModuleSyntax": true/);
});

test("the scaffold uses extensionless relative imports", () => {
  const { files } = scaffoldFiles("@acme/bb-plugin-notes");
  for (const [path, source] of Object.entries(files)) {
    if (!/\.tsx?$/.test(path)) continue;
    assert.doesNotMatch(source, /(?:from\s+|import\()["']\.\.?\/[^"']+\.tsx?["']/);
  }
});

test("create refuses an existing non-empty directory", () => {
  const cwd = freshDir();
  mkdirSync(join(cwd, "bb-plugin-taken"));
  writeFileSync(join(cwd, "bb-plugin-taken", "keep.txt"), "here first\n");
  const result = runCreate("bb-plugin-taken", { cwd, install: okInstall });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /exists and is not empty/);
  assert.equal(readFileSync(join(cwd, "bb-plugin-taken", "keep.txt"), "utf8"), "here first\n");
});

test("an install failure exits 1 but leaves the scaffold intact", () => {
  const cwd = freshDir();
  const result = runCreate("bb-plugin-offline", {
    cwd,
    install: () => ({ status: 1, output: "npm ERR! EPERM something local\n" }),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /npm install failed — the scaffold is intact/);
  assert.ok(existsSync(join(cwd, "bb-plugin-offline", "server/server.ts")));
});

test("transient npm failures retry up to three times", () => {
  const cwd = freshDir();
  let calls = 0;
  const result = runCreate("bb-plugin-flaky", {
    cwd,
    install: () => {
      calls += 1;
      return calls < 3
        ? { status: 1, output: "npm ERR! 502 Bad Gateway (E502)\n" }
        : { status: 0, output: "" };
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /retrying \(attempt 2 of 3\)/);
});

test("non-transient npm failures do not retry", () => {
  const cwd = freshDir();
  let calls = 0;
  const result = runCreate("bb-plugin-broken", {
    cwd,
    install: () => {
      calls += 1;
      return { status: 1, output: "npm ERR! ERESOLVE unable to resolve dependency tree\n" };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 1);
});

test("an unusable package name exits 1 before touching the disk", () => {
  const cwd = freshDir();
  const result = runCreate("---", { cwd, install: okInstall });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /./);
});
