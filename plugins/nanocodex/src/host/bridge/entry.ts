import { randomBytes } from "node:crypto";
import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  createBridgeIo,
  experimental_defineProviderBridge,
  modelListParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  threadDiscardParamsSchema,
  threadForkParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type BridgeCapabilities,
  type PromptInput,
  type ProviderHealthResult,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { NativeBinding } from "../binding.ts";
import { createProcessBinding } from "../binding.ts";
import { NANOCODEX_BINDING_VERSION, NANOCODEX_WIRE_MODELS } from "../../shared/provider-catalog.ts";
import {
  NoActiveTurnError,
  SessionBusyError,
  createSessionRegistry,
  type PreparedSession,
  type SessionRegistry,
} from "../session.ts";
import { createNanocodexStorage, type NanocodexStorage } from "../storage.ts";
import { createThreadWriter } from "./timeline.ts";
import { createNanocodexErrorReporter } from "../telemetry.ts";
import type { SentryPluginReporter } from "@bb-kit/sentry/node";

export const CAPABILITIES: BridgeCapabilities = {
  grammarVersions: [3, 3],
  sessionRestore: true,
  fork: "checkpoint",
  approvalEnforcedBy: "provider",
  steerMode: "inject",
  threadArchive: false,
  threadRename: false,
  threadGoalClear: false,
  skills: { configure: false },
};

interface ThreadIdentityResult {
  readonly providerThreadId: string;
  readonly sessionRestorable: true;
}

interface BridgeDependencies {
  readonly createStorage?: (dataDir: string) => NanocodexStorage;
  readonly createBinding?: (storage: NanocodexStorage) => NativeBinding;
  readonly createRegistry?: (args: {
    binding: NativeBinding;
    storage: NanocodexStorage;
  }) => SessionRegistry;
  readonly captureFailure?: (operation: string, error: unknown) => void;
}

export interface NanocodexBridge {
  start(context: { readonly dataDir: string }): void;
  handleLine(line: string): void;
  close(): Promise<void>;
}

type JsonRpcId = string | number;

