// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComposerSelection, PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import type { PermissionMode } from "./permission-modes";
import { forgetAllPermissionModes, keptPermissionMode } from "./thread-permission-picks";

const ALL = ["accept-edits", "auto", "full"] as const;

/**
 * BB's thread composer as the picker sees it: the mode lives in the composer and resets to
 * the thread's last sent mode on a thread switch, and `setSelection` can refuse a mode.
 */
const bb = {
  threadId: "a" as string | null,
  /** Each thread's last sent mode, what BB's composer resets to. */
  defaults: new Map<string, PermissionMode>([
    ["a", "auto"],
    ["b", "auto"],
  ]),
  mode: "auto" as PermissionMode,
  ceiling: "full" as PermissionMode,
  /** Whether the machine has answered with its limit and the provider's modes. */
  machineKnown: true,
  /** Modes BB keeps the current mode in place of. */
  refuses: new Set<PermissionMode>(),
  /** Holds `setSelection` until the test lets it go. */
  hold: null as null | { release(): void },
  deleted: new Map<string, () => void>(),
  /** Reports an event appended to a thread, as BB's realtime feed does. */
  turns: new Map<string, (eventType: string) => void>(),
  calls: [] as ComposerSelection[],
  composer: null as PluginComposerApi | null,
  listeners: new Set<() => void>(),
};

function publish() {
  bb.composer = makeComposer();
  for (const listener of bb.listeners) listener();
}

function makeComposer(): PluginComposerApi {
  const threadId = bb.threadId;
  return {
    key: threadId === null ? "new-thread" : `thread:${threadId}`,
    scope:
      threadId === null ? { kind: "new-thread", projectId: "p" } : { kind: "thread", threadId },
    selection: { providerId: "claude-code", model: "opus", permissionMode: bb.mode },
    setSelection: async (requested: ComposerSelection) => {
      bb.calls.push(requested);
      if (bb.hold) {
        await new Promise<void>((resolve) => (bb.hold = { release: resolve }));
        bb.hold = null;
      }
      // A pick lands on the composer it was made in, never on the one opened since.
      if (bb.threadId === threadId && requested.permissionMode) {
        if (!bb.refuses.has(requested.permissionMode)) bb.mode = requested.permissionMode;
        publish();
      }
      return { providerId: "claude-code", model: "opus", permissionMode: bb.mode };
    },
  } as unknown as PluginComposerApi;
}

function openThread(threadId: string | null) {
  act(() => {
    bb.threadId = threadId;
    bb.mode = (threadId && bb.defaults.get(threadId)) || "auto";
    publish();
  });
}

function setCeiling(ceiling: PermissionMode) {
  act(() => {
    bb.ceiling = ceiling;
    publish();
  });
}

vi.mock("./composer-handle", () => ({
  usePickerComposer: () =>
    useSyncExternalStore(
      (listener) => {
        bb.listeners.add(listener);
        return () => bb.listeners.delete(listener);
      },
      () => bb.composer!,
    ),
}));

vi.mock("./model-picker/catalog", () => ({
  useCatalogRouting: () => "routing",
  usePermissionInfo: () =>
    bb.machineKnown
      ? { ceiling: bb.ceiling, provider: { name: "Claude Code", modes: ALL } }
      : undefined,
}));

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@get-bb/plugin-sdk/app")>()),
  useSdk: () => ({
    subscribe: (args: {
      threadId: string;
      callback(event: {
        changes: readonly string[];
        metadata?: { eventTypes?: readonly string[] };
      }): void;
    }) => {
      bb.deleted.set(args.threadId, () => args.callback({ changes: ["thread-deleted"] }));
      bb.turns.set(args.threadId, (eventType) =>
        args.callback({ changes: ["events-appended"], metadata: { eventTypes: [eventType] } }),
      );
      return () => {
        bb.deleted.delete(args.threadId);
        bb.turns.delete(args.threadId);
      };
    },
  }),
}));

const { ComposerPermissionControl } = await import("./ComposerPermissionControl");

function renderControl() {
  return render(
    <CompactViewportOverrideProvider isCompactViewport>
      <ComposerPermissionControl />
    </CompactViewportOverrideProvider>,
  );
}

function trigger() {
  return screen.getByRole("button", { name: "Permission mode" });
}

async function pick(name: RegExp) {
  fireEvent.click(trigger());
  fireEvent.click(await screen.findByRole("menuitemradio", { name }));
}

const REFUSED = "BB kept the current permission mode.";

