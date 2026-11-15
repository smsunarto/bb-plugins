import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { useSdk, type PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import type { EnvironmentProvider, Host, Project } from "./machine-options";

/** One read: the last good value stays on screen through a refresh or a failed one. */
export interface Resource<T> {
  value: T | undefined;
  loading: boolean;
  error: string | null;
}

export interface MachineData {
  hosts: Resource<readonly Host[]>;
  /** The project's environment catalog, with each provider's availability per machine. */
  providers: Resource<readonly EnvironmentProvider[]>;
  project: Resource<Project>;
}

const DEADLINE_MS = 10_000;
const EMPTY: Resource<never> = { value: undefined, loading: false, error: null };

/** App-wide, so every new-thread composer opens on what the last one loaded. */
const cache = new Map<string, Resource<unknown>>();
const listeners = new Set<() => void>();
let version = 0;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(key: string, resource: Resource<unknown>) {
  cache.set(key, resource);
  version += 1;
  for (const listener of listeners) listener();
}

/** Re-reads `key`, keeping its last value meanwhile; a read already running is shared. */
function refresh<T>(key: string, read: (signal: AbortSignal) => Promise<T>) {
  const current = cache.get(key) ?? EMPTY;
  if (current.loading) return;
  set(key, { ...current, loading: true });
  read(AbortSignal.timeout(DEADLINE_MS)).then(
    (value) => set(key, { value, loading: false, error: null }),
    (reason: unknown) =>
      set(key, {
        value: current.value,
        loading: false,
        error:
          reason instanceof DOMException && reason.name === "TimeoutError"
            ? "BB took too long to answer."
            : reason instanceof Error
              ? reason.message
              : String(reason),
      }),
  );
}

function reads(sdk: PluginBrowserBbSdk, projectId: string) {
  return {
    hosts: () => refresh("hosts", (signal) => sdk.hosts.list({ signal })),
    providers: () =>
      refresh(`providers:${projectId}`, (signal) =>
        sdk.environments.listProviders({ projectId, signal }),
      ),
    project: () =>
      refresh(`project:${projectId}`, (signal) => sdk.projects.get({ projectId, signal })),
  };
}

/**
 * The machines, environments and project the machine sheet lists. Shows what is cached at
 * once and refreshes all three each time the sheet opens, so a machine that came online since
 * shows up without a reload. Three reads, none per machine.
 */
export function useMachineData(projectId: string | undefined, open: boolean): MachineData {
  const sdk = useSdk();
  useSyncExternalStore(subscribe, () => version);

  const load = useEffectEvent((id: string) => retryMachineData(sdk, id));
  useEffect(() => {
    if (open && projectId) load(projectId);
  }, [open, projectId]);

  return {
    hosts: (cache.get("hosts") ?? EMPTY) as Resource<readonly Host[]>,
    providers: (cache.get(`providers:${projectId}`) ?? EMPTY) as Resource<
      readonly EnvironmentProvider[]
    >,
    project: (cache.get(`project:${projectId}`) ?? EMPTY) as Resource<Project>,
  };
}

/** Reads all three again; a read already running is shared. */
export function retryMachineData(sdk: PluginBrowserBbSdk, projectId: string) {
  const read = reads(sdk, projectId);
  read.hosts();
  read.providers();
  read.project();
}
