import {
  isStandaloneBuiltinCompactCommand,
  type BridgeExecutionOptions,
  type ClientTurnRequestId,
  type PromptInput as BridgePromptInput,
} from "@get-bb/plugin-sdk/provider-bridge";
import type {
  DefaultAgent,
  Model,
  PromptInput,
  SessionSnapshot,
  Thinking,
  Turn,
  TurnResult,
} from "nanocodex/host";
import type { NativeAgentOptions, NativeBinding } from "./binding.ts";
import { createTurnProjector, type TurnProjector } from "./bridge/project.ts";
import { usageBreakdown, type ThreadWriter, type TurnScribe } from "./bridge/timeline.ts";
import { isNanocodexModel, isNanocodexThinking } from "./catalog.ts";
import type { NanocodexStorage, StoredThread } from "./storage.ts";

export interface PreparedSession {
  readonly providerThreadId: string;
  activate(writer: ThreadWriter): void;
  dispose(): Promise<void>;
}

export interface SessionRegistry {
  prepareNew(args: SessionOptions & { readonly providerThreadId: string }): Promise<PreparedSession>;
  prepareResume(args: SessionOptions & { readonly providerThreadId: string }): Promise<PreparedSession>;
  prepareFork(args: SessionOptions & { readonly providerThreadId: string; readonly seed: SessionSnapshot }): Promise<PreparedSession>;
  prepareTurn(args: StartTurnOptions): () => void;
  prepareSteer(args: SteerOptions): () => Promise<void>;
  stop(threadId: string, intent: "interrupt" | "release"): Promise<void>;
  discard(threadId: string, providerThreadId: string): Promise<void>;
  close(): Promise<void>;
}

interface SessionOptions {
  readonly threadId: string;
  readonly cwd: string;
  readonly options: BridgeExecutionOptions;
}

interface StartTurnOptions {
  readonly threadId: string;
  readonly input: readonly BridgePromptInput[];
  readonly clientRequestId: ClientTurnRequestId | null;
  readonly options: BridgeExecutionOptions;
}

interface SteerOptions extends Omit<StartTurnOptions, "clientRequestId"> {
  readonly clientRequestId: ClientTurnRequestId;
}

interface SessionBase {
  readonly threadId: string;
  readonly providerThreadId: string;
  readonly cwd: string;
  readonly writer: ThreadWriter;
  readonly agentOptions: NativeAgentOptions;
  readonly durabilityId: string;
  agent: DefaultAgent;
  nextCheckpoint: number;
  lastSnapshot: SessionSnapshot | undefined;
  forkSeed: SessionSnapshot | undefined;
}

interface IdleSession extends SessionBase {
  readonly kind: "idle";
}

type RunningOperation =
  | { readonly kind: "prepared" }
  | { readonly kind: "turn"; readonly native: Turn }
  | { readonly kind: "compact" };

interface RunningSession extends SessionBase {
  readonly kind: "running";
  readonly scribe: TurnScribe;
  operation: RunningOperation;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
  cancelRequested: boolean;
  releaseRequested: boolean;
  stopWatching: () => void;
}

interface ClosedSession {
  readonly kind: "closed";
  readonly threadId: string;
  readonly providerThreadId: string;
}

type SessionState = IdleSession | RunningSession | ClosedSession;

export class NoActiveTurnError extends Error {}
export class SessionBusyError extends Error {}

