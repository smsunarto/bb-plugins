import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { RPCContext, RPCProcedures, StandardSchemaV1 } from "../rpc/rpc.ts";
import {
  assertRPCKeys,
  createClient,
  noInputSchema,
  RPCValidationError,
  runtimeProcedures,
} from "../rpc/rpc.ts";
import type { MaybePromise } from "../utils/types.ts";
import type { CommandContext, CommandMap, CommandResult } from "../command/command.ts";
import type { ProgramDefinition } from "../command/runner.ts";
import { buildProgram, commandDefinitions, runProgram } from "../command/runner.ts";
import type { Session, ToolMap, ToolsContext } from "../tools/tools.ts";
import { assertToolKeys, runtimeTools, toolName } from "../tools/tools.ts";
import {
  capturePluginFailure,
  createPluginErrorReporter,
  createPluginErrorReporterDisposer,
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
  type PluginPerformanceReporterFactory,
} from "./performance-reporter.ts";
import { hostContext, type Context, type HostAgentsSeam } from "./host.ts";

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
export type { HostSeam } from "./host.ts";
export { hostContext } from "./host.ts";
export type { Context } from "./host.ts";

declare const outsidePreset: unique symbol;

/** `"bb"`. Derived from Context, never spelled twice. */
type PresetField = keyof Context;

/**
 * Diagnostic only. An RPC map whose execute demands a field the frozen
 * preset does not have fails to assign to this, and TypeScript prints
 * the offending keys inside the type name.
 */
export type HandlerDemandsFieldOutsideThePreset<Keys extends PropertyKey> = {
  readonly [outsidePreset]: Keys;
};

/** Same, for agent tools. Tools additionally get `tool`. */
export type ToolDemandsFieldOutsideThePreset<Keys extends PropertyKey> = {
  readonly [outsidePreset]: Keys;
};

type OutsidePreset<Demand, Allowed extends PropertyKey> = Exclude<keyof Demand, Allowed>;

type RPCFieldCheck<R extends RPCProcedures> = [OutsidePreset<RPCContext<R>, PresetField>] extends [
  never,
]
  ? unknown
  : { rpc: HandlerDemandsFieldOutsideThePreset<OutsidePreset<RPCContext<R>, PresetField>> };

type ToolFieldCheck<T extends ToolMap> = [
  OutsidePreset<ToolsContext<T>, PresetField | "tool">,
] extends [never]
  ? unknown
  : {
      agents: ToolDemandsFieldOutsideThePreset<
        OutsidePreset<ToolsContext<T>, PresetField | "tool">
      >;
    };

/**
 * Intersected into `definePlugin`'s parameter. Resolves to `unknown`
 * when every demand is a preset field, and to a re-declaration of
 * `rpc` / `command` / `agents` with the diagnostic type otherwise.
 */
export type ClosedContext<
  R extends RPCProcedures,
  T extends ToolMap = Record<never, never>,
> = RPCFieldCheck<R> & ToolFieldCheck<T>;

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export type DefinedPlugin<R extends RPCProcedures> = ((bb: BbPluginApi) => Promise<void>) & {
  readonly rpc: R;
};

/**
 * The composition root (§2, §7, ADR-0012). Fuses the plugin id, the
 * RPC map, and the curated Commands into one DefinedPlugin. That
 * value is the entry factory bb's server.ts default-exports, plus the
 * map as `.rpc` so UI can type-only import that default. There is no
 * author `context` callback — the factory always builds the frozen
 * `{ bb }` preset from the host. `setup` is METHOD
 * syntax on purpose — bivariant parameters let a callback annotated
 * with a test fake still assign against `BbPluginApi`.
 */
export function definePlugin<
  R extends RPCProcedures,
  C extends CommandMap = Record<never, never>,
  T extends ToolMap = Record<never, never>,
