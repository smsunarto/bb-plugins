/**
 * `src/bridge/options.ts` — native execution-option vocabulary → Amp
 * vocabulary. Pure mapping, wired to `conversation.ts` only; the native
 * session layer (U5) calls these when building a `SessionShape` and
 * per-message options.
 *
 * Sketch deviations, forced by the verified `BridgeExecutionOptions` schema
 * (provider-bridge.d.ts:4713-4755): the sketch's `serviceTier: "priority"`,
 * `permissionMode: "bypass"`, and `reasoningLevel: "minimal"` vocabulary
 * does not exist. Real enums: serviceTier `default | fast`; permissionMode
 * `accept-edits | auto | full`; reasoningLevel
 * `none | low | medium | high | xhigh | max | ultra | ultracode`.
 * `promptMode: "plan"` has no Amp equivalent and is ignored here; whether to
 * declare it unsupported is a declaration concern (U6).
 */
import { z } from "zod";
import type { BridgeExecutionOptions } from "@get-bb/plugin-sdk/provider-bridge";
import type { SessionShape } from "./conversation.ts";
import type { AmpPermissionRule } from "./execute.ts";

export type { AmpPermissionRule } from "./execute.ts";

/** Provider-flavored knobs bb passes through untouched in `providerOptions`. */
export const ampProviderOptionsSchema = z
  .object({
    /** Absolute path of the Amp CLI the bridge spawns (registration-resolved,
     * and the test seam). */
    ampCliPath: z.string().min(1).optional(),
    /** Amp project for new Orb threads. */
    orbProject: z.string().min(1).optional(),
  })
  .partial();

export type AmpProviderOptions = z.infer<typeof ampProviderOptionsSchema>;

/** Never throws: an absent or malformed bag reads as all-defaults. */
export function readProviderOptions(raw: unknown): AmpProviderOptions {
  const parsed = ampProviderOptionsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

export function toSessionShape(args: {
  cwd: string;
  options: BridgeExecutionOptions;
  disallowedTools: readonly string[];
  mcpConfigDigest: string;
  /** Amp Fast mode only applies before the session's first Amp thread
   * exists; a continued thread keeps its original service tier. */
  firstExecution: boolean;
}): SessionShape {
  return {
    cwd: args.cwd,
    mode: modeFor(args.options.reasoningLevel),
    dangerouslyAllowAll: args.options.permissionMode === "full",
    fast: args.options.serviceTier === "fast" && args.firstExecution,
    denied: [...args.disallowedTools],
    mcpConfigDigest: args.mcpConfigDigest,
  };
}

/** Per-message knobs that do not force a new Amp process. */
export function toMessageOptions(options: BridgeExecutionOptions): {
  model: string | null;
  instructions: string | null;
} {
  return {
    model: options.model ?? null,
    instructions: options.instructions ?? null,
  };
}

/** bb `disallowedTools` → `amp.permissions` rules for the settings file the
 * owned execute layer writes (`{ tool, action: "reject" }` per entry). */
export function toAmpPermissions(disallowed: readonly string[]): AmpPermissionRule[] {
  return disallowed.map((tool) => ({ tool, action: "reject" }));
}

/**
 * bb reasoning ladder → Amp's four modes. Exhaustive over the verified enum;
 * an absent level means the bb default, which maps to Amp "medium".
 */
function modeFor(level: BridgeExecutionOptions["reasoningLevel"]): SessionShape["mode"] {
  switch (level) {
    case "none":
    case "low":
      return "low";
    case undefined:
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
      return "high";
    case "max":
    case "ultra":
    case "ultracode":
      return "ultra";
  }
}
