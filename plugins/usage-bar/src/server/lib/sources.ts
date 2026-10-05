import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  builtinAccount,
  builtinProvider,
  type Measurement,
  measurementSchema,
  onHost,
  resourceListSchema,
  USAGE_FETCH_METHOD,
  USAGE_LIST_METHOD,
} from "./builtin.ts";
import { localClaude, localCodex, poolToken } from "./credentials.ts";
import {
  type ClaudeWebReader,
  createClaudeWebReader,
  normalizeEmail,
  withClaudeWeb,
} from "./claude-web.ts";
import { claudeExtras, codexExtras, type ExtrasUpdate, NO_EXTRAS } from "./extras.ts";
import { accountListSchema, type MenuAccount, type MenuProvider, poolProviders } from "./pool.ts";

export const POOL_PLUGIN_ID = "account-pool";

type ExtrasReader = (provider: MenuProvider["id"], accountId: string) => Promise<ExtrasUpdate>;

/** Where the menu's accounts come from, and how to reach each one's extras. */
export interface Source {
  kind: "pool" | "builtin";
  providers: MenuProvider[];
  /** Each call creates one fan-out batch. Observations are shared only within that batch. */
  extras(refresh?: boolean): ExtrasReader;
}

type Collected = {
  provider: MenuProvider["id"];
  account: MenuAccount;
  accountKey: string | null;
  email: string | null;
};

function collectedAccount(
  id: string,
  resource: Parameters<typeof builtinAccount>[1],
  measurement: Measurement,
  provider: MenuProvider["id"],
): Collected | null {
  const account = builtinAccount(id, resource, measurement, 1);
  if (account === null) return null;
  const accountKey = measurement.usage.status === "ok" ? measurement.accountKey : null;
  const email = measurement.usage.status === "ok" ? measurement.usage.accountEmail : null;
  return { provider, account, accountKey, email: accountKey ? (email ?? null) : null };
}

function webFallback(
  source: Source,
  accounts: { id: string; email: string | null }[],
  readWeb: ClaudeWebReader,
  signal: AbortSignal,
): Source {
  return {
    ...source,
    extras(refresh = false) {
      const read = source.extras(refresh);
      // OAuth requests can finish at different times. Share one web observation
      // across this fan-out, then let the next batch reach the reader's cache.
      let web: ReturnType<ClaudeWebReader> | null = null;
      return async (provider, accountId) => {
        const extras = await read(provider, accountId);
        // Credits OAuth reported win. Unknown ones (a transient failure) still ask the web.
        if (provider !== "claude" || extras.resetCredits != null) return extras;
        const email = normalizeEmail(accounts.find((account) => account.id === accountId)?.email);
        if (
          !email ||
          accounts.filter((account) => normalizeEmail(account.email) === email).length !== 1
        )
          return extras;
        web ??= readWeb(signal, refresh);
        return withClaudeWeb(extras, accountId, accounts, await web);
      };
    },
  };
}

const BUILTIN_MS = 5 * 60_000;
type UsageCache = Map<
  string,
  { at: number; measurement: Promise<import("./builtin.ts").Measurement> }
>;

type PluginSources = Awaited<ReturnType<BbPluginApi["sdk"]["plugins"]["experimental_discoverRpc"]>>;

/** Account Pooler's accounts, or null when it holds none. */
async function poolSource(
  bb: BbPluginApi,
  signal: AbortSignal,
  readWeb: ClaudeWebReader,
): Promise<Source | null> {
  const accounts = await bb.sdk.plugins.callRpc({
    pluginId: POOL_PLUGIN_ID,
    method: "account.list",
    input: null,
    outputSchema: accountListSchema,
    signal,
  });
  if (accounts.length === 0) return null;
  const dataDir = bb.server.experimental_dataDir;
  const codexIds = new Map(accounts.map((account) => [account.id, account.codexAccountId]));
  return webFallback(
    {
      kind: "pool",
      providers: poolProviders(accounts),
      extras: () => async (provider, accountId) => {
        const token = await poolToken(dataDir, accountId);
        if (token === null) return NO_EXTRAS;
        return provider === "codex"
          ? codexExtras(token, codexIds.get(accountId) ?? null, signal)
          : claudeExtras(token, signal);
      },
    },
    accounts.filter((account) => account.provider === "claude"),
    readWeb,
    signal,
  );
}

