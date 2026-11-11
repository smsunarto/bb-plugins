/**
 * Fix checks: the reader picks failing checks on a pull request's head, and
 * a new thread is composed with the end of each one's log to fix them.
 */
import { z } from "zod";
import type { CheckRow } from "./change.ts";

/** Checks one Fix takes at a time: the prompt has to stay readable. */
export const MAX_FIX_CHECKS = 10;
/** Logs read per prompt: each is a GitHub request, and three failures say enough. */
export const MAX_LOGS = 3;
/** A tail's cap in characters: sixty lines can still be long ones. */
export const LOG_CHARS = 20_000;
/** Why a log is missing, capped: GitHub's error text is not ours to size. */
export const MISSING_CHARS = 500;

/** A check's id on one head: its workflow and name, which the checks facet keys rows by. */
export const checkId = (check: Pick<CheckRow, "workflow" | "name">) =>
  `${check.workflow ?? ""}:${check.name}`;

/** `build`, `build and lint`, `build, lint, and 2 more`. */
export function checkNames(checks: readonly Pick<CheckRow, "name">[]): string {
  const names = checks.map((check) => check.name);
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]}`;
  return `${names[0]}, ${names[1]}, and ${names.length - 2} more`;
}

/**
 * The new-thread composer's request, passed through. bb validates it in
 * full when the thread is spawned; this only checks it is one.
 */
export const newThreadRequestSchema = z.looseObject({
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  environment: z.looseObject({ type: z.string() }),
  input: z.array(z.unknown()),
});
export type NewThreadRequestInput = z.infer<typeof newThreadRequestSchema>;
