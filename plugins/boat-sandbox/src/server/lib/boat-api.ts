// The only module that speaks Boat's REST API. Everything it returns is parsed
// here, so the rest of the plugin works with typed sandboxes and frames.
import { createHash } from "node:crypto";
import { z } from "zod";
import { MACHINE_KEY_LABEL, SANDBOX_TYPES, type SandboxType } from "../../shared/constants.ts";
import { sandboxStateSchema, sandboxTypeSchema } from "../../shared/schema.ts";

export interface BoatCredentials {
  apiBase: string;
  apiKey: string;
}

export class BoatApiError extends Error {
  override readonly name = "BoatApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    /** Boat's own message for the failure, such as `sandbox_restoring`. */
    readonly detail: string = "",
    /** Boat's `error.details.retryable`: the machine did not complete the call. */
    readonly retryable: boolean = false,
  ) {
    super(message);
  }
}

/** What a retried call would repeat: an idempotent control-plane call, a file write, or a command. */
export type BoatCall = "idempotent" | "file" | "command";

const RETRY_ATTEMPTS = 15;
const RETRY_DELAY_MS = 2_000;

/** Whether Boat says this call did not take effect and may be sent again unchanged. */
export function canRetry(error: unknown, call: BoatCall): boolean {
  if (!(error instanceof BoatApiError)) return false;
  // no_ready_machine, out_of_capacity: "retry after a few seconds".
  if (error.status === 503) return true;
  if (error.status === 409 && error.code === "sandbox_starting") return true;
  if (error.status === 409 && error.code === "idempotency_in_progress")
    return call === "idempotent";
  if (error.status === 502 && error.code === "sandbox_direct_failed") {
    // A command the machine may have run must not be sent twice; a restoring sandbox never ran it.
    return error.retryable && (call !== "command" || error.detail === "sandbox_restoring");
  }
  return call === "idempotent" && error.status === 500;
}

export interface BoatRetryOptions {
  signal: AbortSignal;
  sleep(delayMs: number): Promise<void>;
  attempts?: number;
}

/** Repeat `fn` while Boat reports a retryable failure, a bounded number of times. */
export async function withBoatRetry<T>(
  call: BoatCall,
  fn: () => Promise<T>,
  options: BoatRetryOptions,
): Promise<T> {
  const attempts = options.attempts ?? RETRY_ATTEMPTS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !canRetry(error, call)) throw error;
      await options.sleep(RETRY_DELAY_MS);
      options.signal.throwIfAborted();
    }
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
const LIST_PAGE_SIZE = 200;

const sandboxSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  state: sandboxStateSchema,
  error: z.string().nullable().default(null),
  type: sandboxTypeSchema.optional(),
  archiveAfter: z.string().nullable().default(null),
  hydrated: z.boolean().nullable().default(null),
  dataExpiredAt: z.string().nullable().default(null),
  stop: z
    .object({
      status: z.enum(["pending", "failing", "completed", "superseded"]),
      error: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type BoatSandbox = z.infer<typeof sandboxSchema>;

const sandboxInfoSchema = z.object({ sandbox: sandboxSchema });
const sandboxListSchema = z.object({
  sandboxes: z.array(sandboxSchema),
  pageInfo: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }).optional(),
});
const meSchema = z.object({
  user: z.object({
    id: z.string().optional(),
    email: z.string().nullable().optional(),
    login: z.string().default(""),
  }),
});
const machineTypeSchema = z.object({
  type: sandboxTypeSchema,
  available: z.boolean(),
  reason: z.string().nullable().default(null),
});
const limitsSchema = z.object({
  activeSandboxes: z.number().optional(),
  maxActiveSandboxes: z.number().optional(),
  machineTypes: z.array(machineTypeSchema).optional(),
});
const savedSnapshotsSchema = z.object({
  snapshots: z.array(z.object({ name: z.string(), status: z.enum(["saving", "ready", "failed"]) })),
});
const commandStartedSchema = z.object({ processId: z.number().int() });
const commandStatusSchema = z.object({
  status: z.enum(["running", "exited", "lost"]),
  running: z.boolean(),
  exitCode: z.number().int().nullable(),
});
const attachFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("attached") }),
  z.object({ type: z.literal("heartbeat") }),
  z.object({ type: z.literal("stdout"), data: z.string(), nextOffset: z.number().int() }),
  z.object({ type: z.literal("stderr"), data: z.string(), nextOffset: z.number().int() }),
  z.object({
    type: z.literal("exit"),
    status: z.enum(["running", "exited", "lost"]),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("reconnect"),
    stdoutOffset: z.number().int(),
    stderrOffset: z.number().int(),
  }),
  z.object({ type: z.literal("error"), error: z.string(), message: z.string().default("") }),
]);
export type BoatAttachFrame = z.infer<typeof attachFrameSchema>;
const errorEnvelopeSchema = z.object({
  error: z
    .object({
      code: z.string(),
      message: z.string().optional(),
      details: z
        .object({ retryable: z.boolean().optional(), message: z.string().optional() })
        .optional(),
    })
    .optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  requestId: z.string().optional(),
});

