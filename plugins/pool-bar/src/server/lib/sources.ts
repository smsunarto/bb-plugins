import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  builtinAccount,
  builtinProvider,
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
import { type AccountExtras, claudeExtras, codexExtras, NO_EXTRAS } from "./extras.ts";
import { accountListSchema, type MenuAccount, type MenuProvider, poolProviders } from "./pool.ts";

export const POOL_PLUGIN_ID = "account-pool";

/** Where the menu's accounts come from, and how to reach each one's extras. */
export interface Source {
  kind: "pool" | "builtin";
  providers: MenuProvider[];
  extras(
    provider: MenuProvider["id"],
    accountId: string,
    refresh?: boolean,
  ): Promise<AccountExtras>;
}

type Collected = {
  provider: MenuProvider["id"];
  account: MenuAccount;
  accountKey: string | null;
  email: string | null;
};

function webFallback(
  source: Source,
  accounts: { id: string; email: string | null }[],
  readWeb: ClaudeWebReader,
  signal: AbortSignal,
): Source {
  // An extras fan-out may finish its OAuth calls at different times. Share one web
  // observation for this source even when an explicit refresh bypasses the service cache.
  let web: ReturnType<ClaudeWebReader> | null = null;
  return {
    ...source,
    async extras(provider, accountId, refresh = false) {
      const extras = await source.extras(provider, accountId);
      if (provider !== "claude" || extras.resetCredits !== null) return extras;
      const email = normalizeEmail(accounts.find((account) => account.id === accountId)?.email);
      if (
        !email ||
        accounts.filter((account) => normalizeEmail(account.email) === email).length !== 1
      )
        return extras;
      web ??= readWeb(signal, refresh);
      return withClaudeWeb(extras, accountId, accounts, await web);
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
      async extras(provider, accountId) {
        const token = await poolToken(dataDir, accountId);
        if (token === null) return NO_EXTRAS;
        return provider === "codex"
          ? codexExtras(token, codexIds.get(accountId) ?? null)
          : claudeExtras(token);
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
    const measurement = await entry.measurement;
    const account = builtinAccount(`${pluginId}:${resource.id}`, resource, measurement, 1);
    if (account !== null)
      collected.push({
        provider,
        account,
        accountKey: measurement.usage.status === "ok" ? measurement.accountKey : null,
        email:
          measurement.usage.status === "ok" && measurement.accountKey
            ? (measurement.usage.accountEmail ?? null)
            : null,
      });
  }
  return collected;
}

/** The CLI's own signed-in account, unless the CLI switched accounts since collection. */
async function localExtras(provider: MenuProvider["id"], accountKey: string | null | undefined) {
  if (!accountKey) return NO_EXTRAS;
  const credential = await (provider === "codex" ? localCodex() : localClaude());
  if (credential === null) return NO_EXTRAS;
  if (credential.accountKey !== accountKey) return NO_EXTRAS;
  return provider === "codex"
    ? codexExtras(credential.token, credential.accountId)
    : claudeExtras(credential.token);
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
  for (const { pluginId } of sources) {
    if (pluginId === POOL_PLUGIN_ID) continue;
    try {
      collected.push(...(await collect(bb, pluginId, primaryHostId, signal, refresh, cache)));
    } catch (error) {
      if (signal.aborted) throw error;
      bb.log.warn(`pool-bar: usage source ${pluginId} unavailable.`);
    }
  }
  const providers = (["codex", "claude"] as const).flatMap((id) => {
    const accounts = collected
      .filter((entry) => entry.provider === id)
      .map(({ account }) => account);
    accounts.forEach((account, index) => {
      account.priority = index + 1;
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
      extras: (provider, accountId) => localExtras(provider, identities.get(accountId)),
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
