import { expect, jest, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type CreateFakePluginHostOptions,
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createMenuHost } from "../src/host/host.ts";
import plugin from "../src/server/server.ts";

/** Load the plugin and start its menu service the way bb does. */
async function startMenu(options: CreateFakePluginHostOptions) {
  const { bb, harness } = createFakePluginHost({ pluginId: "usage-bar", ...options });
  await plugin(bb);
  const service = harness.behavior.runService("menu-bar");
  return {
    harness,
    service,
    async stop() {
      service.controller.abort();
      await service.done;
      await harness.lifecycle.dispose();
    },
  };
}

/**
 * Build the helper in a fresh process whose HOME has no cached binary and whose
 * PATH leads with the given shell `tools`, and report how the build failed.
 * Shadow xcode-select by default: the SDK can also discover system tools even
 * when a service's PATH is empty, including a real Xcode install on macOS.
 */
async function buildWith(tools: Record<string, string>) {
  const home = await mkdtemp(join(tmpdir(), "usage-bar-build-"));
  const bin = join(home, "bin");
  try {
    await mkdir(bin);
    for (const [name, script] of Object.entries({ "xcode-select": "exit 1", ...tools })) {
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
  const { harness, service } = await startMenu({
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
  try {
    await started;
    service.controller.abort();
    expect(await service.done.then(() => "stopped")).toBe("stopped");
  } finally {
    service.controller.abort();
    await harness.lifecycle.dispose();
  }
});

test("the menu goes to each connected host until it answers that it cannot draw one", async () => {
  const { harness, stop } = await startMenu({
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
    await stop();
  }
});

test("a Mac without the Xcode tools marks the plugin as needing configuration once", async () => {
  const { harness, stop } = await startMenu({
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
  try {
    await waitFor(() => harness.inspection.needsConfigurationMessages.length > 0);
    await harness.behavior.experimental_emitHostSignal("mac", "menu", { type: "menuOpened" });
    await waitFor(() => harness.inspection.experimental_hostRpcCalls.length >= 2);
    expect(harness.inspection.needsConfigurationMessages).toEqual([
      "Host mac: Install the Xcode command line tools.",
    ]);
  } finally {
    await stop();
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

const mac = makeHostResponse({ id: "mac", status: "connected" });
const poolAccount = {
  id: "one",
  provider: "codex",
  label: "One",
  email: "one@example.com",
  subscriptionType: "plus",
  rateLimitTier: null,
  enabled: true,
  priority: 1,
  lastUsedAt: null,
  fiveHourUtilization: 0.25,
  fiveHourResetAt: null,
  sevenDayUtilization: null,
  sevenDayResetAt: null,
  familyWeekly: {},
  limitWindows: [],
  observedAt: null,
  heldUntil: null,
  error: null,
  inFlight: 0,
  status: "ready",
};
/** Account Pooler holding one account; `refreshUsage` answers its Refresh calls. */
const pool = (refreshUsage: () => Promise<unknown>) => ({
  experimental_discoverRpc: async () => [{ pluginId: "account-pool" }],
  callRpc: async ({ method }: { method: string }) =>
    method === "account.refreshUsage" ? refreshUsage() : [poolAccount],
});
type RenderInput = { refreshing: boolean; snapshot: { error: string | null } };
const renders = (harness: Awaited<ReturnType<typeof startMenu>>["harness"], hostId: string) =>
  harness.inspection.experimental_hostRpcCalls
    .filter((call) => call.hostId === hostId)
    .map(({ input }) => ({
      refreshing: (input as RenderInput).refreshing,
      error: (input as RenderInput).snapshot.error,
    }));

test("each host draws one menu at a time, then the latest, without holding up other hosts", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let macCalls = 0;
  let macInFlight = 0;
  let macPeak = 0;
  let firstSignal: AbortSignal | undefined;
  const { harness, stop } = await startMenu({
    dataDir: "/srv/bb",
    sdk: {
      hosts: { list: async () => [mac, makeHostResponse({ id: "mini", status: "connected" })] },
      plugins: { experimental_discoverRpc: async () => [] },
      system: { config: async () => ({ primaryHostId: null }) },
    },
    experimental_callHostRpc: async ({ hostId, signal }) => {
      if (hostId === "mac") {
        macCalls += 1;
        macPeak = Math.max(macPeak, ++macInFlight);
        if (macCalls === 1) {
          firstSignal = signal;
          await held;
        }
        macInFlight -= 1;
      }
      return { status: "ok" };
    },
  });
  try {
    await waitFor(() => macCalls === 1);
    await harness.behavior.experimental_emitHostSignal("mini", "menu", { type: "refresh" });
    // The other Mac draws Refresh start to finish while this one still draws its first menu.
    await waitFor(() => renders(harness, "mini").at(-1)?.refreshing === false);
    expect(renders(harness, "mini").some(({ refreshing }) => refreshing)).toBe(true);
    expect(macCalls).toBe(1);
    expect(firstSignal?.aborted).toBe(false);
    release();
    await waitFor(() => macCalls === 2);
    await sleep(50);
    expect(renders(harness, "mac").map(({ refreshing }) => refreshing)).toEqual([false, false]);
    expect(macPeak).toBe(1);
  } finally {
    release();
    await stop();
  }
});

test("stopping the service cancels a render in flight", async () => {
  let signal: AbortSignal | undefined;
  const { stop } = await startMenu({
    dataDir: "/srv/bb",
    sdk: {
      hosts: { list: async () => [mac] },
      plugins: { experimental_discoverRpc: async () => [] },
    },
    experimental_callHostRpc: (call) => {
      signal = call.signal;
      return new Promise(() => {});
    },
  });
  await waitFor(() => signal !== undefined);
  await stop();
  expect(signal?.aborted).toBe(true);
});

test("a restarted service starts over and draws the menu again", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const { harness, service, stop } = await startMenu({
    dataDir: "/srv/bb",
    sdk: {
      hosts: { list: async () => [mac] },
      plugins: { experimental_discoverRpc: async () => [] },
      system: { config: async () => ({ primaryHostId: null }) },
    },
    // The first run stops while its render is still in flight.
    experimental_callHostRpc: async () => {
      if (++calls === 1) await held;
      return { status: "ok" };
    },
  });
  try {
    await waitFor(() => renders(harness, "mac").length === 1);
    service.controller.abort();
    await service.done;
    const restarted = harness.behavior.runService("menu-bar");
    // The first run's render never finished, yet the new run draws on its own.
    await waitFor(() => renders(harness, "mac").length >= 2);
    expect(renders(harness, "mac").length).toBeGreaterThanOrEqual(2);
    restarted.controller.abort();
    await restarted.done;
  } finally {
    release();
    await stop();
  }
});

test("Refresh while a refresh runs does not start another", async () => {
  let refreshes = 0;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { harness, stop } = await startMenu({
    dataDir: "/srv/bb",
    sdk: {
      hosts: { list: async () => [mac] },
      plugins: pool(async () => {
        refreshes += 1;
        await finished;
        return null;
      }),
    },
    experimental_callHostRpc: () => ({ status: "ok" }),
  });
  try {
    await waitFor(() => renders(harness, "mac").length > 0);
    await harness.behavior.experimental_emitHostSignal("mac", "menu", { type: "refresh" });
    await harness.behavior.experimental_emitHostSignal("mac", "menu", { type: "refresh" });
    await waitFor(() => refreshes === 1);
    await sleep(20);
    expect(refreshes).toBe(1);
    expect(renders(harness, "mac").at(-1)?.refreshing).toBe(true);
    finish();
    await waitFor(() => renders(harness, "mac").at(-1)?.refreshing === false);
    expect(refreshes).toBe(1);
  } finally {
    finish();
    await stop();
  }
});

test("dev bb instances idle instead of drawing a second menu bar", async () => {
  let lists = 0;
  const { harness, stop } = await startMenu({
    dataDir: "/home/me/.bb-dev/data",
    sdk: {
      hosts: {
        list: async () => {
          lists += 1;
          return [mac];
        },
      },
    },
  });
  await sleep(20);
  expect(lists).toBe(0);
  expect(harness.inspection.logEntries).toContainEqual({
    level: "info",
    message: "usage-bar: dev bb instances do not draw the menu bar; idling.",
  });
  await stop();
});

/**
 * Bun's fake timers leave `setImmediate` real, and the Effect scheduler runs on it,
 * so flushing immediates lets every fiber and promise settle between timer steps.
 */
async function settle() {
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}
async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    jest.advanceTimersByTime(1_000);
    await settle();
  }
}

test("every 15 seconds the menu lists hosts again and draws on newly connected Macs", async () => {
  jest.useFakeTimers();
  let lists = 0;
  const menu = await startMenu({
    dataDir: "/srv/bb",
    sdk: {
      hosts: { list: async () => (++lists === 1 ? [] : [mac]) },
      plugins: { experimental_discoverRpc: async () => [] },
      system: { config: async () => ({ primaryHostId: null }) },
    },
    experimental_callHostRpc: () => ({ status: "ok" }),
  });
  try {
    await advance(14_000);
    expect(lists).toBe(1);
    expect(renders(menu.harness, "mac")).toEqual([]);
    await advance(2_000);
    expect(lists).toBe(2);
    expect(renders(menu.harness, "mac").at(-1)).toEqual({ refreshing: false, error: null });
  } finally {
    await menu.stop();
    jest.useRealTimers();
  }
});

test("a source read that never answers neither stops polling nor piles up", async () => {
  jest.useFakeTimers();
  let lists = 0;
  let discoveries = 0;
  const menu = await startMenu({
    dataDir: "/srv/bb",
    sdk: {
      hosts: { list: async () => (++lists === 1 ? [] : [mac]) },
      plugins: {
        // Like an SDK read that ignores its signal: it never settles.
        experimental_discoverRpc: () => {
          discoveries += 1;
          return new Promise(() => {});
        },
      },
    },
    experimental_callHostRpc: () => ({ status: "ok" }),
  });
  try {
    await advance(60_000);
    expect(lists).toBeGreaterThan(1);
    // The Mac that connected later gets a menu that says the reading is stale.
    expect(renders(menu.harness, "mac").at(-1)).toEqual({
      refreshing: false,
      error: "Couldn't refresh usage. Showing the last reading.",
    });
    expect(discoveries).toBe(1);
  } finally {
    await menu.stop();
    jest.useRealTimers();
  }
});

test("Refresh works again after Account Pooler never answers a refresh", async () => {
  jest.useFakeTimers();
  let refreshes = 0;
  const menu = await startMenu({
    dataDir: "/srv/bb",
    sdk: {
      hosts: { list: async () => [mac] },
      plugins: pool(() => (++refreshes === 1 ? new Promise(() => {}) : Promise.resolve(null))),
    },
    experimental_callHostRpc: () => ({ status: "ok" }),
  });
  try {
    await settle();
    await menu.harness.behavior.experimental_emitHostSignal("mac", "menu", { type: "refresh" });
    await settle();
    expect(renders(menu.harness, "mac").at(-1)?.refreshing).toBe(true);
    await advance(60_000);
    expect(renders(menu.harness, "mac").at(-1)?.refreshing).toBe(false);
    await menu.harness.behavior.experimental_emitHostSignal("mac", "menu", { type: "refresh" });
    await settle();
    expect(refreshes).toBe(2);
  } finally {
    await menu.stop();
    jest.useRealTimers();
  }
});

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await sleep(5);
}
