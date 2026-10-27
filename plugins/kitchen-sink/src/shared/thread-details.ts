import { z } from "zod";

/** The most scripts one project keeps; the card lists every one in its menu. */
export const MAX_PROJECT_SCRIPTS = 20;

/** A shell command the thread details card runs in a terminal at the thread's checkout. */
export const projectScriptSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  command: z.string().trim().min(1).max(4000),
});
export type ProjectScript = z.output<typeof projectScriptSchema>;

export const projectScriptsInputSchema = z.strictObject({ projectId: z.string().min(1).max(200) });
export const projectScriptsOutputSchema = z.strictObject({
  scripts: z.array(projectScriptSchema).max(MAX_PROJECT_SCRIPTS),
});
/** One change to a project's scripts; the server applies it to the stored list. */
export const projectScriptEditSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("upsert"), script: projectScriptSchema }),
  z.strictObject({ kind: z.literal("delete"), scriptId: z.string().min(1).max(64) }),
]);
export type ProjectScriptEdit = z.output<typeof projectScriptEditSchema>;
export const saveProjectScriptInputSchema = z.strictObject({
  projectId: z.string().min(1).max(200),
  edit: projectScriptEditSchema,
});

export function projectScriptsKey(projectId: string): string {
  return `project-scripts:${projectId}`;
}

/** Git work the card hands to the thread's agent; each names a prompt in `instructions/thread-details/`. */
export const AGENT_GIT_ACTIONS = ["push-and-create-pr", "commit", "push", "update-pr"] as const;
export type AgentGitAction = (typeof AGENT_GIT_ACTIONS)[number];
export const askAgentInputSchema = z.strictObject({
  threadId: z.string().min(1).max(200),
  action: z.enum(AGENT_GIT_ACTIONS),
});
export const askAgentOutputSchema = z.strictObject({ ok: z.literal(true) });
