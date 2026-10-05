import { z } from "zod";

/**
 * "Add to chat" in bb: the copy-context route (http.ts) answers this beside
 * upstream's clipboard text, and the panel (agent-handoff.ts) puts `quote` in
 * the composer with a pill for the session. The pill's item id is the only
 * thing that reaches the server again, at send (session-mention.ts).
 */
export const selectionHandoff = z.object({
  /** The selection alone, without upstream's agent preamble. */
  quote: z.string().min(1),
  sessionId: z.string().min(1),
  /** The displayed version, so the agent reads what the user quoted. */
  version: z.number().int().nonnegative(),
  /** The displayed version's title: the pill's label. */
  title: z.string(),
});
export type SelectionHandoff = z.infer<typeof selectionHandoff>;

export const SESSION_MENTION_PROVIDER = "session";

type SessionVersion = Pick<SelectionHandoff, "sessionId" | "version">;

export function sessionMentionId({ sessionId, version }: SessionVersion): string {
  return `${sessionId}@${version}`;
}

export function parseSessionMentionId(id: string): SessionVersion | undefined {
  const match = /^([^@]+)@(\d+)$/.exec(id);
  return match ? { sessionId: match[1]!, version: Number(match[2]) } : undefined;
}
