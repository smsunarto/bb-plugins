import { defaultStackParser, makeNodeTransport, NodeClient, Scope } from "@sentry/node";
import { redactPluginError, sanitizeSentryEvent } from "./privacy.ts";

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
): (context: Readonly<{ pluginId: string }>) => SentryPluginReporter | undefined {
  return ({ pluginId }) => {
    const dsn = options.dsn?.trim();
    if (dsn === undefined || dsn.length === 0) {
      return undefined;
    }

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

    return {
      capture(failure) {
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
      },
      dispose(timeoutMs) {
        if (closing === undefined) {
          try {
            closing = Promise.resolve(client.close(timeoutMs)).then(
              () => undefined,
              () => undefined,
            );
          } catch {
            closing = Promise.resolve();
          }
        }
        return closing;
      },
    };
  };
}
