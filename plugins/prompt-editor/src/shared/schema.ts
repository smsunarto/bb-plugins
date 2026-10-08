import { z } from "zod";

/**
 * What a file means to the agent, from its place in the plugin:
 *
 *   instructions/tools/<tool>.md               tool description
 *   instructions/tools/<tool>.instructions.md  tool thread snippet
 *   instructions/**.md                         thread instructions and prompts
 *   skills/**.md                               skill text
 */
export const fileKindSchema = z.enum(["tool-description", "tool-instructions", "prompt", "skill"]);
export type FileKind = z.infer<typeof fileKindSchema>;

export const agentFileSchema = z.object({
  /** Relative to the plugin root, with `/` separators. */
  path: z.string(),
  kind: fileKindSchema,
  /** The public tool name, for the two tool kinds. */
  tool: z.string().nullable(),
  chars: z.number(),
});
export type AgentFile = z.infer<typeof agentFileSchema>;

export const toolSchema = z.object({
  name: z.string(),
  /** The description the agent sees right now, from bb. */
  live: z.string().nullable(),
  /** `instructions/tools/<name>.md`, or null when the text lives in code. */
  file: z.string().nullable(),
  /** The file differs from the live text: the plugin has not reloaded since the edit. */
  drift: z.boolean(),
});
export type Tool = z.infer<typeof toolSchema>;

export const pluginSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  /** Null when editable; otherwise why the files are read-only. */
  readOnly: z.string().nullable(),
  tools: z.array(toolSchema),
  files: z.array(agentFileSchema),
});
export type Plugin = z.infer<typeof pluginSchema>;

export const pluginsSchema = z.object({ plugins: z.array(pluginSchema) });

export const fileRefSchema = z.object({ pluginId: z.string().min(1), path: z.string().min(1) });
export type FileRef = z.infer<typeof fileRefSchema>;

export const fileSchema = z.object({
  content: z.string(),
  /** `{{key}}` names the plugin's code fills; a save must keep the same set. */
  placeholders: z.array(z.string()),
  /** The snippet cap for tool thread snippets, null for other kinds. */
  maxChars: z.number().nullable(),
});
export type FileContent = z.infer<typeof fileSchema>;

export const saveSchema = fileRefSchema.extend({
  /** The content the editor loaded; the save fails if the file changed since. */
  previous: z.string(),
  content: z.string(),
});
export type SaveInput = z.infer<typeof saveSchema>;

export const saveResultSchema = z.object({
  /** The file as written, the base for the next save. */
  content: z.string(),
  /** Null when the plugin reloaded; otherwise why it did not. */
  reloadError: z.string().nullable(),
});
export type SaveResult = z.infer<typeof saveResultSchema>;