export interface BoatMachineType {
  type: SandboxType;
  available: boolean;
  reason: string | null;
}

export interface BoatAccount {
  identity: string;
  login: string;
  activeSandboxes: number | null;
  maxActiveSandboxes: number | null;
}

export interface BoatCreateRequest {
  key: string;
  /** Unique per attempt: a replay must not hand back a sandbox that cleanup since deleted. */
  idempotencyKey: string;
  name: string;
  type: SandboxType;
  from: string | null;
  environment: string | null;
  ttlSeconds: number | null;
}

export interface BoatOffsets {
  stdout: number;
  stderr: number;
}

export interface BoatClient {
  /** SHA-256 of the account id (or its email or login), so resources pin an account without naming it. */
  account(signal?: AbortSignal): Promise<BoatAccount>;
  machineTypes(signal?: AbortSignal): Promise<BoatMachineType[]>;
  savedSnapshots(signal?: AbortSignal): Promise<string[]>;
  create(request: BoatCreateRequest, signal?: AbortSignal): Promise<BoatSandbox>;
  /** Null once Boat answers 404: deleted, or a cancelled create. */
  get(sandboxId: string, signal?: AbortSignal): Promise<BoatSandbox | null>;
  listByKey(key: string, signal?: AbortSignal): Promise<BoatSandbox[]>;
  stop(sandboxId: string, signal?: AbortSignal): Promise<void>;
  resume(sandboxId: string, ttlSeconds: number | null, signal?: AbortSignal): Promise<void>;
  extend(sandboxId: string, ttlSeconds: number, signal?: AbortSignal): Promise<void>;
  /** Idempotent: a sandbox that is already gone counts as deleted. */
  delete(sandboxId: string, signal?: AbortSignal): Promise<void>;
  startCommand(sandboxId: string, command: string, signal: AbortSignal): Promise<number>;
  commandStatus(
    sandboxId: string,
    processId: number,
    signal: AbortSignal,
  ): Promise<{ status: "running" | "exited" | "lost"; running: boolean; exitCode: number | null }>;
  attach(
    sandboxId: string,
    processId: number,
    offsets: BoatOffsets,
    signal: AbortSignal,
  ): AsyncIterable<BoatAttachFrame>;
  stopCommand(sandboxId: string, processId: number): Promise<void>;
  writeFile(
    sandboxId: string,
    path: string,
    content: string,
    encoding: "utf8" | "base64",
    signal: AbortSignal,
  ): Promise<void>;
  deleteFile(sandboxId: string, path: string): Promise<void>;
}

export type BoatClientFactory = (credentials: BoatCredentials) => BoatClient;

export function isBoatApiError(
  error: unknown,
  status?: number,
  code?: string,
): error is BoatApiError {
  return (
    error instanceof BoatApiError &&
    (status === undefined || error.status === status) &&
    (code === undefined || error.code === code)
  );
}

