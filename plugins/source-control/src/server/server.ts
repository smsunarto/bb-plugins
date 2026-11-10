import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  ACTION_DEADLINE_MS,
  sourceControlHostContract,
  sourceControlHostSignals,
} from "../contract/host.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { execGh } from "../forge/exec-gh.ts";
import type { Exec } from "../forge/github.ts";
import { createForgeSites, FORGE_DEADLINE_MS } from "./forge-sites.ts";
import { openStore } from "./store.ts";
import { createThreadBranches } from "./thread-branches.ts";
import { createThreadChanges } from "./thread-changes.ts";

export type SourceControlDeps = {
  serverExec: Exec;
  now: () => number;
  /** How long a write may run on the host. */
  actionDeadlineMs?: number;
  /** How long a host read may take before the host counts as offline. */
  hostDeadlineMs?: number;
};

/** The plugin with its outside world injected, for tests. */
export function createSourceControl(deps: SourceControlDeps) {
  return async function plugin(bb: BbPluginApi): Promise<void> {
    const lifecycle = new AbortController();
    bb.onDispose(() => lifecycle.abort());
    const host = bb.hosts.experimental_client({
      contract: sourceControlHostContract,
      experimental_signals: sourceControlHostSignals,
    });
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
      actionDeadlineMs: deps.actionDeadlineMs ?? ACTION_DEADLINE_MS,
      ...(deps.hostDeadlineMs === undefined ? {} : { hostDeadlineMs: deps.hostDeadlineMs }),
      // A branch a background recheck changed reaches the thread's watchers.
      branches: createThreadBranches(bb, (threadId) => void changes.branchMayHaveChanged(threadId)),
      host: {
        workspace: (hostId, input, options) =>
          host.call("workspace", input, { hostId, ...options }),
        renewWatch: (hostId, path, options) =>
          host.call("renewWatch", { path }, { hostId, ...options }),
        vcsAction: (hostId, input, options) =>
          host.call("vcsAction", input, { hostId, ...options }),
        patches: (hostId, input, options) => host.call("patches", input, { hostId, ...options }),
      },
    });

    bb.rpc.register(
      sourceControlContract,
      {
        changeForThread: ({ keys }) => changes.read(keys),
        refreshThread: async ({ threadId }) => {
          await changes.retry(threadId);
          return { ok: true as const };
        },
        patches: ({ threadId, source }, context) =>
          changes.patches(threadId, source, context.experimental_signal),
        vcsAction: ({ threadId, action, expected }) => changes.act(threadId, action, expected),
        setReadAs: async ({ threadId, readAs }) => {
          await changes.setReadAs(threadId, readAs);
          return { ok: true as const };
        },
      },
      { experimental_discoverable: true },
    );
    bb.rpc.experimental_whileWatched("changeForThread", (read, signal) => {
      return "key" in read ? changes.watch(read.key, signal) : undefined;
    });

    bb.onDispose(
      host.experimental_onSignal("checkoutChanged", ({ hostId, payload }) =>
        Promise.all(payload.paths.map((path) => changes.checkoutChanged(hostId, path))).then(
          () => undefined,
        ),
      ),
    );
    // A GitButler thread names its branch in the `but` commands of its turns.
    for (const event of ["thread.idle", "thread.failed"] as const) {
      bb.events.on(event, ({ thread }) => {
        void changes.turnEnded(thread.id).catch((error: unknown) => {
          bb.log.debug(`Could not read the branch of ${thread.id}: ${String(error)}`);
        });
      });
    }
  };
}

export default createSourceControl({ serverExec: execGh, now: Date.now });
