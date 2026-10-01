import type { BbPluginApi, PluginCliCommand, PluginCliContext } from "@get-bb/plugin-sdk";
import { defineCli, PluginCliError } from "@get-bb/plugin-sdk";
import type { CommandMap, CommandsContext } from "../command/command.ts";
import type { Context } from "../context.ts";
import {
  PLUGIN_ID_PATTERN,
  RESERVED_COMMAND_KEYS,
  TOOL_KEY_PATTERN,
  toolName,
} from "../names/names.ts";
import type { RPCContext, RPCProcedures, RuntimeProcedure, StandardSchemaV1 } from "../rpc/rpc.ts";
import { assertRPCKeys, callProcedure, noInputSchema, RPCValidationError } from "../rpc/rpc.ts";
import type { RuntimeTool, Session, ToolMap, ToolsContext } from "../tools/tools.ts";
import type { MaybePromise } from "../utils/types.ts";
import {
  capturePluginFailure,
  createPluginErrorReporter,
  createReporterDisposer,
  isAbortedFailure,
  observePluginFailure,
  type PluginErrorReporter,
  type PluginErrorReporterFactory,
} from "./error-reporter.ts";
import {
  createPluginPerformanceReporter,
  finishTraceOnSuccess,
  rpcTraceOperation,
  startPluginTrace,
  toolTraceOperation,
  type PluginPerformanceReporter,
  type PluginPerformanceReporterFactory,
} from "./performance-reporter.ts";

export type {
  PluginErrorReporter,
  PluginErrorReporterFactory,
  PluginFailure,
} from "./error-reporter.ts";
export type {
  PluginPerformanceReporter,
  PluginPerformanceReporterFactory,
  PluginPerformanceTrace,
  PluginTraceOutcome,
} from "./performance-reporter.ts";
export type { Context } from "../context.ts";

/**
 * The services every handler's `ctx` annotation asks for, minus what the
 * host and the call itself supply. `services(bb)` must return at least
 * this, so a missing service is reported on the `services` line.
 */
type Demanded<R extends RPCProcedures, M extends CommandMap, T extends ToolMap> = Omit<
  RPCContext<R> & CommandsContext<M> & ToolsContext<T>,
  "bb" | "tool" | keyof PluginCliContext
>;

/** Makes `services` required once any handler asks for a service. */
type RequireServices<R extends RPCProcedures, M extends CommandMap, T extends ToolMap> = [
  keyof Demanded<R, M, T>,
] extends [never]
  ? unknown
  : { services: (bb: BbPluginApi) => unknown };

export type DefinedPlugin<R extends RPCProcedures> = ((bb: BbPluginApi) => Promise<void>) & {
  readonly rpc: R;
};

type Reporters = {
  errors: PluginErrorReporter | undefined;
  performance: PluginPerformanceReporter | undefined;
};

/**
 * The composition root. Fuses the plugin id, its services, RPCs,
 * commands, and agent tools into the entry factory `server.ts`
 * default-exports. The returned factory also carries the RPC map as
 * `.rpc`, so app/ can type-only import it.
 *
 * Load order: services → RPC → CLI → agents → setup. `services(bb)`
 * runs once per load. A service that holds resources registers its own
 * cleanup with `bb.onDispose`.
 */
export function definePlugin<
  R extends RPCProcedures,
  M extends CommandMap = Record<never, never>,
  T extends ToolMap = Record<never, never>,
  S extends object = Record<never, never>,
