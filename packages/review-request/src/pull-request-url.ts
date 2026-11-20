/**
 * The links Source Control opens in Review: a pull request's own page on
 * GitHub. Shared by Source Control (its `parsePrLink`, server and app) and
 * the plugins that ask it for a Review, so they agree on which links those
 * are. Free of the DOM, so Source Control's core may import it.
 */

const NAME = "[A-Za-z0-9_.-]+";
const PULL_REQUEST_URL = new RegExp(
  `^https://(?:www\\.)?github\\.com/(${NAME})/(${NAME})/pull/(\\d+)/?$`,
);

/** A pull request a link names: its repository and number. */
export type PullRequestUrl = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
};

/**
 * The pull request a link to its own page names, the links Source Control
 * opens in Review; null for anything else, such as a file or comment deep
 * link. Source Control's `parsePrLink` is this grammar.
 */
export function parsePullRequestUrl(url: string): PullRequestUrl | null {
  const match = PULL_REQUEST_URL.exec(url.trim());
  if (!match) return null;
  const number = Number(match[3]);
  return Number.isSafeInteger(number) && number > 0
    ? { owner: match[1]!, repo: match[2]!, number }
    : null;
}

/** `owner/repo#number` for a link to a pull request's own page; null for any other link. */
export function pullRequestUrlKey(url: string): string | null {
  const ref = parsePullRequestUrl(url);
  return ref ? `${ref.owner}/${ref.repo}#${ref.number}` : null;
}
