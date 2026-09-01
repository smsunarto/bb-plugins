/**
 * Opt-out gate backed by bb's plugin settings. Every Sentry reporter that
 * receives a settings host injects one shared boolean setting, on by
 * default, so plugin authors never declare it themselves. Reporters ask
 * the gate before sending; nothing leaves the process while the stored
 * value is still loading.
 */

export const TELEMETRY_SETTINGS_BLOCK = {
  telemetry: {
    type: "boolean" as const,
    label: "Send anonymous crash and performance reports",
    description:
      "Error and timing reports are scrubbed of paths, arguments, and " +
      "message contents before they are sent. Turn this off to send nothing.",
    default: true,
  },
};

type TelemetrySettingsValues = Readonly<{ telemetry: boolean }>;

/**
 * The slice of `BbPluginApi` the gate needs. Structural on purpose:
 * bb-kit-sentry stays free of an SDK dependency, and the real
 * `bb.settings` object satisfies this shape.
 */
export interface SentryTelemetryHost {
  readonly settings: {
    define(descriptors: typeof TELEMETRY_SETTINGS_BLOCK): {
      get(): Promise<TelemetrySettingsValues>;
      onChange(listener: (next: TelemetrySettingsValues) => void): void;
    };
  };
}

export interface TelemetryGate {
  /** Resolves once the stored value has loaded; re-reads on every call so live toggles apply. */
  decided(): Promise<boolean>;
}

const gates = new WeakMap<SentryTelemetryHost, TelemetryGate>();

/**
 * One gate per host, shared by the error and performance reporters so the
 * setting is defined exactly once. Any settings failure fails open:
 * telemetry is on by default, and a broken settings store must not
 * silence it or crash the plugin.
 */
export function telemetryGate(host: SentryTelemetryHost): TelemetryGate {
  const existing = gates.get(host);
  if (existing !== undefined) return existing;
  const gate = createGate(host);
  gates.set(host, gate);
  return gate;
}

function createGate(host: SentryTelemetryHost): TelemetryGate {
  let enabled: boolean | undefined;
  let loaded: Promise<void>;
  try {
    const handle = host.settings.define(TELEMETRY_SETTINGS_BLOCK);
    handle.onChange((next) => {
      enabled = next.telemetry;
    });
    loaded = handle.get().then(
      (values) => {
        // ??= so a change that raced ahead of the initial load wins.
        enabled ??= values.telemetry;
        return undefined;
      },
      () => {
        enabled ??= true;
        return undefined;
      },
    );
  } catch {
    enabled = true;
    loaded = Promise.resolve();
  }
  return {
    decided: () => loaded.then(() => enabled ?? true),
  };
}
