import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallOutcome } from "./bin-create.ts";
import { runCreate } from "./bin-create.ts";
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
    "server.ts",
    "server.test.ts",
    "server/context.ts",
    "rpc/ping.ts",
    "rpc/ping.test.ts",
    "cli/status.ts",
    "cli/status.test.ts",
    "ui/rpc.ts",
    "ui/app.tsx",
    "ui/app.test.ts",
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
  // place, so @bb-kit/core imports resolve at run time (§7).
  assert.ok((pkg["dependencies"] as Record<string, string>)["@bb-kit/core"]);
  assert.ok(!(pkg["devDependencies"] as Record<string, string>)["@bb-kit/core"]);
  const bb = pkg["bb"] as Record<string, unknown>;
  assert.equal(bb["name"], "notes");
  assert.equal(bb["server"], "./server.ts");
  assert.equal(bb["app"], "./ui/app.tsx");
  assert.deepEqual(bb["branding"], { icon: "./assets/icon.svg" });
  assert.deepEqual(bb["skills"], []);
  const scripts = pkg["scripts"] as Record<string, unknown>;
  assert.equal(scripts["check"], "bb-kit check");
  assert.equal(scripts["test"], "node --test --import tsx");
});

test("the scaffold templates bake the derived id into server, ui, and tests", () => {
  const { id, files } = scaffoldFiles("@acme/bb-plugin-notes");
  assert.equal(id, "notes");
  assert.match(files["server.ts"] ?? "", /namespace: "notes"/);
  assert.match(files["ui/rpc.ts"] ?? "", /createRPC<RPC>\("notes"\)/);
  assert.match(files["server.test.ts"] ?? "", /callRpc\("notes_ping"\)/);
  assert.match(files["ui/app.test.ts"] ?? "", /"notes_ping": async/);
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
  assert.ok(existsSync(join(cwd, "bb-plugin-offline", "server.ts")));
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
