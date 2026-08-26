import { useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { gtdSidebarRpcContract } from "@/server";
import { threadDisplayTitle } from "@/lib/inbox";
import { resolveSidebarBranchLabel } from "@/lib/gitbutler";
import type { SidebarPullRequest } from "@/lib/pr-index";

const PR_INDEX_REFRESH_MS = 2 * 60_000;

export function useThreadPullRequests(
  threads: readonly PluginSidebarThread[],
  gitButlerLabels: ReadonlyMap<string, string>,
): ReadonlyMap<string, SidebarPullRequest> {
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const [byThreadId, setByThreadId] = useState<ReadonlyMap<string, SidebarPullRequest>>(
    () => new Map(),
  );

  const payload = useMemo(
    () =>
      threads.slice(0, 100).map((thread) => ({
        threadId: thread.id,
        environmentId: thread.environment?.id ?? null,
        branchName: resolveSidebarBranchLabel(
          thread.environment?.branchName ?? null,
          thread.environment?.id ?? null,
          gitButlerLabels,
        ),
        title: threadDisplayTitle(thread),
      })),
    [gitButlerLabels, threads],
  );
  const payloadKey = useMemo(
    () =>
      payload
        .map(
          (row) =>
            `${row.threadId}:${row.environmentId ?? ""}:${row.branchName ?? ""}:${row.title}`,
        )
        .join("\n"),
    [payload],
  );

  const payloadRef = useRef(payload);
  payloadRef.current = payload;

  useEffect(() => {
    const current = payloadRef.current;
    if (current.length === 0) {
      setByThreadId(new Map());
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const result = await rpc.call("listThreadPullRequests", {
          threads: payloadRef.current,
        });
        if (cancelled) return;
        setByThreadId(
          new Map(
            result.pullRequests.map((row) => [
              row.threadId,
              {
                number: row.number,
                title: row.title,
                url: row.url,
                state: row.state as SidebarPullRequest["state"],
                attention: row.attention,
                source: row.source,
              },
            ]),
          ),
        );
      } catch {
        // Keep the last index. A failed tick must not blank badges that were
        // already on screen.
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), PR_INDEX_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [payloadKey, rpc]);

  return byThreadId;
}
