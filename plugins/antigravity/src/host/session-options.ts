import {
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  THREAD_DELTA_NOTIFICATION_METHOD,
  type PermissionMode,
} from "@get-bb/plugin-sdk/provider-bridge";

/**
 * Translates bb's native controls onto `agy acp` session options and adds
 * typed rate-limit recovery hints.
 *
 * - **Permissions:** Accept Edits sets `mode: "accept-edits"`, Auto sets
 *   `mode: "auto"` (reaching the SDK ACP bridge as `accept-edits` so `agy`
 *   auto-approves safe actions and asks bb for irreversible ones), and Full
 *   sets `mode: "auto"` while keeping bb's `permissionMode: "full"` so bb
 *   auto-approves remaining prompts without restarting `agy acp`.
 * - **Plan:** A turn with `promptMode: "plan"` sets `mode: "plan"` and routes
 *   through `accept-edits` even in Full threads so plan approval reaches bb.
 *   The next ordinary turn restores the permission-implied mode.
 * - **Agent options cleanup:** Drops `mode` from `bb/session-options` state
 *   deltas so users do not see a duplicate mode selector beside bb's native
 *   permission and Plan controls.
 * - **Rate-limit recovery:** Emits a typed `provider/recovery` (`rateLimited`)
 *   notification when `agy acp` reports a quota or HTTP 429 error mid-turn.
 */

const MODE_OPTION_ID = "mode";
const PLAN_MODE = "plan";
const SESSION_OPTIONS_STATE_KIND = "bb/session-options";

const MODE_FOR_PERMISSION: Readonly<Record<PermissionMode, string>> = {
  "accept-edits": "accept-edits",
  auto: "auto",
  full: "auto",
};

const OPTION_REQUESTS: ReadonlySet<string> = new Set([
  BRIDGE_REQUEST_METHODS.threadStart,
  BRIDGE_REQUEST_METHODS.threadResume,
  BRIDGE_REQUEST_METHODS.threadFork,
  BRIDGE_REQUEST_METHODS.turnStart,
  BRIDGE_REQUEST_METHODS.turnSteer,
]);

const SESSION_OPENERS: ReadonlySet<string> = new Set([
  BRIDGE_REQUEST_METHODS.threadStart,
  BRIDGE_REQUEST_METHODS.threadResume,
  BRIDGE_REQUEST_METHODS.threadFork,
]);

const SESSION_CLOSERS: ReadonlySet<string> = new Set([
  BRIDGE_REQUEST_METHODS.threadStop,
  BRIDGE_REQUEST_METHODS.threadDiscard,
]);

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\bRESOURCE_EXHAUSTED\b/iu,
  /\bexhausted your quota\b/iu,
  /\bquota exceeded\b/iu,
  /\brate[\s-]?limit(?:ed|ing)?\b/iu,
  /\btoo many requests\b/iu,
  /\b(?:http|status|code)[\s:]+429\b/iu,
];

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

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && Object.hasOwn(MODE_FOR_PERMISSION, value);
}

