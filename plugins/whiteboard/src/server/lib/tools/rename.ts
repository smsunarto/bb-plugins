import type { JsonValue } from "../../../shared/vendor/json/src/index.ts";
import { authoringTools } from "../vendor/review/src/review-api/authoring-tools.ts";

/**
 * The one session-tool rename, applied at the agent boundary (design §3.5).
 * Upstream `publicTool` already turned `review_x` into `session_x`; bb names
 * the same tools `whiteboard_session_x`. Result text is never renamed here:
 * the few upstream literals that name a tool are renamed at their source by
 * the vendoring tool's `rename` rows.
 */

/**
 * The catalog's `session_x` suffixes, longest first, read from the upstream
 * catalog itself so a new upstream tool is renamed without an edit here.
 * Scratchpad and trace flags change descriptions only, never names.
 */
export const SESSION_TOOL_SUFFIXES: readonly string[] = authoringTools()
  .map((tool) => tool.name)
  .filter((name) => name.startsWith("review_"))
  .map((name) => name.slice("review_".length))
  .sort((a, b) => b.length - a.length || a.localeCompare(b));

const TOKEN = new RegExp(`(?<!whiteboard_)\\bsession_(${SESSION_TOOL_SUFFIXES.join("|")})\\b`, "g");

/** `session_x` → `whiteboard_session_x`. `whiteboard_status` is unchanged. */
export function bbToolName(name: string): string {
  return name.replace(/^session_/, "whiteboard_session_");
}

/** Rewrite catalog `session_x` tokens not already prefixed. Idempotent. */
export function renameToolTokens(text: string): string {
  return text.replace(TOKEN, "whiteboard_session_$1");
}

/** Keys whose values are data, not prose (upstream `translateSchemaDescriptions`). */
const DATA_KEYS = new Set(["examples", "default", "const", "enum"]);

/** `renameToolTokens` over schema `description` keys, skipping examples/default/const/enum. */
export function renameSchemaDescriptions<T extends JsonValue>(schema: T): T {
  if (Array.isArray(schema)) return schema.map((item) => renameSchemaDescriptions(item)) as T;
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description" && typeof value === "string") out[key] = renameToolTokens(value);
    else if (DATA_KEYS.has(key)) out[key] = value;
    else out[key] = renameSchemaDescriptions(value);
  }
  return out as T;
}
