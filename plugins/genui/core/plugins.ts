// Plugins: the BB plugins a handoff says it installed, reloaded or removed,
// each beside what BB runs now. The agent supplies only the claim (id, action,
// note); the name, version, source and status are BB's. A claim BB's state
// contradicts (reloaded but not running, removed but still installed) is
// marked. BB reports no load time, so a matching row says the plugin runs,
// not that the reload happened. Pure: no React, no DOM.
import { fieldsOf, str } from "./fields";
import type { Value } from "./types";

export type PluginAction = "installed" | "reloaded" | "removed" | "not-reloaded";

export const PLUGIN_ACTIONS: readonly PluginAction[] = [
  "installed",
  "reloaded",
  "removed",
  "not-reloaded",
];

export const PLUGIN_ACTION_LABEL: Readonly<Record<PluginAction, string>> = {
  installed: "Installed",
  reloaded: "Reloaded",
  removed: "Removed",
  "not-reloaded": "Not reloaded",
};

/** What the reply says it did to one plugin. */
export interface PluginClaim {
  readonly id: string;
  readonly action: PluginAction;
  /** Why it was not reloaded, or anything else worth a line. */
  readonly note: string | null;
}

/** Most plugins a Plugins list may name. */
export const MAX_PLUGIN_CLAIMS = 25;

/** A plugin id as BB writes them (`source-control`, `bb--git`). */
export const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const ITEM_SHAPE = "{id, action: installed|reloaded|removed|not-reloaded, note?}";

/** `items` as written: one claim per plugin, the first for an id kept. */
export function parsePluginClaims(value: Value | undefined): Parsed<readonly PluginClaim[]> {
  if (!Array.isArray(value))
    return { ok: false, error: `Plugins items must be a list of ${ITEM_SHAPE}` };
  const claims = new Map<string, PluginClaim>();
  for (const item of value as readonly Value[]) {
    const fields = fieldsOf(item);
    const id = str(fields?.id)?.trim().toLowerCase() ?? null;
    if (id === null || !PLUGIN_ID.test(id)) {
      return { ok: false, error: `Plugins items: each needs a plugin id, as ${ITEM_SHAPE}` };
    }
    const written =
      str(fields?.action)
        ?.trim()
        .toLowerCase()
        .replace(/[\s_]+/g, "-") ?? null;
    const action = PLUGIN_ACTIONS.find((known) => known === written);
    if (action === undefined) {
      return {
        ok: false,
        error: `Plugins items: "${id}" needs action installed, reloaded, removed or not-reloaded`,
      };
    }
    if (!claims.has(id)) claims.set(id, { id, action, note: str(fields?.note)?.trim() ?? null });
  }
  if (claims.size === 0) return { ok: false, error: "Plugins items must name at least one plugin" };
  if (claims.size > MAX_PLUGIN_CLAIMS)
    return { ok: false, error: `Plugins takes at most ${MAX_PLUGIN_CLAIMS} plugins` };
  return { ok: true, value: [...claims.values()] };
}

/** BB's plugin states. */
export type PluginStatus =
  | "running"
  | "starting"
  | "degraded"
  | "error"
  | "disabled"
  | "incompatible"
  | "missing"
  | "needs-configuration";

export const PLUGIN_STATUS_LABEL: Readonly<Record<PluginStatus, string>> = {
  running: "Running",
  starting: "Starting",
  degraded: "Degraded",
  error: "Failed",
  disabled: "Disabled",
  incompatible: "Incompatible",
  missing: "Source missing",
  "needs-configuration": "Needs configuration",
};

export interface PluginInfo {
  readonly found: true;
  readonly id: string;
  readonly name: string;
  readonly version: string | null;
  /** Its branding icon, as BB's plugin icon reads it. */
  readonly icon: string | null;
  /** Where BB loads it from, as BB words it ("path · ~/git/x/plugins/y"). */
  readonly source: string;
  /** BB's caveat about that source (a workspace BB may remove). */
  readonly sourceNotice: string | null;
  readonly status: PluginStatus;
  /** BB's reason for a status that isn't running. */
  readonly statusDetail: string | null;
}

/** An id BB has no plugin for. */
export interface MissingPlugin {
  readonly found: false;
  readonly id: string;
}

export type PluginState = PluginInfo | MissingPlugin;

export interface PluginsView {
  readonly ok: true;
  /** One per id asked for, in that order. */
  readonly plugins: readonly PluginState[];
  readonly fetchedAt: number;
}

export type PluginTone = "good" | "warn" | "bad" | "info";

/** One row: the claim beside BB's state, and whether they agree. */
export interface PluginRow {
  readonly claim: PluginClaim;
  readonly state: PluginState;
  /** BB's state in a word: "Running", "Not installed". */
  readonly stateLabel: string;
  readonly tone: PluginTone;
  /** What contradicts the claim or needs the reader, in a sentence; null when nothing does. */
  readonly problem: string | null;
}

/** The claim against BB's state. */
export function pluginRow(claim: PluginClaim, state: PluginState): PluginRow {
  if (!state.found) {
    return claim.action === "removed"
      ? { claim, state, stateLabel: "Not installed", tone: "good", problem: null }
      : {
          claim,
          state,
          stateLabel: "Not installed",
          tone: "bad",
          problem: "BB has no plugin with this id.",
        };
  }
  const stateLabel = PLUGIN_STATUS_LABEL[state.status];
  if (claim.action === "removed") {
    return { claim, state, stateLabel, tone: "bad", problem: "Still installed." };
  }
  if (claim.action === "not-reloaded") {
    // BB still runs what it ran before; the note says why.
    return {
      claim,
      state,
      stateLabel,
      tone: "warn",
      problem: claim.note === null ? "No reason given." : null,
    };
  }
  switch (state.status) {
    case "running":
      return { claim, state, stateLabel, tone: "good", problem: null };
    case "starting":
      return { claim, state, stateLabel, tone: "info", problem: null };
    case "disabled":
      return {
        claim,
        state,
        stateLabel,
        tone: "warn",
        problem: state.statusDetail ?? "Disabled, so BB isn't running it.",
      };
    default:
      return {
        claim,
        state,
        stateLabel,
        tone: "bad",
        problem: state.statusDetail ?? `${stateLabel}, so BB isn't running it.`,
      };
  }
}

/** Rows for the claims, with BB's answer where it named the plugin; an id BB left out reads as not installed. */
export function pluginRows(
  claims: readonly PluginClaim[],
  states: readonly PluginState[],
): PluginRow[] {
  const byId = new Map(states.map((state) => [state.id, state]));
  return claims.map((claim) =>
    pluginRow(claim, byId.get(claim.id) ?? { found: false, id: claim.id }),
  );
}

/** A plugin that will change state without anyone acting. */
export function pluginSettling(state: PluginState): boolean {
  return state.found && state.status === "starting";
}
