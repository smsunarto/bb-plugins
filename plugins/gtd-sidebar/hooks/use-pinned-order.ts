import { useCallback, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { gtdSidebarRpcContract } from "@/server";
import { useLifecycleChannelList } from "@/hooks/use-lifecycle-channel-list";

export interface PinnedOrderApi {
  /** bb's `pinSortKey` for the thread; null while unpinned or not yet loaded. */
  pinOrderKeyFor(thread: PluginSidebarThread): string | null;
}

/** Two pin orderings are the same when every pinned thread kept its key. */
export function pinOrdersMatch(
  current: ReadonlyMap<string, string | null>,
  pins: readonly { threadId: string; pinSortKey: string | null }[],
): boolean {
  if (current.size !== pins.length) return false;
  return pins.every((pin) => current.get(pin.threadId) === pin.pinSortKey);
}

/**
 * bb's pinned order for the Pinned shelf — the same one the built-in
 * sidebar drags by, so a move made over there lands in the same place here.
 *
 * `pinSortKey` never reaches the frontend: the host's sidebar thread
 * mapping drops it. The shelf re-reads it off bb's thread table through the
 * plugin backend instead, on the same `lifecycle` channel the snooze rows
 * use — the backend publishes there on every `pin-state-changed` (a pin, an
 * unpin, and a `reorderPinned`).
 */
export function usePinnedOrder(): PinnedOrderApi {
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const [pins, setPins] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  useLifecycleChannelList(
    useCallback(() => rpc.call("listPinnedOrder", {}), [rpc]),
    useCallback((result) => {
      setPins((current) =>
        pinOrdersMatch(current, result.pins)
          ? current
          : new Map(result.pins.map((pin) => [pin.threadId, pin.pinSortKey])),
      );
    }, []),
  );

  return useMemo(() => ({ pinOrderKeyFor: (thread) => pins.get(thread.id) ?? null }), [pins]);
}
