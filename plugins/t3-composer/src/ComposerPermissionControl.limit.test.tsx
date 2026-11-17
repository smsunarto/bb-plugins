// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bb,
  openThread,
  renderControl,
  resetFakeComposer,
  setControl,
  trigger,
} from "./permission-test-composer";
import { CEILING_REASON, type PermissionMode } from "./permission-modes";
// workaround:t3-composer/thread-permission-reset begin
import { forgetAllPermissionModes } from "./thread-permission-picks";
// workaround:t3-composer/thread-permission-reset end

const MODELS = [{ id: "opus", model: "opus", displayName: "Opus", isDefault: true }];

/**
 * The machine limit as the real catalog reads it: BB's server holds each machine's limit,
 * answers `providers.models` with it, and reports a change as `host-connected` on that host,
 * the way its Settings → Machines route does. "mac" is the primary machine.
 */
const server = {
  limits: new Map<string, PermissionMode>(),
  /** Which machine each thread's environment is on. */
  threadHosts: new Map<string, string>(),
  /** Machines with no daemon session: BB 0.49 answers 200, Full Access and a model load error. */
  disconnected: new Set<string>(),
  /** Machines whose provider cannot list models: a load error, but the real limit. */
  signedOut: new Set<string>(),
  /** How many of the next `providers.models` reads reject, as on a timeout. */
  failNext: 0,
  reads: [] as { environmentId?: string; hostId?: string; preferCached?: boolean }[],
  /** Holds the next `providers.models` answers until the test lets them go. */
  held: null as null | (() => void)[],
  hostListeners: new Set<(event: { id?: string; changes: string[] }) => void>(),
  connectionListeners: new Set<(event: { state: string }) => void>(),
};

function hostOf(args: { environmentId?: string; hostId?: string }) {
  return args.hostId ?? args.environmentId?.replace(/^env-/, "") ?? "mac";
}

const PROVIDERS = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    capabilities: { permissionModes: ["accept-edits", "auto", "full"] },
  },
];

const sdk = {
  threads: {
    get: async ({ threadId }: { threadId: string }) => {
      const hostId = server.threadHosts.get(threadId)!;
      return {
        id: threadId,
        environmentId: `env-${hostId}`,
        environment: { id: `env-${hostId}`, hostId },
      };
    },
  },
  environments: {
    get: async ({ environmentId }: { environmentId: string }) => ({
      id: environmentId,
      hostId: hostOf({ environmentId }),
    }),
  },
  hosts: {
    get: async ({ hostId }: { hostId: string }) => ({
      id: hostId,
      maxPermissionMode: server.limits.get(hostId)!,
      status: server.disconnected.has(hostId) ? "disconnected" : "connected",
    }),
  },
  system: { config: async () => ({ primaryHostId: "mac" }) },
  providers: {
    models: async (args: { environmentId?: string; hostId?: string; preferCached?: boolean }) => {
      server.reads.push({
        environmentId: args.environmentId,
        hostId: args.hostId,
        preferCached: args.preferCached,
      });
      const hostId = hostOf(args);
      const fail = server.failNext > 0;
      if (fail) server.failNext -= 1;
      if (server.held) await new Promise<void>((resolve) => server.held!.push(resolve));
      if (fail) throw new Error("The operation timed out.");
      if (server.disconnected.has(hostId)) {
        // BB 0.49's execution options: no machine session, so no machine, so Full Access.
        return {
          permissionCeiling: "full" as PermissionMode,
          providers: PROVIDERS,
          models: [],
          modelLoadError: { providerId: "claude-code", code: "failed", detail: "Not connected" },
        };
      }
      // Read when the server answers, as BB reads the limit from its database.
      const permissionCeiling = server.limits.get(hostId)!;
      if (server.signedOut.has(hostId)) {
        return {
          permissionCeiling,
          providers: PROVIDERS,
          models: [],
          modelLoadError: { providerId: "claude-code", code: "auth_required", detail: null },
        };
      }
      return { permissionCeiling, providers: PROVIDERS, models: MODELS, modelLoadError: null };
    },
  },
  subscribe: (args: { event: string; callback(event: unknown): void }) => {
    if (args.event === "host:changed") {
      server.hostListeners.add(args.callback);
      return () => server.hostListeners.delete(args.callback);
    }
    if (args.event === "realtime:connection") {
      const listener = args.callback;
      server.connectionListeners.add(listener);
      // BB replays its last connection state to a new listener.
      queueMicrotask(() => listener({ state: "connected" }));
      return () => server.connectionListeners.delete(listener);
    }
    return () => {};
  },
};

