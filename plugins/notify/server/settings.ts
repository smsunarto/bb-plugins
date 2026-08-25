import { SOUND_OFF, SOUND_OPTIONS } from "./sound.ts";

export type Settings = {
  notifyOnIdle: boolean;
  notifyOnFailed: boolean;
  includeChildThreads: boolean;
  includeHiddenThreads: boolean;
  minRunSeconds: string;
  sound: string;
  agentTool: boolean;
};

export const SETTINGS_DEFAULTS: Settings = {
  notifyOnIdle: true,
  notifyOnFailed: true,
  includeChildThreads: false,
  includeHiddenThreads: false,
  minRunSeconds: "0",
  sound: SOUND_OFF,
  agentTool: false,
};

/** The settings block `setup` passes to `bb.settings.define`. */
export const SETTINGS_BLOCK = {
  notifyOnIdle: {
    type: "boolean" as const,
    label: "Notify when a thread finishes",
    default: SETTINGS_DEFAULTS.notifyOnIdle,
  },
  notifyOnFailed: {
    type: "boolean" as const,
    label: "Notify when a thread fails",
    default: SETTINGS_DEFAULTS.notifyOnFailed,
  },
  includeChildThreads: {
    type: "boolean" as const,
    label: "Include child threads",
    description: "Subagent threads are noisy; off by default.",
    default: SETTINGS_DEFAULTS.includeChildThreads,
  },
  includeHiddenThreads: {
    type: "boolean" as const,
    label: "Include hidden threads",
    description: "Background plugin workers are hidden threads.",
    default: SETTINGS_DEFAULTS.includeHiddenThreads,
  },
  minRunSeconds: {
    type: "string" as const,
    label: "Minimum run time (seconds)",
    description:
      "Skip threads that finished faster than this. A thread whose start the plugin never saw always notifies.",
    default: SETTINGS_DEFAULTS.minRunSeconds,
  },
  sound: {
    type: "select" as const,
    label: "Sound",
    description:
      "off is silent. system default lets macOS choose. A named tone silences the notification and plays that tone instead, so the two do not stack.",
    options: [...SOUND_OPTIONS],
    default: SETTINGS_DEFAULTS.sound,
  },
  agentTool: {
    type: "boolean" as const,
    label: "Give agents a notify_user tool",
    description: "Lets an agent interrupt you deliberately. Off until you want that.",
    default: SETTINGS_DEFAULTS.agentTool,
  },
};

export function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...SETTINGS_DEFAULTS, ...overrides };
}

const readers = new WeakMap<object, () => Settings>();

/** Bind the live settings reader. `setup` does this after `define`; tests bind a snapshot. */
export function bindSettings(bb: object, read: () => Settings): void {
  readers.set(bb, read);
}

export function pluginSettings(bb: object): Settings {
  const read = readers.get(bb);
  if (read === undefined) {
    throw new Error("notify settings are not bound for this host");
  }
  return read();
}