export function createBridge(dependencies: BridgeDependencies = {}): NanocodexBridge {
  const io = createBridgeIo();
  let registry: SessionRegistry | undefined;
  let binding: NativeBinding | undefined;
  let storage: NanocodexStorage | undefined;
  const captureFailure = (operation: string, error: unknown): void => {
    try {
      dependencies.captureFailure?.(operation, error);
    } catch {
      return;
    }
  };

  const requireRuntime = (): {
    registry: SessionRegistry;
    binding: NativeBinding;
    storage: NanocodexStorage;
  } => {
    if (registry === undefined || binding === undefined || storage === undefined) {
      throw new Error("The NanoCodex bridge received a request before start()");
    }
    return { registry, binding, storage };
  };

  const invalidParams = (id: JsonRpcId, method: string, issues: unknown): void => {
    io.send({
      jsonrpc: "2.0",
      id,
      error: {
        code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        message: `Invalid params for ${method}`,
        data: issues,
      },
    });
  };

  const methodNotFound = (id: JsonRpcId, method: string): void => {
    io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not implemented: ${method}`);
  };

  const activate = (
    prepared: PreparedSession,
    args: {
      readonly threadId: string;
      readonly input?: readonly PromptInput[];
      readonly options: Parameters<SessionRegistry["prepareTurn"]>[0]["options"];
    },
  ): void => {
    try {
      const writer = createThreadWriter({
        threadId: args.threadId,
        providerThreadId: prepared.providerThreadId,
        send: io.send,
      });
      prepared.activate(writer);
      if (args.input !== undefined && args.input.length > 0) {
        const afterReply = requireRuntime().registry.prepareTurn({
          threadId: args.threadId,
          input: args.input,
          clientRequestId: null,
          options: args.options,
        });
        afterReply();
      }
    } catch (error) {
      captureFailure("thread/activate", error);
      void prepared.dispose().catch((disposeError) => {
        captureFailure("thread/activate/dispose", disposeError);
      });
      void registry?.stop(args.threadId, "release").catch((stopError) => {
        captureFailure("thread/activate/stop", stopError);
      });
    }
  };

  const handlers: Record<string, (id: JsonRpcId, params: unknown) => void | Promise<void>> = {
    [BRIDGE_REQUEST_METHODS.initialize]: (id) => {
      io.sendResult(id, {
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: CAPABILITIES,
      });
    },
    [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
      const parsed = modelListParamsSchema.safeParse(params);
      if (!parsed.success)
        return invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
      io.sendResult(id, { models: NANOCODEX_WIRE_MODELS, selectedOnlyModels: [] });
    },
    [BRIDGE_REQUEST_METHODS.providerHealth]: async (id, params) => {
      const parsed = providerMaintenanceParamsSchema.safeParse(params);
      if (!parsed.success)
        return invalidParams(id, BRIDGE_REQUEST_METHODS.providerHealth, parsed.error.issues);
      io.sendResult(id, await providerHealth(requireRuntime().binding));
    },
    [BRIDGE_REQUEST_METHODS.providerUsage]: (id) =>
      methodNotFound(id, BRIDGE_REQUEST_METHODS.providerUsage),
    [BRIDGE_REQUEST_METHODS.providerInstallationStatus]: (id) =>
      methodNotFound(id, BRIDGE_REQUEST_METHODS.providerInstallationStatus),
    [BRIDGE_REQUEST_METHODS.providerInstallationRun]: (id) =>
      methodNotFound(id, BRIDGE_REQUEST_METHODS.providerInstallationRun),
    [BRIDGE_REQUEST_METHODS.threadStart]: async (id, params) => {
      const parsed = threadStartParamsSchema.safeParse(params);
      if (!parsed.success)
        return invalidParams(id, BRIDGE_REQUEST_METHODS.threadStart, parsed.error.issues);
      const providerThreadId = mintProviderThreadId();
      const prepared = await requireRuntime().registry.prepareNew({
        threadId: parsed.data.threadId,
        providerThreadId,
        cwd: parsed.data.cwd,
        options: parsed.data.options,
      });
      io.sendResult(id, identity(providerThreadId));
      activate(prepared, {
        threadId: parsed.data.threadId,
        input: parsed.data.input,
        options: parsed.data.options,
      });
    },
    [BRIDGE_REQUEST_METHODS.threadResume]: async (id, params) => {
      const parsed = threadResumeParamsSchema.safeParse(params);
      if (!parsed.success)
        return invalidParams(id, BRIDGE_REQUEST_METHODS.threadResume, parsed.error.issues);
      const prepared = await requireRuntime().registry.prepareResume({
        threadId: parsed.data.threadId,
        providerThreadId: parsed.data.providerThreadId,
        cwd: parsed.data.cwd,
        options: parsed.data.options,
      });
      io.sendResult(id, identity(parsed.data.providerThreadId));
      activate(prepared, {
        threadId: parsed.data.threadId,
        input: parsed.data.input as readonly PromptInput[] | undefined,
        options: parsed.data.options,
      });
    },
    [BRIDGE_REQUEST_METHODS.threadFork]: async (id, params) => {
      const parsed = threadForkParamsSchema.safeParse(params);
      if (!parsed.success)
        return invalidParams(id, BRIDGE_REQUEST_METHODS.threadFork, parsed.error.issues);
      let seed;
      try {
        seed = await requireRuntime().storage.readCheckpoint(
          parsed.data.sourceProviderThreadId,
          parsed.data.sourceProviderCheckpointId,
        );
      } catch (error) {
        io.sendError(
          id,
          BRIDGE_JSON_RPC_ERRORS.FORK_CHECKPOINT_UNSUPPORTED,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      const providerThreadId = mintProviderThreadId();
      const prepared = await requireRuntime().registry.prepareFork({
        threadId: parsed.data.threadId,
        providerThreadId,
        cwd: parsed.data.cwd,
        options: parsed.data.options,
        seed,
      });
      io.sendResult(id, identity(providerThreadId));
      activate(prepared, { threadId: parsed.data.threadId, options: parsed.data.options });
    },
    [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
      const parsed = turnStartParamsSchema.safeParse(params);
      if (!parsed.success)
        return invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      let afterReply: () => void;
      try {
        afterReply = requireRuntime().registry.prepareTurn({
          threadId: parsed.data.threadId,
          input: parsed.data.input as readonly PromptInput[],
          clientRequestId: parsed.data.clientRequestId,
          options: parsed.data.options,
        });
      } catch (error) {
        if (error instanceof SessionBusyError) {
          io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, error.message);
          return;
        }
        throw error;
      }
      io.sendResult(id, {});
      afterReply();
    },
    [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
      const parsed = turnSteerParamsSchema.safeParse(params);
      if (!parsed.success)
        return invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
      let afterReply: () => Promise<void>;
      try {
        afterReply = requireRuntime().registry.prepareSteer({
          threadId: parsed.data.threadId,
          input: parsed.data.input as readonly PromptInput[],
          clientRequestId: parsed.data.clientRequestId,
          options: parsed.data.options,
        });
      } catch (error) {
        if (error instanceof NoActiveTurnError) {
          io.sendError(id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, error.message);
          return;
        }
        throw error;
      }
      io.sendResult(id, {});
      void afterReply().catch((error) => {
        captureFailure(BRIDGE_REQUEST_METHODS.turnSteer, error);
      });
    },
    [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
      const parsed = threadStopParamsSchema.safeParse(params);
      if (!parsed.success)
        return invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      io.sendResult(id, {});
      void requireRuntime()
        .registry.stop(parsed.data.threadId, parsed.data.intent)
        .catch((error) => {
          captureFailure(BRIDGE_REQUEST_METHODS.threadStop, error);
        });
    },
    [BRIDGE_REQUEST_METHODS.threadDiscard]: (id, params) => {
      const parsed = threadDiscardParamsSchema.safeParse(params);
      if (!parsed.success)
        return invalidParams(id, BRIDGE_REQUEST_METHODS.threadDiscard, parsed.error.issues);
      io.sendResult(id, {});
      void requireRuntime()
        .registry.discard(parsed.data.threadId, parsed.data.providerThreadId)
        .catch((error) => {
          captureFailure(BRIDGE_REQUEST_METHODS.threadDiscard, error);
        });
    },
    [BRIDGE_REQUEST_METHODS.threadArchive]: (id) =>
      methodNotFound(id, BRIDGE_REQUEST_METHODS.threadArchive),
    [BRIDGE_REQUEST_METHODS.threadUnarchive]: (id) =>
      methodNotFound(id, BRIDGE_REQUEST_METHODS.threadUnarchive),
    [BRIDGE_REQUEST_METHODS.threadNameSet]: (id) =>
      methodNotFound(id, BRIDGE_REQUEST_METHODS.threadNameSet),
    [BRIDGE_REQUEST_METHODS.threadGoalClear]: (id) =>
      methodNotFound(id, BRIDGE_REQUEST_METHODS.threadGoalClear),
    [BRIDGE_REQUEST_METHODS.skillsConfigure]: (id) =>
      methodNotFound(id, BRIDGE_REQUEST_METHODS.skillsConfigure),
  };

  return {
    start(context) {
      storage = (dependencies.createStorage ?? createNanocodexStorage)(context.dataDir);
      binding = (dependencies.createBinding ?? createProcessBinding)(storage);
      registry = (dependencies.createRegistry ?? createSessionRegistry)({ binding, storage });
    },
    handleLine(line) {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const request = message as { id?: unknown; method?: unknown; params?: unknown };
      if (
        (typeof request.id !== "string" && typeof request.id !== "number") ||
        typeof request.method !== "string"
      )
        return;
      const handler = handlers[request.method];
      if (handler === undefined) return methodNotFound(request.id, request.method);
      runBridgeRequest({
        request: { id: request.id, method: request.method, params: request.params },
        sendError: io.sendError,
        handleRequest: async (decoded) => {
          try {
            await handler(decoded.id, decoded.params);
          } catch (error) {
            captureFailure(decoded.method, error);
            throw error;
          }
        },
      });
    },
    async close() {
      try {
        await registry?.close();
      } finally {
        registry = undefined;
        binding = undefined;
        storage = undefined;
      }
    },
  };
}

async function providerHealth(binding: NativeBinding): Promise<ProviderHealthResult> {
  const status = await binding.health({ beginLogin: true });
  const base = {
    accountEmail: null,
    canInstall: false,
    canUpdate: false,
    installedVersion: NANOCODEX_BINDING_VERSION,
    loginCommand: null,
    minimumSupportedVersion: NANOCODEX_BINDING_VERSION,
    planLabel: null,
  };
  switch (status.state) {
    case "authenticated":
      return { supported: true, health: { ...base, status: "ready", statusMessage: null } };
    case "expired":
      return {
        supported: true,
        health: {
          ...base,
          status: "expired",
          statusMessage:
            "The ChatGPT subscription expired. Start device login from provider health.",
        },
      };
    case "pending":
      return {
        supported: true,
        health: {
          ...base,
          status: "unauthenticated",
          statusMessage: `Device login is pending. Open ${status.verificationUrl} and enter ${status.userCode}.`,
        },
      };
    case "signed_out":
      return {
        supported: true,
        health: { ...base, status: "unauthenticated", statusMessage: "NanoCodex is signed out." },
      };
    case "broken":
      return {
        supported: true,
        health: { ...base, status: "unknown", statusMessage: status.message },
      };
  }
}

function identity(providerThreadId: string): ThreadIdentityResult {
  return { providerThreadId, sessionRestorable: true };
}

function mintProviderThreadId(): string {
  return `nanocodex-${randomBytes(12).toString("hex")}`;
}

let runtime: NanocodexBridge | undefined;
let errors: SentryPluginReporter | undefined;
let closing: Promise<void> | undefined;

function captureHostFailure(operation: string, error: unknown): void {
  errors?.capture({ boundary: "host.bridge", operation, error });
}

function closeRuntime(): Promise<void> {
  closing ??= (async () => {
    try {
      await runtime?.close();
    } catch (error) {
      captureHostFailure("bridge/close", error);
    } finally {
      runtime = undefined;
      await errors?.dispose(2_000);
      errors = undefined;
    }
  })();
  return closing;
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  start(context) {
    closing = undefined;
    errors = createNanocodexErrorReporter(context.pluginId);
    runtime = createBridge({ captureFailure: captureHostFailure });
    try {
      runtime.start(context);
    } catch (error) {
      captureHostFailure("bridge/start", error);
      void closeRuntime();
      throw error;
    }
  },
  handleLine(line) {
    runtime?.handleLine(line);
  },
  onSigterm() {
    void closeRuntime();
  },
  onSigint() {
    void closeRuntime();
  },
  onClose() {
    void closeRuntime();
  },
});
