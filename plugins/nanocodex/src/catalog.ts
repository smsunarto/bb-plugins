/**
 * `src/catalog.ts` — the plugin's fixed facts, as a subpath-free leaf.
 *
 * A leaf on purpose: production bb loads a path-installed plugin's `server.ts`
 * from source, and its runtime shim cannot resolve `@get-bb/plugin-sdk`
 * subpaths. Everything `server.ts` reaches transitively must therefore import
 * nothing but `zod`, node builtins, and the SDK root. This module imports
 * nothing at all.
 *
 * Single source of truth for anything the declaration and the bridge both
 * state. A fact stated twice is a fact that drifts, so the model catalog, the
 * reasoning ladder, the minimum version, and the context window each live
 * here once and are read from both sides.
 */

/** The bb provider id. Derived from the package name (`@smsunarto/bb-plugin-nanocodex`); stable forever once a thread persists it. */
export const NANOCODEX_PROVIDER_ID = "nanocodex";

/** Minimum nanocodex the bridge is written against. Health reports `unsupported_version` below it. */
export const MINIMUM_NANOCODEX_VERSION = "0.5.0";

/**
 * `CONTEXT_WINDOW_TOKENS` from `nanocodex-oai-api/src/lib.rs`. Reported as
 * `usage.modelContextWindow`. `MAX_CONTEXT_WINDOW_TOKENS` (872_000) also
 * exists in that file; whether it applies per model is unconfirmed, so the
 * conservative number is the one we report.
 */
export const NANOCODEX_CONTEXT_WINDOW_TOKENS = 272_000;

/**
 * Env var naming the nanocodex executable, read by the *server* at
 * registration (`lib/provision.ts`) and echoed to the bridge through
 * `deriveProviderOptions`. User-facing.
 */
export const NANOCODEX_CLI_PATH_ENV = "NANOCODEX_CLI_PATH";

/**
 * Test seam: overrides the command and argv prefix the bridge spawns per
 * turn. `BB_`-prefixed on purpose — `sanitizeInheritedChildProcessEnv` strips
 * `BB_*` from the child, so the override can never reach nanocodex itself.
 * `test/conformance.test.ts` sets these to the fake CLI.
 */
export const NANOCODEX_COMMAND_OVERRIDE_ENV = "BB_NANOCODEX_COMMAND";
export const NANOCODEX_ARGS_OVERRIDE_ENV = "BB_NANOCODEX_ARGS";

/**
 * bb reasoning levels that map 1:1 onto `--thinking`. `ultracode` and `ultra`
 * have no nanocodex spelling, so they are absent from the declared ladder and
 * `run.ts` treats them as "omit the flag" if one ever arrives.
 */
export const NANOCODEX_REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type NanocodexReasoningLevel = (typeof NANOCODEX_REASONING_LEVELS)[number];

/**
 * The model catalog. `nanocodex run --help` documents the full ids
 * (gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna) as the `--model` values, so the
 * bb model id and the CLI argument are the same string and nothing has to
 * translate. Short names are not documented and are not used. Served twice —
 * as the declaration's cold-cache fallback and as the bridge's live
 * `model/list` answer — from this one constant.
 */
const FULL_REASONING_LADDER = NANOCODEX_REASONING_LEVELS.map((level) => ({
  reasoningEffort: level,
  description: `--thinking ${level}`,
}));

export const NANOCODEX_MODELS = [
  {
    id: "gpt-5.6-sol",
    displayName: "Sol",
    description: "The default nanocodex model.",
    supportedReasoningEfforts: FULL_REASONING_LADDER,
    defaultReasoningEffort: "high",
    isDefault: true,
  },
  {
    id: "gpt-5.6-terra",
    displayName: "Terra",
    description: "Selects --model gpt-5.6-terra.",
    supportedReasoningEfforts: FULL_REASONING_LADDER,
    defaultReasoningEffort: "high",
    isDefault: false,
  },
  {
    id: "gpt-5.6-luna",
    displayName: "Luna",
    description: "Selects --model gpt-5.6-luna.",
    supportedReasoningEfforts: FULL_REASONING_LADDER,
    defaultReasoningEffort: "high",
    isDefault: false,
  },
] as const;

/**
 * Service tiers. `--fast-mode <bool>` (default false, env NANOCODEX_FAST_MODE)
 * is documented as "Use priority processing for model requests", which maps
 * 1:1 onto bb's closed default|fast tier enum. The declaration lists these
 * and `run.ts` adds `--fast-mode true` when the turn's tier is "fast".
 */
export const NANOCODEX_SERVICE_TIERS = [
  { id: "default", label: "Standard" },
  { id: "fast", label: "Fast", description: "Priority processing (--fast-mode)" },
] as const;

/** The daemon's `model/list` result additionally requires the raw provider `model` string. */
export const NANOCODEX_WIRE_MODELS = NANOCODEX_MODELS.map((entry) =>
  Object.assign({}, entry, { model: entry.id }),
);

/**
 * Default history budget for a stitched prompt, in bytes of rendered text.
 * Bytes, not tokens: the bridge cannot tokenize, and pretending otherwise
 * would turn an estimate into a fake measurement. 60 KB is roughly 15k tokens
 * at the ~4 bytes/token the fixtures show, which costs about $0.13 of input
 * per turn on top of nanocodex's ~13.4k-token fixed overhead. Overridable per
 * install through the `historyBudgetKb` plugin setting.
 *
 * @see src/bridge/prompt.ts for how the budget is spent.
 */
export const DEFAULT_HISTORY_BUDGET_BYTES = 60_000;