function toApiError(status: number, text: string): BoatApiError {
  let parsed: z.infer<typeof errorEnvelopeSchema> | null = null;
  try {
    parsed = errorEnvelopeSchema.parse(JSON.parse(text));
  } catch {
    parsed = null;
  }
  const code = parsed?.error?.code ?? parsed?.code ?? `http_${status}`;
  const detail = parsed?.error?.details?.message ?? parsed?.error?.message ?? parsed?.message ?? "";
  const message = detail.length > 0 ? detail : text.trim() || `HTTP ${status}`;
  return new BoatApiError(
    status,
    code,
    `Boat ${code}: ${message}`,
    parsed?.requestId ?? null,
    detail,
    parsed?.error?.details?.retryable === true,
  );
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export function createBoatClient(
  credentials: BoatCredentials,
  fetchImpl: typeof fetch = fetch,
): BoatClient {
  const base = credentials.apiBase.replace(/\/+$/, "");
  const authHeaders = {
    authorization: `Bearer ${credentials.apiKey}`,
    accept: "application/json",
  };

  async function request<T>(
    method: string,
    path: string,
    options: {
      schema: z.ZodType<T>;
      body?: unknown;
      headers?: Record<string, string>;
      query?: Record<string, string | undefined>;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const url = new URL(`${base}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    const response = await fetchImpl(url, {
      method,
      headers: {
        ...authHeaders,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: withTimeout(options.signal),
    });
    const text = await response.text();
    if (!response.ok) throw toApiError(response.status, text);
    return options.schema.parse(text.length === 0 ? {} : JSON.parse(text));
  }

  const sandboxPath = (sandboxId: string) => `/sandboxes/${encodeURIComponent(sandboxId)}`;
  const ignoreNotFound = async (promise: Promise<unknown>): Promise<void> => {
    try {
      await promise;
    } catch (error) {
      if (!isBoatApiError(error, 404)) throw error;
    }
  };

  return {
    async account(signal) {
      const [me, limits] = await Promise.all([
        request("GET", "/me", { schema: meSchema, signal }),
        request("GET", "/limits", { schema: limitsSchema, signal }),
      ]);
      const subject = me.user.id || me.user.email || me.user.login;
      if (!subject) {
        throw new Error(
          "Boat's /me answered without an account id, email or login; the account cannot be pinned.",
        );
      }
      return {
        identity: createHash("sha256").update(subject).digest("hex"),
        login: me.user.login,
        activeSandboxes: limits.activeSandboxes ?? null,
        maxActiveSandboxes: limits.maxActiveSandboxes ?? null,
      };
    },
    async machineTypes(signal) {
      const limits = await request("GET", "/limits", { schema: limitsSchema, signal });
      return (
        limits.machineTypes ??
        SANDBOX_TYPES.map((type) => ({ type, available: true, reason: null }))
      );
    },
    async savedSnapshots(signal) {
      const result = await request("GET", "/saved-snapshots", {
        schema: savedSnapshotsSchema,
        signal,
      });
      return result.snapshots
        .filter((snapshot) => snapshot.status === "ready")
        .map((snapshot) => snapshot.name);
    },
    async create(input, signal) {
      const created = await request("POST", "/sandboxes", {
        schema: sandboxInfoSchema,
        headers: { "idempotency-key": input.idempotencyKey },
        body: {
          type: input.type,
          ttlSeconds: input.ttlSeconds,
          name: input.name,
          labels: { [MACHINE_KEY_LABEL]: input.key },
          ...(input.from === null ? {} : { from: input.from }),
          ...(input.environment === null ? {} : { environment: input.environment }),
        },
        signal,
      });
      return created.sandbox;
    },
    async get(sandboxId, signal) {
      try {
        const info = await request("GET", sandboxPath(sandboxId), {
          schema: sandboxInfoSchema,
          signal,
        });
        return info.sandbox;
      } catch (error) {
        if (isBoatApiError(error, 404)) return null;
        throw error;
      }
    },
    async listByKey(key, signal) {
      const sandboxes: BoatSandbox[] = [];
      let cursor: string | undefined;
      do {
        const page = await request("GET", "/sandboxes", {
          schema: sandboxListSchema,
          query: { label: `${MACHINE_KEY_LABEL}=${key}`, limit: String(LIST_PAGE_SIZE), cursor },
          signal,
        });
        sandboxes.push(...page.sandboxes);
        cursor = page.pageInfo?.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
      } while (cursor !== undefined);
      return sandboxes;
    },
    async stop(sandboxId, signal) {
      await request("POST", `${sandboxPath(sandboxId)}/stop`, {
        schema: z.unknown(),
        body: {},
        signal,
      });
    },
    async resume(sandboxId, ttlSeconds, signal) {
      await request("POST", `${sandboxPath(sandboxId)}/resume`, {
        schema: z.unknown(),
        body: { ttlSeconds },
        signal,
      });
    },
    async extend(sandboxId, ttlSeconds, signal) {
      await request("PATCH", sandboxPath(sandboxId), {
        schema: z.unknown(),
        body: { ttlSeconds },
        signal,
      });
    },
    async delete(sandboxId, signal) {
      await ignoreNotFound(
        request("DELETE", sandboxPath(sandboxId), {
          schema: z.unknown(),
          headers: { "x-ascii-confirm-delete": sandboxId },
          signal,
        }),
      );
    },
    async startCommand(sandboxId, command, signal) {
      const started = await request("POST", `${sandboxPath(sandboxId)}/commands`, {
        schema: commandStartedSchema,
        body: { command, detached: true },
        signal,
      });
      return started.processId;
    },
    commandStatus(sandboxId, processId, signal) {
      return request("GET", `${sandboxPath(sandboxId)}/commands/${processId}`, {
        schema: commandStatusSchema,
        signal,
      });
    },
    async *attach(sandboxId, processId, offsets, signal) {
      const url = new URL(`${base}${sandboxPath(sandboxId)}/commands/${processId}/stream`);
      url.searchParams.set("stdoutOffset", String(offsets.stdout));
      url.searchParams.set("stderrOffset", String(offsets.stderr));
      const response = await fetchImpl(url, { headers: authHeaders, signal });
      if (!response.ok) throw toApiError(response.status, await response.text());
      if (response.body === null) return;
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line.length > 0) yield attachFrameSchema.parse(JSON.parse(line));
            newline = buffer.indexOf("\n");
          }
        }
        if (buffer.trim().length > 0) yield attachFrameSchema.parse(JSON.parse(buffer));
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
    async stopCommand(sandboxId, processId) {
      await ignoreNotFound(
        request("DELETE", `${sandboxPath(sandboxId)}/commands/${processId}`, {
          schema: z.unknown(),
        }),
      );
    },
    async writeFile(sandboxId, path, content, encoding, signal) {
      await request("PUT", `${sandboxPath(sandboxId)}/files`, {
        schema: z.unknown(),
        body: { path, content, encoding },
        signal,
      });
    },
    async deleteFile(sandboxId, path) {
      await ignoreNotFound(
        request("DELETE", `${sandboxPath(sandboxId)}/files`, {
          schema: z.unknown(),
          query: { path },
        }),
      );
    },
  };
}
