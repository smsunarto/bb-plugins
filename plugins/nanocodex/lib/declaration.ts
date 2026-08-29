/**
 * `lib/declaration.ts` — the provider declaration.
 *
 * Server-side UX facts. The bridge's `initialize` capabilities are the
 * behavior facts. Nothing synchronizes the two, so `test/declaration.test.ts`
 * pins the pairs that must agree, and anything both sides state is read from
 * `src/catalog.ts` rather than written twice.
 */

import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import {
  DEFAULT_HISTORY_BUDGET_BYTES,
  NANOCODEX_MODELS,
  NANOCODEX_PROVIDER_ID,
  NANOCODEX_REASONING_LEVELS,
  NANOCODEX_SERVICE_TIERS,
} from "../src/catalog.ts";

/** Load-time facts the registration carries to the bridge. `deriveProviderOptions` is synchronous and sits on the turn-submit path, so it must resolve nothing itself. */
export interface NanocodexProviderPaths {
  readonly nanocodexCliPath: string;
}

/** Plugin settings, defined in `server.ts` and read here. */
export interface NanocodexSettings {
  readonly historyBudgetKb: number;
  readonly subagents: boolean;
  readonly webSearch: boolean;
  readonly imageGeneration: boolean;
  readonly mcpDefaults: boolean;
}

/**
 * Build the declaration.
 *
 * The load-bearing choices, each an honest consequence of a one-shot child
 * that reads no stdin:
 *
 *   permissionModes: ["full"]        The execution-options permission tuple is
 *     a discriminated union, and `accept-edits` and `auto` both require a
 *     reviewer the child cannot consult — it never pauses and cannot be
 *     asked. nanocodex executes unsandboxed; `full` is what that is called.
 *
 *   supportsNativeUserQuestion: false   No native ask-user tool reaches back.
 *
 *   fork: "checkpoint"               A ledger slice is a fork. The handshake
 *     may narrow this but never widen it, and it says `checkpoint` too.
 *
 *   supportsManualCompaction: true   `/compact` runs a summarizing turn and
 *     rewrites the ledger base. The stitched-prompt design makes context
 *     growth the user's problem, so it owes the user a lever.
 *
 *   supportsServiceTier: true        `nanocodex run --fast-mode true` selects
 *     priority processing (verified in `run --help`; env NANOCODEX_FAST_MODE).
 *     The tiers map 1:1 onto bb's default|fast enum, so the picker control is
 *     real: `run.ts` adds the flag when the turn's tier is "fast".
 *
 *   composerActions: []              No plan mode. Mapping bb's
 *     `promptMode: "plan"` onto an instruction prefix is possible and is a
 *     product choice, not a capability; it stays out of v1.
 *
 *   maintenance: {health, installation}, usage: false — `nanocodex credits`
 *     sits behind the optional `tempo` cargo feature and is absent from
 *     default builds. Probe, never assume.
 *
 * Dynamic tools arriving on `thread/start` are DROPPED and documented: the
 * child cannot call back into bb. `--mcp-stdio` plus a bridge-hosted shim
 * forwarding to `item/tool/call` is the eventual answer, and its syntax is
 * unverified, so v1 does not pretend.
 */
export function buildNanocodexProviderDeclaration(
  paths: NanocodexProviderPaths,
  settings: () => NanocodexSettings,
): PluginProviderDeclaration {
  return {
    id: NANOCODEX_PROVIDER_ID,
    displayName: "nanocodex",
    icon: "./assets/icon.svg",
    capabilities: {
      supportsServiceTier: true,
      supportsNativeUserQuestion: false,
      fork: "checkpoint",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: NANOCODEX_REASONING_LEVELS,
    },
    composerActions: [],
    reasoningLevels: NANOCODEX_REASONING_LEVELS.map((id) => ({ id, label: titleCase(id) })),
    serviceTiers: NANOCODEX_SERVICE_TIERS,
    models: { scope: "host", fallback: NANOCODEX_MODELS },
    maintenance: { health: true, usage: false, installation: true },
    strings: {
      signInHint:
        "Run `nanocodex auth status` on the host; nanocodex shares ~/.codex/auth.json with Codex, so `codex login` also signs it in.",
      expiredHint:
        "nanocodex credentials expired. Run `codex login` on the host to refresh ~/.codex/auth.json, which nanocodex shares with Codex.",
      // brandPrefix omitted: the validator rejects a blank string, and
      // nanocodex has no brand prefix to add.
      installUrl: "https://github.com/gakonst/nanocodex",
    },
    env: {
      passthrough: [
        "CODEX_HOME",
        "NANOCODEX_AUTH_FILE",
        "NANOCODEX_CLI_PATH",
        "NANOCODEX_ROLLOUTS",
        "NANOCODEX_FAST_MODE",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
      ],
    },
    deriveProviderOptions: () => {
      const current = settings();
      return {
        nanocodexCliPath: paths.nanocodexCliPath,
        historyBudgetBytes: current.historyBudgetKb * 1024 || DEFAULT_HISTORY_BUDGET_BYTES,
        features: {
          subagents: current.subagents,
          webSearch: current.webSearch,
          imageGeneration: current.imageGeneration,
          mcpDefaults: current.mcpDefaults,
        },
      };
    },
  };
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
