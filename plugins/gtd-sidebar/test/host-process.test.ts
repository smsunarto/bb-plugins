import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("the branch probe finds GitButler in a user tool directory without a shell PATH", async () => {
  const home = await mkdtemp(join(tmpdir(), "gtd-host-process-"));
  try {
    const bin = join(home, ".local", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "but"),
      `#!/bin/sh
test "$1" = status && test "$2" = --json || exit 1
printf '%s' '{"stacks":[{"branches":[{"name":"scott/sdk-probe"}]}]}'
`,
      { mode: 0o755 },
    );
    // Isolate the SDK's process-wide toolchain, just as a fresh daemon starts
    // with its own service environment. The real host harness validates output.
    const entryUrl = pathToFileURL(join(import.meta.dirname, "../host.ts")).href;
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
const { default: entry } = await import(${JSON.stringify(entryUrl)});
const host = experimental_createHostEntryHarness(entry);
try {
  console.log(JSON.stringify(await host.experimental_call("branchSummary", { cwd: process.cwd() })));
} finally {
  await host.experimental_dispose();
}`,
      ],
      {
        env: { HOME: home, PATH: "/nonexistent", SHELL: "/bin/sh" },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout)).toEqual({ label: "scott/sdk-probe" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
