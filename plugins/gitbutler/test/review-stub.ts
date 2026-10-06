import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * A parent thread on a ready environment, a host that resolves repositories
 * like the real one (an omitted key is the first repository), real KV
 * semantics, and children whose status the test sets.
 */
export function reviewContext(options: { environment?: unknown } = {}) {
  const spawned: Record<string, unknown>[] = [];
  const hostInputs: unknown[] = [];
  const kv = new Map<string, unknown>();
  const children = new Map<string, { status: string; archivedAt: number | null }>();
  const parent = {
    id: "t1",
    projectId: "p1",
    environmentId: "env-1",
    providerId: "claude-code",
    environment:
      options.environment === undefined
        ? { hostId: "host-1", path: "/work", status: "ready" }
        : options.environment,
  };
  const bb = {
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId === "t1") return parent;
          const child = children.get(threadId);
          if (!child) throw new Error("Thread not found");
          return { id: threadId, deletedAt: null, ...child };
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
        call: async (_method: string, input: { repositoryKey?: string }) => {
          hostInputs.push(input);
          const key = input.repositoryKey ?? "repos/api";
          return { key, path: `/work/${key}` };
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
  return { ctx: { bb } as never, spawned, hostInputs, children };
}
