// Pure helpers for resolving the CLIProxyAPI source. No IO here — the install
// pipeline injects fetch.

/**
 * Ref sentinel: resolve the repository's newest published release rather than
 * a fixed branch or tag. A repository that also carries a branch literally
 * named "latest" cannot be reached by name; pin it by commit instead.
 */
export const LATEST_RELEASE_REF = "latest";

export const CORE_REPO = "router-for-me/CLIProxyAPI";
export const CORE_REF = LATEST_RELEASE_REF;

export interface CoreSource {
  repo: string;
  ref: string;
}

export const DEFAULT_CORE_SOURCE: CoreSource = {
  repo: CORE_REPO,
  ref: CORE_REF,
};
const INVALID_REF_CHARACTERS = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface Release {
  tag: string;
  assets: ReleaseAsset[];
}

/** The published archive for this platform plus the checksums file that must
    verify it. Both are required; a release missing either is built from
    source instead. */
export interface ReleaseBinary {
  assetName: string;
  assetUrl: string;
  checksumsUrl: string;
}

/**
 * A resolved install target. The commit is always known, so a build from
 * source is always possible; `binary` is set only when the ref names a
 * published release that ships an archive for this platform.
 */
export interface SourceRevision {
  repo: string;
  ref: string;
  commit: string;
  version: string;
  archiveUrl: string;
  binary: ReleaseBinary | null;
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

export function isLatestReleaseRef(ref: string): boolean {
  return ref.trim().toLowerCase() === LATEST_RELEASE_REF;
}

export function commitApiUrl(source: CoreSource = DEFAULT_CORE_SOURCE): string {
  return `https://api.github.com/repos/${source.repo}/commits/${encodeURIComponent(source.ref)}`;
}

export function latestReleaseApiUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

export function releaseTagApiUrl(repo: string, tag: string): string {
  return `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
}

export function normalizeVersion(version: string): string {
  return version.replace(/^v/, "");
}

/** GitHub's releases/latest already excludes drafts and prereleases, so the
    tag it reports is the newest release a user would download by hand. */
export function parseRelease(json: unknown): Release {
  if (typeof json !== "object" || json === null) {
    throw new Error("malformed GitHub release response");
  }
  const record = json as Record<string, unknown>;
  if (typeof record.tag_name !== "string" || record.tag_name.trim().length === 0) {
    throw new Error("GitHub release response has no tag_name");
  }
  const assets: ReleaseAsset[] = [];
  if (Array.isArray(record.assets)) {
    for (const entry of record.assets) {
      if (typeof entry !== "object" || entry === null) continue;
      const asset = entry as Record<string, unknown>;
      if (typeof asset.name === "string" && typeof asset.browser_download_url === "string") {
        assets.push({ name: asset.name, url: asset.browser_download_url });
      }
    }
  }
  return { tag: normalizeCoreRef(record.tag_name), assets };
}

/** Release archives are CLIProxyAPI_<ver>_<os>_<arch>.tar.gz; upstream uses
    aarch64 (not arm64) and ships tar.gz only for darwin and linux. Anything
    else returns null and falls back to a source build. */
export function releaseAssetName(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | null {
  if (platform !== "darwin" && platform !== "linux") return null;
  const archName = arch === "arm64" ? "aarch64" : arch === "x64" ? "amd64" : null;
  if (!archName) return null;
  return `CLIProxyAPI_${normalizeVersion(version)}_${platform}_${archName}.tar.gz`;
}

/** Null whenever this platform's archive or checksums.txt is absent — the
    caller then builds the same commit from source. */
export function pickReleaseBinary(
  release: Release,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): ReleaseBinary | null {
  const name = releaseAssetName(release.tag, platform, arch);
  if (name === null) return null;
  const asset = release.assets.find((candidate) => candidate.name === name);
  const checksums = release.assets.find((candidate) => candidate.name === "checksums.txt");
  if (!asset || !checksums) return null;
  return { assetName: asset.name, assetUrl: asset.url, checksumsUrl: checksums.url };
}

/** checksums.txt lines are "<sha256>  <filename>". */
export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match) map.set(match[2]!.trim(), match[1]!.toLowerCase());
  }
  return map;
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
  binary: ReleaseBinary | null = null,
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
    binary,
  };
}
