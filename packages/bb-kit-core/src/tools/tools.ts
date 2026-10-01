import type {
  PluginAgentConfigurationContext,
  PluginAgentToolContext,
  PluginAgentToolResult,
  PluginRowPresentation,
} from "@get-bb/plugin-sdk";
import type { Context } from "../context.ts";
import type { JSONObjectSchema, SchemaOutput, StandardSchemaV1 } from "../rpc/rpc.ts";
import type { ContextDemand, MaybePromise, UnionToIntersection } from "../utils/types.ts";

/** The per-resolution payload `enabled` and the skills selector answer against. */
export type Session = PluginAgentConfigurationContext;
/** The per-call host facts a tool's `ctx.tool` carries. */
export type ToolInvocation = PluginAgentToolContext;
export type ToolResult = PluginAgentToolResult;
export type ToolPresentation = PluginRowPresentation;

/** What a tool's `execute` receives: the plugin Context plus the per-call host facts. */
export type ToolContext<C extends Context = Context> = C & { tool: ToolInvocation };

type ObjectSchema = StandardSchemaV1 & JSONObjectSchema;

/**
 * `enabled` is synchronous because the host resolves the agent
 * configuration synchronously; a Promise there fails the selection
 * closed.
 */
export type DefinedTool<C extends Context, In extends ObjectSchema> = {
  readonly description: string;
  readonly instructions?: string;
  readonly presentation?: ToolPresentation;
  readonly parameters: In;
  enabled?(ctx: C, session: Session): boolean;
  execute(ctx: ToolContext<C>, input: SchemaOutput<In>): MaybePromise<ToolResult>;
};

/**
 * Declare an agent tool. Its public name is derived from the
 * `agents.tools` map key, so there is no name field to hold wrong.
 */
export function defineTool<In extends ObjectSchema, C extends Context = Context>(
  definition: DefinedTool<C, In>,
): DefinedTool<C, In> {
  return definition;
}

export type AnyTool = {
  readonly description: string;
  readonly instructions?: string;
  readonly presentation?: ToolPresentation;
  readonly parameters: StandardSchemaV1;
  enabled?(ctx: never, session: never): boolean;
  execute(ctx: never, ...rest: never[]): unknown;
};

export type ToolMap = Record<string, AnyTool>;

/** The runtime view the composition root calls. */
export type RuntimeTool = {
  description: string;
  instructions?: string;
  presentation?: ToolPresentation;
  parameters: StandardSchemaV1;
  enabled?: (ctx: unknown, session: Session) => boolean;
  execute: (ctx: unknown, input: unknown) => MaybePromise<ToolResult>;
};

/** What a tool map collectively demands of `ctx`. */
export type ToolsContext<T extends ToolMap> = UnionToIntersection<ContextDemand<T[keyof T]>>;