export function isAntigravityRateLimitMessage(message: string): boolean {
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

function readStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (record === null) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

function firstNonEmpty(values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function resolveProfileLaunchConfig(
  envVars: Record<string, string>,
  specEnv: Record<string, string>,
): { geminiDir: string; appDataDir: string; disableKeyring: boolean } {
  const geminiDir = firstNonEmpty([
    envVars["BB_ANTIGRAVITY_GEMINI_DIR"],
    specEnv["BB_ANTIGRAVITY_GEMINI_DIR"],
    process.env.BB_ANTIGRAVITY_GEMINI_DIR,
  ]);
  const appDataDir =
    firstNonEmpty([
      envVars["BB_ANTIGRAVITY_APP_DATA_DIR"],
      specEnv["BB_ANTIGRAVITY_APP_DATA_DIR"],
      process.env.BB_ANTIGRAVITY_APP_DATA_DIR,
    ]) || "antigravity-cli";
  const disableKeyring =
    firstNonEmpty([
      envVars["BB_ANTIGRAVITY_DISABLE_KEYRING"],
      specEnv["BB_ANTIGRAVITY_DISABLE_KEYRING"],
      process.env.BB_ANTIGRAVITY_DISABLE_KEYRING,
    ]) === "1";
  return { geminiDir, appDataDir, disableKeyring };
}

function applyLaunchOverrides(
  providerOptions: Message | null,
  envVars: Record<string, string>,
  executableOverride: string | undefined,
): Message | null {
  const launchSpec = asRecord(providerOptions?.["acpLaunchSpec"]);
  if (providerOptions === null || launchSpec === null) {
    return providerOptions;
  }
  const specEnv = readStringRecord(launchSpec["env"]);
  const { geminiDir, appDataDir, disableKeyring } = resolveProfileLaunchConfig(envVars, specEnv);

  let nextLaunchSpec = launchSpec;
  let changed = false;

  if (executableOverride && nextLaunchSpec["command"] === "agy") {
    nextLaunchSpec = { ...nextLaunchSpec, command: executableOverride };
    changed = true;
  }

  if (geminiDir !== "") {
    const existingArgs = Array.isArray(nextLaunchSpec["args"])
      ? nextLaunchSpec["args"].filter((entry): entry is string => typeof entry === "string")
      : [];
    const hasGeminiDir =
      existingArgs.includes("--gemini-dir") || existingArgs.includes("--gemini_dir");
    if (!hasGeminiDir) {
      nextLaunchSpec = {
        ...nextLaunchSpec,
        args: [...existingArgs, "--gemini-dir", geminiDir, "--app-data-dir", appDataDir],
      };
      changed = true;
    }
  }

  if (disableKeyring) {
    nextLaunchSpec = {
      ...nextLaunchSpec,
      env: { ...specEnv, DBUS_SESSION_BUS_ADDRESS: "" },
    };
    changed = true;
  }

  return changed ? { ...providerOptions, acpLaunchSpec: nextLaunchSpec } : providerOptions;
}

function applyExecutableOverride(
  options: Message,
  executableOverride: string | undefined,
): Message {
  const envVars = readStringRecord(options["envVars"]);
  const providerOptions = asRecord(options["providerOptions"]);
  const updatedProviderOptions = applyLaunchOverrides(providerOptions, envVars, executableOverride);
  const disableKeyring =
    (envVars["BB_ANTIGRAVITY_DISABLE_KEYRING"] ?? process.env.BB_ANTIGRAVITY_DISABLE_KEYRING) ===
    "1";
  const nextEnvVars = disableKeyring ? { ...envVars, DBUS_SESSION_BUS_ADDRESS: "" } : null;

  if (updatedProviderOptions === providerOptions && nextEnvVars === null) {
    return options;
  }
  return {
    ...options,
    ...(updatedProviderOptions === providerOptions
      ? {}
      : { providerOptions: updatedProviderOptions }),
    ...(nextEnvVars === null ? {} : { envVars: nextEnvVars }),
  };
}

export interface AntigravitySessionTranslator {
  inbound(line: string): string;
  outbound(line: string): string;
}

export function createAntigravitySessionTranslator(args?: {
  executableOverride?: string;
}): AntigravitySessionTranslator {
  const impliedModes = new Map<string, string>();
  const executableOverride = args?.executableOverride?.trim() || undefined;

  function translateOptions(method: string, threadId: string, rawOptions: Message): Message {
    const options = applyExecutableOverride(rawOptions, executableOverride);
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

    const mode = planTurn ? PLAN_MODE : MODE_FOR_PERMISSION[permissionMode];
    const derived: Record<string, string> = {};
    if (impliedModes.get(threadId) !== mode) {
      impliedModes.set(threadId, mode);
      derived[MODE_OPTION_ID] = mode;
    }
    if (Object.keys(derived).length === 0) {
      return next;
    }
    const chosen = asRecord(options["sessionOptions"]) ?? {};
    return {
      ...next,
      sessionOptions: { ...derived, ...chosen },
    };
  }

  function rewriteSessionOptionsDelta(message: Message): string | null {
    if (message["method"] !== THREAD_DELTA_NOTIFICATION_METHOD) return null;
    const params = asRecord(message["params"]);
    const deltas = params?.["deltas"];
    if (params === null || !Array.isArray(deltas)) return null;

    let changed = false;
    for (const entry of deltas) {
      const delta = asRecord(entry);
      const payload = asRecord(delta?.["payload"]);
      const options = payload?.["options"];
      if (
        payload !== null &&
        delta?.["kind"] === "extension.state" &&
        delta["extensionKind"] === SESSION_OPTIONS_STATE_KIND &&
        Array.isArray(options)
      ) {
        const filtered = options.filter((opt) => asRecord(opt)?.["id"] !== MODE_OPTION_ID);
        if (filtered.length !== options.length) {
          payload["options"] = filtered;
          changed = true;
        }
      }
    }
    return changed ? `${JSON.stringify(message)}\n` : null;
  }

  function maybeRateLimitRecoveryLine(message: Message): string | null {
    if (message["method"] !== BRIDGE_NOTIFICATION_METHODS.error) return null;
    const params = asRecord(message["params"]);
    const threadId = params?.["threadId"];
    const errorMessage = params?.["message"];
    if (
      typeof threadId !== "string" ||
      threadId.trim() === "" ||
      typeof errorMessage !== "string"
    ) {
      return null;
    }
    if (!isAntigravityRateLimitMessage(errorMessage)) return null;
    return `${JSON.stringify({
      jsonrpc: "2.0",
      method: BRIDGE_NOTIFICATION_METHODS.providerRecovery,
      params: {
        threadId,
        kind: "rateLimited",
        message: errorMessage,
        retryable: false,
      },
    })}\n`;
  }

  return {
    inbound(line) {
      const message = parseMessage(line);
      const method = message?.["method"];
      if (message === null || typeof method !== "string") return line;
      const params = asRecord(message["params"]);
      if (params === null) return line;

      // Apply executable and pooled-profile overrides to sessionless methods (`model/list`, `provider/*`).
      if (!OPTION_REQUESTS.has(method)) {
        const envVars = readStringRecord(params["envVars"]);
        const providerOptions = asRecord(params["providerOptions"]);
        const updatedProviderOptions = applyLaunchOverrides(
          providerOptions,
          envVars,
          executableOverride,
        );
        const disableKeyring =
          (envVars["BB_ANTIGRAVITY_DISABLE_KEYRING"] ??
            process.env.BB_ANTIGRAVITY_DISABLE_KEYRING) === "1";
        if (updatedProviderOptions !== providerOptions || disableKeyring) {
          return JSON.stringify({
            ...message,
            params: {
              ...params,
              ...(updatedProviderOptions === providerOptions
                ? {}
                : { providerOptions: updatedProviderOptions }),
              ...(disableKeyring ? { envVars: { ...envVars, DBUS_SESSION_BUS_ADDRESS: "" } } : {}),
            },
          });
        }
        return line;
      }

      const threadId = params["threadId"];
      if (typeof threadId !== "string") return line;
      if (SESSION_OPENERS.has(method) || SESSION_CLOSERS.has(method)) {
        impliedModes.delete(threadId);
      }
      const options = asRecord(params["options"]);
      if (!OPTION_REQUESTS.has(method) || options === null) return line;
      const translated = translateOptions(method, threadId, options);
      if (translated === options) return line;
      return JSON.stringify({ ...message, params: { ...params, options: translated } });
    },

    outbound(line) {
      const needsDeltaCheck = line.includes(SESSION_OPTIONS_STATE_KIND);
      const needsErrorCheck = line.includes(`"${BRIDGE_NOTIFICATION_METHODS.error}"`);
      if (!needsDeltaCheck && !needsErrorCheck) return line;

      const message = parseMessage(line);
      if (message === null) return line;

      if (needsDeltaCheck) {
        const rewritten = rewriteSessionOptionsDelta(message);
        if (rewritten !== null) return rewritten;
      }
      if (needsErrorCheck) {
        const recovery = maybeRateLimitRecoveryLine(message);
        if (recovery !== null) {
          const normalizedLine = line.endsWith("\n") ? line : `${line}\n`;
          return `${normalizedLine}${recovery}`;
        }
      }
      return line;
    },
  };
}
