import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  experimental_useProviders as useProviders,
  useSdk,
  type ComposerSelection,
  type PluginBrowserBbSdk,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import {
  isPermissionModeAbove,
  permissionModeBelow,
  type PermissionMode,
} from "../permission-modes";

type ModelsResult = Awaited<ReturnType<PluginBrowserBbSdk["providers"]["models"]>>;
export type CatalogModel = ModelsResult["models"][number];
export type CatalogProvider = ReturnType<typeof useProviders>["providers"][number];

/** Where a provider's model list is read: the thread's environment, a chosen machine, or bb's primary one. */
export type CatalogRouting =
  | { kind: "environment"; environmentId: string }
  | { kind: "host"; hostId: string; projectId?: string }
  | { kind: "primary"; projectId?: string };

export type ProviderCatalog =
  | { status: "loading"; models: readonly CatalogModel[] }
  | { status: "ready"; models: readonly CatalogModel[]; fetchedAt: number }
  | {
      status: "error";
      models: readonly CatalogModel[];
      message: string;
      fetchedAt: number;
      /** Consecutive failed loads, which space out the automatic retries. */
      failures: number;
    };

const LOADING: ProviderCatalog = { status: "loading", models: [] };
const STALE_AFTER_MS = 5 * 60_000;
const REQUEST_DEADLINE_MS = 15_000;
const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 2 * 60_000;

/** When a read that failed `failures` times in a row, last at `failedAt`, is tried again. */
function retryAt(failedAt: number, failures: number) {
  return failedAt + Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS);
}

/**
 * One app-wide cache shared by every mounted composer, keyed by routing and
 * provider, so two composers on the same machine share one request per provider.
 */
const catalogs = new Map<string, ProviderCatalog>();
/**
 * What the machine allows a provider, from the same reads as its models: BB's own picker
 * reads it from that response too. Kept apart from the models, since a provider that cannot
 * list models still answers with its permission modes.
 */
export interface PermissionInfo {
  ceiling: PermissionMode;
  /** Null when the machine does not offer the provider. */
  provider: { name: string; modes: readonly PermissionMode[] } | null;
}
const permissions = new Map<string, PermissionInfo>();
/** Each provider's most recently listed models, from any routing. */
const lastListed = new Map<string, readonly CatalogModel[]>();
const inFlight = new Set<string>();
/** A read asked for while the same one was under way, run once that one ends. */
const rerun = new Map<string, LoadOptions>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

