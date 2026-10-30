import { AsyncLocalStorage } from "node:async_hooks";
import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type { HostResolver } from "../../../shared/contracts/engine.ts";
import {
  HOST_PAYLOAD_LIMIT_BYTES,
  HOST_TIMEOUT_MS,
  type HostFunctionName,
  type HostModule,
  type HostSignalPayload,
  type WhiteboardHostContract,
  type WhiteboardHostSignals,
  whiteboardHostContract,
  whiteboardHostSignals,
} from "../../../shared/contracts/host-contract.ts";
import {
  type VcsHandle,
  type WireError,
  type WireResult,
  decodeWire,
  encodeWire,
} from "../../../shared/contracts/wire.ts";
import { LocalVcsToolsMissingError } from "../../../shared/node/local-vcs/index.ts";
import { ReviewInputError } from "../../../shared/review/input-error.ts";
import { isWhiteboardHostResolver } from "../host-resolver.ts";
import { vcsProxy } from "./vcs-proxy.ts";

/** The typed client for the plugin's host entry (design §3.1). */
export type WhiteboardHostClient = ExperimentalHostClient<
  WhiteboardHostContract,
  WhiteboardHostSignals
>;

/** What every facade module calls through. Installed once per plugin load. */
export type HostIo = {
  client: WhiteboardHostClient;
  resolver: HostResolver;
};

type StreamListener = (payload: HostSignalPayload<"structuralEvents">) => void;
type WatchListener = (payload: HostSignalPayload<"worktreeChanged">) => void;
type ExitListener = (hostId: string) => void;

/** The live installation: the client, the resolver and the signal routing tables. */
type Installation = HostIo & {
  streams: Map<string, { hostId: string; listener: StreamListener }>;
  watches: Map<string, { hostId: string; listener: WatchListener }>;
  exits: Set<ExitListener>;
  disposers: Set<() => void>;
};

let current: Installation | undefined;

/**
 * A host call bb could not deliver or finish: the host is not connected, is
 * suspended, or did not answer before the call's timeout. The message names
 * the machine, because the browser and the agent may be on other machines.
 * Not a `ReviewInputError`: upstream treats those as invalid sources, and an
 * offline host says nothing about the source.
 */
export class HostUnavailableError extends Error {
  override readonly name = "HostUnavailableError";

  constructor(
    readonly hostId: string,
    hostName: string,
    timedOut: boolean,
  ) {
    super(
      timedOut
        ? `${hostName} did not answer in time. Whiteboard reads this checkout on ${hostName}. Check that it is awake and connected to bb, then retry.`
        : `${hostName} is not connected to bb. Whiteboard reads this checkout on ${hostName}. Reconnect it, then retry.`,
    );
  }
}

/**
 * The host daemon enforces the call's timeout itself, including fetching the
 * host artifact and starting the worker, and answers before bb's transport
 * timeout (the timeout plus 6 s of grace). It answers `command_failed` with
 * one of these messages.
 */
const DAEMON_DEADLINE =
  /^host plugin call \S+ (?:reached its deadline before dispatch|exceeded its deadline)$/;

/** A bb transport failure (`ApiError` body), or undefined for the host entry's own error. */
function transportFailure(error: unknown): "unavailable" | "timedOut" | undefined {
  const body = (error as { body?: { code?: unknown; message?: unknown } } | null)?.body;
  if (body?.code === "host_unavailable") return "unavailable";
  if (body?.code === "command_timeout") return "timedOut";
  if (
    body?.code === "command_failed" &&
    typeof body.message === "string" &&
    DAEMON_DEADLINE.test(body.message)
  )
    return "timedOut";
  return undefined;
}

async function fromTransportError(
  error: unknown,
  hostId: string,
  resolver: HostResolver,
): Promise<unknown> {
  const failure = transportFailure(error);
  if (!failure) return error;
  const name = isWhiteboardHostResolver(resolver) ? await resolver.hostName(hostId) : hostId;
  return new HostUnavailableError(hostId, name, failure === "timedOut");
}