/** One built-in source's accounts on this Mac. */
async function collect(
  bb: BbPluginApi,
  pluginId: string,
  hostId: string | null,
  signal: AbortSignal,
  refresh: boolean,
  cache: UsageCache,
): Promise<Collected[]> {
  const { resources } = await bb.sdk.plugins.callRpc({
    pluginId,
    method: USAGE_LIST_METHOD,
    input: {},
    outputSchema: resourceListSchema,
    signal,
  });
  const collected: Collected[] = [];
  let failures = 0;
  for (const resource of resources) {
    const provider = builtinProvider(resource);
    if (provider === null || !onHost(resource, hostId)) continue;
    const key = `${pluginId}:${resource.id}`;
    let entry = cache.get(key);
    if (!entry || refresh || Date.now() - entry.at >= BUILTIN_MS) {
      entry = {
        at: Date.now(),
        measurement: bb.sdk.plugins.callRpc({
          pluginId,
          method: USAGE_FETCH_METHOD,
          input: { resourceId: resource.id, refresh },
          outputSchema: measurementSchema,
          signal,
        }),
      };
      cache.set(key, entry);
    }
    let measurement: import("./builtin.ts").Measurement;
    try {
      measurement = await entry.measurement;
    } catch (error) {
      if (signal.aborted) throw error;
      failures++;
      bb.log.warn(`usage-bar: one ${pluginId} usage resource unavailable.`);
      continue;
    }
    const account = collectedAccount(key, resource, measurement, provider);
    if (account !== null) collected.push(account);
  }
  if (!collected.length && failures) throw new Error("Usage resources unavailable");
  return collected;
}

/** The CLI's own signed-in account, unless the CLI switched accounts since collection. */
async function localExtras(
  provider: MenuProvider["id"],
  accountKey: string | null | undefined,
  signal: AbortSignal,
) {
  if (!accountKey) return NO_EXTRAS;
  const credential = await (provider === "codex" ? localCodex() : localClaude());
  if (credential === null) return NO_EXTRAS;
  if (credential.accountKey !== accountKey) return NO_EXTRAS;
  return provider === "codex"
    ? codexExtras(credential.token, credential.accountId, signal)
    : claudeExtras(credential.token, signal);
}

/** bb's built-in providers: the account signed in to each CLI on this Mac. */
async function builtinSource(
  bb: BbPluginApi,
  sources: PluginSources,
  signal: AbortSignal,
  refresh: boolean,
  cache: UsageCache,
  readWeb: ClaudeWebReader,
): Promise<Source> {
  const { primaryHostId } = await bb.sdk.system.config();
  const collected: Collected[] = [];
  let failures = 0;
  for (const { pluginId } of sources) {
    if (pluginId === POOL_PLUGIN_ID) continue;
    try {
      collected.push(...(await collect(bb, pluginId, primaryHostId, signal, refresh, cache)));
    } catch (error) {
      if (signal.aborted) throw error;
      failures++;
      bb.log.warn(`usage-bar: usage source ${pluginId} unavailable.`);
    }
  }
  if (!collected.length && failures) throw new Error("Usage sources unavailable");
  const providers = (["codex", "claude"] as const).flatMap((id) => {
    const accounts = collected
      .filter((entry) => entry.provider === id)
      .map(({ account }) => account);
    accounts.forEach((account, index) => {
      account.current = index === 0;
    });
    return accounts.length > 0 ? [{ id, name: id === "codex" ? "Codex" : "Claude", accounts }] : [];
  });
  const identities = new Map(
    collected.map(({ account, accountKey }) => [account.id, accountKey] as const),
  );
  return webFallback(
    {
      kind: "builtin",
      providers,
      extras: () => (provider, accountId) =>
        localExtras(provider, identities.get(accountId), signal),
    },
    collected
      .filter((entry) => entry.provider === "claude")
      .map(({ account, email }) => ({ id: account.id, email })),
    readWeb,
    signal,
  );
}

/**
 * Account Pooler when it is loaded and holds accounts, otherwise the built-in
 * providers' signed-in accounts on this Mac. `refresh` asks the built-in sources
 * for a fresh collection; pool refreshes go through `account.refreshUsage`.
 */
async function readSource(
  bb: BbPluginApi,
  signal: AbortSignal,
  refresh: boolean,
  cache: UsageCache,
  readWeb: ClaudeWebReader,
): Promise<Source> {
  const sources = await bb.sdk.plugins.experimental_discoverRpc({ method: USAGE_LIST_METHOD });
  if (sources.some((source) => source.pluginId === POOL_PLUGIN_ID)) {
    const pool = await poolSource(bb, signal, readWeb);
    if (pool !== null) return pool;
  }
  return builtinSource(bb, sources, signal, refresh, cache, readWeb);
}

/** The service owns one cache, including failed collections, to avoid keychain prompt storms. */
export function createSourceReader(
  bb: BbPluginApi,
  readWeb: ClaudeWebReader = createClaudeWebReader(),
) {
  const cache: UsageCache = new Map();
  return (signal: AbortSignal, refresh: boolean) => readSource(bb, signal, refresh, cache, readWeb);
}
