import { z } from "zod";

/**
 * The bb-kit RPC tunnel between the panel and the in-process Hono app
 * (design §3.2). `path` is relative to `/reviews-api` and includes the query.
 */
export const API_ORIGIN = "http://whiteboard.local";
export const API_PREFIX = "/reviews-api";
/** Non-watch NDJSON routes are collected whole up to this size, then answer 413. */
export const NDJSON_COLLECT_LIMIT_BYTES = 8 * 1024 * 1024;

export const apiRequest = z.strictObject({
  method: z.enum(["GET", "POST"]),
  path: z
    .string()
    .regex(/^\/[^\s]*$/)
    .max(8192),
  /** JSON text for POST. */
  body: z
    .string()
    .max(32 * 1024 * 1024)
    .optional(),
  /** The panel's thread. Sets the request's ThreadContext. */
  threadId: z.string().optional(),
});
export type ApiRequest = z.infer<typeof apiRequest>;

export const apiResponse = z.object({
  status: z.number().int(),
  contentType: z.string(),
  /** base64 for image/* resources. */
  encoding: z.enum(["utf8", "base64"]),
  body: z.string(),
});
export type ApiResponse = z.infer<typeof apiResponse>;

export const infoInput = z.strictObject({
  threadId: z.string().optional(),
  sessionId: z.string().optional(),
});
export type InfoInput = z.infer<typeof infoInput>;

export const infoOutput = z.object({
  appVersion: z.string(),
  softwareMapEnabled: z.boolean(),
  scratchpadEnabled: z.boolean(),
  /** diffr found on the session's (or thread's) host. */
  structuralDiffEnabled: z.boolean(),
});
export type InfoOutput = z.infer<typeof infoOutput>;

/** A mounted panel renews the engine's worktree interest lease this often (`interest`)... */
export const WATCH_HEARTBEAT_MS = 30_000;
/** ...and the engine lets the lease lapse this long after the last renewal or watch read. */
export const UI_INTEREST_TTL_MS = 90_000;

/** `interest` answers nothing; the call is the renewal. */
export const interestOutput = z.object({});

/** How long an agent's open waits for a client of its thread to focus the tab. */
export const PENDING_OPEN_TTL_MS = 5 * 60_000;

/**
 * Read the focus an agent's open left for a thread (design §3.6). `after` is
 * the newest open the client focused there: the server forgets opens up to
 * it, so each focuses once, and answers only a newer one.
 */
export const claimOpenInput = z.strictObject({
  threadId: z.string().min(1),
  after: z.number().optional(),
});
export const claimOpenOutput = z.object({
  /**
   * Null when no newer open is waiting, it is older than 5 minutes, or its tab
   * was closed. `at` orders opens per thread, as `whiteboard:open` does.
   */
  open: z.object({ sessionId: z.string(), title: z.string(), at: z.number() }).nullable(),
});
export type PendingOpen = NonNullable<z.infer<typeof claimOpenOutput>["open"]>;

/** `/watch` and `/:id/watch` answer one snapshot line per tunnel call (design §1.3). */
export function isWatchPath(path: string): boolean {
  const pathname = path.split("?", 1)[0] ?? path;
  return pathname === "/watch" || /^\/[^/]+\/watch$/.test(pathname);
}

/**
 * Resolves a session file to the live file bb opens in its file opener (the
 * builtin File Editor, design §0.1). `target` is null when the file has no
 * live copy (commit or retained sources), so the panel keeps it in-panel.
 */
export const liveFileInput = z.strictObject({
  sessionId: z.string().min(1),
  version: z.number().int().nonnegative().optional(),
  generation: z.string().min(1).optional(),
  path: z.string().min(1).max(4096),
  repositoryId: z.string().optional(),
  head: z.string().optional(),
  base: z.string().optional(),
});
export type LiveFileInput = z.infer<typeof liveFileInput>;

export const liveFileOutput = z.object({
  target: z.object({ kind: z.literal("host"), hostId: z.string(), path: z.string() }).nullable(),
});
export type LiveFileOutput = z.infer<typeof liveFileOutput>;
