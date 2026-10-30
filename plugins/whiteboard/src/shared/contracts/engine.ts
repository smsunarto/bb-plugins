import type { ReviewApi } from "../../server/lib/review/api.ts";
import type { SettingsPayload } from "./channels.ts";
import type { InfoInput, InfoOutput, PendingOpen } from "./rpc.ts";

/**
 * Server-side seams between the engine, its RPC handlers and the agent tools.
 * Server-only by use; it holds types alone.
 */

/** Who is driving the current request. Present means `desktopAvailable`. */
export type ThreadContext = {
  threadId: string;
  projectId?: string;
  /** The thread environment's host, resolved lazily and cached here. */
  hostId?: string;
  signal?: AbortSignal;
};

/** What a caller knows when it enters the engine. No thread means no ThreadContext. */
export type ThreadContextInput = {
  threadId?: string;
  projectId?: string;
  signal?: AbortSignal;
};

/** The single in-process engine behind the RPC methods, the tools and the CLI. */
export interface Engine {
  /** Whiteboard's operations. Call them inside `run`, which supplies their thread context. */
  api: ReviewApi;
  /**
   * Run `fn` as the caller: with its thread context, after settings load, and
   * refused once the plugin is disposing. `fn` gets one signal that aborts on
   * dispose, thread abort or the caller's own signal; dispose waits for
   * every running `fn` before closing the store.
   */
  run<T>(context: ThreadContextInput, fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** The `info` RPC. A thread panel showing a session also records its tab. */
  info(input: InfoInput): Promise<InfoOutput>;
  /** The `claimOpen` RPC: forget opens up to `after`, and read a newer waiting one. */
  claimOpen(threadId: string, after?: number): Promise<PendingOpen | null>;
  /** Refresh worktree sources every second until the returned release; held per watched read. */
  watchWorktrees(): () => void;
  /** Idempotent. The plugin's single `bb.onDispose` hook calls it. */
  dispose(): Promise<void>;
}

/** Repository to bb host routing. */
export interface HostResolver {
  /**
   * Always answers a hostId, in order: the repository's `repository_hosts` row,
   * the calling thread's environment host, the single connected persistent host.
   * Otherwise throws `ReviewInputError(..., 409)`.
   */
  hostFor(target: { repositoryId?: string; rootPath?: string }): Promise<string>;
  /** Record the host that registered a repository. A path bound to another host throws 409. */
  bindRepository(
    repository: { repositoryId: string; rootPath: string },
    hostId: string,
  ): Promise<void>;
}

/** Plugin settings. */
export interface WhiteboardSettings {
  scratchpadEnabled(): boolean;
  softwareMapEnabled(): boolean;
  /** Called after a change is applied. Returns an unsubscribe. */
  subscribe(listener: (next: SettingsPayload, previous: SettingsPayload) => void): () => void;
}

/** Plugin services: built once per load in `server.ts`. */
export type WhiteboardServices = {
  settings: WhiteboardSettings;
  engine: Engine;
};

/** The `open` callback `createReviewApi` receives. */
export type OpenPanel = (review: {
  reviewId: string;
  title: string;
}) => Promise<{ softwareMapEnabled: boolean }>;
