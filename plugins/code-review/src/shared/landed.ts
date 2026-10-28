import { z } from "zod";
import {
  type Account,
  type PrRef,
  accountSchema,
  parsePrReference,
  prKey,
  prRefSchema,
  prStateSchema,
} from "./schema.ts";

/*
 * Work a thread landed: pull requests that merged, and commits on their
 * repository's default branch. The agent lists them once something lands;
 * the `::code-review-landed` card shows them with a button that settles
 * (archives) the thread, and the thread's title starts with 🚀 while
 * everything it lists has landed.
 */

export const LANDED_DIRECTIVE = "code-review-landed";
/** Pull requests and commits one card lists, each. */
export const MAX_LANDED = 10;

const NAME = "[A-Za-z0-9_.-]+";
const SHA = "[0-9a-fA-F]{7,64}";
const COMMIT_KEY = new RegExp(`^(${NAME})/(${NAME})@(${SHA})$`);
const COMMIT_URL = new RegExp(
  `^(?:https?://)?(?:www\\.)?github\\.com/(${NAME})/(${NAME})/commit/(${SHA})(?:[/?#].*)?$`,
);

export const commitRefSchema = z.strictObject({
  owner: z.string().regex(new RegExp(`^${NAME}$`)),
  repo: z.string().regex(new RegExp(`^${NAME}$`)),
  sha: z.string().regex(/^[0-9a-f]{7,64}$/),
});
export type CommitRef = z.infer<typeof commitRefSchema>;

/** `owner/repo@sha`. */
export function commitKey(ref: CommitRef): string {
  return `${ref.owner}/${ref.repo}@${ref.sha}`;
}

/** One commit in one repository, by a full SHA or either one's abbreviation. Owners and repositories ignore case. */
export function sameCommit(a: CommitRef, b: CommitRef): boolean {
  return (
    `${a.owner}/${a.repo}`.toLowerCase() === `${b.owner}/${b.repo}`.toLowerCase() &&
    (a.sha.startsWith(b.sha) || b.sha.startsWith(a.sha))
  );
}

/** Reads `owner/repo@sha` or a github.com commit URL. Null for anything else. */
export function parseCommitReference(text: string): CommitRef | null {
  const trimmed = text.trim();
  const match = COMMIT_KEY.exec(trimmed) ?? COMMIT_URL.exec(trimmed);
  if (!match) return null;
  const [, owner, repo, sha] = match;
  if (!owner || !repo || !sha) return null;
  return { owner, repo, sha: sha.toLowerCase() };
}

export const landedTargetSchema = z.strictObject({
  account: accountSchema,
  prs: z.array(prRefSchema).max(MAX_LANDED),
  commits: z.array(commitRefSchema).max(MAX_LANDED),
});
export type LandedTarget = z.infer<typeof landedTargetSchema>;

export const landedPrSchema = z.object({
  ref: prRefSchema,
  title: z.string(),
  url: z.string(),
  state: prStateSchema,
});
export type LandedPr = z.infer<typeof landedPrSchema>;

export const landedCommitSchema = z.object({
  /** The full SHA when GitHub resolved it. */
  ref: commitRefSchema,
  /** The repository's default branch. */
  branch: z.string(),
  /** On `branch`. */
  landed: z.boolean(),
  headline: z.string().nullable(),
  url: z.string(),
});
export type LandedCommit = z.infer<typeof landedCommitSchema>;

export const landedSchema = z.object({
  prs: z.array(landedPrSchema),
  commits: z.array(landedCommitSchema),
});
export type Landed = z.infer<typeof landedSchema>;

/** What has not landed yet, one line each. Empty when everything listed has. */
export function notLanded(landed: Landed): string[] {
  return [
    ...landed.prs
      .filter((pr) => pr.state !== "merged")
      .map((pr) => `${prKey(pr.ref)} (${pr.state === "open" ? "open" : "closed without merging"})`),
    ...landed.commits
      .filter((commit) => !commit.landed)
      .map((commit) => `${commitKey(commit.ref)} (not on ${commit.branch})`),
  ];
}

/**
 * Whether a later read can differ: a pull request is still open or a commit
 * has not reached its branch yet. Merged and closed pull requests are final.
 */
export function canStillLand(landed: Landed): boolean {
  return (
    landed.prs.some((pr) => pr.state === "open") || landed.commits.some((commit) => !commit.landed)
  );
}

/** The card's directive. Every value is a validated key, so none needs escaping. */
export function landedDirective({ account, prs, commits }: LandedTarget): string {
  const attributes = [
    prs.length ? `prs="${prs.map(prKey).join(" ")}"` : "",
    commits.length ? `commits="${commits.map(commitKey).join(" ")}"` : "",
    `account="${account}"`,
  ];
  return `::${LANDED_DIRECTIVE}{${attributes.filter(Boolean).join(" ")}}`;
}

const list = <T>(parse: (text: string) => T | null) =>
  z
    .string()
    .optional()
    .transform((value, context) => {
      const words = value?.split(/\s+/).filter(Boolean) ?? [];
      const refs = words.map(parse);
      if (refs.some((ref) => ref === null) || refs.length > MAX_LANDED) {
        context.addIssue({ code: "custom", message: "Not a list of references." });
        return z.NEVER;
      }
      return refs as T[];
    });

const attributesSchema = z
  .strictObject({
    account: accountSchema,
    prs: list<PrRef>((text) => (/^[^/]+\/[^#]+#\d+$/.test(text) ? parsePrReference(text) : null)),
    commits: list<CommitRef>((text) => (COMMIT_KEY.test(text) ? parseCommitReference(text) : null)),
  })
  .refine(({ prs, commits }) => prs.length + commits.length > 0);

/** The card's target from its directive's untrusted attributes, or null. */
export function parseLandedAttributes(attributes: Readonly<Record<string, string>>): {
  account: Account;
  prs: PrRef[];
  commits: CommitRef[];
} | null {
  const parsed = attributesSchema.safeParse(attributes);
  return parsed.success ? parsed.data : null;
}

/** The thread title with 🚀 in front while `launched`, and without it otherwise. */
export function launchTitle(title: string, launched: boolean): string {
  const bare = title.replace(/^(?:🚀\s*)+/u, "");
  return launched ? `🚀 ${bare}` : bare;
}
