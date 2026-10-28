import { SANDBOX_TYPES, type SandboxType } from "../../shared/constants.ts";

export const DEFAULT_API_BASE = "https://boat.dev/api/v1";
const MAX_IDLE_MINUTES = 24 * 60;
/** Boat accepts auto-stop up to 30 days. */
const MAX_AUTO_STOP_HOURS = 30 * 24;

export const SETTING_DESCRIPTORS = {
  apiKey: {
    type: "string",
    secret: true,
    label: "Boat API key",
    description:
      "A key from `boat api-key create bb --preset ci` or the dashboard. It needs sandbox create, read, update, stop, resume and delete, exec, file.write and account.read.",
  },
  apiBase: {
    type: "string",
    label: "Boat API base URL",
    description: "Change only for a self-hosted or staging Boat.",
    default: DEFAULT_API_BASE,
  },
  defaultType: {
    type: "select",
    label: "Default sandbox size",
    description: "Used when a thread does not pick a size in the composer.",
    options: Array.from(SANDBOX_TYPES),
    experimental_optionLabels: {
      small: "small · 2 vCPU · 4 GB",
      default: "default · 4 vCPU · 8 GB",
      large: "large · 8 vCPU · 16 GB",
      xlarge: "xlarge · 16 vCPU · 32 GB",
    },
    default: "default",
  },
  environment: {
    type: "string",
    label: "Boat environment",
    description:
      "The Boat environment new sandboxes attach to (repositories, secrets, logins). Blank uses your account default.",
    default: "",
  },
  idleMinutes: {
    type: "number",
    label: "Stop after idle (minutes)",
    description:
      "Stop an idle sandbox after this long; its disk is kept and the machine resumes on demand. 0 leaves stopping to Boat's auto-stop.",
    default: 15,
  },
  autoStopHours: {
    type: "number",
    label: "Boat auto-stop (hours)",
    description:
      "Boat's own stop timer, kept as a backstop: while idle stopping is on, the plugin extends it for machines in use. 0 turns it off, which the free trial refuses.",
    default: 24,
  },
} as const;

export interface RawSettings {
  apiKey: string | undefined;
  apiBase: string;
  defaultType: string;
  environment: string;
  idleMinutes: number;
  autoStopHours: number;
}

export interface ResolvedSettings {
  apiKey: string;
  apiBase: string;
  defaultType: SandboxType;
  environment: string | null;
  idleMs: number | null;
  ttlSeconds: number | null;
}

export type SettingsResolution =
  | { ok: true; settings: ResolvedSettings }
  | { ok: false; message: string };

function isSandboxType(value: string): value is SandboxType {
  return (SANDBOX_TYPES as readonly string[]).includes(value);
}

function wholeNumber(name: string, value: number, max: number): string | null {
  return Number.isInteger(value) && value >= 0 && value <= max
    ? null
    : `${name} must be a whole number between 0 and ${max}, not ${value}.`;
}

export function resolveSettings(raw: RawSettings): SettingsResolution {
  const apiKey = (raw.apiKey ?? "").trim();
  if (apiKey.length === 0) {
    return { ok: false, message: "Set apiKey in the plugin's settings." };
  }
  const apiBase = raw.apiBase.trim().replace(/\/+$/, "");
  let parsedBase: URL;
  try {
    parsedBase = new URL(apiBase);
  } catch {
    return { ok: false, message: `apiBase must be an absolute URL, not "${raw.apiBase}".` };
  }
  if (parsedBase.protocol !== "https:" && parsedBase.hostname !== "localhost") {
    return { ok: false, message: "apiBase must use https." };
  }
  if (!isSandboxType(raw.defaultType)) {
    return {
      ok: false,
      message: `defaultType must be one of ${SANDBOX_TYPES.join(", ")}, not "${raw.defaultType}".`,
    };
  }
  const problem =
    wholeNumber("idleMinutes", raw.idleMinutes, MAX_IDLE_MINUTES) ??
    wholeNumber("autoStopHours", raw.autoStopHours, MAX_AUTO_STOP_HOURS);
  if (problem !== null) return { ok: false, message: problem };
  const environment = raw.environment.trim();
  return {
    ok: true,
    settings: {
      apiKey,
      apiBase,
      defaultType: raw.defaultType,
      environment: environment.length === 0 ? null : environment,
      idleMs: raw.idleMinutes === 0 ? null : raw.idleMinutes * 60_000,
      ttlSeconds: raw.autoStopHours === 0 ? null : raw.autoStopHours * 3600,
    },
  };
}
