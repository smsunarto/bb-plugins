import {
  BRIDGE_REQUEST_METHODS,
  THREAD_DELTA_NOTIFICATION_METHOD,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { AvailableModel, PermissionMode } from "@get-bb/plugin-sdk/provider-bridge";
import type { ModelCatalog } from "./model-order.ts";

/**
 * Drives Devin's own session options from bb's native controls.
 *
 * Devin's ACP server offers two session options the SDK bridge does not map
 * to bb concepts: `speed` (`standard` | `fast`) and `mode` (Code, Smart, Ask,
 * Plan, Bypass). Left alone, the bridge lists both in bb's generic "Agent
 * options" menu, while bb's fast toggle, permission picker, and Plan action
 * do nothing to Devin. This translator sits on the bridge's stdio
 * (src/host/host.ts) and closes that gap:
 *
 * - **Fast.** Every model advertises bb's `fast` service tier, and each turn
 *   sets `speed` from the turn's tier. The duplicate Speed entry is dropped
 *   from the Agent options menu.
 * - **Permissions.** Accept Edits runs Devin in Code, Auto in Smart, Full in
 *   Bypass. The bridge rejects bb's `auto` mode, so an Auto thread reaches
 *   the bridge as Accept Edits: Smart approves what it judges safe and asks
 *   bb for the rest.
 * - **Plan.** A turn bb sends in plan mode (`/plan`) runs in Devin's Plan
 *   mode; the next ordinary turn returns to the permission mode's Devin mode.
 *   The bridge approves every request under Full, Devin's request to leave
 *   Plan mode included, so a plan turn reaches the bridge as Accept Edits and
 *   the plan's approval comes to bb.
 *
 * The mode is set only when the mode bb implies changes, so a mode the user
 * picks in the Agent options menu (Ask, say) holds until they change bb's
 * permission mode or send a plan turn. Devin ignores a value its session
 * does not offer, so a Cloud thread without these options runs unchanged.
 */

/** Devin's session config option ids and values (`devin acp` 3000.11). */
const SPEED_OPTION = "speed";
const FAST_SPEED = "fast";
const STANDARD_SPEED = "standard";
const MODE_OPTION = "mode";
const PLAN_MODE = "plan";

/** The Devin mode each bb permission mode runs in. */
const MODE_FOR_PERMISSION: Readonly<Record<PermissionMode, string>> = {
  "accept-edits": "accept-edits",
  auto: "smart",
  full: "bypass",
};

/** bb's service tier id for fast; the bridge's own catalogs use the same. */
const FAST_SERVICE_TIER = "fast";

/** The bridge's thread state kind for the Agent options menu. Not exported
 *  by the SDK; the bridge publishes it as `extension.state`. */
const SESSION_OPTIONS_STATE_KIND = "bb/session-options";

/** Requests whose `params.options` carry bb's execution options. */
const OPTION_REQUESTS: ReadonlySet<string> = new Set([
  BRIDGE_REQUEST_METHODS.threadStart,
  BRIDGE_REQUEST_METHODS.threadResume,
  BRIDGE_REQUEST_METHODS.threadFork,
  BRIDGE_REQUEST_METHODS.turnStart,
  BRIDGE_REQUEST_METHODS.turnSteer,
]);

/** Requests that open a new Devin session, which starts in Code mode. */
const SESSION_OPENERS: ReadonlySet<string> = new Set([
  BRIDGE_REQUEST_METHODS.threadStart,
  BRIDGE_REQUEST_METHODS.threadResume,
  BRIDGE_REQUEST_METHODS.threadFork,
]);

const SESSION_CLOSERS: ReadonlySet<string> = new Set([
  BRIDGE_REQUEST_METHODS.threadStop,
  BRIDGE_REQUEST_METHODS.threadDiscard,
]);

type Message = Record<string, unknown>;

function asRecord(value: unknown): Message | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Message)
    : null;
}

function parseMessage(line: string): Message | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

const isPermissionMode = (value: unknown): value is PermissionMode =>
  typeof value === "string" && Object.hasOwn(MODE_FOR_PERMISSION, value);

