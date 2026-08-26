/**
 * GitHub identity that can be read without the GitHub API: a git remote, or a
 * `owner/repo#123` / `#123` mention in a thread title.
 */

export interface GithubRepo {
  owner: string;
  repo: string;
}

export interface ParsedPrRef {
  owner: string | null;
  repo: string | null;
  number: number;
}

const GITHUB_REMOTE = /(?:github\.com[:/]|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
const TITLE_OWNER_REPO_PR = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/;
const TITLE_BARE_PR = /(?:\bPR\s*|#)(\d+)\b/i;

export function parseGithubRemote(url: string): GithubRepo | null {
  const match = url.trim().match(GITHUB_REMOTE);
  if (match === null) return null;
  const owner = match[1];
  const repo = match[2]?.replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function parsePrRefFromTitle(title: string): ParsedPrRef | null {
  const named = title.match(TITLE_OWNER_REPO_PR);
  if (named !== null) {
    const number = Number(named[3]);
    if (!Number.isInteger(number) || number < 1) return null;
    return { owner: named[1] ?? null, repo: named[2] ?? null, number };
  }
  const bare = title.match(TITLE_BARE_PR);
  if (bare === null) return null;
  const number = Number(bare[1]);
  if (!Number.isInteger(number) || number < 1) return null;
  return { owner: null, repo: null, number };
}

export function githubPullUrl(owner: string, repo: string, number: number): string {
  return `https://github.com/${owner}/${repo}/pull/${number}`;
}