export function createSessionRegistry(args: {
  readonly binding: NativeBinding;
  readonly storage: NanocodexStorage;
}): SessionRegistry {
  const { binding, storage } = args;
  const sessions = new Map<string, SessionState>();
  let closed = false;

  const prepareSession = async (
    options: SessionOptions & { readonly providerThreadId: string },
    mode: "new" | "resume" | "fork",
    seed?: SessionSnapshot,
  ): Promise<PreparedSession> => {
    if (closed) throw new Error("The NanoCodex session registry is closed");
    const nativeOptions = toNativeAgentOptions(options);
    let stored: StoredThread;
    let agent: DefaultAgent;
    if (mode === "new") {
      stored = await storage.createThread(options.providerThreadId);
      agent = await createDurableAgent(
        binding,
        storage,
        options.providerThreadId,
        stored.durabilityId,
        nativeOptions,
      );
    } else if (mode === "fork") {
      if (seed === undefined) throw new Error("A fork needs an exact checkpoint seed");
      stored = await storage.createFork(options.providerThreadId, seed);
      agent = await createForkAgent(binding, nativeOptions, seed);
    } else {
      stored = await storage.readThread(options.providerThreadId);
      agent = stored.forkSeed === undefined
        ? await createDurableAgent(
            binding,
            storage,
            options.providerThreadId,
            stored.durabilityId,
            nativeOptions,
          )
        : await createForkAgent(binding, nativeOptions, stored.forkSeed);
    }

    let activated = false;
    return {
      providerThreadId: options.providerThreadId,
      activate(writer) {
        if (activated) throw new Error("The prepared NanoCodex session is already active");
        activated = true;
        sessions.set(options.threadId, {
          kind: "idle",
          threadId: options.threadId,
          providerThreadId: options.providerThreadId,
          cwd: options.cwd,
          writer,
          agent,
          agentOptions: nativeOptions,
          durabilityId: stored.durabilityId,
          nextCheckpoint: stored.nextCheckpoint,
          lastSnapshot: latestSnapshot(stored),
          forkSeed: stored.forkSeed,
        });
      },
      async dispose() {
        if (!activated) await agent.session.shutdown();
      },
    };
  };

  const executeTurn = async (
    running: RunningSession,
    input: readonly BridgePromptInput[],
    options: BridgeExecutionOptions,
  ): Promise<void> => {
    let native: Turn | undefined;
    let result: TurnResult | undefined;
    let projector: TurnProjector | undefined;
    try {
      running.scribe.open(running.agent.sessionId);
      await running.agent.session.setThinking(toThinking(options.reasoningLevel));
      await running.agent.session.setFastMode(options.serviceTier === "fast");
      if (running.cancelRequested) {
        if (!running.releaseRequested) running.scribe.settle("interrupted");
        return;
      }
      if (isStandaloneBuiltinCompactCommand(input)) {
        running.operation = { kind: "compact" };
        projector = startProjection(running);
        running.scribe.acceptAll();
        await running.agent.session.compact();
        if (running.lastSnapshot === undefined) {
          throw new Error("NanoCodex cannot checkpoint an empty compacted session");
        }
        const context = await running.agent.session.context();
        const snapshot: SessionSnapshot = {
          ...running.lastSnapshot,
          workspace: context.workspace,
          history: context.history,
        };
        await commitCheckpoint(running, snapshot);
        if (projector.compactionCount === 0) running.scribe.compacted();
        if (!running.releaseRequested) running.scribe.settle("completed");
        return;
      }

      projector = startProjection(running);
      native = running.agent.turn.prompt({ input: toNativePrompt(input) });
      running.operation = { kind: "turn", native };
      await native.accepted();
      running.scribe.acceptAll();
      result = await native.result();
      const [snapshot, usage] = await Promise.all([result.snapshot(), result.usage()]);
      await commitCheckpoint(running, snapshot, {
        retainAsForkSeed: running.forkSeed !== undefined,
      });
      running.writer.addUsage(usageBreakdown(usage), projector.firstCallInputTokens);

      if (running.forkSeed !== undefined) {
        const durable = await createDurableAgent(
          binding,
          storage,
          running.providerThreadId,
          running.durabilityId,
          { ...running.agentOptions, resume: snapshot },
        );
        await storage.establishDurability(running.providerThreadId);
        const branch = running.agent;
        running.agent = durable;
        running.forkSeed = undefined;
        await branch.session.shutdown();
      }
      if (!running.releaseRequested) running.scribe.settle("completed");
    } catch (error) {
      if (!running.releaseRequested) {
        if (running.cancelRequested || errorCode(error) === "cancelled") {
          running.scribe.settle("interrupted");
        } else {
          const message = error instanceof Error ? error.message : String(error);
          running.scribe.fail({ message, settlesTurn: false });
          running.scribe.settle("failed", { error: { message } });
        }
      }
    } finally {
      running.stopWatching();
      result?.dispose();
      native?.dispose();
      sessions.set(
        running.threadId,
        running.releaseRequested
          ? { kind: "closed", threadId: running.threadId, providerThreadId: running.providerThreadId }
          : idleFrom(running),
      );
      running.resolveSettled();
    }
  };

  const prepareTurn = (options: StartTurnOptions): (() => void) => {
    const idle = sessions.get(options.threadId);
    if (idle?.kind !== "idle") {
      throw new SessionBusyError(`NanoCodex thread ${options.threadId} is not idle`);
    }
    const scribe = idle.writer.scribe({
      ordinal: idle.nextCheckpoint,
      clientRequestIds: options.clientRequestId === null ? [] : [options.clientRequestId],
    });
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const running: RunningSession = {
      ...idle,
      kind: "running",
      scribe,
      operation: { kind: "prepared" },
      settled,
      resolveSettled,
      cancelRequested: false,
      releaseRequested: false,
      stopWatching: () => {},
    };
    sessions.set(options.threadId, running);
    return () => { void executeTurn(running, options.input, options.options); };
  };

  const prepareSteer = (options: SteerOptions): (() => Promise<void>) => {
    const state = sessions.get(options.threadId);
    if (state?.kind !== "running" || state.operation.kind !== "turn") {
      throw new NoActiveTurnError("No active NanoCodex turn for this thread");
    }
    const native = state.operation.native;
    return async () => {
      try {
        await native.steer({ input: toNativePrompt(options.input) });
      } catch (error) {
        state.scribe.warn({
          summary: "NanoCodex rejected steered input.",
          details: error instanceof Error ? error.message : String(error),
        });
      } finally {
        state.scribe.adopt([options.clientRequestId]);
        state.scribe.acceptAll();
      }
    };
  };

  const stop = async (threadId: string, intent: "interrupt" | "release"): Promise<void> => {
    const state = sessions.get(threadId);
    if (state === undefined || state.kind === "closed") return;
    if (state.kind === "running") {
      state.releaseRequested = intent === "release";
      state.cancelRequested = true;
      if (state.operation.kind === "turn") {
        if (intent === "release") state.stopWatching();
        await state.operation.native.cancel();
      }
      await state.settled;
    }
    if (intent === "interrupt") return;
    await state.agent.session.shutdown();
    sessions.delete(threadId);
  };

  const discard = async (threadId: string, providerThreadId: string): Promise<void> => {
    await stop(threadId, "release");
    await storage.discardThread(providerThreadId);
  };

  return {
    prepareNew(options) {
      return prepareSession(options, "new");
    },
    prepareResume(options) {
      return prepareSession(options, "resume");
    },
    prepareFork(options) {
      return prepareSession(options, "fork", options.seed);
    },
    prepareTurn,
    prepareSteer,
    stop,
    discard,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...sessions.keys()].map((threadId) => stop(threadId, "release")));
      await binding.close();
    },
  };

  function startProjection(running: RunningSession): TurnProjector {
    const projector = createTurnProjector({
      scribe: running.scribe,
      raw: (payload) => running.writer.raw(payload, "unknown"),
    });
    const watcher = running.agent.events.watch();
    running.stopWatching = watcher.onEvent((event) => {
      try {
        projector.consume(event);
      } catch (error) {
        running.scribe.warn({
          summary: "One NanoCodex event could not be projected.",
          details: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return projector;
  }

  async function commitCheckpoint(
    running: RunningSession,
    snapshot: SessionSnapshot,
    options: { readonly retainAsForkSeed?: boolean } = {},
  ): Promise<void> {
    const checkpointId = await storage.commitCheckpoint(running.providerThreadId, snapshot, options);
    if (checkpointId !== String(running.nextCheckpoint)) {
      throw new Error(`NanoCodex checkpoint sequence changed from ${running.nextCheckpoint} to ${checkpointId}`);
    }
    running.nextCheckpoint += 1;
    running.lastSnapshot = snapshot;
    if (options.retainAsForkSeed === true) running.forkSeed = snapshot;
  }
}

async function createDurableAgent(
  binding: NativeBinding,
  storage: NanocodexStorage,
  providerThreadId: string,
  durabilityId: string,
  options: NativeAgentOptions,
): Promise<DefaultAgent> {
  return binding.createAgent({
    ...options,
    durability: { store: storage.durabilityFor(providerThreadId), id: durabilityId },
  });
}

async function createForkAgent(
  binding: NativeBinding,
  options: NativeAgentOptions,
  seed: SessionSnapshot,
): Promise<DefaultAgent> {
  const temporary = await binding.createAgent({ ...options, resume: seed });
  try {
    return await temporary.session.fork();
  } finally {
    await temporary.session.shutdown();
  }
}

function idleFrom(running: RunningSession): IdleSession {
  return {
    kind: "idle",
    threadId: running.threadId,
    providerThreadId: running.providerThreadId,
    cwd: running.cwd,
    writer: running.writer,
    agentOptions: running.agentOptions,
    durabilityId: running.durabilityId,
    agent: running.agent,
    nextCheckpoint: running.nextCheckpoint,
    lastSnapshot: running.lastSnapshot,
    forkSeed: running.forkSeed,
  };
}

function latestSnapshot(stored: StoredThread): SessionSnapshot | undefined {
  return stored.nextCheckpoint === 0 ? undefined : stored.checkpoints[String(stored.nextCheckpoint - 1)];
}

function toNativeAgentOptions(options: SessionOptions): NativeAgentOptions {
  return {
    model: toModel(options.options.model),
    thinking: toThinking(options.options.reasoningLevel),
    fastMode: options.options.serviceTier === "fast",
    instructions: options.options.instructions,
    workspace: options.cwd,
  };
}

function toModel(value: string | undefined): Model {
  return isNanocodexModel(value) ? value : "gpt-5.6-sol";
}

function toThinking(value: string | undefined): Thinking {
  return isNanocodexThinking(value) ? value : "high";
}

function toNativePrompt(input: readonly BridgePromptInput[]): PromptInput {
  const items: ({ type: "text"; text: string } | { type: "image"; image_url: string })[] = [];
  for (const item of input) {
    switch (item.type) {
      case "text":
        items.push({ type: "text", text: item.text });
        break;
      case "image":
        items.push({ type: "image", image_url: item.url });
        break;
      case "localFile":
        items.push({ type: "text", text: `(see the file at ${item.path})` });
        break;
      case "localImage":
        items.push({ type: "text", text: `(see the image at ${item.path})` });
        break;
    }
  }
  return items;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
}
