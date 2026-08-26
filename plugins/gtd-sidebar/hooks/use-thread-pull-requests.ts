import { useEffect, useMemo, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { gtdSidebarRpcContract } from "@/server";
import { PR_INDEX_CHANNEL } from "@/lib/channels";
import { threadDisplayTitle } from "@/lib/inbox";
import { resolveSidebarBranchLabel } from "@/lib/gitbutler";
import type { SidebarPullRequest } from "@/lib/pr-index";

function branchNamesFor(
  thread: PluginSidebarThread,
  gitButlerLabels: ReadonlyMap<string, string>,
): string[] {
  const raw = thread.environment?.branchName?.trim() ?? "";
  const label =
    resolveSidebarBranchLabel(
      thread.environment?.branchName ?? null,
      thread.environment?.id ?? null,
      gitButlerLabels,
    )?.trim() ?? "";
  const names: string[] = [];
  if (raw.length > 0) names.push(raw);
  if (label.length > 0 && label !== raw) names.push(label);
  return names;
}

interface IndexRow {
  environmentId: string;
  number: number;
  title: string;
  url: string;
  state: string;
  attention: string;
}

function asIndexRow(value: unknown): IndexRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.environmentId !== "string") return null;
  if (typeof record.number !== "number" || typeof record.title !== "string") return null;
  if (typeof record.url !== "string" || typeof record.state !== "string") return null;
  if (typeof record.attention !== "string") return null;
  return {
    environmentId: record.environmentId,
    number: record.number,
    title: record.title,
    url: record.url,
    state: record.state,
    attention: record.attention,
  };
}

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
        branchName: thread.environment?.branchName ?? null,
        branchNames: branchNamesFor(thread, gitButlerLabels),
        title: threadDisplayTitle(thread),
      })),
    [gitButlerLabels, threads],
  );
  const payloadKey = useMemo(
    () =>
      payload
        .map(
          (row) =>
            `${row.threadId}:${row.environmentId ?? ""}:${row.branchName ?? ""}:${row.branchNames.join(",")}:${row.title}`,
        )
        .join("\n"),
    [payload],
  );

  const payloadRef = useRef(payload);
  payloadRef.current = payload;

  const refresh = useRef<() => Promise<void>>(async () => {});
  refresh.current = async () => {
    const current = payloadRef.current;
    if (current.length === 0) {
      setByThreadId(new Map());
      return;
    }
    try {
      const result = await rpc.call("listThreadPullRequests", {
        threads: current,
      });
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
      // Keep the last index. A failed hydrate must not blank badges.
    }
  };

  useEffect(() => {
    let cancelled = false;
    void refresh.current();
    // Reconcile rarely: GitHub webhooks drive live colour, but delivery can
    // miss (bb connect is session-gated, so hooks may not be registered).
    const timer = setInterval(() => {
      if (!cancelled) void refresh.current();
    }, 10 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [payloadKey, rpc]);

  useRealtime(PR_INDEX_CHANNEL, (payloadValue) => {
    if (typeof payloadValue !== "object" || payloadValue === null || Array.isArray(payloadValue)) {
      void refresh.current();
      return;
    }
    const record = payloadValue as Record<string, unknown>;
    if (record.refresh === true) {
      void refresh.current();
      return;
    }
    if (!Array.isArray(record.rows)) {
      void refresh.current();
      return;
    }
    const rows = record.rows.flatMap((entry) => {
      const row = asIndexRow(entry);
      return row === null ? [] : [row];
    });
    if (rows.length === 0) return;
    const byEnv = new Map(rows.map((row) => [row.environmentId, row]));
    setByThreadId((prev) => {
      const next = new Map(prev);
      for (const thread of payloadRef.current) {
        if (thread.environmentId === null) continue;
        const row = byEnv.get(thread.environmentId);
        if (row === undefined) continue;
        next.set(thread.threadId, {
          number: row.number,
          title: row.title,
          url: row.url,
          state: row.state as SidebarPullRequest["state"],
          attention: row.attention,
          source: "rest",
        });
      }
      return next;
    });
  });

  const connectionState = useRealtimeConnectionState();
  const seenConnected = useRef(false);
  useEffect(() => {
    if (connectionState !== "connected") return;
    if (!seenConnected.current) {
      seenConnected.current = true;
      return;
    }
    void refresh.current();
  }, [connectionState]);

  return byThreadId;
}