>(
  definition: {
    pluginId: string;
    errorReporter?: PluginErrorReporterFactory;
    performanceReporter?: PluginPerformanceReporterFactory;
    rpc: R;
    command?: C;
    agents?: {
      tools: T;
      skills?: string[] | ((ctx: Context, session: Session) => string[]);
      instructions?(
        ctx: Context,
        resolution: { threadId: string; projectId: string },
      ): string | null;
    };
    setup?(bb: BbPluginApi): MaybePromise<void>;
  } & ClosedContext<R, T>,
): DefinedPlugin<R> {
  const { pluginId, rpc } = definition;
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new Error(`invalid plugin id "${pluginId}": must match /^[a-z0-9][a-z0-9-]*$/`);
  }
  assertRPCKeys(rpc);
  const curated = definition.command ?? {};
  for (const key of Object.keys(curated)) {
    if (key === "rpc" || key === "help") {
      throw new Error(`"${key}" is a reserved command name`);
    }
  }
  if (definition.agents) {
    assertToolKeys(definition.agents.tools);
  }
  const summary = `CLI for the ${pluginId} plugin`;

  const factory = async (bb: BbPluginApi): Promise<void> => {
    let reporter = createPluginErrorReporter(definition.errorReporter, pluginId);
    let performanceReporter = createPluginPerformanceReporter(
      definition.performanceReporter,
      pluginId,
    );
    const disposeErrorReporter = createPluginErrorReporterDisposer(reporter);
    const disposePerformanceReporter = createPluginErrorReporterDisposer(performanceReporter);
    const disposeReporters = async (): Promise<void> => {
      await Promise.all([disposeErrorReporter(), disposePerformanceReporter()]);
    };
    if (reporter !== undefined || performanceReporter !== undefined) {
      try {
        bb.onDispose(disposeReporters);
      } catch {
        reporter = undefined;
        performanceReporter = undefined;
        void disposeReporters();
      }
    }
    const startupTrace = startPluginTrace(performanceReporter, "plugin.startup");

    try {
      // Order (§7): context → client → rpc.register → cli.register → agents → setup.
      const ctx = hostContext(bb);
      const client = createClient(rpc, ctx as RPCContext<R>);

      // rpc.register: contract keyed by the map key (the public
      // name); handlers invoke RPC execute DIRECTLY (the host
      // validates the name, the client the in-process path — no call is
      // validated twice).
      const procedures = runtimeProcedures(rpc);
      const contract: Record<string, { input: StandardSchemaV1; output: StandardSchemaV1 }> = {};
      const handlers: Record<string, (input: unknown) => Promise<unknown>> = {};
      for (const key of Object.keys(procedures)) {
        const procedure = procedures[key];
        if (!procedure) {
          continue;
        }
        contract[key] = {
          input: procedure.input ?? noInputSchema,
          output: procedure.output,
        };
        const traceOperation = rpcTraceOperation(key);
        handlers[key] = procedure.input
          ? async (input: unknown) => {
              const trace = startPluginTrace(performanceReporter, traceOperation);
              try {
                const result = await procedure.execute(ctx, input);
                trace?.finish("ok");
                return result;
              } catch (error) {
                trace?.finish("error");
                capturePluginFailure(reporter, { boundary: "rpc.execute", operation: key, error });
                throw error;
              }
            }
          : async () => {
              const trace = startPluginTrace(performanceReporter, traceOperation);
              try {
                const result = await procedure.execute(ctx);
                trace?.finish("ok");
                return result;
              } catch (error) {
                trace?.finish("error");
                capturePluginFailure(reporter, { boundary: "rpc.execute", operation: key, error });
                throw error;
              }
            };
      }
      bb.rpc.register(contract, handlers);

      // cli.register — always (§2): curated commands plus the always-on
      // rpc subtree behind ONE program, so root help lists everything.
      const runtimeClient = client as unknown as Record<
        string,
        (input?: unknown) => Promise<unknown>
      >;
      const makeDefinitions = (overlay: Omit<CommandContext, "bb">): ProgramDefinition[] => [
        ...commandDefinitions(curated, Object.freeze({ ...ctx, ...overlay })),
        rpcSubtreeDefinition(rpc, runtimeClient, reporter),
      ];
      // One metadata build at registration; a configure that throws here
      // propagates out of the factory (the plugin does not load).
      const metadataProgram = buildProgram(makeDefinitions({}), { name: pluginId, summary });
      const commands = metadataProgram.commands.map((command) => ({
        name: command.name(),
        summary: command.summary(),
        usage: command.usage(),
      }));
      bb.cli.register({
        name: pluginId,
        summary,
        commands,
        run: (argv, overlay) =>
          runProgram(() => makeDefinitions(overlay), argv, {
            name: pluginId,
            summary,
            onUnhandledError(error) {
              if (!isAbortedFailure(error, overlay.signal)) {
                capturePluginFailure(reporter, {
                  boundary: "command.execute",
                  operation: argv[0] ?? "root",
                  error,
                });
              }
            },
          }),
      });

      // agents (ADR-0015): one registration per tool under the derived
      // name. Registration goes through the seam type — the SDK's own
      // registerTool overloads name zod, which bb-kit never imports.
      const agents = definition.agents;
      if (agents) {
        const host: HostAgentsSeam = bb;
        const tools = runtimeTools(agents.tools);
        const keys = Object.keys(tools);
        for (const key of keys) {
          const tool = tools[key];
          if (!tool) {
            continue;
          }
          const operation = toolName(pluginId, key);
          const traceOperation = toolTraceOperation(key);
          host.agents.registerTool({
            name: operation,
            description: tool.description,
            ...(tool.instructions === undefined ? {} : { instructions: tool.instructions }),
            ...(tool.presentation === undefined ? {} : { presentation: tool.presentation }),
            parameters: tool.parameters,
            execute: (params, invocation) => {
              const trace = startPluginTrace(performanceReporter, traceOperation);
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
                  capturePluginFailure(reporter, {
                    boundary: "agent.tool",
                    operation,
                    error,
                  });
                },
              );
            },
          });
        }

        // Synthesized ONLY when gating or a skills selection exists
        // (ADR-0017) — an unconditional configure would override the
        // host's all-on default. A throwing predicate propagates and
        // the host fails that selection closed.
        const gated = keys.some((key) => tools[key]?.enabled !== undefined);
        const skills = agents.skills;
        if (gated || skills !== undefined) {
          host.agents.configure((session) =>
            observePluginFailure(
              () => {
                const selected = keys.filter((key) => {
                  const tool = tools[key];
                  if (!tool) {
                    return false;
                  }
                  return tool.enabled === undefined || tool.enabled(ctx, session);
                });
                let selectedSkills: string[] = [];
                if (skills !== undefined) {
                  selectedSkills = Array.isArray(skills) ? skills : skills(ctx, session);
                }
                return {
                  tools: selected.map((key) => toolName(pluginId, key)),
                  skills: selectedSkills,
                };
              },
              (error) => {
                capturePluginFailure(reporter, { boundary: "agent.configure", error });
              },
            ),
          );
        }

        if (agents.instructions !== undefined) {
          const instructions = agents.instructions;
          host.agents.contributeInstructions((resolution) =>
            observePluginFailure(
              () => instructions(ctx, resolution),
              (error) => {
                capturePluginFailure(reporter, { boundary: "agent.instructions", error });
              },
            ),
          );
        }
      }
      startupTrace?.checkpoint("registered");
    } catch (error) {
      startupTrace?.finish("error");
      capturePluginFailure(reporter, { boundary: "plugin.factory", error });
      await disposeReporters();
      throw error;
    }

    try {
      await definition.setup?.(bb);
    } catch (error) {
      startupTrace?.finish("error");
      capturePluginFailure(reporter, { boundary: "plugin.setup", error });
      await disposeReporters();
      throw error;
    }
    startupTrace?.finish("ok");
  };
  return Object.assign(factory, { rpc });
}

