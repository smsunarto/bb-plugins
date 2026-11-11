import type {
  BbPluginApi,
  ExperimentalPluginRpcHandlersWithContext,
  PluginAgentToolContext,
} from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import { makePluginRuntime, type PluginRuntime } from "@bb-plugins/effect-bridge";
import { Effect } from "effect";
import { z } from "zod";
import {
  ACTION_DEADLINE_MS,
  sourceControlHostContract,
  sourceControlHostSignals,
} from "../contract/host.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import type { ChangeKey } from "../core/ids.ts";
import { shareDirective } from "../core/directive.ts";
import { execGh } from "../forge/exec-gh.ts";
import type { Exec } from "../forge/github.ts";
import { createAsk, type Ask } from "./ask.ts";
import {
  createForgeSites,
  FORGE_DEADLINE_MS,
  MERGE_DEADLINE_MS,
  type HostForge,
} from "./forge-sites.ts";
import {
  createGuides,
  type Guides,
  WRITE_GUIDE,
  writeGuideEnabled,
  writeGuideTool,
} from "./guides.ts";
import type { HostCalls } from "./host-calls.ts";
import { SharedWork } from "./shared.ts";
import {
  createReviewStart,
  REPORT_FINDINGS,
  reportFindingsEnabled,
  reportFindingsTool,
} from "./review-start.ts";
import { openStore, type Store } from "./store.ts";
import { createThreadBranches } from "./thread-branches.ts";
import { createThreadChanges } from "./thread-changes.ts";
import { createMoved, type Moved } from "./moved.ts";

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
type Start = ReturnType<typeof createReviewStart>;

const files = instructionFiles(import.meta.url);
const SHARE_CHANGE = "source_control_share_change";

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
    // A merge is never retried, and may take GitHub longer than a read.
    merge: (hostId, write, signal) =>
      host.call("forgeMerge", write, { hostId, signal, timeoutMs: MERGE_DEADLINE_MS }),
    review: (hostId, input, signal) => host.call("forgeReview", input, options(hostId, signal)),
    submitReview: (hostId, write, signal) =>
      host.call("forgeSubmitReview", write, options(hostId, signal)),
  };
}

/** Writes to a pull request (draft or ready, merge), and what a merge needs. Never retried. */
function forgeHandlers(runtime: Runtime, changes: Changes) {
  return {
    // A write is not stopped by its caller leaving: only unloading the plugin stops it.
    forgeAction: ({ threadId, action, expected }) =>
      runtime.run(changes.forgeAction(threadId, action, expected)),
    changeForgeAction: ({ key, action, expected }) =>
      runtime.run(changes.review.forgeAction(key, action, expected)),
    mergePolicy: ({ key, number }, context) =>
      runtime.run(changes.review.mergePolicy(key, number), context.experimental_signal),
  } satisfies Partial<ExperimentalPluginRpcHandlersWithContext<typeof sourceControlContract>>;
}

/** A Change's reading guide and viewed marks; only the review page's open starts a run. */
function guideHandlers(guides: Guides) {
  return {
    guideForChange: ({ keys }) => guides.read(keys),
    openGuide: ({ key }) => guides.open(key),
    rewriteGuide: ({ key }) => guides.rewrite(key),
    setViewed: ({ key, path, blob, viewed }) => {
      guides.setViewed(key, path, blob, viewed);
      return { ok: true as const };
    },
  } satisfies Partial<ExperimentalPluginRpcHandlersWithContext<typeof sourceControlContract>>;
}

/** The Change's Ask thread, and a thread to fix a checkout's missing tool. */
function askHandlers(ask: Ask) {
  return {
    askForChange: ({ keys }) => ask.read(keys),
    ask: (question) => ask.ask(question),
    openAskAsThread: ({ key }) => ask.openAsThread(key),
    askToFix: ({ threadId }) => ask.toFix(threadId),
  } satisfies Partial<ExperimentalPluginRpcHandlersWithContext<typeof sourceControlContract>>;
}

/** A Change's review items, drafts and selection, starting a bb review of it, and sending batches. */
function reviewHandlers(runtime: Runtime, review: Changes["review"], start: Start) {
  const { items, batches } = review;
  return {
    reviewForChange: ({ keys }) => items.read(keys),
    saveDraft: ({ key, draft }) => ({ ok: true as const, draft: items.saveDraft(key, draft) }),
    deleteDraft: ({ key, id }) => {
      items.deleteDraft(key, id);
      return { ok: true as const };
    },
    setSelected: ({ key, ids, selected }) => {
      items.setSelected(key, ids, selected);
      return { ok: true as const };
    },
    dismissItem: ({ key, id }) => {
      items.dismiss(key, id);
      return { ok: true as const };
    },
    setTray: ({ key, tray }) => {
      items.setTray(key, tray);
      return { ok: true as const };
    },
    agentTargets: async ({ key }) => ({ targets: await batches.targets(key) }),
    // A send is not stopped by its caller leaving: a retry with the same id finds where it got to.
    sendBatch: ({ key, batch }) => runtime.run(batches.send(key, batch)),
    stopAgent: ({ key, batchId }) => batches.stop(key, batchId),
    startReview: ({ key }) => start.startReview(key),
    changeConversation: ({ key }, context) =>
      runtime.run(items.conversation(key), context.experimental_signal),
  } satisfies Partial<ExperimentalPluginRpcHandlersWithContext<typeof sourceControlContract>>;
}

