// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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
import { forgetCatalogs } from "./model-picker/catalog";
// workaround:t3-composer/thread-permission-reset begin
import { forgetAllPermissionModes } from "./thread-permission-picks";
// workaround:t3-composer/thread-permission-reset end

/**
 * The machine limit as the real catalog reads it: BB's server holds each machine's limit,
 * answers `providers.models` with it, and reports a change as `host-connected` on that host,
 * the way its Settings → Machines route does.
 */
const server = {
  limits: new Map<string, PermissionMode>(),
  /** Which machine each thread's environment is on. */
  threadHosts: new Map<string, string>(),
  reads: [] as { environmentId?: string; hostId?: string; preferCached?: boolean }[],
  /** Holds the next `providers.models` answers until the test lets them go. */
  held: null as null | (() => void)[],
  hostListeners: new Set<(event: { id?: string; changes: string[] }) => void>(),
  connectionListeners: new Set<(event: { state: string }) => void>(),
};

function hostOfEnvironment(environmentId: string) {
  return environmentId.replace(/^env-/, "");
}

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
  providers: {
    models: async (args: { environmentId?: string; hostId?: string; preferCached?: boolean }) => {
      server.reads.push({
        environmentId: args.environmentId,
        hostId: args.hostId,
        preferCached: args.preferCached,
      });
      const hostId = args.hostId ?? hostOfEnvironment(args.environmentId!);
      if (server.held) await new Promise<void>((resolve) => server.held!.push(resolve));
      return {
        // Read when the server answers, as BB reads the limit from its database.
        permissionCeiling: server.limits.get(hostId)!,
        providers: [
          {
            id: "claude-code",
            displayName: "Claude Code",
            capabilities: { permissionModes: ["accept-edits", "auto", "full"] },
          },
        ],
        models: [],
        modelLoadError: null,
      };
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
}));

setControl((await import("./ComposerPermissionControl")).ComposerPermissionControl);

/** Changes a machine's limit in Settings → Machines. */
async function setLimit(hostId: string, limit: PermissionMode) {
  server.limits.set(hostId, limit);
  await act(async () => {
    for (const listener of server.hostListeners) {
      listener({ id: hostId, changes: ["host-connected"] });
    }
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
    server.reads = [];
    server.held = null;
  });
  afterEach(() => {
    cleanup();
    forgetCatalogs();
    // workaround:t3-composer/thread-permission-reset begin
    forgetAllPermissionModes();
    // workaround:t3-composer/thread-permission-reset end
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
});
