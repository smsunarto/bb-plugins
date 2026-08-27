import type { MaybePromise, UnionToIntersection } from "../utils/types.ts";
import type { JSONObjectSchema, SchemaOutput, StandardSchemaV1 } from "../rpc/rpc.ts";
import type {
  PluginAgentConfigurationContext,
  PluginAgentToolContext,
  PluginAgentToolPresentation,
  PluginAgentToolResult,
} from "@get-bb/plugin-sdk";

// ── Agent tool shapes ────────────────────────────────────────────────

/**
 * Host types crossing the seam verbatim (ADR-0015) — the `Context.bb`
 * policy: zero translation drift in exchange for the SDK's own shapes.
 * `Session` is the per-resolution payload `enabled` and the skills
 * selector answer against; `ToolInvocation` the per-call host facts.
 */
export type Session = PluginAgentConfigurationContext;
export type ToolInvocation = PluginAgentToolContext;
export type ToolResult = PluginAgentToolResult;
export type ToolPresentation = PluginAgentToolPresentation;

/**
 * What a tool's `execute` receives: the plugin Context plus the
 * per-call host facts under one key — the CommandContext twin. Host
 * plumbing folds into the context; the payload stays a parameter.
 */
export type ToolContext<C> = C & { tool: ToolInvocation };

/** The object-only parameters pin (ADR-0016), shared with the rpc domain. */
type ObjectSchema = StandardSchemaV1 & JSONObjectSchema;

/**
 * The precise shape `defineTool` returns. `execute` and `enabled` are
 * method syntax so the concrete shape satisfies `AnyTool` bivariantly
 * (the AnyProcedure precedent). `enabled` is synchronous because the
 * host resolves configure synchronously at thread.start/turn.submit;
 * a Promise-returning selection would fail closed there.
 */
export type DefinedTool<Context, In extends ObjectSchema> = {
  readonly description: string;
  readonly instructions?: string;
  readonly presentation?: ToolPresentation;
  readonly parameters: In;
  enabled?(context: Context, session: Session): boolean;
  execute(context: ToolContext<Context>, input: SchemaOutput<In>): MaybePromise<ToolResult>;
};

/**
 * Declare an agent tool. `Context` infers from the callbacks'
 * first-parameter annotations and stays `unknown` when unannotated.
 * The public name is derived by `toolName` from the composition root's
 * map key — there is no name field to hold wrong (ADR-0015).
 */
export function defineTool<Context, In extends ObjectSchema>(definition: {
  description: string;
  instructions?: string;
  presentation?: ToolPresentation;
  parameters: In;
  enabled?(context: Context, session: Session): boolean;
  execute(context: ToolContext<Context>, input: SchemaOutput<In>): MaybePromise<ToolResult>;
}): DefinedTool<Context, In> {
  return definition;
}

/**
 * The loose shape every concrete tool satisfies. Method syntax on
 * purpose: parameters compare bivariantly, so tools with narrower
 * context and input types still satisfy `ToolMap` (the AnyProcedure
 * precedent).
 */
export type AnyTool = {
  readonly description: string;
  readonly instructions?: string;
  readonly presentation?: ToolPresentation;
  readonly parameters: StandardSchemaV1;
  enabled?(context: never, session: never): boolean;
  execute(context: never, ...rest: never[]): unknown;
};

export type ToolMap = Record<string, AnyTool>;

/**
 * The runtime view — what the `definePlugin` factory actually calls.
 * Reached by one contained cast from the precise generic types (the
 * runtimeProcedures precedent).
 */
export type RuntimeTool = {
  description: string;
  instructions?: string;
  presentation?: ToolPresentation;
  parameters: StandardSchemaV1;
  enabled?: (context: unknown, session: Session) => boolean;
  execute: (context: unknown, input: unknown) => MaybePromise<ToolResult>;
};

export function runtimeTools(tools: ToolMap): Record<string, RuntimeTool> {
  return tools as unknown as Record<string, RuntimeTool>;
}

export const TOOL_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Validate tool map keys (the assertRPCKeys twin), called from
 * `definePlugin` at define time. A key is the underscored basename of
 * its unit file; the host's own name grammar is wider, but bb-kit
 * derives names, it never accepts them.
 */
export function assertToolKeys(tools: ToolMap): void {
  for (const key of Object.keys(tools)) {
    if (!TOOL_KEY_PATTERN.test(key)) {
      throw new Error(`invalid tool key "${key}": must match /^[a-z][a-z0-9_]*$/`);
    }
  }
}

/**
 * THE single derivation of a tool's public name. The host applies no
 * namespace and rejects cross-plugin collisions at registration, so
 * bb-kit prefixes the plugin id itself; authors never type the prefix.
 */
export function toolName(pluginId: string, key: string): string {
  return `${pluginId.replaceAll("-", "_")}_${key}`;
}

type ToolDemand<T> = T extends {
  execute(context: infer C, ...rest: never[]): unknown;
}
  ? ToolContext<unknown> extends C
    ? never // a tool demanding only the overlay demands nothing
    : C
  : never;

/**
 * What a tool map collectively demands of the context. Mirrors
 * `RPCContext`; one extraction arm suffices because `DefinedTool` ties
 * `execute` and `enabled` to the same Context parameter, so a demand
 * annotated only on `enabled` still reaches `execute`'s declared type.
 */
export type ToolsContext<T extends ToolMap> = [ToolDemand<T[keyof T]>] extends [never]
  ? {}
  : UnionToIntersection<ToolDemand<T[keyof T]>>;
