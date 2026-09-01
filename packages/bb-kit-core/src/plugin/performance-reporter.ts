export type PluginTraceOutcome = "ok" | "error" | "cancelled" | "retry" | "incomplete";

export interface PluginPerformanceTrace {
  checkpoint(name: string): void;
  finish(outcome: PluginTraceOutcome): void;
}

export interface PluginPerformanceReporter {
  start(args: Readonly<{ operation: string; variant?: string }>): PluginPerformanceTrace;
  dispose?(timeoutMs: number): void | Promise<void>;
}

export type PluginPerformanceReporterFactory = (
  context: Readonly<{ pluginId: string }>,
) => PluginPerformanceReporter | undefined;

export function createPluginPerformanceReporter(
  factory: PluginPerformanceReporterFactory | undefined,
  pluginId: string,
): PluginPerformanceReporter | undefined {
  try {
    return factory?.({ pluginId });
  } catch {
    return undefined;
  }
}

/**
 * Start a trace whose methods can never throw into plugin code. A
 * reporter that fails at start, checkpoint, or finish degrades to no
 * telemetry for that operation.
 */
export function startPluginTrace(
  reporter: PluginPerformanceReporter | undefined,
  operation: string,
  variant?: string,
): PluginPerformanceTrace | undefined {
  if (reporter === undefined) {
    return undefined;
  }
  let trace: PluginPerformanceTrace;
  try {
    trace = reporter.start(variant === undefined ? { operation } : { operation, variant });
  } catch {
    return undefined;
  }
  return {
    checkpoint(name) {
      try {
        trace.checkpoint(name);
      } catch {
        // telemetry never breaks the traced operation
      }
    },
    finish(outcome) {
      try {
        trace.finish(outcome);
      } catch {
        // telemetry never breaks the traced operation
      }
    },
  };
}

/**
 * Finish the trace as "ok" only after the callback's (possibly async)
 * result settles successfully; a throw or rejection passes through
 * untouched so the caller's failure path owns the non-ok outcome.
 */
export function finishTraceOnSuccess<T>(
  trace: PluginPerformanceTrace | undefined,
  callback: () => T | Promise<T>,
): T | Promise<T> {
  const result = callback();
  if (result instanceof Promise) {
    return result.then((value) => {
      trace?.finish("ok");
      return value;
    });
  }
  trace?.finish("ok");
  return result;
}

/** RPC keys are camelCase; telemetry identifiers are lowercase kebab. */
export function rpcTraceOperation(key: string): string {
  return `rpc.${key.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
}

/** Tool keys are already lowercase snake, valid as-is. */
export function toolTraceOperation(key: string): string {
  return `tool.${key}`;
}
