import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { sourceControlHostContract } from "../contract/host.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { execGh } from "../forge/exec-gh.ts";
import type { Exec } from "../forge/github.ts";
import { createForgeSites, FORGE_DEADLINE_MS } from "./forge-sites.ts";
import { openStore } from "./store.ts";
import { createThreadChanges } from "./thread-changes.ts";

export type SourceControlDeps = { serverExec: Exec; now: () => number };

/** The plugin with its outside world injected, for tests. */
export function createSourceControl(deps: SourceControlDeps) {
  return async function plugin(bb: BbPluginApi): Promise<void> {
    const lifecycle = new AbortController();
    bb.onDispose(() => lifecycle.abort());
    const host = bb.hosts.experimental_client({ contract: sourceControlHostContract });
    const sites = createForgeSites({
      serverExec: deps.serverExec,
      now: deps.now,
      host: {
        accounts: (hostId, signal) =>
          host.call("forgeAccounts", {}, { hostId, signal, timeoutMs: FORGE_DEADLINE_MS }),
        pullRequest: (hostId, query, signal) =>
          host.call(
            "forgeCall",
            { op: "pr.read", ...query },
            { hostId, signal, timeoutMs: FORGE_DEADLINE_MS },
          ),
      },
    });
    const changes = createThreadChanges({
      bb,
      store: openStore(bb),
      sites,
      now: deps.now,
      lifecycle: lifecycle.signal,
      workspace: (hostId, path, options) =>
        host.call("workspace", { path }, { hostId, ...options }),
    });

    bb.rpc.register(
      sourceControlContract,
      {
        changeForThread: ({ keys }) => changes.read(keys),
        refreshThread: async ({ threadId }) => {
          await changes.retry(threadId);
          return { ok: true as const };
        },
      },
      { experimental_discoverable: true },
    );
    bb.rpc.experimental_whileWatched("changeForThread", (read, signal) => {
      return "key" in read ? changes.watch(read.key, signal) : undefined;
    });
  };
}

export default createSourceControl({ serverExec: execGh, now: Date.now });
