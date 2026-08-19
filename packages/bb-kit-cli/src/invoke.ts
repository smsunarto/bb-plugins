import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { discoverProject, type DiscoveredOperation } from "./project.js";

interface RpcSuccessEnvelope {
  ok: true;
  result: unknown;
}

interface RpcFailureEnvelope {
  ok: false;
  error?: {
    code?: string;
    message?: string;
    issues?: unknown[];
  };
}

type RpcEnvelope = RpcSuccessEnvelope | RpcFailureEnvelope;

export interface InvocationResult {
  operation: string;
  pluginId: string;
  rpcMethod: string;
  kind: DiscoveredOperation["kind"];
  risk: DiscoveredOperation["risk"];
  result: unknown;
}

export interface InvokeOptions {
  input?: string;
  confirm?: boolean;
  serverUrl?: string;
  cwd?: string;
  fetch?: typeof fetch;
}

export class InvocationError extends Error {
  readonly code: string;
  readonly issues: readonly unknown[];

  constructor(code: string, message: string, issues: readonly unknown[] = []) {
    super(message);
    this.name = "InvocationError";
    this.code = code;
    this.issues = issues;
  }
}

function parseInput(value: string, cwd: string): unknown {
  const source = value?.startsWith("@")
    ? readFileSync(resolve(cwd, value.slice(1)), "utf8")
    : value;
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new InvocationError(
      "invalid_json",
      `operation input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function operationInvokeCommand(
  operation: Pick<DiscoveredOperation, "identity" | "input">,
): string | null {
  if (operation.input === null) return null;
  const base = `bb-kit invoke ${operation.identity}`;
  return operation.input.mode === "none"
    ? base
    : `${base} --input ${shellQuote(JSON.stringify(operation.input.example))}`;
}

function findOperation(
  root: string,
  identity: string,
): {
  pluginId: string;
  operation: DiscoveredOperation;
  rpcMethod: string;
} {
  const project = discoverProject(root);
  const operation = project.modules
    .flatMap((module) => module.operations)
    .find((candidate) => candidate.identity === identity);
  if (!operation) {
    throw new InvocationError(
      "unknown_operation",
      `unknown operation "${identity}"; run bb-kit operations to list available operations`,
    );
  }
  if (!operation.rpcMethod) {
    throw new InvocationError(
      "unlocked_operation",
      `${identity} has no locked RPC method; run bb-kit check`,
    );
  }
  return { pluginId: project.pluginId, operation, rpcMethod: operation.rpcMethod };
}

function assertInvocable(identity: string, operation: DiscoveredOperation, confirm: boolean): void {
  if (operation.kind === "unknown") {
    throw new InvocationError(
      "unknown_operation_kind",
      `${identity} has an unrecognized operation kind; run bb-kit check`,
    );
  }
  if (operation.kind === "command" && operation.risk === null) {
    throw new InvocationError(
      "unknown_operation_risk",
      `${identity} has no recognized risk classification; run bb-kit check`,
    );
  }
  if (operation.metadataError !== null || operation.input === null) {
    throw new InvocationError(
      "invalid_operation_metadata",
      `${identity} has invalid input metadata: ${operation.metadataError ?? "input state is missing"}; run bb-kit check`,
    );
  }
  if (operation.risk === "destructive" && !confirm) {
    throw new InvocationError(
      "confirmation_required",
      `${identity} is destructive; re-run with --confirm after reviewing the input`,
    );
  }
}

function assertInputState(
  identity: string,
  operation: DiscoveredOperation,
  hasInput: boolean,
): void {
  if (operation.input === null) {
    throw new InvocationError(
      "invalid_operation_metadata",
      `${identity} has invalid input metadata: ${operation.metadataError ?? "input state is missing"}; run bb-kit check`,
    );
  }
  if (operation.input.mode === "none" && hasInput) {
    throw new InvocationError(
      "unexpected_operation_input",
      `${identity} accepts no input; omit --input`,
    );
  }
  if (operation.input.mode === "required" && !hasInput) {
    const example = JSON.stringify(operation.input.example);
    throw new InvocationError(
      "missing_operation_input",
      `${identity} requires input. Example: ${example}. Run: ${operationInvokeCommand(operation)}`,
    );
  }
}

export interface OperationInvocationPreflight {
  readonly identity: string;
  readonly hasInput: boolean;
}

/** Validate a batch before any operation in it can mutate loaded-plugin state. */
export function preflightOperationInvocations(
  root: string,
  invocations: readonly OperationInvocationPreflight[],
  confirm = false,
): void {
  for (const { identity, hasInput } of invocations) {
    const { operation } = findOperation(root, identity);
    assertInvocable(identity, operation, confirm);
    assertInputState(identity, operation, hasInput);
  }
}

/** Invoke a loaded operation through bb's native RPC HTTP endpoint. */
export async function invokeOperation(
  root: string,
  identity: string,
  options: InvokeOptions = {},
): Promise<InvocationResult> {
  const { pluginId, operation, rpcMethod } = findOperation(root, identity);
  assertInvocable(identity, operation, options.confirm === true);
  assertInputState(identity, operation, options.input !== undefined);

  const cwd = options.cwd ?? root;
  const input = operation.input?.mode === "none" ? null : parseInput(options.input as string, cwd);
  const baseUrl = new URL(
    options.serverUrl ?? process.env.BB_SERVER_URL ?? "http://127.0.0.1:38886",
  );
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new InvocationError("invalid_server_url", "bb server URL must use HTTP or HTTPS");
  }
  const endpoint = new URL(
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/${encodeURIComponent(rpcMethod)}`,
    baseUrl,
  );
  const request = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await request(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl.origin,
      },
      body: JSON.stringify(input),
    });
  } catch (error) {
    throw new InvocationError(
      "transport_error",
      `could not reach bb at ${baseUrl.origin}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const envelope = (await response.json().catch(() => null)) as RpcEnvelope | null;
  if (!response.ok || !envelope?.ok) {
    const failure = envelope && !envelope.ok ? envelope.error : undefined;
    throw new InvocationError(
      failure?.code ?? "transport_error",
      failure?.message ?? `bb RPC request failed with HTTP ${response.status}`,
      failure?.issues,
    );
  }
  return {
    operation: identity,
    pluginId,
    rpcMethod,
    kind: operation.kind,
    risk: operation.risk,
    result: envelope.result,
  };
}
