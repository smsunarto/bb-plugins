import type { BbPluginApi, PluginCliCommand, PluginCliContext } from "@get-bb/plugin-sdk";
import { defineCli, PluginCliError } from "@get-bb/plugin-sdk";
import type { CommandMap, CommandsContext } from "../command/command.ts";
import type { Context } from "../context.ts";
import {
  PLUGIN_ID_PATTERN,
  RESERVED_COMMAND_KEYS,
  TOOL_KEY_PATTERN,
  toolRegistrations,
  type ToolRegistration,
  toolName,
} from "../names/names.ts";
import type { RPCContext, RPCProcedures, RuntimeProcedure, StandardSchemaV1 } from "../rpc/rpc.ts";
import { assertRPCKeys, callProcedure, noInputSchema, RPCValidationError } from "../rpc/rpc.ts";
import type { InstructionFiles } from "../instructions/instructions.ts";
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
 * Identity: `pluginId` is the id bb derives from package.json `name`, the
 * one routes, storage, settings, and reporters key on. `publicName` is
 * what users and agents type: the `bb <publicName>` CLI and the
 * `<public_name>_<key>` tool names. It defaults to `pluginId`; set it only
 * when a plugin is renamed but must keep its stored identity.
 *
 * Load order: services → RPC → CLI → agents → setup. `services(bb)`
 * runs once per load. A service that holds resources registers its own
 * cleanup with `bb.onDispose`.
 *
 * All of it runs inside bb's plugin factory, before bb activates the
 * plugin. There, host plugin calls (`bb.hosts.experimental_client().call`)
 * always throw, and `bb.sdk` and `bb.server.loopbackBaseUrl` throw while the
 * server is still starting. Work that needs them runs later: in a handler,
 * a timer, or a `bb.background.service`, whose `start` runs once the
 * factory has resolved.
 */
export function definePlugin<
  R extends RPCProcedures,
  M extends CommandMap = Record<never, never>,
  T extends ToolMap = Record<never, never>,
  S extends object = Record<never, never>,
>(
  definition: {
    pluginId: string;
    /** The CLI name and tool-name prefix. Defaults to `pluginId`. */
    publicName?: string;
    /** Override only the CLI root, keeping the public tool-name prefix. */
    cliName?: string;
    /**
     * Build the plugin's long-lived collaborators once per load. Keep it
     * synchronous and free of host and SDK calls: it runs before bb
     * activates the plugin. Start-up work belongs in a
     * `bb.background.service`.
     */
    services?(bb: BbPluginApi): S & Demanded<NoInfer<R>, NoInfer<M>, NoInfer<T>>;
    errorReporter?: PluginErrorReporterFactory;
    performanceReporter?: PluginPerformanceReporterFactory;
    rpc: R;
    /** Publish the RPC contract (methods and JSON schemas) to `bb plugin rpc`. Off by default. */
    rpcPublication?: { discoverable?: boolean; description?: string };
    command?: M;
    agents?: {
      /**
       * `instructionFiles(import.meta.url)`. Each tool's description and
       * thread snippet are read from `instructions/tools/` at load.
       */
      files: InstructionFiles;
      tools: T;
      /**
       * Extra complete names for existing tools, `{ old_name: "key" }`,
       * for callers that still hold a retired name. An alias shares its
       * tool's parameters, description, presentation, `enabled` gate,
       * tracing, and error reporting. Its tool's thread snippet stays on
       * the canonical name, so a session holding both reads it once.
       */
      aliases?: Readonly<Record<string, keyof NoInfer<T> & string>>;
      skills?: string[] | ((ctx: Context<S>, session: Session) => string[]);
      instructions?(
        ctx: Context<S>,
        resolution: { threadId: string; projectId: string },
      ): string | null;
    };
    /**
     * Runs last, for host wiring bb-kit does not own: events, hooks, http,
     * settings, background services. Register here, and start work from
     * those: host plugin calls throw here, and a rejected await fails the
     * whole load.
     */
    setup?(ctx: Context<S>): MaybePromise<void>;
  } & RequireServices<NoInfer<R>, NoInfer<M>, NoInfer<T>>,
): DefinedPlugin<R> {
  const { pluginId, rpc } = definition;
  if (typeof pluginId !== "string" || !PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new Error(`invalid plugin id "${pluginId}": must match ${PLUGIN_ID_PATTERN}`);
  }
  const publicName = definition.publicName === undefined ? pluginId : definition.publicName;
  if (typeof publicName !== "string" || !PLUGIN_ID_PATTERN.test(publicName)) {
    throw new Error(`invalid public name "${publicName}": must match ${PLUGIN_ID_PATTERN}`);
  }
  const cliName = definition.cliName === undefined ? publicName : definition.cliName;
  if (typeof cliName !== "string" || !PLUGIN_ID_PATTERN.test(cliName)) {
    throw new Error(`invalid CLI name "${cliName}": must match ${PLUGIN_ID_PATTERN}`);
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
  const registrations = toolRegistrations(
    publicName,
    Object.keys(tools),
    definition.agents?.aliases,
  );

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
          name: cliName,
          summary: `CLI for the ${publicName} plugin`,
          commands: {
            ...cliCommands(ctx, commands, reporters.errors),
            ...rpcCommands(ctx, rpc, reporters.errors),
          },
        }),
      );
      if (definition.agents) {
        registerAgents(bb, ctx, publicName, tools, registrations, definition.agents, reporters);
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
  publicName: string,
  tools: Record<string, RuntimeTool>,
  registrations: ToolRegistration[],
  agents: {
    files: InstructionFiles;
    skills?: string[] | ((ctx: never, session: Session) => string[]);
    instructions?(ctx: never, resolution: { threadId: string; projectId: string }): string | null;
  },
  reporters: Reporters,
): void {
  const keys = Object.keys(tools);
  for (const { name, key, alias } of registrations) {
    const tool = tools[key] as RuntimeTool;
    const text = agents.files.tool(toolName(publicName, key));
    const traceOperation = toolTraceOperation(key);
    bb.agents.registerTool({
      name,
      ...(alias ? { description: text.description } : text),
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
            // The called name, so a report shows whether a retired alias still has callers.
            capturePluginFailure(reporters.errors, {
              boundary: "agent.tool",
              operation: name,
              error,
            });
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
        () => {
          const enabled = new Set(
            keys.filter((key) => tools[key]?.enabled?.(ctx, session) ?? true),
          );
          return {
            // An alias follows its tool's gate.
            tools: registrations.filter(({ key }) => enabled.has(key)).map(({ name }) => name),
            skills:
              skills === undefined ? [] : Array.isArray(skills) ? skills : skills(ctx, session),
          };
        },
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
