import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Engine, WhiteboardSettings } from "../../shared/contracts/engine.ts";
import { CATALOG_TAG } from "../../shared/contracts/rpc.ts";
import { ReviewInputError } from "../../shared/review/input-error.ts";
import { createHostResolver } from "./host-resolver.ts";
import {
  HostUnavailableError,
  installHostIo,
  onWorkerExit,
  withHostRoute,
} from "./host-io/client.ts";
import { forgetExists, memoizeExists } from "./host-io/fs.ts";
import { forgetRepoContext, resolveRepoContext } from "./host-io/local-vcs.ts";
import { defaultPullRequestDeps } from "./host-io/pull-request.ts";
import { forgetProbes, probeHost } from "./host-io/probe.ts";
import { migrate } from "./migrations.ts";
import { createOpenPanel } from "./open-panel.ts";
import { createRealtime, publishEngineChanges } from "./realtime.ts";
import { createScratchpads } from "./scratchpads.ts";
import { createSessionTabs } from "./session-tabs.ts";
import { whenSettingsLoaded } from "./settings.ts";
import { installDatabase } from "./sqlite.ts";
import { PLUGIN_VERSION, createStatus } from "./status.ts";
import { desktopAvailable, runWithThread } from "./thread-context.ts";
import { createReviewApi } from "./review/api.ts";
import { openLocalReviewStore } from "./review/local-data.ts";

/** The store, the operations, host routing and lifecycle share one owner per plugin load. */
export function createEngine(bb: BbPluginApi, settings: WhiteboardSettings): Engine {
  migrate(bb);
  const database = installDatabase(bb.storage.database());
  const resolver = createHostResolver(bb);
  const uninstallHost = installHostIo(bb, resolver);
  const stopExistsMemo = memoizeExists();
  const scratchpads = createScratchpads(bb);
  const { store, data } = openLocalReviewStore(database, {
    pullRequests: defaultPullRequestDeps,
    scratchpadId: scratchpads.currentId,
  });
  const register = data.register.bind(data);
  data.register = async (root) => {
    // Registration belongs to the caller's host, even when this path is already
    // bound: the path is read there, never on the host that holds the binding.
    const hostId = await resolver.callerHost();
    const repository = await withHostRoute(hostId, () => register(root));
    await resolver.bindRepository(
      { repositoryId: repository.id, rootPath: store.repositoryPath(repository.id) },
      hostId,
    );
    forgetExists();
    await resolveRepoContext(store.repositoryPath(repository.id));
    return repository;
  };
  const realtime = createRealtime(bb);
  const tabs = createSessionTabs({ bb, store });
  const api = createReviewApi({
    store,
    data,
    open: createOpenPanel({ settings, realtime, openTab: tabs.open }),
    capabilities: () => ({
      desktopAvailable: desktopAvailable(),
      softwareMapEnabled: settings.softwareMapEnabled(),
    }),
    scratchpadEnabled: () => settings.scratchpadEnabled(),
    status: createStatus(bb),
    resolveId: scratchpads.resolveId,
    writableId: scratchpads.writableId,
  });
  const stopChanges = publishEngineChanges(realtime, { store, data });
  // The scratchpad's catalog row comes and goes with its setting.
  const stopSettings = settings.subscribe((next, previous) => {
    if (next.scratchpadEnabled !== previous.scratchpadEnabled) realtime.invalidate([CATALOG_TAG]);
  });
  const stopExits = onWorkerExit((hostId) => {
    forgetProbes(hostId);
    forgetExists();
  });
  const lifecycle = new AbortController();
  const running = new Set<Promise<unknown>>();
  let disposed = false;
  let disposing: Promise<void> | undefined;
  // Requests wait for settings only, never for a repository's host.
  const ready = whenSettingsLoaded(settings);
  // Host calls fail during factory registration; bb starts services after it.
  // A host that is offline now is primed on its first catalog read instead.
  bb.background.service("repo-contexts", {
    async start() {
      await Promise.allSettled(store.repositories().map(({ path }) => resolveRepoContext(path)));
      store.invalidateCatalog();
    },
  });
  const shuttingDown = () => new ReviewInputError("Whiteboard is shutting down.", 409);

  const run: Engine["run"] = (context, fn) =>
    runWithThread(context, async () => {
      await ready;
      if (disposed) throw shuttingDown();
      const signals = [lifecycle.signal, context.signal].filter(
        (signal): signal is AbortSignal => !!signal,
      );
      const signal = AbortSignal.any(signals);
      signal.throwIfAborted();
      const pending = fn(signal);
      running.add(pending);
      try {
        return await pending;
      } catch (error) {
        throw lifecycle.signal.aborted ? shuttingDown() : error;
      } finally {
        running.delete(pending);
      }
    });

  return {
    api,
    run,
    info: (input) =>
      run({ threadId: input.threadId }, async () => {
        const sessionId = input.sessionId ? scratchpads.resolveId(input.sessionId) : undefined;
        if (sessionId && sessionId === scratchpads.currentId() && settings.scratchpadEnabled())
          await store.ensureScratchpad();
        const snapshot = sessionId ? store.read(sessionId) : undefined;
        // Home rows, verbs and restored tabs open without the agent's `open`.
        if (input.threadId && sessionId) tabs.track(input.threadId, sessionId);
        // diffr runs on the repository's host. Home (no pinned session) lists
        // every repository, so it asks every host that holds one. The first
        // host with diffr decides, so a silent host does not hold Home up.
        const repositoryId = snapshot?.source?.pins.repositoryId;
        const hosts: Array<string | Promise<string>> = repositoryId
          ? [resolver.hostFor({ repositoryId })]
          : resolver.boundHosts();
        const hasDiffr = async (hostId: string | Promise<string>) => {
          try {
            return !!(await probeHost(await hostId)).diffr;
          } catch (error) {
            const message = `whiteboard: structural diff capability could not be probed: ${String(error)}`;
            // An offline host is expected; its reads name it to the user.
            if (error instanceof HostUnavailableError) bb.log.debug(message);
            else bb.log.warn(message);
            return false;
          }
        };
        const structuralDiffEnabled = await new Promise<boolean>((resolve) => {
          const answers = hosts.map(async (hostId) => {
            if (await hasDiffr(hostId)) resolve(true);
          });
          void Promise.all(answers).then(() => resolve(false));
        });
        return {
          ...(sessionId ? { sessionId } : {}),
          appVersion: PLUGIN_VERSION,
          softwareMapEnabled: settings.softwareMapEnabled(),
          scratchpadEnabled: settings.scratchpadEnabled(),
          structuralDiffEnabled,
        };
      }),
    claimOpen: (threadId, after) => tabs.claimOpen(threadId, after),
    watchWorktrees: () => (disposed ? () => {} : store.watchWorktrees()),
    dispose() {
      return (disposing ??= (async () => {
        disposed = true;
        lifecycle.abort();
        stopChanges();
        stopSettings();
        tabs.dispose();
        realtime.dispose();
        stopExits();
        await ready;
        await Promise.allSettled(running);
        await store.close();
        await data.close();
        uninstallHost();
        stopExistsMemo();
        forgetRepoContext();
        forgetProbes();
      })());
    },
  };
}