describe("ComposerPermissionControl across threads", () => {
  beforeEach(() => {
    bb.threadId = "a";
    bb.defaults = new Map([
      ["a", "auto"],
      ["b", "auto"],
    ]);
    bb.mode = "auto";
    bb.ceiling = "full";
    bb.machineKnown = true;
    bb.refuses = new Set();
    bb.hold = null;
    bb.calls = [];
    bb.deleted = new Map();
    bb.turns = new Map();
    publish();
  });
  afterEach(() => {
    cleanup();
    forgetAllPermissionModes();
  });

  it("keeps a thread's pick when you open another thread and come back", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));

    openThread("b");
    await waitFor(() => expect(trigger().textContent).toContain("Approve for me"));
    openThread("a");
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
  });

  it("keeps the pick when the control mounts again for the thread", async () => {
    const first = renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
    first.unmount();

    openThread("b");
    const second = renderControl();
    await waitFor(() => expect(trigger().textContent).toContain("Approve for me"));
    second.unmount();

    openThread("a");
    renderControl();
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
  });

  it("restores once the machine answers after the switch", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));

    openThread("b");
    bb.machineKnown = false;
    openThread("a");
    expect(trigger().textContent).toContain("Approve for me");
    act(() => {
      bb.machineKnown = true;
      publish();
    });
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
  });

  it("starts a new thread at BB's default mode", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));

    openThread(null);
    await waitFor(() => expect(trigger().textContent).toContain("Approve for me"));
    expect(bb.calls).toEqual([{ permissionMode: "full" }]);
  });

  it("settles a kept pick under a machine limit lowered while away", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));

    openThread("b");
    setCeiling("accept-edits");
    openThread("a");
    await waitFor(() => expect(trigger().textContent).toContain("Accept Edits"));
  });

  it("does not revert a change made after the restore", async () => {
    renderControl();
    await pick(/Full Access/);
    openThread("b");
    openThread("a");
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));

    // Like BB's own cycle shortcut or a `#` keyword.
    await act(() => bb.composer!.setSelection({ permissionMode: "accept-edits" }));
    await waitFor(() => expect(trigger().textContent).toContain("Accept Edits"));
    expect(keptPermissionMode("a")).toBe("accept-edits");

    openThread("b");
    openThread("a");
    await waitFor(() => expect(trigger().textContent).toContain("Accept Edits"));
  });

  it("still restores a thread after a mode was refused on another", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));

    openThread("b");
    bb.refuses.add("full");
    await pick(/Full Access/);
    await screen.findByText(REFUSED);
    bb.refuses.clear();

    openThread("a");
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
  });

  it("leaves the mode to BB once a turn starts on the thread", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(keptPermissionMode("a")).toBe("full"));

    act(() => bb.turns.get("a")?.("item/agentMessage/delta"));
    expect(keptPermissionMode("a")).toBe("full");
    // Another client sends a turn with its own mode; BB now resets the thread to that one.
    act(() => bb.turns.get("a")?.("turn/started"));
    expect(keptPermissionMode("a")).toBeUndefined();
    bb.defaults.set("a", "accept-edits");
    openThread("b");
    openThread("a");
    await waitFor(() => expect(trigger().textContent).toContain("Accept Edits"));
  });

  it("forgets a thread's pick once BB deletes the thread", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(keptPermissionMode("a")).toBe("full"));

    act(() => bb.deleted.get("a")?.());
    expect(keptPermissionMode("a")).toBeUndefined();
  });
});

describe("ComposerPermissionControl's refusal message", () => {
  beforeEach(() => {
    bb.threadId = "a";
    bb.defaults = new Map([
      ["a", "auto"],
      ["b", "auto"],
    ]);
    bb.mode = "auto";
    bb.ceiling = "full";
    bb.machineKnown = true;
    bb.refuses = new Set(["full"]);
    bb.hold = null;
    bb.calls = [];
    publish();
  });
  afterEach(() => {
    cleanup();
    forgetAllPermissionModes();
  });

  it("clears once the mode changes", async () => {
    renderControl();
    await pick(/Full Access/);
    await screen.findByText(REFUSED);

    await act(() => bb.composer!.setSelection({ permissionMode: "accept-edits" }));
    await waitFor(() => expect(trigger().textContent).toContain("Accept Edits"));
    expect(screen.queryByText(REFUSED)).toBeNull();
  });

  it("keeps no pick BB refused", async () => {
    renderControl();
    await pick(/Full Access/);
    await screen.findByText(REFUSED);
    expect(keptPermissionMode("a")).toBeUndefined();
  });

  it("clears on a thread switch", async () => {
    renderControl();
    await pick(/Full Access/);
    await screen.findByText(REFUSED);

    openThread("b");
    expect(screen.queryByText(REFUSED)).toBeNull();
  });

  it("stays off the thread opened while the refused pick was pending", async () => {
    renderControl();
    bb.hold = { release() {} };
    await pick(/Full Access/);
    openThread("b");
    await act(async () => bb.hold?.release());
    await waitFor(() => expect(bb.calls).toHaveLength(1));
    expect(screen.queryByText(REFUSED)).toBeNull();
  });

  it("clears on the next pick", async () => {
    renderControl();
    await pick(/Full Access/);
    await screen.findByText(REFUSED);

    bb.hold = { release() {} };
    await pick(/Accept Edits/);
    expect(screen.queryByText(REFUSED)).toBeNull();
    await act(async () => bb.hold?.release());
  });

  it("does not come back when the mode returns to the refused value", async () => {
    renderControl();
    await pick(/Full Access/);
    await screen.findByText(REFUSED);

    await act(() => bb.composer!.setSelection({ permissionMode: "accept-edits" }));
    await act(() => bb.composer!.setSelection({ permissionMode: "auto" }));
    await waitFor(() => expect(trigger().textContent).toContain("Approve for me"));
    expect(screen.queryByText(REFUSED)).toBeNull();
  });
});
