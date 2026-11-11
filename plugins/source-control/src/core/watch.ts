/**
 * Pull requests a thread watches, and the work a thread landed. Shapes and
 * pure rules shared by the server (which keeps watches and checks what
 * landed), a host (which may read GitHub for them) and the app (which draws
 * the landed card). Ported from `plugins/code-review/src/shared/{schema,landed}.ts`.
 */
import { z } from "zod";

const NAME = "[A-Za-z0-9_.-]+";
const SHA = "[0-9a-fA-F]{7,64}";
const PR_KEY = new RegExp(`^(${NAME})/(${NAME})#(\\d+)$`);
const PR_URL = new RegExp(
  `^(?:https?://)?(?:www\\.)?github\\.com/(${NAME})/(${NAME})/pull/(\\d+)(?:[/?#].*)?$`,
);
const COMMIT_KEY = new RegExp(`^(${NAME})/(${NAME})@(${SHA})$`);
const COMMIT_URL = new RegExp(
  `^(?:https?://)?(?:www\\.)?github\\.com/(${NAME})/(${NAME})/commit/(${SHA})(?:[/?#].*)?$`,
);

/** Enterprise Managed Users add `_<shortcode>`, e.g. `mona-cat_octo`. Never a leading dash. */
export const loginSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, "Not a GitHub login.");

export const prRefSchema = z
  .object({
    owner: z.string().regex(new RegExp(`^${NAME}$`)),
    repo: z.string().regex(new RegExp(`^${NAME}$`)),
    number: z.number().int().positive(),
  })
  .strict();
export type PrRef = z.infer<typeof prRefSchema>;

export const commitRefSchema = z
  .object({
    owner: z.string().regex(new RegExp(`^${NAME}$`)),
    repo: z.string().regex(new RegExp(`^${NAME}$`)),
    sha: z.string().regex(/^[0-9a-f]{7,64}$/),
  })
  .strict();
export type CommitRef = z.infer<typeof commitRefSchema>;

/** `owner/repo#123`. */
export const prKey = (ref: PrRef) => `${ref.owner}/${ref.repo}#${ref.number}`;
/** `owner/repo@sha`. */
export const commitKey = (ref: CommitRef) => `${ref.owner}/${ref.repo}@${ref.sha}`;

/** One pull request, whatever the case of its owner and repository. */
export const sameRef = (a: PrRef, b: PrRef) => prKey(a).toLowerCase() === prKey(b).toLowerCase();

/** One commit in one repository, by a full SHA or either one's abbreviation. */
export function sameCommit(a: CommitRef, b: CommitRef): boolean {
  return (
    `${a.owner}/${a.repo}`.toLowerCase() === `${b.owner}/${b.repo}`.toLowerCase() &&
    (a.sha.startsWith(b.sha) || b.sha.startsWith(a.sha))
  );
}

/** Reads `owner/repo#123` or a github.com pull request URL. Null for anything else. */
export function parsePrReference(text: string): PrRef | null {
  const trimmed = text.trim();
  const match = PR_KEY.exec(trimmed) ?? PR_URL.exec(trimmed);
  if (!match) return null;
  const number = Number(match[3]);
  return Number.isSafeInteger(number) && number > 0
    ? { owner: match[1]!, repo: match[2]!, number }
    : null;
}

/** Reads `owner/repo@sha` or a github.com commit URL. Null for anything else. */
export function parseCommitReference(text: string): CommitRef | null {
  const trimmed = text.trim();
  const match = COMMIT_KEY.exec(trimmed) ?? COMMIT_URL.exec(trimmed);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, sha: match[3]!.toLowerCase() };
}

export const prStateSchema = z.enum(["open", "merged", "closed"]);
export type PrState = z.infer<typeof prStateSchema>;

export const watchCheckSchema = z
  .object({
    /** `run:<databaseId>` for a check run, `status:<context>` for a commit status. */
    id: z.string(),
    name: z.string(),
    state: z.enum(["success", "failure", "pending", "neutral", "skipped", "cancelled"]),
    detailsUrl: z.string().nullable(),
  })
  .strict();
export type WatchCheck = z.infer<typeof watchCheckSchema>;