vi.mock(
  "./composer-handle",
  async () => (await import("./permission-test-composer")).composerHandleMock,
);
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@get-bb/plugin-sdk/app")>()),
  useSdk: () => sdk,
  experimental_useProviders: () => ({
    status: "ready",
    providers: [{ id: "claude-code", displayName: "Claude Code" }],
  }),
}));

const { ComposerPermissionControl } = await import("./ComposerPermissionControl");
const catalog = await import("./model-picker/catalog");
setControl(ComposerPermissionControl);

/** Changes a machine's limit in Settings → Machines. */
async function setLimit(hostId: string, limit: PermissionMode) {
  server.limits.set(hostId, limit);
  await hostConnected(hostId);
}

async function hostConnected(hostId: string | undefined, times = 1) {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
      for (const listener of server.hostListeners) {
        listener({ id: hostId, changes: ["host-connected"] });
      }
    }
  });
}

async function reconnect() {
  await act(async () => {
    for (const listener of server.connectionListeners) listener({ state: "disconnected" });
    for (const listener of server.connectionListeners) listener({ state: "connected" });
  });
}

/** Opens the menu once the machine has answered, which makes the trigger interactive. */
async function openMenu() {
  await waitFor(() => expect((trigger() as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(trigger());
  await screen.findAllByRole("menuitemradio");
}

function fullAccess() {
  return screen.getByRole("menuitemradio", { name: /Full Access/ });
}

function isDisabled(row: HTMLElement) {
  return row.getAttribute("aria-disabled") === "true" || row.hasAttribute("data-disabled");
}

async function releaseHeld() {
  const held = server.held ?? [];
  server.held = null;
  await act(async () => {
    for (const resolve of held) resolve();
  });
}

const settle = (ms = 50) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** What the model picker reads from the same store. */
const probe = { renders: 0, status: "" };
function CatalogProbe() {
  const models = catalog.useModelCatalog(bb.composer!, true);
  probe.renders += 1;
  probe.status = models.catalogFor("claude-code").status;
  return null;
}

/** Points the new-thread composer at an existing environment. */
function reuseEnvironment(environmentId: string) {
  act(() => {
    bb.composer = {
      ...bb.composer!,
      selection: { ...bb.composer!.selection!, environment: { type: "reuse", environmentId } },
    } as never;
    for (const listener of bb.listeners) listener();
  });
}

describe("ComposerPermissionControl's machine limit", () => {
  beforeEach(() => {
    resetFakeComposer();
    server.limits = new Map([
      ["mac", "full"],
      ["linux", "full"],
    ]);
    server.threadHosts = new Map([
      ["a", "mac"],
      ["b", "linux"],
      ["c", "mac"],
    ]);
    bb.defaults.set("c", "auto");
    server.disconnected = new Set();
    server.signedOut = new Set();
    server.failNext = 0;
    server.reads = [];
    server.held = null;
    probe.renders = 0;
    probe.status = "";
  });
  afterEach(() => {
    cleanup();
    catalog.forgetCatalogs();
    // workaround:t3-composer/thread-permission-reset begin
    forgetAllPermissionModes();
    // workaround:t3-composer/thread-permission-reset end
    server.hostListeners.clear();
    server.connectionListeners.clear();
  });

  it("disables Full Access in the open menu once the machine's limit is lowered", async () => {
    renderControl();
    await openMenu();
    expect(isDisabled(fullAccess())).toBe(false);

    await setLimit("mac", "auto");

    await waitFor(() => expect(isDisabled(fullAccess())).toBe(true));
    expect(screen.getByText(CEILING_REASON)).toBeTruthy();
  });

  it("enables Full Access again once the limit is raised", async () => {
    server.limits.set("mac", "auto");
    renderControl();
    await openMenu();
    expect(isDisabled(fullAccess())).toBe(true);

    await setLimit("mac", "full");

    await waitFor(() => expect(isDisabled(fullAccess())).toBe(false));
  });

  it("reads the lowered limit for a menu opened after the change", async () => {
    renderControl();
    await waitFor(() => expect(server.reads).toHaveLength(1));

    await setLimit("mac", "auto");
    await openMenu();

    await waitFor(() => expect(isDisabled(fullAccess())).toBe(true));
  });

  it("reads a limit changed while the picker was unmounted, showing the cached one meanwhile", async () => {
    const { unmount } = renderControl();
    await waitFor(() => expect(server.reads).toHaveLength(1));
    unmount();

    // Settings → Machines replaces the thread view, so nothing hears the change.
    server.limits.set("mac", "auto");
    server.held = [];
    renderControl();
    await openMenu();
    // The cached limit stays usable until the machine answers.
    expect(isDisabled(fullAccess())).toBe(false);

    await releaseHeld();
    await waitFor(() => expect(isDisabled(fullAccess())).toBe(true));
  });

  it("lists the models afresh, not from BB's cache, once the cached list is stale", async () => {
    const { unmount } = renderControl();
    await waitFor(() => expect(server.reads).toHaveLength(1));
    unmount();

    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
    try {
      renderControl();
      await waitFor(() => expect(server.reads).toHaveLength(2));
      expect(server.reads[1]!.preferCached).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  it("reads only the thread's machine when another machine's limit changes", async () => {
    renderControl();
    await waitFor(() => expect(server.reads).toHaveLength(1));

    await setLimit("linux", "auto");

    expect(server.reads).toEqual([{ environmentId: "env-mac", hostId: undefined }]);
  });

  it("follows the machine of the thread switched to", async () => {
    renderControl();
    await waitFor(() => expect(server.reads).toHaveLength(1));
    server.limits.set("linux", "auto");

    openThread("b");
    await openMenu();

    await waitFor(() => expect(isDisabled(fullAccess())).toBe(true));
    await setLimit("linux", "full");
    await waitFor(() => expect(isDisabled(fullAccess())).toBe(false));
  });

  it("keeps the last change when the limit moves again while a read is in flight", async () => {
    renderControl();
    await waitFor(() => expect(server.reads).toHaveLength(1));
    await openMenu();

    server.held = [];
    await setLimit("mac", "auto");
    await setLimit("mac", "full");
    await releaseHeld();

    await waitFor(() => expect(server.reads).toHaveLength(3));
    expect(isDisabled(fullAccess())).toBe(false);
  });

  it("reads the limit again after BB's realtime connection comes back", async () => {
    renderControl();
    await waitFor(() => expect(server.reads).toHaveLength(1));

    server.limits.set("mac", "auto");
    await act(async () => {
      for (const listener of server.connectionListeners) listener({ state: "disconnected" });
      for (const listener of server.connectionListeners) listener({ state: "connected" });
    });
    await openMenu();

    await waitFor(() => expect(isDisabled(fullAccess())).toBe(true));
  });

  it("disables a mode BB refused right away, before the machine answers again", async () => {
    renderControl();
    await waitFor(() => expect(server.reads).toHaveLength(1));
    // Lowered where this page did not hear it; BB's composer already holds the new limit.
    server.limits.set("mac", "auto");
    bb.refuses = new Set(["full"]);
    server.held = [];

    await openMenu();
    fireEvent.click(fullAccess());
    await waitFor(() => expect(bb.calls).toHaveLength(1));

    await openMenu();
    await waitFor(() => expect(isDisabled(fullAccess())).toBe(true));
    await releaseHeld();
    await waitFor(() => expect(server.reads).toHaveLength(2));
    expect(isDisabled(fullAccess())).toBe(true);
  });

  it("enables a refused mode again when the machine still allows it", async () => {
    renderControl();
    await waitFor(() => expect(server.reads).toHaveLength(1));
    // Refused for another reason than the limit.
    bb.refuses = new Set(["full"]);

    await openMenu();
    fireEvent.click(fullAccess());
    await waitFor(() => expect(server.reads).toHaveLength(2));

    await openMenu();
    await waitFor(() => expect(isDisabled(fullAccess())).toBe(false));
  });

  it("keeps a lower limit when BB answers for a disconnected machine after a reconnect", async () => {
    server.limits.set("mac", "auto");
    renderControl();
    await openMenu();
    expect(isDisabled(fullAccess())).toBe(true);

    server.disconnected.add("mac");
    await reconnect();
    await settle();

    expect(server.reads).toHaveLength(2);
    expect(isDisabled(fullAccess())).toBe(true);
  });

  it("keeps a lower limit when switching back to a thread on a disconnected machine", async () => {
    server.limits.set("mac", "auto");
    renderControl();
    await waitFor(() => expect(server.reads).toHaveLength(1));
    openThread("b");
    await waitFor(() => expect(server.reads).toHaveLength(2));
    server.disconnected.add("mac");
    openThread("a");
    await waitFor(() => expect(server.reads).toHaveLength(3));

    await openMenu();
    await settle();
    expect(isDisabled(fullAccess())).toBe(true);
  });

  it("raises the limit of a machine whose provider cannot list models", async () => {
    server.limits.set("mac", "auto");
    server.signedOut.add("mac");
    renderControl();
    await openMenu();
    expect(isDisabled(fullAccess())).toBe(true);

    await setLimit("mac", "full");

    await waitFor(() => expect(isDisabled(fullAccess())).toBe(false));
  });

  it("keeps the first answer's limit when a change mid-read queues a re-read that fails", async () => {
    server.held = [];
    renderControl();
    await waitFor(() => expect(server.reads).toHaveLength(1));
    server.failNext = 1;
    await hostConnected("mac");
    await releaseHeld();
    await settle(100);

    expect(server.reads).toHaveLength(2);
    expect((trigger() as HTMLButtonElement).disabled).toBe(false);
  });

  it("enables a refused mode again when the re-read that would confirm the refusal fails", async () => {
    renderControl();
    await waitFor(() => expect(server.reads).toHaveLength(1));
    // Refused for another reason than the limit, and the machine does not answer.
    bb.refuses = new Set(["full"]);
    server.failNext = 1;

    await openMenu();
    fireEvent.click(fullAccess());
    await waitFor(() => expect(server.reads).toHaveLength(2));
    await settle(100);

    await openMenu();
    expect(isDisabled(fullAccess())).toBe(false);
    expect(screen.queryByText(CEILING_REASON)).toBeNull();
  });

  it("leaves a new-thread composer on the primary machine alone when another machine changes", async () => {
    openThread(null);
    renderControl();
    await waitFor(() => expect(server.reads).toHaveLength(1));
    await settle();

    await hostConnected("linux");
    await hostConnected("some-other-host");
    await settle();
    expect(server.reads).toHaveLength(1);

    await setLimit("mac", "auto");
    await openMenu();
    await waitFor(() => expect(isDisabled(fullAccess())).toBe(true));
  });

  it("leaves a new-thread composer on a reused environment alone when another machine changes", async () => {
    openThread(null);
    reuseEnvironment("env-mac");
    renderControl();
    await waitFor(() => expect(server.reads).toHaveLength(1));
    await settle();

    await hostConnected("linux");
    await settle();
    expect(server.reads).toHaveLength(1);
  });

  it("keeps a ready model list when a re-read after a reconnect fails", async () => {
    renderControl();
    render(<CatalogProbe />);
    await waitFor(() => expect(probe.status).toBe("ready"));
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
    try {
      server.failNext = 1;
      await reconnect();
      await settle(100);
      expect(server.reads).toHaveLength(2);
      expect(probe.status).toBe("ready");
    } finally {
      clock.mockRestore();
    }
  });

  it("re-renders nothing for re-reads that find the limit unchanged", async () => {
    let commits = 0;
    render(
      <Profiler id="control" onRender={() => (commits += 1)}>
        <ComposerPermissionControl />
      </Profiler>,
    );
    render(<CatalogProbe />);
    await waitFor(() => expect(probe.status).toBe("ready"));
    await settle();
    const renders = probe.renders;
    const committed = commits;

    for (let i = 0; i < 10; i += 1) {
      await hostConnected("mac");
      await settle(10);
    }

    expect(server.reads.length).toBeGreaterThan(1);
    expect(probe.renders - renders).toBe(0);
    expect(commits - committed).toBe(0);
  });

  it("holds a burst of changes to one read under way and one queued", async () => {
    renderControl();
    renderControl();
    renderControl();
    await waitFor(() => expect(server.reads).toHaveLength(1));
    server.held = [];
    await hostConnected("mac", 50);
    await reconnect();
    await reconnect();
    expect(server.reads).toHaveLength(2);

    await releaseHeld();
    await settle();
    expect(server.reads).toHaveLength(3);
  });

  it("leaves no listener behind across remounts, thread switches and StrictMode", async () => {
    for (let i = 0; i < 5; i += 1) {
      const view = renderControl();
      await settle(5);
      expect(server.hostListeners.size).toBe(1);
      view.unmount();
      expect(server.hostListeners.size).toBe(0);
      expect(server.connectionListeners.size).toBe(0);
    }
    const strict = render(
      <StrictMode>
        <ComposerPermissionControl />
      </StrictMode>,
    );
    await settle();
    openThread("b");
    await settle();
    openThread(null);
    await settle();
    expect(server.hostListeners.size).toBe(1);
    expect(server.connectionListeners.size).toBe(1);
    strict.unmount();
    expect(server.hostListeners.size).toBe(0);
    expect(server.connectionListeners.size).toBe(0);
  });
});
