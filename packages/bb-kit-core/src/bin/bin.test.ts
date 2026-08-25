import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCreate } from "./create.ts";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "bin.ts");
const REPO_MODULES = join(here, "..", "..", "..", "..", "node_modules");
const bunOnPath = spawnSync("bun", ["--version"], { stdio: "ignore" }).error === undefined;

test(
  "bun can run check end to end now that parsing is in-process",
  { skip: bunOnPath ? false : "bun is not on PATH" },
  () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "bb-kit-bin-")));
    const created = runCreate("bb-plugin-notes", {
      cwd: parent,
      install: () => ({ status: 0, output: "" }),
    });
    assert.equal(created.exitCode, 0, created.stderr);
    const root = join(parent, "bb-plugin-notes");
    mkdirSync(join(root, "node_modules", "@get-bb"), { recursive: true });
    symlinkSync(
      join(REPO_MODULES, "@get-bb", "plugin-sdk"),
      join(root, "node_modules", "@get-bb", "plugin-sdk"),
    );
    symlinkSync(join(REPO_MODULES, "typescript"), join(root, "node_modules", "typescript"));
    const result = spawnSync("bun", [binPath, "check"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RPC names:\n {2}ping\n/);
    assert.match(result.stdout, /check passed\n$/);
  },
);