/**
 * The always-mounted `rpc` subtree (ADR-0013): one entry per
 * RPC under its public name, one optional JSON-object
 * positional, dispatched through the validating client. Success prints
 * compact JSON to stdout; every failure is exit 1 on stderr.
 */
function rpcSubtreeDefinition(
  procedures: RPCProcedures,
  client: Record<string, (input?: unknown) => Promise<unknown>>,
  reporter: PluginErrorReporter | undefined,
): ProgramDefinition {
  const children = Object.keys(procedures).map((key): ProgramDefinition => {
    const kind = procedures[key]?.kind ?? "query";
    return {
      name: key,
      summary: `(${kind})`,
      configure: (cmd) => {
        cmd.argument("[input]", "JSON object input");
      },
      action: async (cmd): Promise<CommandResult> => {
        const raw = cmd.processedArgs[0] as string | undefined;
        let input: unknown;
        if (raw !== undefined) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { exitCode: 1, stderr: `invalid JSON input: ${message}\n` };
          }
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { exitCode: 1, stderr: "input must be a JSON object\n" };
          }
          input = parsed;
        }
        try {
          const call = client[key];
          if (!call) {
            return { exitCode: 1, stderr: `unknown RPC "${key}"\n` };
          }
          const result = input === undefined ? await call() : await call(input);
          return { exitCode: 0, stdout: `${JSON.stringify(result)}\n` };
        } catch (error) {
          if (!(error instanceof RPCValidationError && error.stage === "input")) {
            capturePluginFailure(reporter, { boundary: "rpc.cli", operation: key, error });
          }
          const message = error instanceof Error ? error.message : String(error);
          return { exitCode: 1, stderr: `${message}\n` };
        }
      },
    };
  });
  return {
    name: "rpc",
    summary: "Call an RPC (JSON object in, JSON object out)",
    children,
  };
}
