import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  ANYWHERE,
  MAX_INSTRUCTIONS_LENGTH,
  ruleSchema,
  type Conditions,
  type Rule,
} from "../shared/rules.ts";

/** Safe filename stem for a doc or rule file (`<id>.md`). */
export const ITEM_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const docMetaSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    enabled: z.boolean().optional(),
    order: z.number().int().optional(),
  })
  .strict();

const ruleFrontmatterSchema = z
  .object({
    name: z.string().max(80).optional(),
    enabled: z.boolean().optional(),
    order: z.number().int().optional(),
    when: z
      .object({
        hosts: z.array(z.string().min(1)).optional(),
        providers: z.array(z.string().min(1)).optional(),
        models: z.array(z.string().trim().min(1).max(200)).optional(),
        projects: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ParsedDoc = {
  id: string;
  name: string;
  enabled: boolean;
  order: number | undefined;
  body: string;
  hasFrontmatter: boolean;
};

export type ParsedRule = {
  rule: Rule;
  order: number | undefined;
};

/** Maps a legacy doc id (such as `imported:shared`) to a portable filename stem. */
export function sanitizeDocId(raw: string): string {
  const withoutImported = raw.startsWith("imported:") ? raw.slice("imported:".length) : raw;
  const cleaned = withoutImported
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/-+$/g, "")
    .slice(0, 80);
  return cleaned || "doc";
}

/** Strips at most one blank separator line immediately after a frontmatter block. */
function bodyAfterFrontmatter(rest: string): string {
  if (rest.startsWith("\r\n")) return rest.slice(2);
  if (rest.startsWith("\n")) return rest.slice(1);
  return rest;
}

/** Formats frontmatter + body so every body string round-trips losslessly. */
function formatWithFrontmatter(meta: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(meta, { lineWidth: 0 });
  if (body.length === 0) return `---\n${yaml}---\n`;
  return `---\n${yaml}---\n\n${body}`;
}

/**
 * Parses `instructions/<id>.md`.
 * Plain Markdown without frontmatter works out of the box (`name = id`, `enabled = true`).
 * A leading `---` block is treated as doc metadata only when it parses as a valid
 * YAML mapping containing at least one known doc key (`name`, `enabled`, `order`).
 */
export function parseDocFile(id: string, raw: string): ParsedDoc {
  const match = FRONTMATTER_RE.exec(raw);
  if (match) {
    try {
      const parsed: unknown = parseYaml(match[1]!);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const checked = docMetaSchema.safeParse(parsed);
        const keys = Object.keys(parsed);
        if (checked.success && keys.length > 0) {
          const data = checked.data;
          return {
            id,
            name: data.name ?? id,
            enabled: data.enabled ?? true,
            order: data.order,
            body: bodyAfterFrontmatter(raw.slice(match[0].length)),
            hasFrontmatter: true,
          };
        }
      }
    } catch {
      // Not valid doc YAML frontmatter; treat the whole file as plain Markdown.
    }
  }
  return { id, name: id, enabled: true, order: undefined, body: raw, hasFrontmatter: false };
}

/** Serializes a doc back to `instructions/<id>.md`. */
export function serializeDocFile(doc: {
  id: string;
  name: string;
  enabled: boolean;
  order?: number;
  body: string;
  hasFrontmatter?: boolean;
}): string {
  const needsFrontmatter =
    doc.hasFrontmatter === true || doc.name !== doc.id || !doc.enabled || doc.order !== undefined;
  if (!needsFrontmatter) return doc.body;
  const meta: Record<string, unknown> = { name: doc.name, enabled: doc.enabled };
  if (doc.order !== undefined) meta.order = doc.order;
  return formatWithFrontmatter(meta, doc.body);
}

/**
 * Parses `rules/<id>.md`.
 * Supports optional YAML frontmatter (`name`, `enabled`, `order`, `when`).
 * Returns `{ error }` when frontmatter is invalid or the body exceeds bb's rule cap.
 */
export function parseRuleFile(id: string, raw: string): ParsedRule | { error: string } {
  if (!ITEM_ID_PATTERN.test(id)) return { error: `Invalid rule file id ${JSON.stringify(id)}` };
  const match = FRONTMATTER_RE.exec(raw);
  let name: string = id;
  let enabled = true;
  let order: number | undefined;
  let when: Conditions = { ...ANYWHERE };
  let instructions = raw;

  if (match) {
    let data: unknown;
    try {
      data = parseYaml(match[1]!);
    } catch (error) {
      return {
        error: `Rule ${id}.md has invalid YAML frontmatter: ${(error as Error).message.split("\n")[0]}`,
      };
    }
    if (data !== null && data !== undefined) {
      if (typeof data !== "object" || Array.isArray(data))
        return { error: `Rule ${id}.md frontmatter must be a YAML mapping` };
      const checked = ruleFrontmatterSchema.safeParse(data);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        return {
          error: `Rule ${id}.md frontmatter error (${issue?.path.join(".") || "root"}): ${issue?.message ?? "invalid"}`,
        };
      }
      if (checked.data.name !== undefined) name = checked.data.name;
      if (checked.data.enabled !== undefined) enabled = checked.data.enabled;
      order = checked.data.order;
      if (checked.data.when !== undefined) {
        when = {
          hosts: checked.data.when.hosts ?? [],
          providers: checked.data.when.providers ?? [],
          models: checked.data.when.models ?? [],
          projects: checked.data.when.projects ?? [],
        };
      }
    }
    instructions = bodyAfterFrontmatter(raw.slice(match[0].length));
  }

  if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    return {
      error: `Rule ${id}.md body is ${instructions.length} characters; max is ${MAX_INSTRUCTIONS_LENGTH}`,
    };
  }
  const validated = ruleSchema.safeParse({ id, name, enabled, instructions, when });
  if (!validated.success) {
    const issue = validated.error.issues[0];
    return {
      error: `Rule ${id}.md is invalid (${issue?.path.join(".") || "rule"}): ${issue?.message ?? "invalid"}`,
    };
  }
  return { rule: validated.data, order };
}

/** Serializes a scoped rule into `rules/<rule.id>.md`. */
export function serializeRuleFile(rule: Rule, order?: number): string {
  const meta: Record<string, unknown> = {
    name: rule.name,
    enabled: rule.enabled,
  };
  if (order !== undefined) meta.order = order;
  const when: Record<string, string[]> = {};
  if (rule.when.hosts.length > 0) when.hosts = [...rule.when.hosts];
  if (rule.when.providers.length > 0) when.providers = [...rule.when.providers];
  if (rule.when.models.length > 0) when.models = [...rule.when.models];
  if (rule.when.projects.length > 0) when.projects = [...rule.when.projects];
  if (Object.keys(when).length > 0) meta.when = when;
  return formatWithFrontmatter(meta, rule.instructions);
}

/** Deterministic sort for docs and rules: explicit `order` first, then id. */
export function compareOrdered(
  a: { id: string; order: number | undefined },
  b: { id: string; order: number | undefined },
): number {
  const aOrder = a.order ?? Number.POSITIVE_INFINITY;
  const bOrder = b.order ?? Number.POSITIVE_INFINITY;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
