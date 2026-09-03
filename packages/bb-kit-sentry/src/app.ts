import { BrowserClient, defaultStackParser, makeFetchTransport, Scope } from "@sentry/browser";
import { Component, createElement, type ComponentType, type ReactNode } from "react";
import { sentryPluginRelease } from "./context.ts";
import { redactPluginError, sanitizeSentryEvent } from "./privacy.ts";

export { sentryPluginRelease, type SentryPluginArtifactIdentity } from "./context.ts";

export type SentryAppTelemetryOptions = Readonly<{
  pluginId: string;
  pluginVersion: string;
  dsn?: string;
  environment?: string;
  /** Test seam for both settings reads and Sentry's transport. */
  fetch?: typeof globalThis.fetch;
}>;

export type SentryAppFailure = Readonly<{
  boundary: string;
  operation?: string;
  error: unknown;
}>;

export interface SentryAppTelemetry {
  capture(failure: SentryAppFailure): undefined;
  /** Add reporting around a `definePluginApp` setup function. */
  instrument<App extends object>(setup: (app: App) => void): (app: App) => void;
  flush(timeoutMs?: number): Promise<void>;
}

const COMPONENT_KEYS: ReadonlySet<string> = new Set([
  "component",
  "headerContent",
  "experimental_sidebarAccessory",
  "icon",
]);
const CALLBACK_KEYS: ReadonlySet<string> = new Set([
  "isAvailable",
  "match",
  "onDraftChange",
  "run",
  "validate",
]);
const MAX_EVENTS_PER_PAGE = 25;
const LIFECYCLE_REGISTRATION_ID = "bb-kit-sentry";

const DISABLED: SentryAppTelemetry = {
  capture: () => undefined,
  instrument: (setup) => setup,
  flush: () => Promise.resolve(),
};

export function sentryAppTelemetry(options: SentryAppTelemetryOptions): SentryAppTelemetry {
  try {
    const dsn = options.dsn?.trim();
    if (dsn === undefined || dsn.length === 0) return DISABLED;
    return createTelemetry({ ...options, dsn });
  } catch {
    return DISABLED;
  }
}

function createTelemetry(
  options: SentryAppTelemetryOptions & Readonly<{ dsn: string }>,
): SentryAppTelemetry {
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const client = new BrowserClient({
    dsn: options.dsn,
    release: sentryPluginRelease(options),
    environment: options.environment ?? "production",
    integrations: [],
    transport: (transportOptions) => makeFetchTransport(transportOptions, fetchImpl),
    stackParser: defaultStackParser,
    beforeSend: sanitizeSentryEvent,
    sendClientReports: false,
    enableLogs: false,
    sendDefaultPii: false,
  });
  client.init();

  const gate = settingsGate(options.pluginId, fetchImpl);
  const reported = new WeakSet<object>();
  let remaining = MAX_EVENTS_PER_PAGE;
  let pending: Promise<void> = Promise.resolve();

  const send = (failure: SentryAppFailure): void => {
    const scope = new Scope();
    scope.setClient(client);
    scope.setTag("bb.plugin.id", options.pluginId);
    scope.setTag("bb.kit.boundary", failure.boundary);
    if (failure.operation !== undefined) scope.setTag("bb.kit.operation", failure.operation);
    scope.captureException(redactPluginError(failure.error));
  };

  const capture = (failure: SentryAppFailure): undefined => {
    try {
      if (typeof failure.error === "object" && failure.error !== null) {
        if (reported.has(failure.error)) return undefined;
        reported.add(failure.error);
      }
      pending = pending
        .then(gate)
        .then((enabled) => {
          if (!enabled || remaining <= 0) return undefined;
          remaining -= 1;
          send(failure);
          return undefined;
        })
        .catch(() => undefined);
    } catch {
      return undefined;
    }
    return undefined;
  };

  const telemetry: SentryAppTelemetry = {
    capture,
    instrument: (setup) => (app) => {
      registerLifecycle(app, options.pluginId, telemetry);
      let instrumented = app;
      try {
        instrumented = instrumentBuilder(app, telemetry);
      } catch {
        // Reporting must never stop the original app from registering.
      }
      try {
        setup(instrumented);
      } catch (error) {
        capture({ boundary: "app.setup", error });
        throw error;
      }
    },
    flush: async (timeoutMs = 2_000) => {
      await pending;
      try {
        await client.flush(timeoutMs);
      } catch {
        // Reporting failures must stay invisible to the plugin.
      }
    },
  };
  return telemetry;
}