export const watchChecksSchema = z
  .object({ headRefOid: z.string(), checks: z.array(watchCheckSchema).max(300) })
  .strict();
export type WatchChecks = z.infer<typeof watchChecksSchema>;

/** One read of a watched pull request. `activity` holds only what others said. */
export const watchReadSchema = z
  .object({
    url: z.string(),
    title: z.string(),
    state: prStateSchema,
    baseRefName: z.string(),
    mergeState: z.string().nullable(),
    checks: watchChecksSchema,
    activity: z.array(z.object({ id: z.string(), line: z.string() }).strict()).max(500),
    /** When GitHub's rate limit runs low, when it resets. */
    pausedUntil: z.number().nullable(),
  })
  .strict();
export type WatchRead = z.infer<typeof watchReadSchema>;

export const checksRunning = (checks: WatchChecks) =>
  checks.checks.some((check) => check.state === "pending");

/** The branch a pull request comes from. */
export const prHeadSchema = z
  .object({ branch: z.string().min(1), head: z.string(), headOwner: z.string().min(1) })
  .strict();
export type PrHead = z.infer<typeof prHeadSchema>;

/** Pull requests and commits one landed card lists, each, across all repositories. */
export const MAX_LANDED = 25;

export const landedTargetSchema = z
  .object({
    account: loginSchema,
    prs: z.array(prRefSchema).max(MAX_LANDED),
    commits: z.array(commitRefSchema).max(MAX_LANDED),
  })
  .strict();
export type LandedTarget = z.infer<typeof landedTargetSchema>;

export const landedSchema = z
  .object({
    prs: z.array(
      z
        .object({ ref: prRefSchema, title: z.string(), url: z.string(), state: prStateSchema })
        .strict(),
    ),
    commits: z.array(
      z
        .object({
          /** The full SHA when GitHub resolved it. */
          ref: commitRefSchema,
          /** The repository's default branch. */
          branch: z.string(),
          landed: z.boolean(),
          headline: z.string().nullable(),
          url: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
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

/** Whether a later read can differ: merged and closed pull requests are final. */
export const canStillLand = (landed: Landed) =>
  landed.prs.some((pr) => pr.state === "open") || landed.commits.some((commit) => !commit.landed);

/** The thread title with 🚀 in front while `launched`, and without it otherwise. */
export function launchTitle(title: string, launched: boolean): string {
  const bare = title.replace(/^(?:🚀\s*)+/u, "");
  return launched ? `🚀 ${bare}` : bare;
}

/** The landed card's directive name; `code-review-landed` is the same card from before the cutover. */
export const LANDED_DIRECTIVE = "source-control-landed";
export const LEGACY_LANDED_DIRECTIVE = "code-review-landed";

/** The card's directive. Every value is a validated key, so none needs escaping. */
export function landedDirective({ account, prs, commits }: LandedTarget): string {
  const attributes = [
    prs.length ? `prs="${prs.map(prKey).join(" ")}"` : "",
    commits.length ? `commits="${commits.map(commitKey).join(" ")}"` : "",
    `account="${account}"`,
  ];
  return `::${LANDED_DIRECTIVE}{${attributes.filter(Boolean).join(" ")}}`;
}

const list = <T>(parse: (text: string) => T | null, exact: RegExp) =>
  z
    .string()
    .optional()
    .transform((value, context) => {
      const refs = (value?.split(/\s+/).filter(Boolean) ?? []).map((word) =>
        exact.test(word) ? parse(word) : null,
      );
      if (refs.some((ref) => ref === null) || refs.length > MAX_LANDED) {
        context.addIssue({ code: "custom", message: "Not a list of references." });
        return z.NEVER;
      }
      return refs as T[];
    });

const landedAttributesSchema = z
  .object({
    account: loginSchema,
    prs: list(parsePrReference, PR_KEY),
    commits: list(parseCommitReference, COMMIT_KEY),
  })
  .strict()
  .refine(({ prs, commits }) => prs.length + commits.length > 0);

/** The landed card's target from its directive's untrusted attributes, or null. */
export function parseLandedAttributes(
  attributes: Readonly<Record<string, string>>,
): LandedTarget | null {
  const parsed = landedAttributesSchema.safeParse(attributes);
  return parsed.success ? parsed.data : null;
}
