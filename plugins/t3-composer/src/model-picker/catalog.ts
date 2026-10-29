import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  experimental_useProviders as useProviders,
  useSdk,
  type ComposerSelection,
  type PluginBrowserBbSdk,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";

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
  | { status: "error"; models: readonly CatalogModel[]; message: string; fetchedAt: number };

const LOADING: ProviderCatalog = { status: "loading", models: [] };
const STALE_AFTER_MS = 5 * 60_000;
const REQUEST_DEADLINE_MS = 15_000;

/**
 * One app-wide cache shared by every mounted composer, keyed by routing and
 * provider, so two composers on the same machine share one request per provider.
 */
const catalogs = new Map<string, ProviderCatalog>();
const inFlight = new Set<string>();
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
}

function load(
  sdk: PluginBrowserBbSdk,
  routing: CatalogRouting,
  providerId: string,
  options: LoadOptions = {},
) {
  const key = catalogKey(routing, providerId);
  if (inFlight.has(key)) return;
  const cached = catalogs.get(key);
  if (!options.force && cached) {
    if (cached.status === "loading") return;
    if (cached.status === "error" && !options.retryErrors) return;
    if (cached.status === "ready" && Date.now() - cached.fetchedAt < STALE_AFTER_MS) return;
  }
  inFlight.add(key);
  // A refresh keeps the models already shown; only a cold miss shows loading.
  if (!cached) publish(key, LOADING);
  const failed = (message: string) =>
    publish(key, {
      status: "error",
      models: catalogs.get(key)?.models ?? [],
      message,
      fetchedAt: Date.now(),
    });
  Promise.resolve()
    .then(() =>
      sdk.providers.models({
        ...routingArgs(routing),
        providerId,
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      }),
    )
    .then((result) => {
      const message = errorMessage(result);
      if (message && result.models.length === 0) return failed(message);
      return publish(key, { status: "ready", models: result.models, fetchedAt: Date.now() });
    })
    .catch((error: unknown) =>
      failed(error instanceof Error ? error.message : "Could not load models."),
    )
    .finally(() => inFlight.delete(key));
}

type ThreadLookup = { status: "pending" } | { status: "ready"; environmentId: string | null };

/** Thread → environment. Failed reads are dropped, so the next ask retries instead of guessing a machine. */
const threadLookups = new Map<string, ThreadLookup>();

function resolveThread(
  sdk: PluginBrowserBbSdk,
  threadId: string,
  options: { refresh?: boolean } = {},
) {
  const current = threadLookups.get(threadId);
  if (current?.status === "pending") return;
  // A thread without an environment yet may get one once provisioned; re-read it when asked.
  if (current?.status === "ready" && (current.environmentId !== null || !options.refresh)) return;
  if (!current) threadLookups.set(threadId, { status: "pending" });
  Promise.resolve()
    .then(() => sdk.threads.get({ threadId, signal: AbortSignal.timeout(REQUEST_DEADLINE_MS) }))
    .then((thread) => {
      threadLookups.set(threadId, { status: "ready", environmentId: thread.environmentId ?? null });
      return notify();
    })
    .catch(() => {
      if (threadLookups.get(threadId)?.status === "pending") threadLookups.delete(threadId);
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

/** Resolves the composer's catalog routing; null while a thread's environment is still being read. */
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

  return {
    providers,
    catalogFor: (providerId) =>
      routing ? (catalogs.get(catalogKey(routing, providerId)) ?? LOADING) : LOADING,
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

export function findCatalogModel(models: readonly CatalogModel[], model: string | undefined) {
  if (!model) return undefined;
  return models.find((candidate) => candidate.model === model || candidate.id === model);
}
