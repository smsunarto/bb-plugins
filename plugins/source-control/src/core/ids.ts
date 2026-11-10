/**
 * Identity of a Change. A `ChangeKey` is derived from facts any reader can
 * see, never minted, so one branch is one Change on every host that has it
 * checked out, before and after its pull request exists.
 *
 * - `gh:<owner>/<repo>:<headOwner>:<branch>` for a branch of a GitHub repository.
 * - `local:<hostId>:<commonDir>:<branch>` for a repository with no GitHub remote,
 *   which only one checkout can know.
 */
import { z } from "zod";

export const changeKeySchema = z.string().min(1).max(2048).brand<"ChangeKey">();
export type ChangeKey = z.infer<typeof changeKeySchema>;

/** A GitHub repository, folded to lower case: GitHub ignores case in owner and name. */
export const repoSchema = z.object({ owner: z.string().min(1), name: z.string().min(1) }).strict();
export type Repo = z.infer<typeof repoSchema>;

/**
 * A remote URL as host and path, so every spelling of one repository compares
 * equal: `git@github.com:o/r.git`, `https://github.com/o/r`, and
 * `ssh://git@github.com/o/r` are all `github.com/o/r`. A port other than the
 * scheme's own stays, since it can be another server. A hosted path is folded
 * to lower case, since GitHub and GitLab ignore case in it. A local path is a
 * file path, so it keeps its case.
 *
 * Ported from `plugins/gitbutler/src/host/origin.ts`.
 */
export function normalizeOrigin(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;
  const local = trimmed.replace(/\/+$/, "").replace(/\.git$/i, "");
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return trimmed;
    }
    // URL drops 80 and 443 for http(s) itself. ssh is not a scheme it knows.
    const port = parsed.port === "" || parsed.port === "22" ? "" : `:${parsed.port}`;
    host = `${parsed.hostname}${port}`;
    path = parsed.pathname;
  } else {
    // scp-like syntax: `[user@]host:path`. A colon after the first slash is
    // part of a local path instead.
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
    if (!scp) return local;
    host = scp[1]!;
    path = scp[2]!;
  }
  if (host === "") return local;
  const repository = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return `${host}/${repository}`.toLowerCase();
}

/** The GitHub repository a remote URL names, or null for any other remote. */
export function githubRepo(url: string | null): Repo | null {
  const origin = url === null ? null : normalizeOrigin(url);
  const match = origin === null ? null : /^github\.com\/([^/]+)\/([^/]+)$/.exec(origin);
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

/**
 * Where a checkout's branch lives on GitHub: the repository pull requests
 * target, and the owner whose copy holds the branch. A fork checkout names
 * the original as `upstream` and the fork as `origin`; otherwise both are `origin`.
 */
export type GitHubHome = { repo: Repo; headOwner: string };

export function githubHome(remotes: {
  origin: string | null;
  upstream: string | null;
}): GitHubHome | null {
  const origin = githubRepo(remotes.origin);
  const upstream = githubRepo(remotes.upstream);
  if (origin && upstream) return { repo: upstream, headOwner: origin.owner };
  if (origin) return { repo: origin, headOwner: origin.owner };
  return null;
}

export function changeKeyOf(
  checkout: { hostId: string; commonDir: string; branch: string },
  home: GitHubHome | null,
): ChangeKey {
  const raw = home
    ? `gh:${home.repo.owner}/${home.repo.name}:${home.headOwner.toLowerCase()}:${checkout.branch}`
    : `local:${checkout.hostId}:${checkout.commonDir}:${checkout.branch}`;
  return changeKeySchema.parse(raw);
}

export function threadTag(threadId: string): string {
  return `thread:${threadId}`;
}

export function changeTag(key: ChangeKey): string {
  return `change:${key}`;
}
