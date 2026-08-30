export type PluginFailure =
  | Readonly<{ boundary: "plugin.factory" | "plugin.setup"; error: unknown }>
  | Readonly<{
      boundary: "rpc.execute" | "rpc.cli" | "command.execute" | "agent.tool";
      operation: string;
      error: unknown;
    }>
  | Readonly<{ boundary: "agent.configure" | "agent.instructions"; error: unknown }>;

export interface PluginErrorReporter {
  capture(failure: PluginFailure): undefined;
  dispose?(timeoutMs: number): void | Promise<void>;
}

export type PluginErrorReporterFactory = (
  context: Readonly<{ pluginId: string }>,
) => PluginErrorReporter | undefined;

const REPORTER_DISPOSE_TIMEOUT_MS = 2_000;

export function createPluginErrorReporter(
  factory: PluginErrorReporterFactory | undefined,
  pluginId: string,
): PluginErrorReporter | undefined {
  try {
    return factory?.({ pluginId });
  } catch {
    return undefined;
  }
}

export function capturePluginFailure(
  reporter: PluginErrorReporter | undefined,
  failure: PluginFailure,
): undefined {
  try {
    return reporter?.capture(failure);
  } catch {
    return undefined;
  }
}

export function createPluginErrorReporterDisposer(
  reporter: PluginErrorReporter | undefined,
  timeoutMs = REPORTER_DISPOSE_TIMEOUT_MS,
): () => Promise<void> {
  let disposing: Promise<void> | undefined;
  return () => {
    if (disposing === undefined) {
      disposing = disposePluginErrorReporter(reporter, timeoutMs);
    }
    return disposing;
  };
}

export function observePluginFailure<T>(callback: () => T, onFailure: (error: unknown) => void): T;
export function observePluginFailure<T>(
  callback: () => T | Promise<T>,
  onFailure: (error: unknown) => void,
): T | Promise<T>;
export function observePluginFailure<T>(
  callback: () => T | Promise<T>,
  onFailure: (error: unknown) => void,
): T | Promise<T> {
  try {
    const result = callback();
    if (result instanceof Promise) {
      return result.catch((error: unknown) => {
        onFailure(error);
        throw error;
      });
    }
    return result;
  } catch (error) {
    onFailure(error);
    throw error;
  }
}

export function isAbortedFailure(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && error instanceof Error && error.name === "AbortError";
}

async function disposePluginErrorReporter(
  reporter: PluginErrorReporter | undefined,
  timeoutMs: number,
): Promise<void> {
  let dispose: PluginErrorReporter["dispose"];
  try {
    dispose = reporter?.dispose;
  } catch {
    return;
  }
  if (dispose === undefined) {
    return;
  }

  let result: void | Promise<void>;
  try {
    result = dispose.call(reporter, timeoutMs);
  } catch {
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.resolve(result).catch(() => undefined), deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
