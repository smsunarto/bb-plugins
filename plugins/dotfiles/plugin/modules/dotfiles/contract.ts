import { z } from "zod";

export const taskIds = [
  "render",
  "check",
  "check:location",
  "check:mise",
  "check:shell",
  "check:mcp",
  "check:python",
  "check:skills",
  "check:dotfiles",
  "check:safety",
  "check:secrets",
  "apply:dry",
  "sync:pull",
] as const;

export const taskIdSchema = z.enum(taskIds);

export const tweakableFileSchema = z.object({
  path: z.string(),
  title: z.string(),
  note: z.string().optional(),
  render: z.boolean().optional(),
  exists: z.boolean(),
  dirty: z.boolean(),
}).strict();

export const tweakableGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  files: z.array(tweakableFileSchema),
}).strict();

export const gitEntrySchema = z.object({
  status: z.string(),
  path: z.string(),
}).strict();

export const overviewOutputSchema = z.object({
  repoPath: z.string(),
  repoExists: z.boolean(),
  branch: z.string(),
  groups: z.array(tweakableGroupSchema),
  gitEntries: z.array(gitEntrySchema),
}).strict();

export const readFileInputSchema = z.object({ path: z.string() }).strict();
export const readFileOutputSchema = z.object({
  content: z.string(),
  sha256: z.string(),
  headContent: z.string().nullable(),
}).strict();

export const saveFileInputSchema = z.object({
  path: z.string(),
  content: z.string(),
  expectedSha256: z.string(),
}).strict();
export const saveFileOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("written"),
    sha256: z.string(),
    renderHint: z.boolean(),
  }).strict(),
  z.object({ outcome: z.literal("conflict") }).strict(),
]);

export const runTaskInputSchema = z.object({ task: taskIdSchema }).strict();
export const taskResultSchema = z.object({
  exitCode: z.number().int(),
  output: z.string(),
}).strict();

export const removeSkillInputSchema = z.object({ name: z.string() }).strict();
export const removeSkillOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("completed"),
    exitCode: z.number().int(),
    output: z.string(),
  }).strict(),
  z.object({ outcome: z.literal("not-found") }).strict(),
]);

export type GitEntry = z.infer<typeof gitEntrySchema>;
export type Overview = z.infer<typeof overviewOutputSchema>;
export type ReadFileResult = z.infer<typeof readFileOutputSchema>;
export type RemoveSkillResult = z.infer<typeof removeSkillOutputSchema>;
export type SaveFileResult = z.infer<typeof saveFileOutputSchema>;
export type TaskId = z.infer<typeof taskIdSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type TweakableFile = z.infer<typeof tweakableFileSchema>;
export type TweakableGroup = z.infer<typeof tweakableGroupSchema>;
