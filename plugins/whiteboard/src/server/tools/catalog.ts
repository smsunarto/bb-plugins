import { z } from "zod";
import type { JsonObject } from "../../shared/json/index.ts";
import { fileLineRangeSchema } from "../../shared/review/source.ts";
import { files } from "../lib/instructions.ts";
import { activitySchema } from "../lib/review/activity.ts";
import type { ReviewApi } from "../lib/review/api.ts";
import { INSTRUCTION_TOPICS } from "../lib/review/instructions.ts";
import { uploadSchema } from "../lib/review/local-data.ts";
import { commandSchema } from "../lib/review/store.ts";
import { flattenSchema } from "./flatten-schema.ts";

/** One agent tool: what bb advertises, how its input is checked, and the operation it runs. */
export interface WhiteboardTool<Schema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  /** Checks every call's input, from bb or `bb whiteboard tool`. */
  schema: Schema;
  /** Advertised instead of `schema` when bb cannot take it as zod: its JSON
   * Schema with the recursion cut, which bb rejects otherwise. */
  advertised?: JsonObject;
  /** Run the operation and answer the text the agent reads. */
  execute(api: ReviewApi, input: z.output<Schema>, signal: AbortSignal): Promise<string>;
}

const SESSION_KEYS: Readonly<Record<string, string>> = {
  reviewId: "sessionId",
  review: "session",
  reviews: "sessions",
};

/**
 * An operation's answer in the agent's vocabulary: `reviewId` becomes
 * `sessionId`, and `review`/`reviews` become `session`/`sessions` with the
 * same rename inside them. Everything else, including authored content that
 * happens to use those words, passes through untouched.
 */
export function sessionKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sessionKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      SESSION_KEYS[key] ?? key,
      key === "review" || key === "reviews" ? sessionKeys(item) : item,
    ]),
  );
}

const json = (value: unknown) => JSON.stringify(sessionKeys(value));

/** Optional, with null meaning omitted: providers send null for read tools' unused fields. */
function omittable<T extends z.ZodType>(schema: T) {
  return schema.nullish().transform((value) => value ?? undefined);
}

/** As `omittable`, with the operation's default advertised and applied. */
function defaulted<T extends string | number>(schema: z.ZodType<T>, fallback: T) {
  return schema
    .default(fallback)
    .nullable()
    .transform((value) => value ?? fallback);
}

const sessionId = z.string().min(1);
const name = z.string().min(1);
const version = omittable(z.number().int().nonnegative());
const side = z.enum(["base", "head"]);
/** A read's selector: a stored `version`, one `commit` of the comparison, or explicit pins. */
const selector = {
  version,
  commit: omittable(name),
  repositoryId: omittable(name),
  head: omittable(name),
  base: omittable(name),
};

function define<Schema extends z.ZodType>(
  toolName: string,
  schema: Schema,
  execute: WhiteboardTool<Schema>["execute"],
  options: { recursive?: boolean } = {},
): WhiteboardTool<Schema> {
  return {
    name: toolName,
    description: files.tool(toolName).description,
    schema,
    ...(options.recursive && {
      advertised: flattenSchema(z.toJSONSchema(schema, { io: "input" }) as JsonObject),
    }),
    execute,
  };
}

type CommandType = z.output<typeof commandSchema>["operation"]["type"];

/** Each command type's operation variants: one, or create's variants by `source`. */
const COMMAND_VARIANTS = new Map(
  commandSchema.shape.operation.options.map((operation) => {
    const variants: readonly z.ZodObject[] =
      operation instanceof z.ZodDiscriminatedUnion ? operation.options : [operation];
    return [variants[0]!.shape.type.value as CommandType, variants] as const;
  }),
);

/**
 * A command's fields as its tool takes them: the operation's own, without
 * `type`, and `sessionId` for `reviewId`. Create, a union on `source`, is
 * advertised flat: `source` as the enum of its variants and every other field
 * from the variant that defines it, optional unless every variant requires
 * it, so the tool schema keeps one root object. `commandSchema` still checks
 * the union when the tool runs.
 */
function commandFields(variants: readonly z.ZodObject[]): z.ZodRawShape {
  const shapes = variants.map((variant) => variant.shape as Record<string, z.ZodType>);
  if (shapes.length === 1)
    return Object.fromEntries(
      Object.entries(shapes[0]!)
        .filter(([key]) => key !== "type")
        .map(([key, field]) => [key === "reviewId" ? "sessionId" : key, field]),
    );

  const flat: Record<string, z.ZodType> = {
    source: z.enum(shapes.map((shape) => (shape.source as z.ZodLiteral<string>).value)),
  };
  for (const shape of shapes)
    for (const [key, field] of Object.entries(shape)) {
      if (key === "type" || key in flat) continue;
      const everywhere = shapes.every(
        (other) => other[key] && !other[key].safeParse(undefined).success,
      );
      flat[key] = everywhere ? field : field.optional();
    }
  return flat;
}

/**
 * A command tool. `open` (create only) steers presentation and stays out of
 * the command, so a retry may choose differently.
 */
function command(type: CommandType, toolName: string, options: { recursive?: boolean } = {}) {
  const schema = z.strictObject({
    ...commandFields(COMMAND_VARIANTS.get(type)!),
    ...(type === "create" && { open: z.boolean().optional() }),
    commandId: z.uuid(),
    leaseId: commandSchema.shape.leaseId,
  });
  return define(
    toolName,
    schema,
    async (api, input: Record<string, unknown>, signal) => {
      const { commandId, leaseId, open, sessionId: id, ...fields } = input;
      const parsed = commandSchema.parse({
        commandId,
        leaseId,
        operation: { ...fields, ...(id !== undefined && { reviewId: id }), type },
      });
      return json(
        await api.command(parsed, { open: typeof open === "boolean" ? open : undefined, signal }),
      );
    },
    options,
  );
}

