import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ladderSchema, rungLabel, type LadderRole, type Rung } from "../contract/ladder.ts";
import { ROLE_SPECS } from "./roles.ts";
import type { Store } from "./store.ts";

/**
 * Which rung of a role's ladder a crew thread starts on. Eligibility comes
 * from the Account Pooler's `status.get`, the read behind `bb pool status`:
 * the pool knows which accounts are exhausted, and per Claude model family
 * which weekly caps are hit. A provider the pool does not route, such as an
 * ACP agent like Antigravity, is skipped only when bb's provider list says bb
 * would refuse it: not available, or without the role's permission mode.
 */

/** Rung 1 is the role's preset as `bb captain new` creates it; rung 2 is Codex. */
export const DEFAULT_LADDERS: Readonly<Record<LadderRole, readonly Rung[]>> = {
  implement: defaultLadder("implement", "high"),
  review: defaultLadder("review", "high"),
};

function defaultLadder(role: LadderRole, codexReasoning: string): Rung[] {
  const preset = ROLE_SPECS[role].preset;
  if (preset === null) throw new Error(`${role} has no preset`);
  return [
    { providerId: preset.providerId, model: preset.modelId, reasoningLevel: preset.reasoningLevel },
    { providerId: "codex", model: "gpt-6-astra", reasoningLevel: codexReasoning },
  ];
}

/**
 * The Tasks preset a rung dispatches with, such as `Captain Review · 2`.
 * Captain owns these and points them at its ladder; the shared `Review` preset
 * other dispatches use is only read, as the template for permission and
 * environment.
 */
export function rungPresetName(role: LadderRole, rung: number): string {
  return `Captain ${ROLE_SPECS[role].label} · ${rung}`;
}

/** The rung number a preset name carries: 1 for the role's shared preset. */
export function rungOfPresetName(name: string): number {
  const match = / · (\d+)$/u.exec(name.trim());
  return match === null ? 1 : Number(match[1]);
}

const PROVIDER_POOL: Readonly<Record<string, string>> = { "claude-code": "claude", codex: "codex" };
const CLAUDE_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;