function publish(key: string, catalog: ProviderCatalog) {
  catalogs.set(key, catalog);
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function routingKey(routing: CatalogRouting): string {
  switch (routing.kind) {
    case "environment":
      return `env:${routing.environmentId}`;
    case "host":
      return `host:${routing.hostId}:${routing.projectId ?? ""}`;
    case "primary":
      return `primary:${routing.projectId ?? ""}`;
  }
}

function catalogKey(routing: CatalogRouting, providerId: string) {
  return `${routingKey(routing)}|${providerId}`;
}

function routingArgs(routing: CatalogRouting) {
  switch (routing.kind) {
    case "environment":
      return { environmentId: routing.environmentId };
    case "host":
      return {
        hostId: routing.hostId,
        ...(routing.projectId ? { projectId: routing.projectId } : {}),
      };
    case "primary":
      return routing.projectId ? { projectId: routing.projectId } : {};
  }
}

function errorMessage(result: ModelsResult): string | null {
  const error = result.modelLoadError;
  if (!error) return null;
  if (error.detail) return error.detail;
  switch (error.code) {
    case "auth_required":
      return "Sign in to this provider to list its models.";
    case "missing_executable":
      return "This provider's CLI is not installed on the machine.";
    case "timeout":
      return "The provider took too long to list its models.";
    default:
      return "The provider could not list its models.";
  }
}

interface LoadOptions {
  /** Refetch even fresh models (the Retry action). */
  force?: boolean;
  /** Retry a failed load. Only an explicit ask (opening the picker, Retry) does, which bounds retries. */
  retryErrors?: boolean;
  /**
   * Re-read what the machine allows after a sign it changed. BB's cached model list will do,
   * as BB's own picker reads it, and a failure keeps what is shown.
   */
  revalidate?: boolean;
}

function load(
  sdk: PluginBrowserBbSdk,
  routing: CatalogRouting,
  providerId: string,
  options: LoadOptions = {},
) {
  const key = catalogKey(routing, providerId);
  if (inFlight.has(key)) {
    // The read under way may have started before the change asked about: read again after it.
    if (options.force || options.revalidate) {
      const queued = rerun.get(key);
      rerun.set(key, {
        force: Boolean(queued?.force || options.force),
        retryErrors: Boolean(queued?.retryErrors || options.retryErrors),
        revalidate: Boolean(queued?.revalidate || options.revalidate),
      });
    }
    return;
  }
  const cached = catalogs.get(key);
  // A stale model list is due a full read anyway, which reads the limit too.
  const staleModels = cached?.status === "ready" && Date.now() - cached.fetchedAt >= STALE_AFTER_MS;
  const permissionsOnly = Boolean(
    options.revalidate && !options.force && cached && cached.status !== "loading" && !staleModels,
  );
  if (!options.force && !options.revalidate && cached) {
    if (cached.status === "loading") return;
    if (cached.status === "error" && !options.retryErrors) return;
    if (cached.status === "ready" && Date.now() - cached.fetchedAt < STALE_AFTER_MS) return;
  }
  inFlight.add(key);
  // A refresh keeps the models already shown; only a cold miss shows loading.
  if (!cached) publish(key, LOADING);
  const failed = (message: string) => {
    const previous = catalogs.get(key);
    publish(key, {
      status: "error",
      models: previous?.models ?? [],
      message,
      fetchedAt: Date.now(),
      failures: (previous?.status === "error" ? previous.failures : 0) + 1,
    });
  };
  Promise.resolve()
    .then(() =>
      sdk.providers.models({
        ...routingArgs(routing),
        providerId,
        ...(permissionsOnly ? { preferCached: true } : {}),
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      }),
    )
    .then((result) => {
      const provider = result.providers.find((entry) => entry.id === providerId);
      // A read queued behind this one has the newer limit.
      if (!rerun.has(key)) {
        permissions.set(key, {
          ceiling: result.permissionCeiling,
          provider: provider
            ? {
                name: provider.displayName,
                modes: provider.capabilities.permissionModes,
              }
            : null,
        });
      }
      if (permissionsOnly) return notify();
      const message = errorMessage(result);
      if (message && result.models.length === 0) return failed(message);
      lastListed.set(providerId, result.models);
      return publish(key, { status: "ready", models: result.models, fetchedAt: Date.now() });
    })
    .catch((error: unknown) => {
      if (permissionsOnly) return;
      failed(error instanceof Error ? error.message : "Could not load models.");
    })
    .finally(() => {
      inFlight.delete(key);
      const next = rerun.get(key);
      if (!next) return;
      rerun.delete(key);
      load(sdk, routing, providerId, next);
    });
}

/**
 * The permission reads a mounted picker shows. BB reports a machine's changed permission limit
 * as that machine connecting again, so while any is watched, that event re-reads the ones on
 * that machine, and a realtime reconnect, which may have missed one, re-reads them all.
 */
const watched = new Map<string, { routing: CatalogRouting; providerId: string; count: number }>();
let stopWatchingChanges: (() => void) | null = null;

/** The machine a routing reads, or null when this page does not know it. */
function routingHostId(routing: CatalogRouting): string | null {
  switch (routing.kind) {
    case "host":
      return routing.hostId;
    case "environment":
      return environmentHosts.get(routing.environmentId) ?? null;
    case "primary":
      return null;
  }
}

function watchChanges(sdk: PluginBrowserBbSdk) {
  if (stopWatchingChanges) return;
  const revalidate = (matches: (routing: CatalogRouting) => boolean) => {
    for (const entry of watched.values()) {
      if (matches(entry.routing)) load(sdk, entry.routing, entry.providerId, { revalidate: true });
    }
  };
  const stopHosts = sdk.subscribe({
    event: "host:changed",
    callback: (event) => {
      if (!event.changes.includes("host-connected")) return;
      revalidate((routing) => {
        const hostId = routingHostId(routing);
        return hostId === null || event.id === undefined || hostId === event.id;
      });
    },
  });
  // BB replays its last connection state to a new listener, so only a drop seen here counts.
  let dropped = false;
  const stopConnection = sdk.subscribe({
    event: "realtime:connection",
    callback: (event) => {
      if (event.state !== "connected") {
        dropped = true;
        return;
      }
      if (!dropped) return;
      dropped = false;
      revalidate(() => true);
    },
  });
  stopWatchingChanges = () => {
    stopHosts();
    stopConnection();
  };
}

/**
 * Watches one permission read for as long as a picker shows it. A read nobody watched may
 * have missed a change, such as while Settings → Machines replaced the thread, so it is read
 * again, showing the cached limit until the machine answers.
 */
function watchPermissions(
  sdk: PluginBrowserBbSdk,
  routing: CatalogRouting,
  providerId: string,
): () => void {
  const key = catalogKey(routing, providerId);
  const entry = watched.get(key);
  if (entry) entry.count += 1;
  else {
    watched.set(key, { routing, providerId, count: 1 });
    load(sdk, routing, providerId, permissions.has(key) ? { revalidate: true } : {});
  }
  watchChanges(sdk);
  return () => {
    const current = watched.get(key);
    if (!current) return;
    current.count -= 1;
    if (current.count > 0) return;
    watched.delete(key);
    if (watched.size > 0) return;
    stopWatchingChanges?.();
    stopWatchingChanges = null;
  };
}

/**
 * BB applied `applied`, or nothing, for a pick of `requested`. BB's composer checks the pick
 * against its own copy of the machine's limit, so a lower mode most likely means the limit
 * dropped: the refused mode turns disabled at once, and the machine is read again, which
 * enables it again if something other than the limit refused it.
 */
export function notePermissionRefused(
  sdk: PluginBrowserBbSdk,
  routing: CatalogRouting,
  providerId: string,
  requested: PermissionMode,
  applied: PermissionMode | null,
): void {
  const key = catalogKey(routing, providerId);
  const info = permissions.get(key);
  const below = permissionModeBelow(requested);
  if (
    info &&
    below !== null &&
    applied !== null &&
    isPermissionModeAbove(requested, applied) &&
    !isPermissionModeAbove(requested, info.ceiling)
  ) {
    permissions.set(key, { ...info, ceiling: below });
    notify();
  }
  load(sdk, routing, providerId, { revalidate: true });
}

type ThreadLookup =
  | { status: "pending" }
  | { status: "failed"; failedAt: number; failures: number }
  | { status: "ready"; environmentId: string | null };

/** Thread → environment. A failed read is retried on the next ask instead of guessing a machine. */
const threadLookups = new Map<string, ThreadLookup>();
/** Environment → machine, from the thread lookups, so a machine's change reaches its threads. */
const environmentHosts = new Map<string, string>();

function resolveThread(
  sdk: PluginBrowserBbSdk,
  threadId: string,
  options: { refresh?: boolean } = {},
) {
  const current = threadLookups.get(threadId);
  if (current?.status === "pending") return;
  // A thread without an environment yet may get one once provisioned; re-read it when asked.
  if (current?.status === "ready" && (current.environmentId !== null || !options.refresh)) return;
  const failures = current?.status === "failed" ? current.failures : 0;
  if (current?.status !== "ready") threadLookups.set(threadId, { status: "pending" });
  Promise.resolve()
    .then(() =>
      sdk.threads.get({
        threadId,
        include: "environment",
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      }),
    )
    .then((thread) => {
      const hostId = "environment" in thread ? thread.environment?.hostId : undefined;
      if (thread.environmentId && hostId) environmentHosts.set(thread.environmentId, hostId);
      threadLookups.set(threadId, { status: "ready", environmentId: thread.environmentId ?? null });
      return notify();
    })
    .catch(() => {
      if (threadLookups.get(threadId)?.status === "pending") {
        threadLookups.set(threadId, {
          status: "failed",
          failedAt: Date.now(),
          failures: failures + 1,
        });
      }
      notify();
    });
}

function threadRouting(threadId: string): CatalogRouting | null {
  const lookup = threadLookups.get(threadId);
  if (lookup?.status !== "ready") return null;
  return lookup.environmentId
    ? { kind: "environment", environmentId: lookup.environmentId }
    : { kind: "primary" };
}

function newThreadRouting(selection: ComposerSelection | null): CatalogRouting {
  const environment = selection?.environment;
  const projectId = selection?.projectId;
  const withProject = projectId ? { projectId } : {};
  switch (environment?.type) {
    case "reuse":
      return { kind: "environment", environmentId: environment.environmentId };
    case "host":
      return environment.hostId
        ? { kind: "host", hostId: environment.hostId, ...withProject }
        : { kind: "primary", ...withProject };
    case "provider":
      return environment.machine?.type === "existing"
        ? { kind: "host", hostId: environment.machine.hostId, ...withProject }
        : { kind: "primary", ...withProject };
    default:
      return { kind: "primary", ...withProject };
  }
}

/** Resolves the composer's catalog routing; null while a thread's environment is unknown. */
export function useCatalogRouting(
  composer: PluginComposerApi,
  enabled: boolean,
): CatalogRouting | null {
  const sdk = useSdk();
  const threadId =
    composer.scope.kind === "new-thread" || !enabled ? null : composer.scope.threadId;
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (threadId !== null) resolveThread(sdk, threadId);
  }, [sdk, threadId]);
  const routing =
    threadId === null ? newThreadRouting(composer.selection) : threadRouting(threadId);
  // Keyed by value, so unrelated store updates do not look like a routing change.
  const key = routing ? routingKey(routing) : null;
  // oxlint-disable-next-line react/exhaustive-deps -- `key` identifies `routing` by value.
  return useMemo(() => routing, [key]);
}

