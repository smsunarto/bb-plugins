import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("built host initializes from one relocated Node 22 file with embedded WASM", async () => {
  const build = Bun.spawn(["bb", "plugin", "build", "."], {
    cwd: PLUGIN_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [buildExitCode, buildStderr] = await Promise.all([
    build.exited,
    new Response(build.stderr).text(),
  ]);
  assert.equal(buildExitCode, 0, buildStderr);

  const source = join(PLUGIN_ROOT, "dist", "host.js");
  const root = await mkdtemp(join(tmpdir(), "nanocodex-host-artifact-"));
  try {
    const artifact = join(root, "host.js");
    await copyFile(source, artifact);
    assert.deepEqual(await readdir(root), ["host.js"]);
    const bundled = await readFile(artifact, "utf8");
    assert.match(bundled, /NANOCODEX_WASM_BASE64/);

    const child = Bun.spawn(
      [
        "node",
        "--experimental-default-type=module",
        "--eval",
        "const m = await import('./host.js'); await m.experimental_initializeNanocodexModule(); if (!m.experimental_providerBridge) process.exit(9)",
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    assert.equal(exitCode, 0, stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
