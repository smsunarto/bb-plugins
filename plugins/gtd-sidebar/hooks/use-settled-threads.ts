import { useCallback, useEffect } from "react";
import { useSdk, type PluginSidebarThreadsState } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { needsOlderArchivePage } from "../lib/settled-threads";

/**
 * Keeps the host's archive paged far enough back to cover the Settled window.
 *
 * bb pages its archive newest first, so the effect asks for one more page
 * whenever every archive it has seen is still on the shelf. The page arrives
 * through the same `experimental_useSidebarThreads` list, which re-runs this
 * until an archive older than the window turns up.
 */
export function useSettledArchivePaging(
  sidebar: Pick<PluginSidebarThreadsState, "experimental_archived" | "threads">,
  now: number,
): void {
  const archived = sidebar.experimental_archived;
  const needsPage = needsOlderArchivePage(sidebar.threads, archived, now);
  useEffect(() => {
    if (!needsPage || archived === null) return;
    void archived.fetchNextPage().catch(() => undefined);
  }, [archived, needsPage]);
}

/**
 * bb's unarchive, made from a Settled row. No read after the mutation: the
 * host's own thread feed moves the row back to its active shelf.
 */
export function useUnsettle(): (threadId: string) => void {
  const sdk = useSdk();
  return useCallback(
    (threadId: string) => {
      // Unarchiving reaches the thread's host, which can be offline. The row
      // stays on the shelf, which is where the thread still is.
      void sdk.threads.unarchive({ threadId }).then(
        () => undefined,
        (error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Couldn’t restore the thread.");
          return undefined;
        },
      );
    },
    [sdk],
  );
}
