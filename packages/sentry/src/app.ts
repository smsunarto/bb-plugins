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

/** Registration fields holding a React component, as of Plugin SDK 0.6.75. */
const COMPONENT_KEYS: ReadonlySet<string> = new Set([
  // Thread context segments: `summary`, `action`, and `details`.
  "action",
  "component",
  "details",
  "experimental_sidebar",
  "headerComponent",
  "headerContent",
  "icon",
  "summary",
]);
/**
 * Registration fields holding a React hook, such as a nav panel's badge or a
 * tab's visibility. bb calls them while rendering, so the wrapper calls the
 * hook unconditionally and only observes what it throws.
 */
const HOOK_KEYS: ReadonlySet<string> = new Set([
  "experimental_useBadge",
  "experimental_usePageTitle",
  "useData",
  "useVisible",
]);
const CALLBACK_KEYS: ReadonlySet<string> = new Set([
  // Composer plus and send menu items accept a predicate as well as a boolean.
  "disabled",
  "isAvailable",
  "match",
  "onActivate",
  "onDraftChange",
  "run",
  "validate",
]);
/** Callbacks whose result is itself a registration, such as a thread action's `item`. */
const FACTORY_KEYS: ReadonlySet<string> = new Set(["item"]);
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
  const wrap = (kind: string, registration: unknown) =>
    wrapRegistration(registration, kind, telemetry);
  const transforms: Record<string, (kind: string, registration: unknown) => unknown> = {
    slots: wrap,
    composer: wrap,
    commands: wrap,
    experimental_icons: wrap,
    experimental_sidebarFooter: wrap,
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
    if (typeof entry === "function") {
      out[key] = wrapFunction(
        key,
        entry as (...args: never[]) => unknown,
        scoped,
        telemetry,
        depth,
      );
    } else if (Array.isArray(entry) || isRecord(entry)) {
      out[key] = wrapRegistration(entry, scoped, telemetry, depth + 1);
    } else {
      out[key] = entry;
    }
  }
  return out;
}

/** Instrument one function-valued registration field by what its key holds. */
function wrapFunction(
  key: string,
  entry: (...args: never[]) => unknown,
  scoped: string,
  telemetry: SentryAppTelemetry,
  depth: number,
): unknown {
  const operation = `${scoped}.${key}`;
  if (COMPONENT_KEYS.has(key)) {
    return instrumentComponent(entry as ComponentType<object>, scoped, telemetry);
  }
  if (HOOK_KEYS.has(key)) return instrumentHook(entry, operation, telemetry);
  if (CALLBACK_KEYS.has(key)) return instrumentCallback(entry, operation, telemetry);
  if (FACTORY_KEYS.has(key)) {
    const factory = instrumentCallback(entry, operation, telemetry);
    return (...args: never[]) =>
      wrapRegistration(factory(...args), operation, telemetry, depth + 1);
  }
  return entry;
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

/**
 * Report what a registered hook throws. The wrapper adds no hooks of its own
 * and always calls the original, so React sees the same hook order. Suspense
 * signals are waiting, not failures.
 */
function instrumentHook(
  hook: (...args: never[]) => unknown,
  operation: string,
  telemetry: SentryAppTelemetry,
): (...args: never[]) => unknown {
  return (...args) => {
    try {
      return hook(...args);
    } catch (error) {
      if (!isSuspenseSignal(error)) telemetry.capture({ boundary: "app.render", operation, error });
      throw error;
    }
  };
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

/**
 * What a render throws to suspend: a thenable, or React 19's internal
 * Suspense exceptions from `use()` (named in development, codes 460, 474,
 * and 542 in production builds).
 */
function isSuspenseSignal(value: unknown): boolean {
  if (isPromiseLike(value)) return true;
  if (!(value instanceof Error)) return false;
  return (
    value.message.startsWith("Suspense Exception:") ||
    /^Minified React error #(?:460|474|542)\b/u.test(value.message)
  );
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
