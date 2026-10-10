import { runGit } from "./cli.ts";

/**
 * A remote URL as host and path, so every spelling of one repository compares
 * equal: `git@github.com:o/r.git`, `https://github.com/o/r`, and
 * `ssh://git@github.com/o/r` are all `github.com/o/r`. A port other than the
 * scheme's own stays, since it can be another server. A hosted path is folded
 * to lower case, since GitHub and GitLab ignore case in it. A local path is a
 * file path, so it keeps its case.
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

/** The repository's `origin`, normalized, or null when it has none. */
export async function readOrigin(
  repositoryPath: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const url = await runGit(repositoryPath, ["config", "--get", "remote.origin.url"], signal);
    return normalizeOrigin(url);
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}
