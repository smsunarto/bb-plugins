/**
 * Work an agent names by where it is: `::source-control{path branch}`, for a
 * checkout or branch other than the one bb placed its thread on. The path is
 * read on the thread's own host, so the card needs no list of checkouts and
 * asks no other host.
 */
import { z } from "zod";
import { threadChangeSchema } from "./change.ts";

export type CheckoutTarget = {
  threadId: string;
  /** Null for the thread's own checkout. */
  path: string | null;
  /** Null for the branch the checkout has checked out. */
  branch: string | null;
};

/** An absolute POSIX path: the checkout hosts are macOS and Linux. */
const PATH = /^\/[^\0\r\n]{0,1023}$/;
/** A branch name git accepts, without spaces or the characters refs forbid. */
const BRANCH = /^(?![-/.])[^\s~^:?*[\\\0]{1,255}$/;

export const checkoutWorkKeySchema = z.string().min(1).max(1600);

export const checkoutWorkTag = (key: string) => `checkout-work:${key}`;

export const checkoutWorkKey = ({ threadId, path, branch }: CheckoutTarget): string =>
  JSON.stringify([threadId, path, branch]);

export function parseCheckoutWorkKey(key: string): CheckoutTarget | null {
  let value: unknown;
  try {
    value = JSON.parse(key);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [threadId, path, branch] = value as unknown[];
  if (typeof threadId !== "string" || threadId === "") return null;
  if (path !== null && (typeof path !== "string" || !PATH.test(path))) return null;
  if (branch !== null && (typeof branch !== "string" || !BRANCH.test(branch))) return null;
  if (path === null && branch === null) return null;
  return { threadId, path, branch };
}

/**
 * The checkout and branch a hand-written directive names, from its untrusted
 * attributes: null when it names neither, a problem when one is unreadable.
 */
export function checkoutAttributes(
  attributes: Readonly<Record<string, string>>,
): { path: string | null; branch: string | null } | { problem: string } | null {
  const { path, branch } = attributes;
  if (path === undefined && branch === undefined) return null;
  const trimmed = path === undefined ? null : path.trim().replace(/(?!^)\/+$/, "");
  if (trimmed !== null && !PATH.test(trimmed))
    return { problem: "Name the checkout by its absolute path, such as /home/me/git/repo." };
  if (branch !== undefined && !BRANCH.test(branch.trim()))
    return { problem: "This is not a branch name bb can read." };
  return { path: trimmed, branch: branch === undefined ? null : branch.trim() };
}

/** The directive that shows a checkout's work, as the ship prompt hands it back to the agent. */
export function checkoutDirective({ path, branch }: Omit<CheckoutTarget, "threadId">): string {
  const attributes = [path ? `path="${path}"` : "", branch ? `branch="${branch}"` : ""];
  const body = attributes.filter(Boolean).join(" ");
  return body ? `::source-control{${body}}` : "::source-control";
}

/**
 * What the card draws: the named branch as a thread's row is shaped, and
 * whether its Change can be opened for review (a checkout bb lists has it, or
 * it has a pull request). Work that is neither shows as a branch to ship.
 */
export const checkoutWorkSchema = z
  .object({ row: threadChangeSchema, reviewable: z.boolean() })
  .strict();
export type CheckoutWork = z.infer<typeof checkoutWorkSchema>;
