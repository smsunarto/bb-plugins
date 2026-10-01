import type { ReviewApiClient } from "../vendor/review-protocol/src/index.ts";
import type { ApiRequest, ApiResponse, InfoInput, InfoOutput } from "./api-tunnel.ts";
import type { SettingsPayload } from "./channels.ts";

/**
 * Server-side seams between work packages (design §1, §3.1, §3.4, §3.10).
 * Server-only by use; it holds types alone, so the app may import it.
 */

/** Who is driving the current request. Present means `desktopAvailable` (design §3.7). */
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

/** The single in-process engine behind the tunnel, the tools and the CLI. */
export interface Engine {
  /** Run one tunnel request through Hono (design §3.2). Never throws for HTTP errors. */
  request(input: ApiRequest): Promise<ApiResponse>;
  /** The `info` RPC. */
  info(input: InfoInput): Promise<InfoOutput>;
  /** A loopback `ReviewApiClient` whose transport is the in-process Hono app. */
  client(): ReviewApiClient;
  /** Run `fn` with a ThreadContext when `context.threadId` is set. */
  withThread<T>(context: ThreadContextInput, fn: () => Promise<T>): Promise<T>;
  /** Idempotent. The plugin's single `bb.onDispose` hook calls it (design §1.7). */
  dispose(): Promise<void>;
}

/** Repository to bb host routing (design §3.1). */
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

/** Plugin settings (design §3.4). `traceEnabled` is a constant false, not a setting (Q2). */
export interface WhiteboardSettings {
  scratchpadEnabled(): boolean;
  softwareMapEnabled(): boolean;
  /** Called after a change is applied. Returns an unsubscribe. */
  subscribe(listener: (next: SettingsPayload, previous: SettingsPayload) => void): () => void;
}

/** bb-kit services: built once per load in `server.ts`. */
export type WhiteboardServices = {
  settings: WhiteboardSettings;
  engine: Engine;
};

/** The `open` callback `createReviewApi` receives (design §3.6). */
export type OpenPanel = (review: {
  reviewId: string;
  title: string;
}) => Promise<{ softwareMapEnabled: boolean }>;
