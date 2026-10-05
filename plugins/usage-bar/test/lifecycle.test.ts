import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { runMenuBar } from "../src/server/lib/menu-bar.ts";

/**
 * Build the helper in a fresh process whose HOME has no cached binary and whose
 * PATH holds only the given shell `tools`, and report how the build failed.
 */
async function buildWith(tools: Record<string, string>) {
  const home = await mkdtemp(join(tmpdir(), "usage-bar-build-"));
  const bin = join(home, "bin");
  try {
    await mkdir(bin);
    for (const [name, script] of Object.entries(tools)) {
      await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    }
    const helper = join(import.meta.dirname, "../src/server/lib/helper.ts");
    const { stdout } = spawnSync(
      process.execPath,
      [
        "-e",
        `const { buildHelper } = await import(${JSON.stringify(helper)});
        try {
          await buildHelper(new AbortController().signal);
        } catch (error) {
          const { name, message, cause } = error;
          console.log(JSON.stringify({ name, message, stderr: cause?.stderr ?? null }));
        }`,
      ],
      { env: { HOME: home, PATH: bin }, encoding: "utf8" },
    );
    return JSON.parse(stdout) as unknown;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("without the Xcode command line tools, the helper build asks for configuration", async () => {
  expect(await buildWith({})).toEqual({
    name: "NeedsConfigurationError",
    message:
      "Usage Bar needs the Xcode command line tools. Run xcode-select --install, then reload the plugin.",
    stderr: "",
  });
});

test("a failed compile asks for configuration with the first compiler lines", async () => {
  expect(
    await buildWith({
      "xcode-select": "exit 0",
      swiftc: "printf 'one\\ntwo\\nthree\\nfour\\nfive\\nsix\\n' >&2; exit 1",
    }),
  ).toEqual({
    name: "NeedsConfigurationError",
    message:
      "Usage Bar could not compile its menu bar helper. Update the Xcode command line tools (xcode-select --install), then reload the plugin.\none\ntwo\nthree\nfour",
    stderr: "one\ntwo\nthree\nfour\nfive\nsix\n",
  });
});

test("a killed compiler stays a plain failure so bb retries the service", async () => {
  expect(await buildWith({ "xcode-select": "exit 0", swiftc: "kill -9 $$" })).toEqual({
    name: "Error",
    message: "usage-bar: swiftc failed",
    stderr: "",
  });
});

test.skipIf(process.platform !== "darwin")(
  "native service stops when the source RPC never resolves",
  async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const abort = new AbortController();
    const original = process.env.BB_USAGE_BAR_ANY_INSTANCE;
    process.env.BB_USAGE_BAR_ANY_INSTANCE = "1";
    const { bb, harness } = createFakePluginHost({
      pluginId: "usage-bar",
      sdk: {
        plugins: {
          experimental_discoverRpc: () => {
            markStarted();
            return new Promise(() => {});
          },
        },
      },
    });
    const running = runMenuBar(bb, abort.signal).then(() => "stopped");
    try {
      await started;
      abort.abort();
      expect(await running).toBe("stopped");
    } finally {
      abort.abort();
      await harness.lifecycle.dispose();
      if (original === undefined) delete process.env.BB_USAGE_BAR_ANY_INSTANCE;
      else process.env.BB_USAGE_BAR_ANY_INSTANCE = original;
    }
  },
  15_000,
);