export interface ModelCatalog {
  providers: readonly CatalogProvider[];
  catalogFor(providerId: string): ProviderCatalog;
  /** Changes when the routing or provider list changes, so an open picker can load again. */
  revision: string;
  /** Loads every listed provider's models and retries failures; the selected provider loads on mount. */
  loadAll(options?: { force?: boolean }): void;
}

/** `enabled` is false where the composer has no pickers, so it reads nothing. */
export function useModelCatalog(composer: PluginComposerApi, enabled: boolean): ModelCatalog {
  const sdk = useSdk();
  const { providers } = useProviders();
  const routing = useCatalogRouting(composer, enabled);
  const selectedProviderId = enabled ? (composer.selection?.providerId ?? null) : null;
  const threadId = composer.scope.kind === "new-thread" ? null : composer.scope.threadId;
  useSyncExternalStore(subscribe, () => version);

  useEffect(() => {
    if (routing && selectedProviderId) load(sdk, routing, selectedProviderId);
  }, [sdk, routing, selectedProviderId]);

  // Only a failed read leaves the machine unknown; while it is pending, the machine is coming.
  const lookup = threadId === null ? undefined : threadLookups.get(threadId);
  const lookupFailed = lookup?.status === "failed";

  // A failed read leaves BB's picker in place of these, and only these offer Retry, so retry
  // it here, spaced out and only while the page is visible, until the machine answers.
  const selectedCatalog =
    routing && selectedProviderId
      ? catalogs.get(catalogKey(routing, selectedProviderId))
      : undefined;
  const nextRetryAt = !enabled
    ? null
    : lookup?.status === "failed"
      ? retryAt(lookup.failedAt, lookup.failures)
      : selectedCatalog?.status === "error"
        ? retryAt(selectedCatalog.fetchedAt, selectedCatalog.failures)
        : null;
  useEffect(() => {
    if (nextRetryAt === null) return;
    const retry = () => {
      if (threadId !== null && threadLookups.get(threadId)?.status === "failed") {
        resolveThread(sdk, threadId);
      } else if (routing && selectedProviderId) {
        load(sdk, routing, selectedProviderId, { retryErrors: true });
      }
    };
    let visibilityListener: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (document.visibilityState === "visible") return retry();
      visibilityListener = () => {
        if (document.visibilityState !== "visible") return;
        document.removeEventListener("visibilitychange", visibilityListener!);
        retry();
      };
      document.addEventListener("visibilitychange", visibilityListener);
    }, nextRetryAt - Date.now());
    return () => {
      clearTimeout(timer);
      if (visibilityListener) document.removeEventListener("visibilitychange", visibilityListener);
    };
  }, [sdk, routing, selectedProviderId, threadId, nextRetryAt]);

  return {
    providers,
    catalogFor: (providerId) => {
      const own = routing ? catalogs.get(catalogKey(routing, providerId)) : undefined;
      if ((own && own.status !== "loading") || lookupFailed) return own ?? LOADING;
      // Until this machine's list arrives, show the provider's last list, so a composer that
      // just opened, such as a thread's after the new-thread page sends, keeps its pickers.
      const models = own?.models.length ? own.models : lastListed.get(providerId);
      return models ? { status: "loading", models } : LOADING;
    },
    revision: `${routing ? routingKey(routing) : "pending"}|${providers.map((p) => p.id).join(",")}`,
    loadAll: (options) => {
      if (!enabled) return;
      if (threadId !== null) resolveThread(sdk, threadId, { refresh: true });
      if (!routing) return;
      for (const provider of providers) {
        load(sdk, routing, provider.id, { force: options?.force, retryErrors: true });
      }
    },
  };
}

