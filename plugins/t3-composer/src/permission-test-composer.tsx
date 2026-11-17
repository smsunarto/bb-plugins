/**
 * Test support for the permission picker: BB's thread composer as the picker sees it, with
 * the mode in the composer, reset to the thread's last sent mode on a thread switch.
 */
import { useSyncExternalStore } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComposerSelection, PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import type { PermissionMode } from "./permission-modes";
import type { ComponentType } from "react";

const ALL = ["accept-edits", "auto", "full"] as const;

type ConnectionState = "disconnected" | "connecting" | "connected";

/**
 * BB's thread composer as the picker sees it: the mode lives in the composer and resets to
 * the thread's last sent mode on a thread switch, and `setSelection` can refuse a mode.
 */
export const bb = {
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
  /** Reports BB's realtime connection state, while anything watches it. */
  connection: null as null | ((state: ConnectionState) => void),
  connectionState: "connected" as ConnectionState,
  calls: [] as ComposerSelection[],
  composer: null as PluginComposerApi | null,
  listeners: new Set<() => void>(),
};

export function publish() {
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

export function openThread(threadId: string | null) {
  act(() => {
    bb.threadId = threadId;
    bb.mode = (threadId && bb.defaults.get(threadId)) || "auto";
    publish();
  });
}

export function setCeiling(ceiling: PermissionMode) {
  act(() => {
    bb.ceiling = ceiling;
    publish();
  });
}

/** Stand-ins for the picker's hooks, for `vi.mock` factories. */
export const composerHandleMock = {
  usePickerComposer: () =>
    useSyncExternalStore(
      (listener) => {
        bb.listeners.add(listener);
        return () => bb.listeners.delete(listener);
      },
      () => bb.composer!,
    ),
};

export const catalogMock = {
  useCatalogRouting: () => "routing",
  usePermissionInfo: () =>
    bb.machineKnown
      ? { ceiling: bb.ceiling, provider: { name: "Claude Code", modes: ALL } }
      : undefined,
};

/** `useSdk()` with BB's realtime feed, which tests drive through `bb.deleted` and `bb.turns`. */
export function fakeSdk() {
  return {
    subscribe: (args: { event: string; threadId?: string; callback(event: unknown): void }) => {
      if (args.event === "realtime:connection") {
        const report = (state: ConnectionState) => {
          bb.connectionState = state;
          args.callback({ state, reconnected: state !== "disconnected", reconnectDelayMs: null });
        };
        bb.connection = report;
        // BB replays its last connection state to a new listener.
        queueMicrotask(() => report(bb.connectionState));
        return () => (bb.connection = null);
      }
      const threadId = args.threadId!;
      bb.deleted.set(threadId, () => args.callback({ changes: ["thread-deleted"] }));
      bb.turns.set(threadId, (eventType) =>
        args.callback({ changes: ["events-appended"], metadata: { eventTypes: [eventType] } }),
      );
      return () => {
        bb.deleted.delete(threadId);
        bb.turns.delete(threadId);
      };
    },
  };
}

/** Thread A open at Approve for me, thread B beside it, every mode allowed. */
export function resetFakeComposer(refuses: readonly PermissionMode[] = []) {
  bb.threadId = "a";
  bb.defaults = new Map([
    ["a", "auto"],
    ["b", "auto"],
  ]);
  bb.mode = "auto";
  bb.ceiling = "full";
  bb.machineKnown = true;
  bb.refuses = new Set(refuses);
  bb.hold = null;
  bb.calls = [];
  bb.deleted = new Map();
  bb.turns = new Map();
  bb.connectionState = "connected";
  publish();
}

let Control: ComponentType | null = null;

/**
 * Sets the picker `renderControl` mounts. The test imports it after its `vi.mock` calls, since
 * those factories import this module.
 */
export function setControl(component: ComponentType) {
  Control = component;
}

export function renderControl() {
  if (!Control) throw new Error("Call setControl first");
  return render(
    <CompactViewportOverrideProvider isCompactViewport>
      <Control />
    </CompactViewportOverrideProvider>,
  );
}

export function trigger() {
  return screen.getByRole("button", { name: "Permission mode" });
}

export async function pick(name: RegExp) {
  fireEvent.click(trigger());
  fireEvent.click(await screen.findByRole("menuitemradio", { name }));
}