>(
  definition: {
    pluginId: string;
    /**
     * Build the plugin's long-lived collaborators once per load. Keep it
     * synchronous; async start-up work belongs in `setup`.
     */
    services?(bb: BbPluginApi): S & Demanded<NoInfer<R>, NoInfer<M>, NoInfer<T>>;
    errorReporter?: PluginErrorReporterFactory;
    performanceReporter?: PluginPerformanceReporterFactory;
    rpc: R;
    /** Publish the RPC contract (methods and JSON schemas) to `bb plugin rpc`. Off by default. */
    rpcPublication?: { discoverable?: boolean; description?: string };
    command?: M;
    agents?: {
      tools: T;
      skills?: string[] | ((ctx: Context<S>, session: Session) => string[]);
      instructions?(
        ctx: Context<S>,
        resolution: { threadId: string; projectId: string },
      ): string | null;
    };
    /** Runs last, for host wiring bb-kit does not own: events, hooks, http, settings. */
    setup?(ctx: Context<S>): MaybePromise<void>;
  } & RequireServices<NoInfer<R>, NoInfer<M>, NoInfer<T>>,
): DefinedPlugin<R> {
  const { pluginId, rpc } = definition;
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new Error(`invalid plugin id "${pluginId}": must match ${PLUGIN_ID_PATTERN}`);
  }
  assertRPCKeys(rpc);
  const commands = definition.command ?? {};
  for (const key of Object.keys(commands)) {
    if (RESERVED_COMMAND_KEYS.includes(key)) {
      throw new Error(`"${key}" is a reserved command name`);
    }
  }
  const tools = (definition.agents?.tools ?? {}) as Record<string, RuntimeTool>;
  for (const key of Object.keys(tools)) {
    if (!TOOL_KEY_PATTERN.test(key)) {
      throw new Error(`invalid tool key "${key}": must match ${TOOL_KEY_PATTERN}`);
    }
  }

  const factory = async (bb: BbPluginApi): Promise<void> => {
    const reporters: Reporters = {
      errors: createPluginErrorReporter(definition.errorReporter, pluginId, bb),
      performance: createPluginPerformanceReporter(definition.performanceReporter, pluginId, bb),
    };
    const disposeErrors = createReporterDisposer(reporters.errors);
    const disposePerformance = createReporterDisposer(reporters.performance);
    const disposeReporters = async (): Promise<void> => {
      await Promise.all([disposeErrors(), disposePerformance()]);
    };
    if (reporters.errors !== undefined || reporters.performance !== undefined) {
      try {
        bb.onDispose(disposeReporters);
      } catch {
        reporters.errors = undefined;
        reporters.performance = undefined;
        void disposeReporters();
      }
    }
    const startupTrace = startPluginTrace(reporters.performance, "plugin.startup");
    const fail = async (boundary: "plugin.factory" | "plugin.setup", error: unknown) => {
      startupTrace?.finish("error");
      capturePluginFailure(reporters.errors, { boundary, error });
      await disposeReporters();
      throw error;
    };

    let ctx: Context<S>;
    try {
      const services = definition.services?.(bb) ?? ({} as S);
      ctx = Object.freeze({ ...services, bb }) as Context<S>;
      registerRPC(bb, ctx, rpc, definition.rpcPublication, reporters);
      bb.cli.register(
        defineCli({
          name: pluginId,
          summary: `CLI for the ${pluginId} plugin`,
          commands: {
            ...cliCommands(ctx, commands, reporters.errors),
            ...rpcCommands(ctx, rpc, reporters.errors),
          },
        }),
      );
      if (definition.agents) {
        registerAgents(bb, ctx, pluginId, tools, definition.agents, reporters);
      }
      startupTrace?.checkpoint("registered");
    } catch (error) {
      return fail("plugin.factory", error);
    }

    try {
      await definition.setup?.(ctx);
    } catch (error) {
      return fail("plugin.setup", error);
    }
    startupTrace?.finish("ok");
  };
  return Object.assign(factory, { rpc });
}

/**
 * The host validates every call on the HTTP path, so handlers run
 * `execute` directly; nothing is validated twice.
 */
function registerRPC(
  bb: BbPluginApi,
  ctx: Context,
  rpc: RPCProcedures,
  publication: { discoverable?: boolean; description?: string } | undefined,
  reporters: Reporters,
): void {
  const contract: Record<
    string,
    { input: StandardSchemaV1; output: StandardSchemaV1; experimental_description?: string }
  > = {};
  const handlers: Record<string, (input: unknown) => Promise<unknown>> = {};
  for (const [key, procedure] of Object.entries(rpc as Record<string, RuntimeProcedure>)) {
    contract[key] = {
      input: procedure.input ?? noInputSchema,
      output: procedure.output,
      ...(procedure.description === undefined
        ? {}
        : { experimental_description: procedure.description }),
    };
    const operation = rpcTraceOperation(key);
    handlers[key] = async (input) => {
      const trace = startPluginTrace(reporters.performance, operation);
      try {
        const result = await (procedure.input
          ? procedure.execute(ctx, input)
          : procedure.execute(ctx));
        trace?.finish("ok");
        return result;
      } catch (error) {
        trace?.finish("error");
        capturePluginFailure(reporters.errors, {
          boundary: "rpc.execute",
          operation: key,
          error,
        });
        throw error;
      }
    };
  }
  bb.rpc.register(contract, handlers as never, {
    experimental_discoverable: publication?.discoverable ?? false,
    ...(publication?.description === undefined
      ? {}
      : { experimental_description: publication.description }),
  });
}

function cliCommands(
  ctx: Context,
  commands: CommandMap,
  reporter: PluginErrorReporter | undefined,
): Record<string, PluginCliCommand> {
  const out: Record<string, PluginCliCommand> = {};
  for (const [key, command] of Object.entries(commands)) {
    const { execute, ...spec } = command as unknown as {
      execute(ctx: unknown, input: unknown): Promise<never>;
    } & Omit<PluginCliCommand, "run">;
    out[key] = {
      ...spec,
      run: async (input, cli: PluginCliContext) => {
        try {
          return await execute(Object.freeze({ ...ctx, ...cli }), input);
        } catch (error) {
          if (!(error instanceof PluginCliError) && !isAbortedFailure(error, cli.signal)) {
            capturePluginFailure(reporter, { boundary: "command.execute", operation: key, error });
          }
          throw error;
        }
      },
    };
  }
  return out;
}

