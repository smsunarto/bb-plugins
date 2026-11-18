import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ladderSchema, rungLabel, type LadderRole, type Rung } from "../contract/ladder.ts";
import { ROLE_SPECS } from "./roles.ts";
import type { Store } from "./store.ts";

/**
 * Which rung of a role's ladder a crew thread starts on. Eligibility comes
 * from the Account Pooler's `status.get`, the read behind `bb pool status`:
 * the pool knows which accounts are exhausted, and per Claude model family
 * which weekly caps are hit. A provider the pool does not route is never
 * skipped, since Captain cannot see its credentials.
 */

/** Rung 1 is the role's preset as `bb captain new` creates it; rung 2 is Codex. */
export const DEFAULT_LADDERS: Readonly<Record<LadderRole, readonly Rung[]>> = {
  plan: defaultLadder("plan", "xhigh"),
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

/** The Tasks preset a rung dispatches with: the role's own preset for rung 1, `Review · 2` after. */
export function rungPresetName(role: LadderRole, rung: number): string {
  const label = ROLE_SPECS[role].label;
  return rung === 1 ? label : `${label} · ${rung}`;
}

/** The rung number a preset name carries: 1 for the role's own preset. */
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

export type Eligibility = { eligible: true } | { eligible: false; reason: string };

/** Whether a rung's provider has an account the pool would route this model to now. */
export function rungEligibility(rung: Rung, pool: PoolView | null, now: number): Eligibility {
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
  options: { after?: number; forced?: number } = {},
): RungChoice | { rung: null; skipped: string[] } {
  if (options.forced !== undefined) {
    const spec = ladder[options.forced - 1];
    if (spec === undefined) throw new Error(`no rung ${options.forced}`);
    return { rung: options.forced, spec, skipped: [], forced: true };
  }
  const skipped: string[] = [];
  for (let index = options.after ?? 0; index < ladder.length; index++) {
    const spec = ladder[index] as Rung;
    const verdict = rungEligibility(spec, pool, now);
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