/**
 * Install the host client and resolver the facades use, and return an
 * uninstall for `bb.onDispose`.
 */
export function installHostIo(bb: BbPluginApi, resolver: HostResolver): () => void {
  return installHostClient(
    bb.hosts.experimental_client({
      contract: whiteboardHostContract,
      experimental_signals: whiteboardHostSignals,
    }),
    resolver,
  );
}

/**
 * Install any client with the host contract (the bb one, or the in-process one
 * specs use). The uninstall unsubscribes, stops every watch and aborts every
 * structural stream (design §1.7), then restores the previous installation.
 */
export function installHostClient(
  client: WhiteboardHostClient,
  resolver: HostResolver,
): () => void {
  const previous = current;
  const installation: Installation = {
    // Every facade calls through here, so transport failures are named once.
    client: {
      call: ((method, input, options) =>
        client.call(method, input, options).catch(async (error: unknown) => {
          throw await fromTransportError(error, options.hostId, resolver);
        })) as WhiteboardHostClient["call"],
      experimental_onSignal: (signal, handler) => client.experimental_onSignal(signal, handler),
      experimental_onWorkerExit: (handler) => client.experimental_onWorkerExit(handler),
    },
    resolver,
    streams: new Map(),
    watches: new Map(),
    exits: new Set(),
    disposers: new Set(),
  };
  const unsubscribe = [
    client.experimental_onSignal("structuralEvents", (event) => {
      const stream = installation.streams.get(event.payload.streamId);
      if (stream?.hostId === event.hostId) stream.listener(event.payload);
    }),
    client.experimental_onSignal("worktreeChanged", (event) => {
      const watch = installation.watches.get(event.payload.watchId);
      if (watch?.hostId === event.hostId) watch.listener(event.payload);
    }),
    client.experimental_onWorkerExit((event) => {
      // A snapshot: listeners added while this exit is delivered wait for the next one.
      for (const listener of Array.from(installation.exits)) listener(event.hostId);
    }),
  ];
  current = installation;
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    for (const off of unsubscribe) off();
    for (const dispose of Array.from(installation.disposers)) dispose();
    installation.disposers.clear();
    if (current === installation) current = previous;
  };
}

function installation(): Installation {
  if (!current)
    throw new Error("whiteboard: host IO is not installed (the engine installs it at setup).");
  return current;
}

/** The installed host IO. Throws when no plugin load installed one. */
export function hostIo(): HostIo {
  return installation();
}

/** Route `structuralEvents` for `streamId` from `hostId` to `listener` until the returned off. */
export function onStructuralEvents(
  streamId: string,
  hostId: string,
  listener: StreamListener,
): () => void {
  const live = installation();
  live.streams.set(streamId, { hostId, listener });
  return () => {
    if (live.streams.get(streamId)?.listener === listener) live.streams.delete(streamId);
  };
}

/** Route `worktreeChanged` for `watchId` from `hostId` to `listener` until the returned off. */
export function onWorktreeChanged(
  watchId: string,
  hostId: string,
  listener: WatchListener,
): () => void {
  const live = installation();
  live.watches.set(watchId, { hostId, listener });
  return () => {
    if (live.watches.get(watchId)?.listener === listener) live.watches.delete(watchId);
  };
}

/** Run `listener` on every unexpected host-worker exit until the returned off. */
export function onWorkerExit(listener: ExitListener): () => void {
  const live = installation();
  live.exits.add(listener);
  return () => live.exits.delete(listener);
}

/** Run `dispose` when the installation is uninstalled (plugin dispose), until the returned off. */
export function onUninstall(dispose: () => void): () => void {
  const live = installation();
  live.disposers.add(dispose);
  return () => live.disposers.delete(dispose);
}

