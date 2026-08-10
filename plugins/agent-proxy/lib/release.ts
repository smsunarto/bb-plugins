// Pure helpers for resolving the CLIProxyAPI fork source. No IO here — the
// install pipeline injects fetch.

export const CORE_REPO = "smsunarto/CLIProxyAPI";
export const CORE_REF = "fix/claude-advisor-server-tool";

export interface CoreSource {
  repo: string;
  ref: string;
}

export const DEFAULT_CORE_SOURCE: CoreSource = {
  repo: CORE_REPO,
  ref: CORE_REF,
};
const INVALID_REF_CHARACTERS = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

export interface SourceRevision {
  repo: string;
  ref: string;
  commit: string;
  version: string;
  archiveUrl: string;
}

export function normalizeCoreRepo(value: string): string {
  let candidate = value.trim();
  const ssh = candidate.match(/^git@github\.com:(.+)$/i);
  if (ssh) candidate = ssh[1]!;
  else if (/^https?:\/\//i.test(candidate)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error("repository must be a GitHub owner/name or URL");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("repository URL must be an HTTPS github.com URL without credentials or query data");
    }
    candidate = url.pathname;
  }

  candidate = candidate.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const parts = candidate.split("/");
  const owner = parts[0] ?? "";
  const repo = parts[1] ?? "";
  const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
  const repoPattern = /^[A-Za-z0-9._-]{1,100}$/;
  if (
    parts.length !== 2 ||
    !ownerPattern.test(owner) ||
    !repoPattern.test(repo) ||
    repo === "." ||
    repo === ".."
  ) {
    throw new Error("repository must be a GitHub owner/name");
  }
  return `${owner}/${repo}`;
}

export function normalizeCoreRef(value: string): string {
  const ref = value.trim();
  const hasInvalidCharacter = Array.from(ref).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x20 || codePoint === 0x7f || INVALID_REF_CHARACTERS.has(character);
  });
  if (ref.length === 0 || ref.length > 255) {
    throw new Error("branch or ref must contain 1 to 255 characters");
  }
  if (
    ref === "@" ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("//") ||
    hasInvalidCharacter ||
    ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error("branch or ref is not a valid Git ref");
  }
  return ref;
}

export function normalizeCoreSource(repo: string, ref: string): CoreSource {
  return { repo: normalizeCoreRepo(repo), ref: normalizeCoreRef(ref) };
}

export function commitApiUrl(source: CoreSource = DEFAULT_CORE_SOURCE): string {
  return `https://api.github.com/repos/${source.repo}/commits/${encodeURIComponent(source.ref)}`;
}

export function sourceArchiveUrl(repo: string, commit: string): string {
  return `https://codeload.github.com/${repo}/tar.gz/${commit}`;
}

export function sourceVersion(ref: string, commit: string): string {
  return `${ref}@${commit.slice(0, 12)}`;
}

export function parseSourceRevision(
  json: unknown,
  source: CoreSource = DEFAULT_CORE_SOURCE,
): SourceRevision {
  if (typeof json !== "object" || json === null) {
    throw new Error("malformed GitHub commit response");
  }
  const commit = (json as Record<string, unknown>).sha;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("GitHub commit response has no valid sha");
  }
  const normalizedCommit = commit.toLowerCase();
  return {
    repo: source.repo,
    ref: source.ref,
    commit: normalizedCommit,
    version: sourceVersion(source.ref, normalizedCommit),
    archiveUrl: sourceArchiveUrl(source.repo, normalizedCommit),
  };
}