/**
 * `bb <plugin> rpc <method> [json]`: call any RPC by its key, with one
 * optional JSON-object input validated in-process the way the host
 * validates it. Prints the result as compact JSON. One command rather than
 * one per method: host command names are lowercase, RPC keys are camelCase.
 */
function rpcCommands(
  ctx: Context,
  rpc: RPCProcedures,
  reporter: PluginErrorReporter | undefined,
): Record<string, PluginCliCommand> {
  const procedures = rpc as Record<string, RuntimeProcedure>;
  const methods = Object.entries(procedures).map(
    ([key, procedure]) => `  ${key}${procedure.description ? `  ${procedure.description}` : ""}`,
  );
  if (methods.length === 0) return {};
  return {
    rpc: {
      summary: "Call an RPC method with an optional JSON object input",
      description: `Methods:\n${methods.join("\n")}`,
      positionals: [
        { name: "method", description: "RPC method key", required: true },
        { name: "input", description: "JSON object input" },
      ],
      run: async ({ positionals }) => {
        const key = positionals["method"] as string;
        const procedure = Object.hasOwn(procedures, key) ? procedures[key] : undefined;
        if (procedure === undefined) {
          throw new PluginCliError(`unknown RPC method "${key}"`, { code: "invalid_value" });
        }
        const raw = positionals["input"];
        let input: unknown;
        if (typeof raw === "string") {
          try {
            input = JSON.parse(raw);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new PluginCliError(`invalid JSON input: ${message}`, { code: "invalid_value" });
          }
          if (input === null || typeof input !== "object" || Array.isArray(input)) {
            throw new PluginCliError("input must be a JSON object", { code: "invalid_value" });
          }
        }
        try {
          const result = await callProcedure(procedure as never, ctx, input);
          return { exitCode: 0, stdout: `${JSON.stringify(result)}\n` };
        } catch (error) {
          if (error instanceof RPCValidationError && error.stage === "input") {
            throw new PluginCliError(error.message, { code: "invalid_value" });
          }
          capturePluginFailure(reporter, { boundary: "rpc.cli", operation: key, error });
          throw error;
        }
      },
    },
  };
}

function registerAgents(
  bb: BbPluginApi,
  ctx: Context,
  pluginId: string,
  tools: Record<string, RuntimeTool>,
  agents: {
    skills?: string[] | ((ctx: never, session: Session) => string[]);
    instructions?(ctx: never, resolution: { threadId: string; projectId: string }): string | null;
  },
  reporters: Reporters,
): void {
  const keys = Object.keys(tools);
  for (const [key, tool] of Object.entries(tools)) {
    const operation = toolName(pluginId, key);
    const traceOperation = toolTraceOperation(key);
    bb.agents.registerTool({
      name: operation,
      description: tool.description,
      ...(tool.instructions === undefined ? {} : { instructions: tool.instructions }),
      ...(tool.presentation === undefined ? {} : { presentation: tool.presentation }),
      // A zod object schema at runtime. The SDK's overloads name zod's
      // types, which bb-kit does not import.
      parameters: tool.parameters as never,
      execute: (params: unknown, invocation) => {
        const trace = startPluginTrace(reporters.performance, traceOperation);
        return observePluginFailure(
          () =>
            finishTraceOnSuccess(trace, () =>
              tool.execute(Object.freeze({ ...ctx, tool: invocation }), params),
            ),
          (error) => {
            if (isAbortedFailure(error, invocation.signal)) {
              trace?.finish("cancelled");
              return;
            }
            trace?.finish("error");
            capturePluginFailure(reporters.errors, { boundary: "agent.tool", operation, error });
          },
        );
      },
    });
  }

  // Only when gating or a skills selection exists: an unconditional
  // configure would override the host's all-on default. The host
  // requires `skills`, so a gated plugin without `agents.skills` selects
  // none; `bb-kit check` flags that when the manifest has skills.
  const gated = keys.some((key) => tools[key]?.enabled !== undefined);
  const skills = agents.skills as string[] | ((ctx: Context, session: Session) => string[]);
  if (gated || skills !== undefined) {
    bb.agents.configure((session) =>
      observePluginFailure(
        () => ({
          tools: keys
            .filter((key) => tools[key]?.enabled?.(ctx, session) ?? true)
            .map((key) => toolName(pluginId, key)),
          skills: skills === undefined ? [] : Array.isArray(skills) ? skills : skills(ctx, session),
        }),
        (error) => {
          capturePluginFailure(reporters.errors, { boundary: "agent.configure", error });
        },
      ),
    );
  }

  const instructions = agents.instructions as
    | ((ctx: Context, resolution: { threadId: string; projectId: string }) => string | null)
    | undefined;
  if (instructions !== undefined) {
    bb.agents.contributeInstructions((resolution) =>
      observePluginFailure(
        () => instructions(ctx, resolution),
        (error) => {
          capturePluginFailure(reporters.errors, { boundary: "agent.instructions", error });
        },
      ),
    );
  }
}