/** Where a host call goes: an explicit host, or the host that owns a repository or path. */
export type HostRoute = { hostId: string } | { repositoryId?: string; rootPath?: string };

const pinnedHost = new AsyncLocalStorage<string>();

/**
 * Run `fn` with every path or repository route sent to `hostId`. Registration
 * uses it: the caller's checkout is on the caller's host, even when the same
 * path is already bound to another host.
 */
export function withHostRoute<T>(hostId: string, fn: () => Promise<T>): Promise<T> {
  return pinnedHost.run(hostId, fn);
}

export async function routeHost(route: HostRoute): Promise<string> {
  if ("hostId" in route) return route.hostId;
  return pinnedHost.getStore() ?? installation().resolver.hostFor(route);
}

/** Record that `rootPath` came from `hostId`, so later calls on it return there. */
export function rememberPath(rootPath: string | null | undefined, hostId: string): void {
  const resolver = current?.resolver;
  if (rootPath && resolver && isWhiteboardHostResolver(resolver))
    resolver.rememberPath(rootPath, hostId);
}

/** The error a hop failure stands for: upstream classes keep their identity and status. */
export function fromWireError(error: WireError | undefined): Error {
  if (!error) return new Error("whiteboard: the host call failed without an error.");
  if (error.name === "ReviewInputError")
    return new ReviewInputError(error.message, (error.status ?? 400) as 400 | 401 | 404 | 409);
  if (error.name === "LocalVcsToolsMissingError")
    return Object.assign(new LocalVcsToolsMissingError(), { message: error.message });
  const out = new Error(error.message) as Error & { status?: number; code?: string };
  out.name = error.name;
  if (error.status !== undefined) out.status = error.status;
  if (error.code !== undefined) out.code = error.code;
  return out;
}

export function isPayloadTooLarge(error: unknown): boolean {
  return error instanceof Error && error.name === "PayloadTooLarge";
}

/** Unwrap an `invoke`/`vcsCall` result. `$vcs` handles become proxies bound to `hostId`. */
export function unwrapResult(result: WireResult, hostId: string): unknown {
  if (!result.ok) throw fromWireError(result.error);
  if (result.value === undefined) return undefined;
  return decodeWire(result.value, (handle: VcsHandle) => vcsProxy(handle, hostId));
}

/** Encode hop arguments, refusing input no hop can carry. */
export function encodeArgs(args: readonly unknown[]) {
  const encoded = args.map((arg) => encodeWire(arg));
  const size = Buffer.byteLength(JSON.stringify(encoded));
  if (size > HOST_PAYLOAD_LIMIT_BYTES)
    throw Object.assign(
      new Error(
        `whiteboard: the host call input is ${size} bytes, above the ${HOST_PAYLOAD_LIMIT_BYTES}-byte host transfer limit.`,
      ),
      { name: "PayloadTooLarge" },
    );
  return encoded;
}

export type InvokeOptions = { timeoutMs?: number; signal?: AbortSignal };

/** Call one allowlisted host export on the host `route` names. Returns the host it ran on. */
export async function invokeOn<M extends HostModule>(
  module: M,
  fn: HostFunctionName<M>,
  args: readonly unknown[],
  route: HostRoute,
  options: InvokeOptions = {},
): Promise<{ value: unknown; hostId: string }> {
  const hostId = await routeHost(route);
  const result = await installation().client.call(
    "invoke",
    { module, fn, args: encodeArgs(args) },
    {
      hostId,
      timeoutMs: options.timeoutMs ?? HOST_TIMEOUT_MS.default,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return { value: unwrapResult(result, hostId), hostId };
}

/** `invokeOn`, returning the value only. */
export async function invokeHost<M extends HostModule>(
  module: M,
  fn: HostFunctionName<M>,
  args: readonly unknown[],
  route: HostRoute,
  options?: InvokeOptions,
): Promise<unknown> {
  return (await invokeOn(module, fn, args, route, options)).value;
}