function settingsGate(
  pluginId: string,
  fetchImpl: typeof globalThis.fetch,
): () => Promise<boolean> {
  const url = `/api/v1/plugins/${encodeURIComponent(pluginId)}/settings`;
  let inFlight: Promise<boolean> | undefined;
  return () => {
    inFlight ??= fetchImpl(url)
      .then(async (response) => {
        if (!response.ok) return true;
        const body: unknown = await response.json();
        const values = isRecord(body) && isRecord(body.values) ? body.values : undefined;
        return values?.telemetry !== false;
      })
      .catch(() => true)
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

function registerLifecycle<App extends object>(
  app: App,
  pluginId: string,
  telemetry: SentryAppTelemetry,
): void {
  try {
    const contentScripts = Reflect.get(app, "contentScripts");
    if (!isRecord(contentScripts) || typeof contentScripts.register !== "function") return;
    contentScripts.register({
      id: LIFECYCLE_REGISTRATION_ID,
      mount() {
        const disposeGlobalHandlers = installGlobalHandlers(pluginId, telemetry);
        return async () => {
          disposeGlobalHandlers();
          await telemetry.flush();
        };
      },
    });
  } catch {
    // An older SDK may not support content scripts. Other boundaries still work.
  }
}

function installGlobalHandlers(pluginId: string, telemetry: SentryAppTelemetry): () => void {
  if (typeof globalThis.addEventListener !== "function") return () => undefined;
  const onError = (event: Event): void => {
    if (!(event instanceof ErrorEvent)) return;
    const error = event.error ?? new Error(event.message);
    if (!belongsToPlugin(pluginId, error, event.filename)) return;
    telemetry.capture({ boundary: "app.global", operation: "error", error });
  };
  const onUnhandledRejection = (event: Event): void => {
    if (!(event instanceof PromiseRejectionEvent)) return;
    if (!belongsToPlugin(pluginId, event.reason)) return;
    telemetry.capture({
      boundary: "app.global",
      operation: "unhandledrejection",
      error: event.reason,
    });
  };
  globalThis.addEventListener("error", onError);
  globalThis.addEventListener("unhandledrejection", onUnhandledRejection);
  return () => {
    globalThis.removeEventListener("error", onError);
    globalThis.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}

function belongsToPlugin(pluginId: string, error: unknown, filename?: string): boolean {
  const marker = `/plugins/${encodeURIComponent(pluginId)}/assets/`;
  if (filename?.includes(marker) === true) return true;
  return error instanceof Error && error.stack?.includes(marker) === true;
}

function instrumentBuilder<App extends object>(app: App, telemetry: SentryAppTelemetry): App {
  const transforms: Record<string, (kind: string, registration: unknown) => unknown> = {
    slots: (kind, registration) => wrapRegistration(registration, kind, telemetry),
    composer: (kind, registration) => wrapRegistration(registration, kind, telemetry),
    contentScripts: (kind, registration) => wrapContentScript(registration, kind, telemetry),
  };
  return new Proxy(app, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || !isRecord(value)) return value;
      const transform = transforms[property];
      return transform === undefined ? value : proxyNamespace(value, property, transform);
    },
  });
}

function proxyNamespace(
  namespace: Record<string, unknown>,
  name: string,
  transform: (kind: string, registration: unknown) => unknown,
): Record<string, unknown> {
  return new Proxy(namespace, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || typeof value !== "function") return value;
      const method = value as (this: unknown, ...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        const [registration, ...rest] = args;
        let transformed = registration;
        try {
          transformed = transform(`${name}.${property}`, registration);
        } catch {
          // Preserve the original registration if instrumentation fails.
        }
        return method.apply(target, [transformed, ...rest]);
      };
    },
  });
}

function wrapRegistration(
  value: unknown,
  operation: string,
  telemetry: SentryAppTelemetry,
  depth = 0,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => wrapRegistration(entry, operation, telemetry, depth + 1));
  }
  if (!isRecord(value) || depth > 4) return value;
  const id = typeof value.id === "string" ? value.id : undefined;
  const scoped = id === undefined ? operation : `${operation}:${id}`;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (COMPONENT_KEYS.has(key) && typeof entry === "function") {
      out[key] = instrumentComponent(entry as ComponentType<object>, scoped, telemetry);
    } else if (CALLBACK_KEYS.has(key) && typeof entry === "function") {
      out[key] = instrumentCallback(
        entry as (...args: never[]) => unknown,
        `${scoped}.${key}`,
        telemetry,
      );
    } else if (Array.isArray(entry) || isRecord(entry)) {
      out[key] = wrapRegistration(entry, scoped, telemetry, depth + 1);
    } else {
      out[key] = entry;
    }
  }
  return out;
}

function instrumentComponent(
  Original: ComponentType<object>,
  operation: string,
  telemetry: SentryAppTelemetry,
): ComponentType<object> {
  class SentryBoundary extends Component<Readonly<{ children?: ReactNode }>, { failed: boolean }> {
    override state = { failed: false };

    static getDerivedStateFromError(): { failed: boolean } {
      return { failed: true };
    }

    override componentDidCatch(error: unknown): void {
      telemetry.capture({ boundary: "app.render", operation, error });
      throw error;
    }

    override render(): ReactNode {
      return this.state.failed ? null : this.props.children;
    }
  }
  const Instrumented = (props: object): ReactNode =>
    createElement(SentryBoundary, null, createElement(Original, props));
  Instrumented.displayName = `SentryBoundary(${Original.displayName ?? Original.name ?? "Component"})`;
  return Instrumented;
}

function instrumentCallback(
  callback: (...args: never[]) => unknown,
  operation: string,
  telemetry: SentryAppTelemetry,
): (...args: never[]) => unknown {
  return (...args) => {
    try {
      const result = callback(...args);
      if (!isPromiseLike(result)) return result;
      return Promise.resolve(result).catch((error: unknown) => {
        telemetry.capture({ boundary: "app.callback", operation, error });
        throw error;
      });
    } catch (error) {
      telemetry.capture({ boundary: "app.callback", operation, error });
      throw error;
    }
  };
}

function wrapContentScript(
  registration: unknown,
  kind: string,
  telemetry: SentryAppTelemetry,
): unknown {
  if (!isRecord(registration) || typeof registration.mount !== "function") return registration;
  const mount = registration.mount as (this: unknown, ...args: never[]) => unknown;
  const operation = typeof registration.id === "string" ? `${kind}:${registration.id}` : kind;
  const wrappedTelemetry: SentryAppTelemetry = {
    ...telemetry,
    capture(failure) {
      return telemetry.capture({ ...failure, boundary: "app.contentScript" });
    },
  };
  return {
    ...registration,
    mount: instrumentCallback(mount.bind(registration), operation, wrappedTelemetry),
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
