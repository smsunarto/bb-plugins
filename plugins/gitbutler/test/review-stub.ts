import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Parent threads on a ready environment, a host that resolves repositories
 * like the real one (an omitted key is the first repository), real KV
 * semantics, and children whose status the test sets.
 */
export function reviewContext(
  options: {
    environment?: unknown;
    /** Runs as the host resolves a repository, as a move mid-request would. */
    onLocate?: () => void;
  } = {},
) {
  const spawned: Record<string, unknown>[] = [];
  const sent: Record<string, unknown>[] = [];
  const hostInputs: unknown[] = [];
  const hostMethods: string[] = [];
  const kv = new Map<string, unknown>();
  const children = new Map<
    string,
    { status: string; archivedAt: number | null; queuedMessageCount?: number }
  >();
  /** Thread lookups that fail with this HTTP status, as a server hiccup would. */
  const lookupFailures = new Map<string, number>();
  const parent = {
    id: "t1",
    projectId: "p1",
    environmentId: "env-1",
    providerId: "claude-code",
    environment:
      options.environment === undefined
        ? { id: "env-1", hostId: "host-1", path: "/work", status: "ready" }
        : options.environment,
  };
  const bb = {
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          // t2 is another thread on the same environment, as local threads share one.
          if (threadId === "t1" || threadId === "t2") return { ...parent, id: threadId };
          const failure = lookupFailures.get(threadId);
          if (failure) throw Object.assign(new Error(`HTTP ${failure}`), { status: failure });
          const child = children.get(threadId);
          // bb answers a deleted thread the way the SDK's BbHttpError reports it.
          if (!child) throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 });
          return { id: threadId, deletedAt: null, queuedMessageCount: 0, ...child };
        },
        send: async (args: { threadId: string } & Record<string, unknown>) => {
          sent.push(args);
          children.set(args.threadId, { status: "active", archivedAt: null });
          return {};
        },
        spawn: async (args: Record<string, unknown>) => {
          spawned.push(args);
          const id = `child-${spawned.length}`;
          children.set(id, { status: "active", archivedAt: null });
          return { id };
        },
      },
    },
    hosts: {
      experimental_client: () => ({
        call: async (
          method: string,
          input: { environmentPath: string; repositoryKey?: string },
        ) => {
          hostInputs.push(input);
          hostMethods.push(method);
          options.onLocate?.();
          const key = input.repositoryKey ?? "repos/api";
          const root = input.environmentPath;
          const path = key === "." ? root : `${root}/${key}`;
          if (method === "checkoutIdentity")
            return {
              key,
              identity: {
                path,
                branch: "gitbutler/workspace",
                head: "a".repeat(40),
                origin: "github.com/acme/api",
                commonDir: `${path}/.git`,
                kind: "gitbutler",
              },
            };
          if (method === "workspace") throw new Error("The full workspace read is unavailable.");
          return { key, path };
        },
      }),
    },
    storage: {
      kv: {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => void kv.set(key, value),
      },
    },
  } as unknown as BbPluginApi;
  /** Moves the parent threads to another environment, on another host. */
  const move = () => {
    parent.environmentId = "env-2";
    parent.environment = { id: "env-2", hostId: "host-2", path: "/other", status: "ready" };
  };
  return {
    ctx: { bb } as never,
    spawned,
    sent,
    hostInputs,
    hostMethods,
    children,
    lookupFailures,
    move,
  };
}
