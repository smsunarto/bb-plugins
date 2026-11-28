import os from "node:os";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_REQUEST_METHODS,
  experimental_defineProviderBridge,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_acpProviderBridge as acp,
  experimental_registerAcpDialect,
} from "@get-bb/plugin-sdk/provider-bridge/acp";
import { createAntigravityDialect } from "./dialect.ts";
import {
  createAntigravityMaintenanceController,
  getAntigravityInstallationRun,
  getAntigravityInstallationStatus,
  resolveAntigravityCommand,
} from "./maintenance.ts";
import { createModelListEnricher } from "./model-catalog.ts";
import { resolveAntigravityNativeRoots } from "./native-roots.ts";
import { createAntigravitySessionTranslator } from "./session-options.ts";

let activeCommand = resolveAntigravityCommand("agy");
let writeThrough: (chunk: string) => void = (chunk) => {
  process.stdout.write(chunk);
};

const maintenance = createAntigravityMaintenanceController();

experimental_registerAcpDialect(
  createAntigravityDialect({
    maintenance,
    getCommand: () => activeCommand,
  }),
);

const sessionTranslator = createAntigravitySessionTranslator({
  executableOverride: process.env.BB_ANTIGRAVITY_EXECUTABLE,
});

const modelEnricher = createModelListEnricher({
  fetchModelsOutput: (command) => maintenance.probeModelsOutput(command),
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractCommandFromLine(line: string): string {
  try {
    const parsed = asRecord(JSON.parse(line));
    const params = asRecord(parsed?.["params"]);
    const options = asRecord(params?.["options"]);
    const providerOptions = asRecord(options?.["providerOptions"] ?? params?.["providerOptions"]);
    const launchSpec = asRecord(providerOptions?.["acpLaunchSpec"]);
    const command = launchSpec?.["command"];
    return resolveAntigravityCommand(typeof command === "string" ? command : "agy");
  } catch {
    return resolveAntigravityCommand("agy");
  }
}

function sendJsonRpcResult(id: string | number, result: unknown): void {
  writeThrough(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendJsonRpcError(id: string | number, code: number, message: string): void {
  writeThrough(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function tryHandleInstallationRequest(line: string): boolean {
  if (
    !line.includes(BRIDGE_REQUEST_METHODS.providerInstallationStatus) &&
    !line.includes(BRIDGE_REQUEST_METHODS.providerInstallationRun)
  ) {
    return false;
  }
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asRecord(JSON.parse(line));
  } catch {
    return false;
  }
  if (parsed === null) return false;
  const method = parsed["method"];
  const id = parsed["id"];
  if (typeof id !== "string" && typeof id !== "number") return false;

  if (method === BRIDGE_REQUEST_METHODS.providerInstallationStatus) {
    const decoded = providerInstallationStatusParamsSchema.safeParse(parsed["params"]);
    if (!decoded.success) {
      sendJsonRpcError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `Invalid params for "${method}": ${decoded.error.message}`,
      );
      return true;
    }
    const command = extractCommandFromLine(line);
    activeCommand = command;
    void getAntigravityInstallationStatus({ command })
      .then((status) => sendJsonRpcResult(id, status))
      .catch((error: unknown) =>
        sendJsonRpcError(
          id,
          BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
          error instanceof Error ? error.message : String(error),
        ),
      );
    return true;
  }

  if (method === BRIDGE_REQUEST_METHODS.providerInstallationRun) {
    const decoded = providerInstallationRunParamsSchema.safeParse(parsed["params"]);
    if (!decoded.success) {
      sendJsonRpcError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `Invalid params for "${method}": ${decoded.error.message}`,
      );
      return true;
    }
    const command = extractCommandFromLine(line);
    activeCommand = command;
    void getAntigravityInstallationRun({ command, action: decoded.data.action })
      .then((result) => sendJsonRpcResult(id, result))
      .catch((error: unknown) =>
        sendJsonRpcError(
          id,
          BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
          error instanceof Error ? error.message : String(error),
        ),
      );
    return true;
  }

  return false;
}

let unwrapStdout: (() => void) | null = null;

function wrapStdout(): void {
  if (unwrapStdout !== null) return;
  const stdout = process.stdout;
  const original = stdout.write.bind(stdout);
  writeThrough = (chunk) => void original(chunk);
  stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === "string" && rest.length === 0) {
      if (modelEnricher.interceptOutbound(chunk, writeThrough)) {
        return true;
      }
      writeThrough(sessionTranslator.outbound(chunk));
      return true;
    }
    return original(chunk as never, ...(rest as never[]));
  }) as typeof stdout.write;
  unwrapStdout = () => {
    stdout.write = original;
    writeThrough = (chunk) => {
      process.stdout.write(chunk);
    };
    unwrapStdout = null;
  };
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  start(context) {
    wrapStdout();
    acp.start?.(context);
  },
  handleLine(line) {
    activeCommand = extractCommandFromLine(line);
    if (tryHandleInstallationRequest(line)) {
      return;
    }
    modelEnricher.beforeInbound(line, activeCommand);
    acp.handleLine(sessionTranslator.inbound(line));
  },
  onClose() {
    acp.onClose?.();
    unwrapStdout?.();
  },
  onSigterm() {
    acp.onSigterm?.();
  },
  onSigint() {
    acp.onSigint?.();
  },
});

export default experimental_defineHostEntry({
  contract: experimental_nativeRootsHostContract,
  handlers: {
    resolveNativeRoots: (input) =>
      resolveAntigravityNativeRoots({
        cwd: input.cwd,
        homeDir: os.homedir(),
      }),
  },
});
