import { z } from "zod";
import { componentNameSchema, type ComponentName } from "./registry.ts";
import { styleNames, type StyleName } from "./styles.ts";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue, JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export interface Span {
  readonly line: number;
  readonly column: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

export const spanSchema = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
});

export const diagnosticCodes = [
  "unknown-component",
  "non-literal-prop",
  "invalid-prop",
  "unexpected-children",
  "expected-code-child",
  "disallowed-child",
  "import-not-allowed",
  "expression-not-allowed",
  "inline-component",
  "fragment-not-allowed",
  "duplicate-state-id",
  "unknown-style",
  "unknown-frontmatter-key",
  "invalid-frontmatter",
  "syntax-error",
] as const;

export type DiagnosticCode = (typeof diagnosticCodes)[number];

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly span: Span | null;
  readonly didYouMean?: string;
}

export const diagnosticSchema = z.object({
  code: z.enum(diagnosticCodes),
  message: z.string(),
  span: spanSchema.nullable(),
  didYouMean: z.string().optional(),
});

export type CanvasNode =
  | { readonly kind: "markdown"; readonly source: string; readonly span: Span }
  | {
      readonly kind: "component";
      readonly name: ComponentName;
      readonly props: Readonly<Record<string, JsonValue>>;
      readonly children: readonly CanvasNode[];
      readonly span: Span;
    }
  | { readonly kind: "diagnostic"; readonly diagnostic: Diagnostic };

export const canvasNodeSchema: z.ZodType<CanvasNode, CanvasNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("markdown"), source: z.string(), span: spanSchema }),
    z.object({
      kind: z.literal("component"),
      name: componentNameSchema,
      props: z.record(z.string(), jsonValueSchema),
      children: z.array(canvasNodeSchema),
      span: spanSchema,
    }),
    z.object({ kind: z.literal("diagnostic"), diagnostic: diagnosticSchema }),
  ]),
);

export interface CanvasDocument {
  readonly style: StyleName;
  readonly nodes: readonly CanvasNode[];
  readonly stateIds: readonly string[];
}

export const canvasDocumentSchema: z.ZodType<CanvasDocument, CanvasDocument> = z.object({
  style: z.enum(styleNames),
  nodes: z.array(canvasNodeSchema),
  stateIds: z.array(z.string()),
});

export { collectDiagnostics, collectStateIds } from "./walk.ts";

export type { StyleName } from "./styles.ts";
export { defaultStyle, isStyleName, styleNames, styles, suggestStyleName } from "./styles.ts";

export type { CanvasSource, CommentsSignal, NarrowSourceResult, StateSignal } from "./source.ts";
export {
  commentsChannel,
  fileNameOf,
  isCanvasPath,
  narrowSource,
  normalizePath,
  stateChannel,
  stateKeyOf,
} from "./source.ts";

export const canvasSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workspace"),
    environmentId: z.string().min(1),
    path: z.string().min(1),
  }),
  z.object({
    kind: z.literal("thread-storage"),
    threadId: z.string().min(1),
    path: z.string().min(1),
  }),
  z.object({
    kind: z.literal("host"),
    hostId: z.string().min(1).nullable(),
    path: z.string().min(1),
  }),
]);

export interface CanvasState {
  readonly values: Readonly<Record<string, JsonValue>>;
  readonly revision: number;
}

export const canvasStateSchema = z.object({
  values: z.record(z.string(), jsonValueSchema),
  revision: z.number().int().nonnegative(),
});

export const unreadableReasons = [
  "missing",
  "too-large",
  "binary",
  "host-offline",
  "no-worktree",
] as const;

export type UnreadableReason = (typeof unreadableReasons)[number];

export const renderInputSchema = z.object({
  source: canvasSourceSchema,
  knownSha256: z.string().nullable().default(null),
});

export const renderOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unchanged"), sha256: z.string() }),
  z.object({
    status: z.literal("rendered"),
    sha256: z.string(),
    modifiedAtMs: z.number().nullable(),
    document: canvasDocumentSchema,
  }),
  z.object({
    status: z.literal("unparseable"),
    sha256: z.string(),
    diagnostic: diagnosticSchema,
  }),
  z.object({
    status: z.literal("unreadable"),
    reason: z.enum(unreadableReasons),
    detail: z.string(),
  }),
]);

export type RenderOutput = z.infer<typeof renderOutputSchema>;

export const stateInputSchema = z.object({ source: canvasSourceSchema });

export const setStateInputSchema = z.object({
  source: canvasSourceSchema,
  key: z.string().min(1),
  value: jsonValueSchema,
});

export const stateSignalSchema = z.object({
  stateKey: z.string(),
  revision: z.number().int().nonnegative(),
});