/**
 * Every Whiteboard tool, in the order bb lists them. The scratchpad setting
 * adds its guidance to `whiteboard_session_get_instructions`; a settings
 * change reloads the plugin, so registration reads it once.
 */
export function whiteboardTools(scratchpadEnabled: boolean): WhiteboardTool[] {
  const instructions = define(
    "whiteboard_session_get_instructions",
    z.strictObject({ topic: defaulted(z.enum(INSTRUCTION_TOPICS), "authoring") }),
    (api, input) => api.instructions(input),
  );
  if (scratchpadEnabled)
    instructions.description += `\n\n${files.read("get-instructions-scratchpad")}`;

  return [
    instructions,
    define("whiteboard_status", z.strictObject({}), async (api) => json(await api.status())),
    define("whiteboard_session_capabilities", z.strictObject({}), async (api) =>
      json(await api.capabilities()),
    ),
    define(
      "whiteboard_session_activity",
      activitySchema.extend({ sessionId }),
      async (api, { sessionId: id, ...update }) =>
        json(await api.activity({ reviewId: id, ...update })),
    ),
    command("delete", "whiteboard_session_delete"),
    command("attention", "whiteboard_session_attention"),
    command("create", "whiteboard_session_create"),
    command("set_target", "whiteboard_session_set_target"),
    command("edit", "whiteboard_session_edit", { recursive: true }),
    command("lens", "whiteboard_session_lens_edit"),
    command("rename", "whiteboard_session_rename"),
    command("repin", "whiteboard_session_repin"),
    command("restore", "whiteboard_session_restore"),
    define("whiteboard_session_list", z.strictObject({}), async (api) =>
      json(await api.catalog({})),
    ),
    define(
      "whiteboard_session_get",
      z.strictObject({
        sessionId,
        version,
        targetId: omittable(name),
        full: omittable(z.boolean()),
        format: defaulted(z.enum(["text", "json"]), "text"),
      }),
      async (api, { sessionId: id, ...read }) => {
        const result = await api.inspect({ reviewId: id, ...read });
        return typeof result === "string" ? result : json(result);
      },
    ),
    define(
      "whiteboard_session_lens_get",
      z.strictObject({ sessionId }),
      async (api, input, signal) =>
        json(await api.lenses({ reviewId: input.sessionId }, { signal })),
    ),
    define("whiteboard_session_history", z.strictObject({ sessionId }), async (api, input) =>
      json(await api.history({ reviewId: input.sessionId })),
    ),
    define("whiteboard_session_open", z.strictObject({ sessionId }), async (api, input) =>
      json(await api.open({ reviewId: input.sessionId })),
    ),
    define(
      "whiteboard_session_environment",
      // `retry` is accepted for older callers; bb prepares nothing to retry.
      z.strictObject({ sessionId, retry: z.boolean().optional() }),
      async (api, input) => json(await api.environment({ reviewId: input.sessionId })),
    ),
    define(
      "whiteboard_session_workspace_cleanup",
      z.strictObject({ workspaceId: name.optional() }),
      async (api, input) => json(await api.workspaceCleanup(input)),
    ),
    define(
      "whiteboard_session_register_repository",
      z.strictObject({ path: name }),
      async (api, input) => json(await api.registerRepository(input)),
    ),
    define(
      "whiteboard_session_resolve_pins",
      z.strictObject({ repositoryId: name, base: name, head: name }),
      async (api, input) => json(await api.resolvePins(input)),
    ),
    define(
      "whiteboard_session_upload",
      uploadSchema,
      async (api, input) => json(await api.upload(input)),
      { recursive: true },
    ),
    define(
      "whiteboard_session_source",
      z.strictObject({
        sessionId,
        version: z.number().int().nonnegative().optional(),
        source: fileLineRangeSchema,
        commit: name.optional(),
      }),
      async (api, { sessionId: id, ...read }) => json(await api.source({ reviewId: id, ...read })),
    ),
    define(
      "whiteboard_session_file",
      z.strictObject({ sessionId, ...selector, side, file: name }),
      async (api, { sessionId: id, ...read }) => json(await api.file({ reviewId: id, ...read })),
    ),
    define(
      "whiteboard_session_tree",
      z.strictObject({
        sessionId,
        ...selector,
        side: defaulted(side, "head"),
        path: defaulted(z.string(), ""),
      }),
      async (api, { sessionId: id, ...read }) => json(await api.tree({ reviewId: id, ...read })),
    ),
    define(
      "whiteboard_session_diff",
      z.strictObject({
        sessionId,
        ...selector,
        paths: omittable(z.array(name).max(200)),
        // No advertised default: the operation refuses `file` with an explicit format.
        format: omittable(z.enum(["files", "patch"])),
        context: omittable(z.number().int().min(0).max(50)),
        maxBytes: defaulted(z.number().int().positive().max(500_000), 40_000),
        /** Older callers' form of `paths: [file], format: "patch"`. */
        file: omittable(name),
      }),
      async (api, { sessionId: id, ...read }) => {
        const diff = await api.diff({ reviewId: id, ...read });
        return diff.format === "files" ? json(diff.files) : diff.text;
      },
    ),
    define(
      "whiteboard_session_commits",
      z.strictObject({ sessionId, version }),
      async (api, input) =>
        json(await api.commits({ reviewId: input.sessionId, version: input.version })),
    ),
  ];
}