/**
 * bb resumes a page's watches while the plugin is still registering, after a
 * reload or a restart, when host calls are refused. A service starts only once
 * the plugin is active, so watches wait for it.
 */
function activation(bb: BbPluginApi) {
  let activate = () => {};
  const active = new Promise<void>((resolve) => {
    activate = resolve;
  });
  bb.background.service("activation", {
    start(signal) {
      activate();
      return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    },
  });
  return <A, E>(work: Effect.Effect<A, E>) =>
    Effect.andThen(
      Effect.promise(() => active),
      work,
    );
}

function registerRpc(
  bb: BbPluginApi,
  runtime: Runtime,
  changes: Changes,
  start: Start,
  guides: Guides,
  ask: Ask,
  moved: Moved,
) {
  const afterRegistration = activation(bb);
  const items = changes.review.items;
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
      ...forgeHandlers(runtime, changes),
      ...reviewHandlers(runtime, changes.review, start),
      ...guideHandlers(guides),
      ...askHandlers(ask),
      ...moved.handlers,
    },
    { experimental_discoverable: true },
  );
  bb.rpc.experimental_whileWatched("changeForThread", (read, signal) => {
    if (!("key" in read)) return undefined;
    // Ends when the last watcher leaves, which interrupts the watch.
    return runtime.run(afterRegistration(changes.watch(read.key)), signal).then(
      () => undefined,
      () => undefined,
    );
  });
  // The review page: each source and the open Change are read only while a page watches them.
  const watchWith =
    <K extends string>(watch: (key: K) => Effect.Effect<unknown, unknown>) =>
    (read: { key?: string } | object, signal: AbortSignal) => {
      if (!("key" in read) || typeof read.key !== "string") return undefined;
      return runtime.run(afterRegistration(watch(read.key as K)), signal).then(
        () => undefined,
        () => undefined,
      );
    };
  bb.rpc.experimental_whileWatched("inbox", watchWith(changes.review.watchInbox));
  bb.rpc.experimental_whileWatched("hostChanges", watchWith(changes.review.watchHost));
  bb.rpc.experimental_whileWatched("changeDetail", watchWith(changes.review.watchChange));
  // Items read from the store only; a watcher brings any behind the Change's head up to it.
  bb.rpc.experimental_whileWatched(
    "reviewForChange",
    watchWith((key: ChangeKey) => Effect.ignore(items.settle(key))),
  );
  bb.rpc.experimental_whileWatched("statusForThread", (read, signal) => {
    if (!("key" in read)) return undefined;
    return runtime.run(afterRegistration(changes.glance(read.key)), signal).then(
      () => undefined,
      () => undefined,
    );
  });
}

function listen(
  bb: BbPluginApi,
  runtime: Runtime,
  host: HostClient,
  changes: Changes,
  guides: Guides,
  moved: Moved,
) {
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
    bb.events.on(event, ({ thread }) => {
      runtime.fork(changes.turnEnded(thread.id));
      // A review that stops without reporting ends with no findings, or failed.
      changes.review.items.runEnded(thread.id, event === "thread.failed");
      changes.review.batches.threadStatus(thread.id, event === "thread.idle" ? "idle" : "failed");
      // A guide run that stops without writing failed; either way its slot is free.
      guides.threadEnded(thread.id);
      // A thread that stops working hears what its watched pull requests did meanwhile.
      moved.threadSettled(thread.id);
    });
  // An agent a batch went to: "fixing" while it runs, gone once archived.
  bb.events.on("thread.active", ({ thread }) =>
    changes.review.batches.threadStatus(thread.id, "running"),
  );
  bb.events.on("thread.archived", ({ thread }) => {
    changes.review.batches.threadStatus(thread.id, "gone");
    guides.threadEnded(thread.id);
    moved.threadGone(thread.id);
  });
  bb.events.on("thread.deleted", ({ thread }) => moved.threadGone(thread.id));
}

