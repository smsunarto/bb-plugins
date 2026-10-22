import type { BbPluginApi } from "@get-bb/plugin-sdk";

const PAGE = 100;
const MAX_ROWS = 2000;
const LIVE = new Set(["starting", "running", "disconnected"]);

async function pages<T>(read: (offset: number) => Promise<T[]>): Promise<T[]> {
  const result: T[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const page = await read(offset);
    result.push(...page);
    if (page.length < PAGE) return result;
  }
  throw new Error("Too many records to establish idleness; automatic stop is deferred.");
}

// Public terminal list scopes are disjoint: host_path omits thread and environment terminals.
export async function busyReason(
  bb: BbPluginApi,
  hostId: string,
  signal: AbortSignal,
): Promise<string | null> {
  // Counts include admitted starts that may not have an environment/list row yet.
  const counts = await Promise.all(
    (["active", "starting", "stopping", "pending"] as const).map((status) =>
      bb.sdk.threads.count({ hostId, status, signal }),
    ),
  );
  if (counts.some((count) => count.total > 0)) return "Agent work is running or starting";
  const environments = await pages((offset) =>
    bb.sdk.environments.list({ hostId, limit: PAGE, offset, signal }),
  );
  if (
    environments.some(
      (env) =>
        env.status === "provisioning" || ["teardown", "retiring"].includes(env.lifecycle.phase),
    )
  )
    return "Environment setup or cleanup is running";
  const threads = await pages((offset) =>
    bb.sdk.threads.list({
      hostId,
      archived: false,
      includeHidden: true,
      limit: PAGE,
      offset,
      signal,
    }),
  );
  if (
    threads.some(
      (thread) =>
        Object.values(thread.activity).some((count) => count > 0) ||
        thread.queuedWork === "waiting" ||
        !["idle", "error"].includes(thread.runtime.displayStatus),
    )
  )
    return "Agent work is running or queued";
  const archived = await pages((offset) =>
    bb.sdk.threads.list({
      hostId,
      archived: true,
      includeHidden: true,
      limit: PAGE,
      offset,
      signal,
    }),
  );
  const scopes: Parameters<typeof bb.sdk.terminals.list>[0]["scope"][] = [
    { kind: "host_path", hostId },
    ...environments
      .filter((env) => env.status !== "destroyed")
      .map((env) => ({ kind: "environment" as const, environmentId: env.id })),
    ...[...threads, ...archived].map((thread) => ({
      kind: "thread" as const,
      threadId: thread.id,
    })),
  ];
  // Bound host reads; one slow/missing result prevents a stop instead of implying idle.
  for (let i = 0; i < scopes.length; i += 8) {
    const results = await Promise.all(
      scopes.slice(i, i + 8).map((scope) => bb.sdk.terminals.list({ scope, signal })),
    );
    if (results.some((result) => result.sessions.some((terminal) => LIVE.has(terminal.status))))
      return "A terminal session is open";
  }
  return null;
}
