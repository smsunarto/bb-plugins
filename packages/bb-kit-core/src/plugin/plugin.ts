import type { AnyRPC } from "../rpc/procedure.ts";
import { runtimeProcedures } from "../rpc/procedure.ts";
import type { MaybePromise } from "../internal/types.ts";
import type { StandardSchemaV1 } from "../rpc/standard-schema.ts";
import type { ClientFor, RPCContext } from "../rpc/rpc.ts";
import { createClient } from "../rpc/rpc.ts";
import { noInputSchema } from "../rpc/no-input.ts";
import { kebabName, wireName } from "../rpc/wire-name.ts";
import type { CLICommand, CLIContext, CLIResult, SubcommandDefinition } from "../cli/runner.ts";
import { buildProgram, commandDefinitions, runProgram } from "../cli/runner.ts";
import type { HostSeam } from "./host.ts";

/**
 * The composition root (§2, §6, ADR-0012). Fuses the RPC, the curated
 * CLI commands, and the context factory into one entry factory bb's
 * server.ts default-exports. `context` and `setup` are METHOD syntax on
 * purpose — bivariant parameters let a `BbPluginApi`-annotated callback
 * accept against the narrower structural seam.
 */
export function definePlugin<
  R extends AnyRPC,
  Cx extends RPCContext<R>,
  C extends Record<string, CLICommand<ClientFor<R>>> = Record<never, never>,
>(definition: {
  rpc: R;
  cli?: { summary: string; commands: C };
  context(bb: HostSeam): MaybePromise<Cx>;
  setup?(bb: HostSeam, extras: { client: ClientFor<R>; context: Cx }): MaybePromise<void>;
}): (bb: HostSeam) => Promise<void> {
  const { rpc } = definition;
  const curated: Record<string, CLICommand<ClientFor<R>>> = definition.cli?.commands ?? {};
  for (const key of Object.keys(curated)) {
    if (key === "rpc" || key === "help") {
      throw new Error(`"${key}" is a reserved command name`);
    }
  }
  const id = rpc.namespace;
  const summary = definition.cli?.summary ?? `RPC access for the ${id} plugin`;

  return async (bb: HostSeam): Promise<void> => {
    // Order (§6): context → client → rpc.register → cli.register → setup.
    const context = await definition.context(bb);
    const client = createClient(rpc, context as RPCContext<R>);

    // rpc.register: wire-named contract; handlers invoke the procedure
    // handlers DIRECTLY (the host validates the wire, the client the
    // in-process path — no call is validated twice).
    const procedures = runtimeProcedures(rpc);
    const contract: Record<string, { input: StandardSchemaV1; output: StandardSchemaV1 }> = {};
    const handlers: Record<string, (input: unknown) => Promise<unknown>> = {};
    for (const key of Object.keys(procedures)) {
      const procedure = procedures[key];
      if (!procedure) {
        continue;
      }
      const wire = wireName(id, key);
      contract[wire] = {
        input: procedure.input ?? noInputSchema,
        output: procedure.output,
      };
      handlers[wire] = procedure.input
        ? async (input: unknown) => procedure.handler(context, input)
        : async () => procedure.handler(context);
    }
    bb.rpc.register(contract, handlers);

    // cli.register — always (§2): curated commands plus the always-on
    // rpc subtree behind ONE program, so root help lists everything.
    const runtimeClient = client as unknown as Record<
      string,
      (input?: unknown) => Promise<unknown>
    >;
    const makeDefinitions = (cliContext: CLIContext): SubcommandDefinition[] => [
      ...commandDefinitions<ClientFor<R>>(curated, client, cliContext),
      rpcSubtreeDefinition(rpc, runtimeClient),
    ];
    // One metadata build at registration; a configure that throws here
    // propagates out of the factory (the plugin does not load).
    const metadataProgram = buildProgram(makeDefinitions({}), { name: id, summary });
    const commands = metadataProgram.commands.map((command) => ({
      name: command.name(),
      summary: command.summary(),
      usage: command.usage(),
    }));
    bb.cli.register({
      name: id,
      summary,
      commands,
      run: (argv, ctx) => runProgram(() => makeDefinitions(ctx), argv, { name: id, summary }),
    });

    if (definition.setup) {
      await definition.setup(bb, { client, context });
    }
  };
}

/**
 * The always-mounted `rpc` subtree (ADR-0013): one subcommand per
 * procedure under its kebab-cased key, one optional JSON-object
 * positional, dispatched through the validating client. Success prints
 * compact JSON to stdout; every failure is exit 1 on stderr.
 */
function rpcSubtreeDefinition(
  rpc: AnyRPC,
  client: Record<string, (input?: unknown) => Promise<unknown>>,
): SubcommandDefinition {
  const children = Object.keys(rpc.procedures).map((key): SubcommandDefinition => {
    const kind = rpc.procedures[key]?.kind ?? "query";
    return {
      name: kebabName(key),
      summary: `(${kind})`,
      configure: (command) => {
        command.argument("[input]", "JSON object input");
      },
      action: async (command): Promise<CLIResult> => {
        const raw = command.processedArgs[0] as string | undefined;
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
            return { exitCode: 1, stderr: `unknown procedure "${key}"\n` };
          }
          const result = input === undefined ? await call() : await call(input);
          return { exitCode: 0, stdout: `${JSON.stringify(result)}\n` };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { exitCode: 1, stderr: `${message}\n` };
        }
      },
    };
  });
  return {
    name: "rpc",
    summary: "Call a procedure (JSON object in, JSON object out)",
    children,
  };
}
