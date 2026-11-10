import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { makePluginRuntime, type PluginRuntime } from "@bb-plugins/effect-bridge";
import { Effect } from "effect";
import {
  ACTION_DEADLINE_MS,
  sourceControlHostContract,
  sourceControlHostSignals,
} from "../contract/host.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { execGh } from "../forge/exec-gh.ts";
import type { Exec } from "../forge/github.ts";
import { createForgeSites, FORGE_DEADLINE_MS, type HostForge } from "./forge-sites.ts";
import type { HostCalls } from "./host-calls.ts";
import { SharedWork } from "./shared.ts";
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

type HostClient = ReturnType<typeof hostClient>;
type Changes = ReturnType<typeof createThreadChanges>;
type Runtime = PluginRuntime<SharedWork>;

const hostClient = (bb: BbPluginApi) =>
  bb.hosts.experimental_client({
    contract: sourceControlHostContract,
    experimental_signals: sourceControlHostSignals,
  });

/** The checkout calls, bound to the host client. */
function checkoutCalls(host: HostClient): HostCalls {
  return {
    workspace: (hostId, input, options) => host.call("workspace", input, { hostId, ...options }),
    renewWatch: (hostId, path, options) =>
      host.call("renewWatch", { path }, { hostId, ...options }),
    vcsAction: (hostId, input, options) => host.call("vcsAction", input, { hostId, ...options }),
    patches: (hostId, input, options) => host.call("patches", input, { hostId, ...options }),
    range: (hostId, input, options) => host.call("range", input, { hostId, ...options }),
  };
}

/** The forge calls a host makes when it is the forge site. */
function forgeCalls(host: HostClient): HostForge {
  const options = (hostId: string, signal: AbortSignal) => ({
    hostId,
    signal,
    timeoutMs: FORGE_DEADLINE_MS,
  });
  return {
    accounts: (hostId, signal) => host.call("forgeAccounts", {}, options(hostId, signal)),
    pullRequest: (hostId, query, signal) =>
      host.call("forgeCall", { op: "pr.read", ...query }, options(hostId, signal)),
    setDraft: (hostId, write, signal) =>
      host.call("forgeWrite", { op: "pr.setDraft", ...write }, options(hostId, signal)),
    review: (hostId, input, signal) => host.call("forgeReview", input, options(hostId, signal)),
  };
}

function registerRpc(bb: BbPluginApi, runtime: Runtime, changes: Changes) {
  bb.rpc.register(
    sourceControlContract,
    {
      changeForThread: ({ keys }) => changes.read(keys),
      statusForThread: ({ keys }) => changes.status(keys),
      refreshThread: async ({ threadId }) => {
        await runtime.run(changes.retry(threadId));
        return { ok: true as const };
      },
      patches: ({ threadId, source }, context) =>
        runtime.run(changes.patches(threadId, source), context.experimental_signal),
      // A write is not stopped by its caller leaving: only unloading the plugin stops it.
      vcsAction: ({ threadId, action, expected }) =>
        runtime.run(changes.act(threadId, action, expected)),
      checksForChange: ({ keys }) => changes.checks(keys),
      forgeAction: ({ threadId, action, expected }) =>
        runtime.run(changes.forgeAction(threadId, action, expected)),
      setReadAs: async ({ threadId, readAs }) => {
        await runtime.run(changes.setReadAs(threadId, readAs));
        return { ok: true as const };
      },
      pageSources: (_input, context) =>
        runtime.run(changes.review.pageSources(), context.experimental_signal),
      inbox: ({ keys }) => changes.review.inbox(keys),
      hostChanges: ({ keys }) => changes.review.hostChanges(keys),
      changeDetail: ({ keys }) => changes.review.detail(keys),
      changeFiles: ({ key, revision }, context) =>
        runtime.run(changes.review.files(key, revision), context.experimental_signal),
      changePatches: ({ key, revision, paths }, context) =>
        runtime.run(changes.review.patches(key, revision, paths), context.experimental_signal),
      changeCommits: ({ key, revision }, context) =>
        runtime.run(changes.review.commits(key, revision), context.experimental_signal),
      changeForgeAction: ({ key, action, expected }) =>
        runtime.run(changes.review.setDraft(key, action.draft, expected)),
    },
    { experimental_discoverable: true },
  );
  bb.rpc.experimental_whileWatched("changeForThread", (read, signal) => {
    if (!("key" in read)) return undefined;
    // Ends when the last watcher leaves, which interrupts the watch.
    return runtime.run(changes.watch(read.key), signal).then(
      () => undefined,
      () => undefined,
    );
  });
  // The review page: each source and the open Change are read only while a page watches them.
  const watchWith =
    <K extends string>(watch: (key: K) => Effect.Effect<unknown, unknown>) =>
    (read: { key?: string } | object, signal: AbortSignal) => {
      if (!("key" in read) || typeof read.key !== "string") return undefined;
      return runtime.run(watch(read.key as K), signal).then(
        () => undefined,
        () => undefined,
      );
    };
  bb.rpc.experimental_whileWatched("inbox", watchWith(changes.review.watchInbox));
  bb.rpc.experimental_whileWatched("hostChanges", watchWith(changes.review.watchHost));
  bb.rpc.experimental_whileWatched("changeDetail", watchWith(changes.review.watchChange));
  bb.rpc.experimental_whileWatched("statusForThread", (read, signal) => {
    if (!("key" in read)) return undefined;
    return runtime.run(changes.glance(read.key), signal).then(
      () => undefined,
      () => undefined,
    );
  });
}

function listen(bb: BbPluginApi, runtime: Runtime, host: HostClient, changes: Changes) {
  bb.onDispose(
    host.experimental_onSignal("checkoutChanged", ({ hostId, payload }) =>
      runtime.run(
        Effect.forEach(payload.paths, (path) => changes.checkoutChanged(hostId, path), {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    ),
  );
  // A GitButler thread names its branch in the `but` commands of its turns.
  for (const event of ["thread.idle", "thread.failed"] as const)
    bb.events.on(event, ({ thread }) => runtime.fork(changes.turnEnded(thread.id)));
}

/** The plugin with its outside world injected, for tests. */
export function createSourceControl(deps: SourceControlDeps) {
  return async function plugin(bb: BbPluginApi): Promise<void> {
    let disposed = false;
    bb.onDispose(() => {
      disposed = true;
    });
    const runtime = await makePluginRuntime(bb, SharedWork.layer);
    const host = hostClient(bb);
    const changes: Changes = createThreadChanges({
      bb,
      store: openStore(bb),
      sites: createForgeSites({
        serverExec: deps.serverExec,
        now: deps.now,
        host: forgeCalls(host),
      }),
      share: await runtime.run(SharedWork),
      host: checkoutCalls(host),
      now: deps.now,
      disposed: () => disposed,
      actionDeadlineMs: deps.actionDeadlineMs ?? ACTION_DEADLINE_MS,
      ...(deps.hostDeadlineMs === undefined ? {} : { hostDeadlineMs: deps.hostDeadlineMs }),
      // A branch a background recheck changed reaches the thread's watchers.
      branches: createThreadBranches(bb, (threadId) =>
        runtime.fork(changes.branchMayHaveChanged(threadId)),
      ),
    });
    registerRpc(bb, runtime, changes);
    listen(bb, runtime, host, changes);
  };
}

export default createSourceControl({ serverExec: execGh, now: Date.now });
