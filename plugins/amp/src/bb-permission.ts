import {
  permissionModeFromBb,
  type AmpPermissionMode,
} from "./permission-mode.ts";

const EVENT_PAGE_SIZE = 1_000;

export interface BbPermissionOptions {
  serverUrl?: string;
  threadId?: string;
  fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read the resolved permission from bb's authoritative thread event stream. */
export async function readBbPermissionMode(
  options: BbPermissionOptions = {},
): Promise<AmpPermissionMode> {
  const serverUrl = options.serverUrl ?? process.env.BB_SERVER_URL;
  const threadId = options.threadId ?? process.env.BB_THREAD_ID;
  if (!serverUrl || !threadId) return "default";

  const eventsUrl = new URL(
    `/api/v1/threads/${encodeURIComponent(threadId)}/events`,
    serverUrl,
  );
  const fetchFn = options.fetch ?? fetch;
  let cursor = 0;
  let permissionMode: AmpPermissionMode = "default";

  for (;;) {
    const url = new URL(eventsUrl);
    url.searchParams.set("afterSeq", String(cursor));
    url.searchParams.set("limit", String(EVENT_PAGE_SIZE));
    const response = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`bb returned ${response.status} ${response.statusText}`);
    }
    const value: unknown = await response.json();
    if (!Array.isArray(value) || value.length === 0) return permissionMode;

    let nextCursor = cursor;
    for (const event of value) {
      if (!isRecord(event) || !Number.isInteger(event.seq)) continue;
      nextCursor = Math.max(nextCursor, event.seq as number);
      if (event.type !== "client/turn/requested" || !isRecord(event.data)) continue;
      const execution = event.data.execution;
      if (!isRecord(execution)) continue;
      permissionMode = permissionModeFromBb(execution.permissionMode) ?? permissionMode;
    }
    if (value.length < EVENT_PAGE_SIZE || nextCursor === cursor) return permissionMode;
    cursor = nextCursor;
  }
}