/** A catalog whose models offer bb's fast tier and no duplicate Speed option. */
export function withDevinSpeed(catalog: ModelCatalog): ModelCatalog {
  const present = (model: AvailableModel): AvailableModel => ({
    ...model,
    supportedServiceTiers: [{ id: FAST_SERVICE_TIER }],
    ...(model.sessionOptions === undefined
      ? {}
      : { sessionOptions: model.sessionOptions.filter((option) => option.id !== SPEED_OPTION) }),
  });
  return {
    models: catalog.models.map(present),
    selectedOnlyModels: catalog.selectedOnlyModels.map(present),
  };
}

export type SessionOptionTranslator = Readonly<{
  /** A line from bb, rewritten before the bridge handles it. */
  inbound(line: string): string;
  /** A bridge stdout line, rewritten before bb reads it. */
  outbound(line: string): string;
}>;

export function createSessionOptionTranslator(): SessionOptionTranslator {
  /** The Devin mode last set from bb's controls, per bb thread. */
  const impliedModes = new Map<string, string>();

  function translateOptions(method: string, threadId: string, options: Message): Message {
    const permissionMode = options["permissionMode"];
    const planTurn = options["promptMode"] === PLAN_MODE;
    const next =
      permissionMode === "auto" || (planTurn && permissionMode === "full")
        ? {
            ...options,
            permissionMode: "accept-edits",
            permissionScope: "workspace",
            approvalReviewer: "user",
            permissionEscalation: options["permissionEscalation"] ?? "ask",
          }
        : options;
    if (method !== BRIDGE_REQUEST_METHODS.turnStart || !isPermissionMode(permissionMode)) {
      return next;
    }
    const derived: Record<string, string> = {};
    const serviceTier = options["serviceTier"];
    if (typeof serviceTier === "string") {
      derived[SPEED_OPTION] = serviceTier === FAST_SERVICE_TIER ? FAST_SPEED : STANDARD_SPEED;
    }
    const mode = planTurn ? PLAN_MODE : MODE_FOR_PERMISSION[permissionMode];
    if (impliedModes.get(threadId) !== mode) {
      impliedModes.set(threadId, mode);
      derived[MODE_OPTION] = mode;
    }
    const chosen = asRecord(options["sessionOptions"]) ?? {};
    return { ...next, sessionOptions: { ...derived, ...chosen } };
  }

  return {
    inbound(line) {
      const message = parseMessage(line);
      const method = message?.["method"];
      if (message === null || typeof method !== "string") return line;
      const params = asRecord(message["params"]);
      const threadId = params?.["threadId"];
      if (params === null || typeof threadId !== "string") return line;
      if (SESSION_OPENERS.has(method) || SESSION_CLOSERS.has(method)) impliedModes.delete(threadId);
      const options = asRecord(params["options"]);
      if (!OPTION_REQUESTS.has(method) || options === null) return line;
      const translated = translateOptions(method, threadId, options);
      if (translated === options) return line;
      return JSON.stringify({ ...message, params: { ...params, options: translated } });
    },
    outbound(line) {
      if (!line.includes(SESSION_OPTIONS_STATE_KIND)) return line;
      const message = parseMessage(line);
      if (message === null || message["method"] !== THREAD_DELTA_NOTIFICATION_METHOD) return line;
      const params = asRecord(message["params"]);
      const deltas = params?.["deltas"];
      if (params === null || !Array.isArray(deltas)) return line;
      // The message was parsed from this line, so its payloads are ours to edit.
      for (const entry of deltas) {
        const delta = asRecord(entry);
        const payload = asRecord(delta?.["payload"]);
        const options = payload?.["options"];
        if (
          payload !== null &&
          delta?.["kind"] === "extension.state" &&
          delta["extensionKind"] === SESSION_OPTIONS_STATE_KIND &&
          Array.isArray(options)
        )
          payload["options"] = options.filter((o) => asRecord(o)?.["id"] !== SPEED_OPTION);
      }
      return `${JSON.stringify(message)}\n`;
    },
  };
}
