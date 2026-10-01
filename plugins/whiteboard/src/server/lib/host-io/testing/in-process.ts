import { watch as fsWatch, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ExperimentalHostRpcContext,
  ExperimentalHostWatchListener,
  ExperimentalHostWatchOptions,
  ExperimentalHostWatchSubscription,
  StandardSchemaV1,
} from "@get-bb/plugin-sdk";
import hostEntry from "../../../../host/host.ts";
import type { HostResolver } from "../../../../shared/contracts/engine.ts";
import {
  type WhiteboardHostSignals,
  whiteboardHostContract,
  whiteboardHostSignals,
} from "../../../../shared/contracts/host-contract.ts";
import { type WhiteboardHostClient, installHostClient } from "../client.ts";

/** The host id the in-process host answers to. */
export const IN_PROCESS_HOST_ID = "in-process";

const OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

async function validate(schema: StandardSchemaV1, value: unknown, label: string): Promise<unknown> {
  const result = await schema["~standard"].validate(value);
  if (result.issues)
    throw new Error(`${label}: ${result.issues.map((issue) => issue.message).join("; ")}`);
  return result.value;
}

/** JSON round trip with the worker's 8 MiB bound, as the daemon transport does. */
function transport(value: unknown, label: string): unknown {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error(`${label} is not JSON-serializable`);
  if (Buffer.byteLength(text) > OUTPUT_LIMIT_BYTES)
    throw new Error(`${label} exceeds ${OUTPUT_LIMIT_BYTES} bytes`);
  return JSON.parse(text);
}

/** `experimental_watch` over `fs.watch`, coalescing like the daemon (75 ms quiet period). */
function nodeWatch(
  options: ExperimentalHostWatchOptions,
  listener: ExperimentalHostWatchListener,
): ExperimentalHostWatchSubscription {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changes = new Map<string, "update">();
  const watcher = fsWatch(options.rootPath, { recursive: true }, (_event, filename) => {
    changes.set(path.join(options.rootPath, String(filename ?? "")), "update");
    clearTimeout(timer);
    timer = setTimeout(() => {
      const batch = [...changes].map(([changed, type]) => ({ path: changed, type }));
      changes.clear();
      void listener({ kind: "changed", changes: batch });
    }, options.debounceMs ?? 75);
  });
  watcher.on("error", (error) => void listener({ kind: "watch-error", message: error.message }));
  return {
    async dispose() {
      clearTimeout(timer);
      watcher.close();
    },
  };
}

export type InProcessHostClient = WhiteboardHostClient & {
  /** Every call, in order, after input validation. */
  readonly calls: Array<{ method: string; input: unknown; hostId: string }>;
  /** Drop every watch the host holds and notify exit subscribers, as a crashed worker would. */
  simulateWorkerExit(hostId?: string): Promise<void>;
};

/**
 * The plugin's real host entry, run in this process with the daemon's
 * boundaries: contract validation and a JSON round trip on input, output and
 * signals, the 8 MiB result bound, call cancellation, and asynchronous signal
 * delivery. Watches use `fs.watch`. Specs and in-process engines use it in
 * place of a bb host.
 */
export function createInProcessHostClient(): InProcessHostClient {
  type Handler = (event: { hostId: string; payload: unknown }) => void | Promise<void>;
  const signalHandlers = new Map<string, Set<Handler>>();
  const exitHandlers = new Set<(event: { hostId: string }) => void | Promise<void>>();
  const live = new Set<ExperimentalHostWatchSubscription>();
  const dataDir = mkdtempSync(path.join(tmpdir(), "whiteboard-host-data-"));
  const tempDir = mkdtempSync(path.join(tmpdir(), "whiteboard-host-temp-"));
  let lifecycle = new AbortController();
  const calls: InProcessHostClient["calls"] = [];

  const context = (hostId: string, signal: AbortSignal) =>
    ({
      signal,
      lifecycle: { signal: lifecycle.signal },
      experimental_paths: { dataDir, tempDir },
      async experimental_emitSignal(name: string, payload: unknown) {
        const contract = whiteboardHostSignals[name as keyof WhiteboardHostSignals];
        if (!contract) throw new Error(`unknown host signal "${name}"`);
        const validated = transport(
          await validate(contract.payload, payload, `host signal ${name}`),
          `host signal ${name}`,
        );
        // Delivered on a later turn, in emission order, like the daemon's IPC.
        setImmediate(() => {
          for (const handler of signalHandlers.get(name) ?? [])
            void handler({ hostId, payload: validated });
        });
      },
      async experimental_watch(
        options: ExperimentalHostWatchOptions,
        listener: ExperimentalHostWatchListener,
      ) {
        const subscription = nodeWatch(options, listener);
        live.add(subscription);
        return {
          async dispose() {
            live.delete(subscription);
            await subscription.dispose();
          },
        };
      },
      experimental_retainWorker() {
        return { dispose: async () => {} };
      },
    }) as ExperimentalHostRpcContext<WhiteboardHostSignals>;

  const client = {
    calls,
    async call(
      method: string,
      input: unknown,
      options: { hostId: string; signal?: AbortSignal; timeoutMs?: number },
    ) {
      const contract = whiteboardHostContract[method as keyof typeof whiteboardHostContract];
      if (!contract) throw new Error(`unknown host rpc method "${method}"`);
      if (options.signal?.aborted)
        throw Object.assign(new Error("Host plugin call was cancelled"), { name: "AbortError" });
      const parsed = transport(await validate(contract.input, input, "input"), "input");
      calls.push({ method, input: parsed, hostId: options.hostId });
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, options.timeoutMs ?? 30_000);
      try {
        const handler = hostEntry.handlers[method as keyof typeof hostEntry.handlers] as (
          input: unknown,
          context: ExperimentalHostRpcContext<WhiteboardHostSignals>,
        ) => unknown;
        const result = await Promise.race([
          handler(parsed, context(options.hostId, controller.signal)),
          new Promise<never>((_, reject) =>
            controller.signal.addEventListener(
              "abort",
              () =>
                reject(
                  Object.assign(new Error("Host plugin call was cancelled"), {
                    name: "AbortError",
                  }),
                ),
              { once: true },
            ),
          ),
        ]);
        return transport(
          await validate(contract.output, result, `host output for ${method}`),
          `host output for ${method}`,
        );
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      }
    },
    experimental_onSignal(name: string, handler: Handler) {
      let handlers = signalHandlers.get(name);
      if (!handlers) signalHandlers.set(name, (handlers = new Set()));
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    experimental_onWorkerExit(handler: (event: { hostId: string }) => void | Promise<void>) {
      exitHandlers.add(handler);
      return () => void exitHandlers.delete(handler);
    },
    async simulateWorkerExit(hostId = IN_PROCESS_HOST_ID) {
      lifecycle.abort();
      lifecycle = new AbortController();
      await Promise.all([...live].map((subscription) => subscription.dispose()));
      live.clear();
      for (const handler of Array.from(exitHandlers)) await handler({ hostId });
    },
  };
  return client as unknown as InProcessHostClient;
}

/** A resolver that sends every call to the in-process host. */
export function inProcessResolver(): HostResolver {
  return {
    hostFor: async () => IN_PROCESS_HOST_ID,
    bindRepository: async () => {},
  };
}

/** Install the in-process host for the facades; returns the client and the uninstall. */
export function installInProcessHostIo(resolver: HostResolver = inProcessResolver()) {
  const client = createInProcessHostClient();
  const uninstall = installHostClient(client, resolver);
  return { client, uninstall };
}
