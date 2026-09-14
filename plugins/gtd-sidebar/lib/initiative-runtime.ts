import type { ProjectFeatures } from "./feature-policy.ts";
// Initiative runtime assembly: plugin storage, the domain service, the
// subscription engine (automation's module), and the agent surface — wired
// once from server.ts.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createInitiativeService, type InitiativeService } from "./initiative-service.ts";
import { createInitiativeStore, type InitiativeStore } from "./initiative-store.ts";
import { registerInitiativeAgents } from "./initiative-tools.ts";
import {
  createSubscriptionStore,
  registerInitiativeSubscriptions,
  type InitiativeSubscriptionRuntimeDeps,
  type SubscriptionEngine,
  type SubscriptionStore,
} from "./initiative-subscriptions.ts";
import { INITIATIVES_CHANNEL } from "./initiative-types.ts";
import type { GtdSidebarHostClient } from "./host-contract.ts";
import type { GitHubCiRunsInput, GitHubPrActivityInput } from "./github-host.ts";
import type { InspectSharedDirectoryInput } from "./shared-directory-host.ts";

export interface InitiativeRuntime {
  features: ProjectFeatures;
  store: InitiativeStore;
  service: InitiativeService;
  subscriptionStore: SubscriptionStore;
  engine: SubscriptionEngine;
}

export interface InitiativeRuntimeDeps {
  features: ProjectFeatures;
  /** The plugin's host client — automation's GitHub bridge methods ride it. */
  host: GtdSidebarHostClient;
  /** Secret-backed Slack bot token for the slack-channel subscription kind. */
  getSlackToken(): Promise<string | undefined>;
}

export function createInitiativeRuntime(
  bb: BbPluginApi,
  deps: InitiativeRuntimeDeps,
): InitiativeRuntime {
  const db = bb.storage.database();
  const store = createInitiativeStore(db);
  const subscriptionStore = createSubscriptionStore(db);
  const publish = (channel: string, payload: unknown) => bb.realtime.publish(channel, payload);

  const service = createInitiativeService({
    store,
    threads: bb.sdk.threads,
    projects: bb.sdk.projects,
    hosts: bb.sdk.hosts,
    inspectSharedDirectory: (hostId, input: InspectSharedDirectoryInput) =>
      deps.host.call("inspectSharedDirectory", input, {
        hostId,
      }),
    pluginId: bb.pluginId,
    publish,
    log: bb.log,
    recheckDispatch: () => bb.experimental_hooks.recheck("message.dispatch"),
  });

  const engine = registerInitiativeSubscriptions(
    {
      storage: bb.storage,
      background: bb.background,
      sdk: {
        threads: {
          get: (args) => bb.sdk.threads.get(args),
          // The engine only ever sends text digests; the SDK seam requires a mode.
          send: (args) => bb.sdk.threads.send({ ...args, mode: "auto" }),
        },
        environments: {
          get: (args) => bb.sdk.environments.get(args),
        },
      },
      realtime: bb.realtime,
      log: bb.log,
      onDispose: (hook) => bb.onDispose(hook),
    },
    {
      getCoordinatorThreadId: (initiativeId) =>
        Promise.resolve(store.get(initiativeId)?.coordinatorThreadId ?? null),
      isEnabled: deps.features.subscriptions,
      isInitiativeActive: (initiativeId) => {
        const initiative = store.get(initiativeId);
        return initiative !== null && initiative.archivedAt === null;
      },
      getSlackToken: deps.getSlackToken,
      hostCall: (method, input, options) =>
        method === "githubCiRuns"
          ? deps.host.call(method, input as GitHubCiRunsInput, options)
          : deps.host.call(method, input as GitHubPrActivityInput, options),
    },
  );

  registerInitiativeAgents(bb, {
    features: deps.features,
    service,
    store,
    engine,
    subscriptions: subscriptionStore,
    threads: bb.sdk.threads,
    pluginId: bb.pluginId,
  });

  // A thread created under an initiative member joins it immediately — before
  // its first provider session — so the synchronous configure/instructions
  // hooks already resolve its role. This covers raw `bb thread spawn
  // --parent-self` calls from inside agents, not just our own tools.
  bb.events.on("thread.created", ({ thread }) => {
    if (deps.features.projects()) service.noteThreadCreated(thread);
  });

  // The admission checkpoint: first messages carrying an initiative init
  // marker are held until registry/index membership resolves, and unmarked
  // children of members get indexed before their first session. See
  // service.dispatchGate for the proceed/wait/reject semantics.
  bb.experimental_hooks.on("message.dispatch", (ctx) =>
    deps.features.projects()
      ? service.dispatchGate({
          threadId: ctx.thread.id,
          parentThreadId: ctx.thread.parentThreadId,
          originPluginId: ctx.originPluginId,
          inputBlocks: ctx.input.blocks,
        })
      : { action: "proceed" },
  );

  // Archiving, restoring, or deleting a coordinator through ordinary thread
  // surfaces (GTD settle, raw bb commands) keeps the registry's paused flag
  // in step — the service ignores the events its own archive loop emits.
  bb.events.on("thread.archived", ({ thread }) => {
    service.noteNativeThreadState(thread.id, "archived");
  });
  bb.events.on("thread.unarchived", ({ thread }) => {
    service.noteNativeThreadState(thread.id, "unarchived");
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    service.noteNativeThreadState(thread.id, "deleted");
  });

  return { features: deps.features, store, service, subscriptionStore, engine };
}

export { INITIATIVES_CHANNEL };
export type { InitiativeSubscriptionRuntimeDeps };