/** The calling thread's Change as a card: the directive names its key and head, nothing else. */
function shareChangeTool(runtime: Runtime, changes: Changes) {
  return {
    name: SHARE_CHANGE,
    ...files.tool(SHARE_CHANGE),
    presentation: {
      label: { pending: "Sharing the Change", completed: "Shared the Change" },
    },
    parameters: z.object({}),
    async execute(_input: Record<string, never>, { threadId }: PluginAgentToolContext) {
      // A thread whose Change was never read is read once, now.
      if (!changes.keyOf(threadId)) await runtime.run(changes.retry(threadId));
      const key = changes.keyOf(threadId);
      if (!key)
        throw new Error(
          "This thread has no Change to share: it needs a checkout with a branch checked out.",
        );
      const detail = changes.review.detail([key])[key];
      const head = detail?.state === "change" ? detail.head : null;
      return shareDirective(key, head);
    },
  };
}

/** Review threads get the findings tool, guide runs the guide tool; every thread can share its Change. */
function registerAgents(
  bb: BbPluginApi,
  runtime: Runtime,
  changes: Changes,
  guides: Guides,
  moved: Moved,
) {
  bb.agents.registerTool(reportFindingsTool(changes.review.items));
  bb.agents.registerTool(writeGuideTool(guides));
  bb.agents.registerTool(shareChangeTool(runtime, changes));
  moved.register();
  bb.agents.configure((session) => {
    const authors = moved.configure(session);
    return {
      tools: [
        ...(reportFindingsEnabled(session) ? [REPORT_FINDINGS] : []),
        ...(writeGuideEnabled(session) ? [WRITE_GUIDE] : []),
        SHARE_CHANGE,
        ...authors.tools,
      ],
      skills: authors.skills,
    };
  });
}

/** Which model writes guides; empty fields take the project's default. */
function guideSettings(bb: BbPluginApi) {
  const settings = bb.settings.define({
    guideProvider: {
      type: "string",
      label: "Guide provider",
      description:
        "Provider for the hidden runs that write a Change's reading guide. Leave empty for the project's default.",
      default: "",
    },
    guideModel: {
      type: "string",
      label: "Guide model",
      description:
        "Model for those runs, such as a fast, small one. Leave empty for the provider's default.",
      default: "",
    },
  });
  return async () => {
    const values = await settings.get();
    const providerId = values.guideProvider.trim();
    const model = values.guideModel.trim();
    return { ...(providerId ? { providerId } : {}), ...(model ? { model } : {}) };
  };
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
    const store: Store = openStore(bb);
    const share = await runtime.run(SharedWork);
    const sites = createForgeSites({
      serverExec: deps.serverExec,
      now: deps.now,
      host: forgeCalls(host),
    });
    const changes: Changes = createThreadChanges({
      bb,
      store,
      sites,
      share,
      host: checkoutCalls(host),
      now: deps.now,
      disposed: () => disposed,
      actionDeadlineMs: deps.actionDeadlineMs ?? ACTION_DEADLINE_MS,
      fork: (work) => {
        if (!disposed) runtime.fork(work);
      },
      ...(deps.hostDeadlineMs === undefined ? {} : { hostDeadlineMs: deps.hostDeadlineMs }),
      // A branch a background recheck changed reaches the thread's watchers.
      branches: createThreadBranches(bb, (threadId) =>
        runtime.fork(changes.branchMayHaveChanged(threadId)),
      ),
    });
    const start = createReviewStart({
      bb,
      store,
      items: changes.review.items,
      detail: (key) => changes.review.detail([key])[key]!,
      invalidate: (tags) => {
        if (!disposed) bb.rpc.experimental_invalidate(tags);
      },
      now: deps.now,
      instructions: () => moved.instructions.get(),
    });
    const invalidate = (tags: readonly string[]) => {
      if (!disposed) bb.rpc.experimental_invalidate(tags);
    };
    const guides = createGuides({
      bb,
      store,
      detail: (key) => changes.review.detail([key])[key]!,
      refresh: changes.review.refresh,
      files: changes.review.files,
      invalidate,
      fork: (work) => {
        if (!disposed) runtime.fork(work);
      },
      now: deps.now,
      model: guideSettings(bb),
    });
    // Once active: waiting runs start, and running ones a restart left are asked about.
    bb.background.service("guides", {
      start(signal) {
        guides.resume();
        return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      },
    });
    const ask = createAsk({
      bb,
      store,
      detail: (key) => changes.review.detail([key])[key]!,
      owners: changes.owners,
      invalidate,
      now: deps.now,
    });
    const moved = createMoved({
      bb,
      store,
      host: checkoutCalls(host),
      read: sites.backgroundRead,
      run: (effect) => runtime.run(effect),
      invalidate,
      pinsChanged: () => runtime.fork(changes.review.refreshInboxes()),
      now: deps.now,
    });
    registerRpc(bb, runtime, changes, start, guides, ask, moved);
    registerAgents(bb, runtime, changes, guides, moved);
    listen(bb, runtime, host, changes, guides, moved);
  };
}

export default createSourceControl({ serverExec: execGh, now: Date.now });
