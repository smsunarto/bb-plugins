import { z } from "zod";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import { AMP_AGENT } from "../src/execution-target.ts";
import { AMP_FALLBACK_MODELS } from "../src/bridge/model-catalog.ts";
import type { OrbIntent } from "../src/orb-intent.ts";
import { AMP_NATIVE_SKILL_ROOTS } from "./provision.ts";
import { AMP_SENTRY_ENV } from "./telemetry.ts";

/** `amp/oracle` timeline items carry only this receipt. The report body
 *  stays in the XDG store on the thread's host, and the plugin's
 *  `getOracleReport` RPC fetches it from there through the host entry. */
export const oracleReceiptSchema = z.object({
  reportId: z.string().min(1),
  question: z.string(),
});

/** `amp/thread-link` thread state: which Amp thread a bb thread maps to and
 *  where it executes. The session emits it when the Amp thread id first
 *  arrives, and once per session for a record that already has one. */
export const threadLinkStateSchema = z.object({
  ampThreadId: z.string().nullable(),
  executionTarget: z.enum(["local", "orb"]),
  syncCommand: z.string().nullable(),
});

export type AmpThreadLinkState = z.infer<typeof threadLinkStateSchema>;

/**
 * The provider declaration for `bb.providers.register`. The executable
 * implementation is the plugin's own provider bridge — the
 * `experimental_providerBridge` export of the `bb.host` artifact — so there
 * is no launch spec: bb runs the bridge on the thread's host and the bridge
 * finds and spawns that host's Amp CLI itself. `id` never changes; "acp-amp"
 * is persisted on every existing thread.
 */
export function buildAmpProviderDeclaration(orb: OrbIntent): PluginProviderDeclaration {
  return {
    id: AMP_AGENT.providerId,
    displayName: AMP_AGENT.displayName,
    icon: "./assets/icon.svg",
    capabilities: {
      supportsServiceTier: true,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: true,
      supportsThreadRename: true,
      // The bridge only distinguishes `full` (dangerouslyAllowAll) from
      // everything else (src/bridge/options.ts), so "auto" would be a
      // second name for "accept-edits" and stays undeclared.
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["low", "medium", "high", "ultra"],
    },
    composerActions: [],
    // Wire ids, not labels: options.ts maps `serviceTier === "fast"` onto
    // Amp's fast mode and treats "default" as the absence of it.
    serviceTiers: [
      { id: "default", label: "Standard" },
      { id: "fast", label: "Fast", description: "Runs the turn in Amp's fast mode." },
    ],
    reasoningLevels: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "ultra", label: "Ultra" },
    ],
    // Local names; bb prefixes the plugin id ("amp") to form the wire values
    // AMP_ORACLE_KIND / AMP_THREAD_LINK_KIND in src/bridge/shapes.ts (the
    // declaration test pins the correspondence).
    extensionKinds: {
      oracle: { item: oracleReceiptSchema },
      "thread-link": { state: threadLinkStateSchema },
    },
    // One probe per host: the catalog is static (src/bridge/model-catalog.ts),
    // never workspace-dependent. The fallback mirrors the bridge's live
    // model/list answer so the picker is populated before any probe.
    models: { scope: "host", fallback: AMP_FALLBACK_MODELS },
    // The bridge answers provider/installation/{status,run}
    // (src/bridge/installation.ts); bb shows Install when the CLI is missing.
    maintenance: { installation: true },
    env: {
      passthrough: ["AMP_CLI_PATH", "AMP_URL", "AMP_API_KEY", ...AMP_SENTRY_ENV],
    },
    experimental_nativeSkillRoots: AMP_NATIVE_SKILL_ROOTS,
    // Synchronous and on the turn-submit path, so it answers from memory. A
    // thread's first command can take the armed intent (src/orb-intent.ts).
    // The bridge applies the target when thread/start creates a fresh record.
    deriveProviderOptions: ({ threadId }): Record<string, string> =>
      orb.runsOnOrb(threadId) ? { executionTarget: "orb" } : {},
  };
}
