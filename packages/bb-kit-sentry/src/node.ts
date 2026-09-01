import { defaultStackParser, makeNodeTransport, NodeClient, Scope } from "@sentry/node";
import { redactPluginError, sanitizeSentryEvent } from "./privacy.ts";
import { telemetryGate, type SentryTelemetryHost, type TelemetryGate } from "./telemetry-gate.ts";

export type SentryErrorReporterOptions = Readonly<{
  dsn?: string;
  release?: string;
  environment?: string;
}>;

type SentryPluginFailure = Readonly<{
  boundary: string;
  operation?: string;
  error: unknown;
}>;

type SentryPluginReporter = {
  capture(failure: SentryPluginFailure): undefined;
  dispose(timeoutMs: number): Promise<void>;
};

export function sentryErrorReporter(
  options: SentryErrorReporterOptions,
): (
  context: Readonly<{ pluginId: string; host?: SentryTelemetryHost }>,
) => SentryPluginReporter | undefined {
  return ({ pluginId, host }) => {
    const dsn = options.dsn?.trim();
    if (dsn === undefined || dsn.length === 0) {
      return undefined;
    }
    const gate = host === undefined ? undefined : telemetryGate(host);

    const client = new NodeClient({
      dsn,
      ...(options.release === undefined ? {} : { release: options.release }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      integrations: [],
      transport: makeNodeTransport,
      stackParser: defaultStackParser,
      beforeSend: sanitizeSentryEvent,
      sendClientReports: false,
      enableLogs: false,
      includeServerName: false,
      sendDefaultPii: false,
    });
    client.init();
    let closing: Promise<void> | undefined;

    const send = (failure: SentryPluginFailure): undefined => {
      try {
        const scope = new Scope();
        scope.setClient(client);
        scope.setTag("bb.plugin.id", pluginId);
        scope.setTag("bb.kit.boundary", failure.boundary);
        if (failure.operation !== undefined) {
          scope.setTag("bb.kit.operation", failure.operation);
        }
        scope.captureException(redactPluginError(failure.error));
      } catch {
        return undefined;
      }
      return undefined;
    };
    const close = (timeoutMs: number): Promise<void> => {
      try {
        return Promise.resolve(client.close(timeoutMs)).then(
          () => undefined,
          () => undefined,
        );
      } catch {
        return Promise.resolve();
      }
    };

    return {
      capture(failure) {
        if (gate === undefined) {
          return send(failure);
        }
        // Captures queued before the decision run ahead of dispose's close
        // because both chain on the same settled load promise, in order.
        void gate
          .decided()
          .then((enabled) => (enabled ? send(failure) : undefined))
          .catch(() => undefined);
        return undefined;
      },
      dispose(timeoutMs) {
        closing ??= disposeGated(gate, close, timeoutMs);
        return closing;
      },
    };
  };
}

async function disposeGated(
  gate: TelemetryGate | undefined,
  close: (timeoutMs: number) => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  if (gate !== undefined) {
    // Bounded: a hung settings load must not stall shutdown past ~1s.
    await Promise.race([gate.decided().catch(() => true), delay(Math.min(1_000, timeoutMs))]);
  }
  await close(timeoutMs);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}
