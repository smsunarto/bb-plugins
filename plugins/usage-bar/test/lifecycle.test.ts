import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createMenuHost } from "../src/host/host.ts";
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
    const helper = join(import.meta.dirname, "../src/host/helper.ts");
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

test("the service stops when the source RPC never resolves", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const abort = new AbortController();
  const { bb, harness } = createFakePluginHost({
    pluginId: "usage-bar",
    sdk: {
      hosts: { list: async () => [] },
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
  }
});

test("the menu goes to each connected host until it answers that it cannot draw one", async () => {
  const abort = new AbortController();
  const { bb, harness } = createFakePluginHost({
    pluginId: "usage-bar",
    dataDir: "/srv/bb",
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({ id: "mac", status: "connected" }),
          makeHostResponse({ id: "linux", status: "connected" }),
          makeHostResponse({ id: "asleep", status: "disconnected" }),
        ],
      },
      plugins: { experimental_discoverRpc: async () => [] },
    },
    experimental_callHostRpc: ({ hostId }) => ({
      status: hostId === "linux" ? "unsupported" : "ok",
    }),
  });
  const calls = () =>
    harness.inspection.experimental_hostRpcCalls.map(({ method, hostId, input }) => ({
      method,
      hostId,
      refreshing: (input as { refreshing: boolean }).refreshing,
    }));
  const running = runMenuBar(bb, abort.signal);
  try {
    await waitFor(() => calls().length >= 2);
    expect(calls()).toEqual([
      { method: "render", hostId: "mac", refreshing: false },
      { method: "render", hostId: "linux", refreshing: false },
    ]);
    await harness.behavior.experimental_emitHostSignal("mac", "menu", { type: "refresh" });
    await waitFor(() => calls().length >= 4 && calls().at(-1)?.refreshing === false);
    // Menu-state changes during the refresh may add renders; only the shape matters.
    const refresh = calls().slice(2);
    expect(new Set(refresh.map(({ hostId }) => hostId))).toEqual(new Set(["mac"]));
    expect(refresh[0]?.refreshing).toBe(true);
    expect(refresh.at(-1)?.refreshing).toBe(false);
  } finally {
    abort.abort();
    await running;
    await harness.lifecycle.dispose();
  }
});

test("a Mac without the Xcode tools marks the plugin as needing configuration once", async () => {
  const abort = new AbortController();
  const { bb, harness } = createFakePluginHost({
    pluginId: "usage-bar",
    dataDir: "/srv/bb",
    sdk: {
      hosts: { list: async () => [makeHostResponse({ id: "mac", status: "connected" })] },
      plugins: { experimental_discoverRpc: async () => [] },
    },
    experimental_callHostRpc: () => ({
      status: "needs-configuration",
      message: "Install the Xcode command line tools.",
    }),
  });
  const running = runMenuBar(bb, abort.signal);
  try {
    await waitFor(() => harness.inspection.needsConfigurationMessages.length > 0);
    await harness.behavior.experimental_emitHostSignal("mac", "menu", { type: "menuOpened" });
    await waitFor(() => harness.inspection.experimental_hostRpcCalls.length >= 2);
    expect(harness.inspection.needsConfigurationMessages).toEqual([
      "Host mac: Install the Xcode command line tools.",
    ]);
  } finally {
    abort.abort();
    await running;
    await harness.lifecycle.dispose();
  }
});

test("hosts that are not Macs answer unsupported without keeping their worker", async () => {
  const host = experimental_createHostEntryHarness(createMenuHost("linux"));
  try {
    expect(
      await host.experimental_call("render", {
        snapshot: { error: null, providers: [] },
        refreshing: false,
      }),
    ).toEqual({ status: "unsupported" });
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(0);
  } finally {
    await host.experimental_dispose();
  }
});

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await sleep(5);
}