/**
 * The routed machine's permission ceiling and the provider's modes, loading them when missing
 * and re-reading them when the machine's limit may have changed (see `watchPermissions`).
 * Undefined until the machine answers, so a picker shows its value read-only.
 */
export function usePermissionInfo(
  routing: CatalogRouting | null,
  providerId: string | null,
): PermissionInfo | undefined {
  const sdk = useSdk();
  useSyncExternalStore(subscribe, () => version);
  useEffect(
    () => (routing && providerId ? watchPermissions(sdk, routing, providerId) : undefined),
    [sdk, routing, providerId],
  );
  return routing && providerId ? permissions.get(catalogKey(routing, providerId)) : undefined;
}

/** A model's display name from its provider's most recent list, once BB has listed it. */
export function listedModelName(providerId: string, model: string): string | undefined {
  return findCatalogModel(lastListed.get(providerId) ?? [], model)?.displayName;
}

export function findCatalogModel(models: readonly CatalogModel[], model: string | undefined) {
  if (!model) return undefined;
  return models.find((candidate) => candidate.model === model || candidate.id === model);
}

/** For tests: forgets every read and lookup. */
export function forgetCatalogs(): void {
  catalogs.clear();
  permissions.clear();
  lastListed.clear();
  inFlight.clear();
  rerun.clear();
  threadLookups.clear();
  environmentHosts.clear();
  watched.clear();
  stopWatchingChanges?.();
  stopWatchingChanges = null;
}
