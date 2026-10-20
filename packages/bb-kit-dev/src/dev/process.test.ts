import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { processIdentity, processMatches, terminateOwnedProcessGroup } from "./process.ts";

for (const ignoreTerm of [false, true]) {
  test(
    `cleanup stops children in separate process groups${ignoreTerm ? " even when they ignore SIGTERM" : ""}`,
    { skip: process.platform === "win32" },
    async (context) => {
      const root = mkdtempSync(join(tmpdir(), "bb-kit-process-"));
      const ready = join(root, "child.pid");
      const childSource = `
        const { writeFileSync } = require("node:fs");
        ${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
        writeFileSync(${JSON.stringify(ready)}, String(process.pid));
        setInterval(() => {}, 1000);
      `;
      const launcher = spawn(
        process.execPath,
        [
          "-e",
          `
            const { spawn } = require("node:child_process");
            spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], {
              detached: true, stdio: "ignore",
            }).unref();
            setInterval(() => {}, 1000);
          `,
        ],
        { detached: true, stdio: "ignore" },
      );
      context.after(() => {
        launcher.kill("SIGKILL");
        if (existsSync(ready)) {
          try {
            process.kill(Number(readFileSync(ready, "utf8")), "SIGKILL");
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
              throw error;
            }
          }
        }
        rmSync(root, { recursive: true, force: true });
      });
      const deadline = Date.now() + 5_000;
      while (!existsSync(ready) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(existsSync(ready), "child did not become ready");
      assert.ok(launcher.pid);
      const identity = processIdentity(launcher.pid);
      const child = processIdentity(Number(readFileSync(ready, "utf8")));
      assert.ok(identity);
      assert.ok(child);

      await terminateOwnedProcessGroup({ ...identity, started: "another process" });
      assert.equal(processMatches(identity), true, "mismatched identity stopped the launcher");
      assert.equal(processMatches(child), true, "mismatched identity stopped a child");

      await terminateOwnedProcessGroup(identity);

      assert.equal(processMatches(identity), false, "launcher survived cleanup");
      assert.equal(processMatches(child), false, "child server survived cleanup");
    },
  );
}

test(
  "cleanup preserves padded-day process identities",
  { skip: process.platform === "win32" || process.env["BB_KIT_PADDED_PS_TEST"] === "1" },
  (context) => {
    const root = mkdtempSync(join(tmpdir(), "bb-kit-padded-ps-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const realPs = spawnSync("sh", ["-c", "command -v ps"], { encoding: "utf8" }).stdout.trim();
    assert.ok(realPs);
    // Replay the platform's space-padded single-digit day without changing
    // the host clock or mocking process liveness and signal delivery.
    writeFileSync(
      join(root, "ps"),
      `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const result = spawnSync(${JSON.stringify(realPs)}, process.argv.slice(2), { encoding: "utf8" });
process.stdout.write(result.stdout.replace(/(\\w{3}\\s+\\w{3})\\s+\\d{1,2}(\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4})/gu, "$1  9$2"));
process.exitCode = result.status ?? 1;
`,
      { mode: 0o755 },
    );
    const result = spawnSync("bun", ["test", import.meta.filename], {
      env: {
        ...process.env,
        PATH: `${root}${delimiter}${process.env["PATH"] ?? ""}`,
        BB_KIT_PADDED_PS_TEST: "1",
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  },
);

test("cleanup escalates the original group for children born during shutdown", async (context) => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "bb-kit-shutdown-"));
  const ready = join(root, "ready");
  const childPid = join(root, "child.pid");
  const launcher = spawn(
    process.execPath,
    [
      "-e",
      `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
let child;
process.on("SIGTERM", () => {
  if (child) return;
  child = spawn(process.execPath, ["-e", ${JSON.stringify(`
    process.on("SIGTERM", () => {});
    require("node:fs").writeFileSync(${JSON.stringify(childPid)}, String(process.pid));
    setInterval(() => {}, 1000);
  `)}], { stdio: "ignore" });
});
writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1000);
`,
    ],
    { detached: true, stdio: "ignore" },
  );
  context.after(() => {
    if (launcher.pid) {
      try {
        process.kill(-launcher.pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 5_000;
  while (!existsSync(ready) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(existsSync(ready));
  assert.ok(launcher.pid);
  const identity = processIdentity(launcher.pid);
  assert.ok(identity);
  await terminateOwnedProcessGroup(identity);
  assert.ok(existsSync(childPid), "launcher did not create a child during shutdown");
  assert.equal(processIdentity(Number(readFileSync(childPid, "utf8"))), null);
});