const familySchema = z
  .object({
    utilization: z.number().nullable().optional(),
    resetAt: z.number().nullable().optional(),
    status: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

/** The fields of `status.get` eligibility reads; the rest passes through. */
const poolSchema = z.object({
  routing: z.record(z.string(), z.boolean()).optional(),
  accounts: z.array(
    z.object({
      provider: z.string(),
      enabled: z.boolean(),
      status: z.string(),
      familyWeekly: z.record(z.string(), familySchema).nullable().optional(),
    }),
  ),
});
export type PoolView = z.infer<typeof poolSchema>;

export const POOL_PLUGIN_ID = "account-pool";
const POOL_DEADLINE_MS = 5_000;

/** The pool's accounts, or null when the Account Pooler cannot be read. */
export async function readPool(bb: Pick<BbPluginApi, "sdk" | "log">): Promise<PoolView | null> {
  try {
    return await bb.sdk.plugins.callRpc({
      pluginId: POOL_PLUGIN_ID,
      method: "status.get",
      input: null as never,
      outputSchema: poolSchema,
      signal: AbortSignal.timeout(POOL_DEADLINE_MS),
    });
  } catch (error) {
    bb.log.warn(`Account Pooler status not read: ${(error as Error).message}`);
    return null;
  }
}

/** What bb's provider list says about one provider, as eligibility reads it. */
export type ProviderView = { available: boolean; permissionModes: readonly string[] };
/** Each provider bb lists, by id; null when the list cannot be read. */
export type ProviderViews = ReadonlyMap<string, ProviderView>;

/** bb's providers on its primary machine, or null when bb does not answer in time. */
export async function readProviders(
  bb: Pick<BbPluginApi, "sdk" | "log">,
): Promise<ProviderViews | null> {
  try {
    const providers = await bb.sdk.providers.list({
      signal: AbortSignal.timeout(POOL_DEADLINE_MS),
    });
    return new Map(
      providers.map((provider) => [
        provider.id,
        {
          available: provider.available,
          permissionModes: [...provider.capabilities.permissionModes],
        },
      ]),
    );
  } catch (error) {
    bb.log.warn(`provider list not read: ${(error as Error).message}`);
    return null;
  }
}

/**
 * What a rung is checked against besides the pool: bb's providers, and the
 * permission mode the rung's preset starts threads with (its own preset's,
 * else the role preset's it will copy). Null when not read: that check passes.
 */
export type RungChecks = {
  providers: ProviderViews | null;
  permissionMode: (rung: number) => string | null;
};

/** The permission mode a rung's thread starts with: its own preset's, else the role preset's. */
export function rungPermissionMode(
  presets: readonly { name: string; permissionMode?: string | undefined }[],
  role: LadderRole,
): (rung: number) => string | null {
  const named = (name: string) =>
    presets.find((preset) => preset.name.toLowerCase() === name.toLowerCase());
  const template = named(ROLE_SPECS[role].preset?.name ?? "");
  return (rung) => (named(rungPresetName(role, rung)) ?? template)?.permissionMode ?? null;
}

export type Eligibility = { eligible: true } | { eligible: false; reason: string };

/**
 * Why bb would refuse to start a rung's thread: its provider is not available,
 * or does not take the role's permission mode, as ACP agents such as
 * Antigravity take no `auto`. Null when nothing stops it.
 */
export function rungRefusal(spec: Rung, rung: number, checks: RungChecks): string | null {
  const provider = checks.providers?.get(spec.providerId);
  if (provider === undefined) return null;
  if (!provider.available) return `${spec.providerId} is not available`;
  const mode = checks.permissionMode(rung);
  if (mode !== null && !provider.permissionModes.includes(mode)) {
    return `${spec.providerId} does not take permission mode ${mode}`;
  }
  return null;
}

/**
 * Whether a rung can start now: bb would accept its provider and permission
 * mode, and the pool has an account it would route this model to.
 */
export function rungEligibility(
  rung: Rung,
  pool: PoolView | null,
  now: number,
  checks?: { rung: number } & RungChecks,
): Eligibility {
  const refusal = checks === undefined ? null : rungRefusal(rung, checks.rung, checks);
  if (refusal !== null) return { eligible: false, reason: refusal };
  const provider = PROVIDER_POOL[rung.providerId];
  if (provider === undefined || pool === null || pool.routing?.[provider] !== true) {
    return { eligible: true };
  }
  const family =
    provider === "claude"
      ? (CLAUDE_FAMILIES.find((name) => rung.model.toLowerCase().includes(name)) ?? "other")
      : null;
  const usable = pool.accounts.some((account) => {
    if (account.provider !== provider || !account.enabled || account.status !== "ready")
      return false;
    const cap = family === null ? null : account.familyWeekly?.[family];
    if (cap === null || cap === undefined) return true;
    const capped = cap.status === "rejected" || (cap.utilization ?? 0) >= 1;
    return !capped || (cap.resetAt !== null && cap.resetAt !== undefined && cap.resetAt <= now);
  });
  if (usable) return { eligible: true };
  return {
    eligible: false,
    reason: `no ready ${provider} account${family === null ? "" : ` with ${family} left`}`,
  };
}

export type RungChoice = {
  /** 1-based, as the CLI and presets name it. */
  rung: number;
  spec: Rung;
  /** Rungs passed over on the way, each with why. */
  skipped: string[];
  forced: boolean;
};

/**
 * The first eligible rung after `after` (0 to start at rung 1), or the forced
 * rung. Null when every remaining rung is ineligible; `skipped` says why.
 */
export function pickRung(
  ladder: readonly Rung[],
  pool: PoolView | null,
  now: number,
  options: { after?: number; forced?: number; checks?: RungChecks } = {},
): RungChoice | { rung: null; skipped: string[] } {
  if (options.forced !== undefined) {
    const spec = ladder[options.forced - 1];
    if (spec === undefined) throw new Error(`no rung ${options.forced}`);
    return { rung: options.forced, spec, skipped: [], forced: true };
  }
  const skipped: string[] = [];
  for (let index = options.after ?? 0; index < ladder.length; index++) {
    const spec = ladder[index] as Rung;
    const verdict = rungEligibility(
      spec,
      pool,
      now,
      options.checks === undefined ? undefined : { rung: index + 1, ...options.checks },
    );
    if (verdict.eligible) return { rung: index + 1, spec, skipped, forced: false };
    skipped.push(`rung ${index + 1} ${rungLabel(spec)}: ${verdict.reason}`);
  }
  return { rung: null, skipped };
}

export const RETRY_PLUGIN_ID = "provider-retry";

const retryDecisionSchema = z
  .object({
    observedAt: z.number(),
    decision: z.object({ kind: z.string(), sendAt: z.number().optional() }),
  })
  .nullable();
export type RetryDecision = z.infer<typeof retryDecisionSchema>;

/**
 * bb's provider-retry decision on a thread's last failed request: `retry`
 * means bb runs it again itself, `decline` means it will not. Undefined when
 * provider-retry cannot be read.
 */
export async function readRetryDecision(
  bb: Pick<BbPluginApi, "sdk">,
  threadId: string,
): Promise<RetryDecision | undefined> {
  try {
    return await bb.sdk.plugins.callRpc({
      pluginId: RETRY_PLUGIN_ID,
      method: "decision.get",
      input: { threadId } as never,
      outputSchema: retryDecisionSchema,
      signal: AbortSignal.timeout(POOL_DEADLINE_MS),
    });
  } catch {
    return undefined;
  }
}

/** A role's ladder: the saved one from Captain settings, else the default. */
export function roleLadder(
  store: Pick<Store, "ladderJson">,
  role: LadderRole,
): { rungs: Rung[]; custom: boolean } {
  const json = store.ladderJson(role);
  if (json !== null) {
    const parsed = ladderSchema.safeParse(JSON.parse(json));
    if (parsed.success) return { rungs: parsed.data, custom: true };
  }
  return { rungs: [...DEFAULT_LADDERS[role]], custom: false };
}
