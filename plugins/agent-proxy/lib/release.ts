// Pure helpers for resolving CLIProxyAPI GitHub releases. No IO here — the
// install pipeline injects fetch.

export const CORE_REPO = "router-for-me/CLIProxyAPI";

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface Release {
  version: string;
  assets: ReleaseAsset[];
}

export function normalizeVersion(version: string): string {
  return version.replace(/^v/, "");
}

/** Release archives are CLIProxyAPI_<ver>_<os>_<arch>.tar.gz; upstream uses
    aarch64 (not arm64) and only ships tar.gz for darwin/linux. */
export function assetName(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`CLIProxyAPI install is not supported on ${platform} (darwin/linux only)`);
  }
  const archName = arch === "arm64" ? "aarch64" : arch === "x64" ? "amd64" : null;
  if (!archName) throw new Error(`unsupported architecture: ${arch}`);
  return `CLIProxyAPI_${normalizeVersion(version)}_${platform}_${archName}.tar.gz`;
}

export function releaseApiUrl(version?: string): string {
  const base = `https://api.github.com/repos/${CORE_REPO}/releases`;
  return version ? `${base}/tags/v${normalizeVersion(version)}` : `${base}/latest`;
}

export function parseRelease(json: unknown): Release {
  if (typeof json !== "object" || json === null) throw new Error("malformed GitHub release response");
  const record = json as Record<string, unknown>;
  const tag = record.tag_name;
  if (typeof tag !== "string" || tag.length === 0) {
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
  return { version: normalizeVersion(tag), assets };
}

export function pickAsset(release: Release, name: string): ReleaseAsset | null {
  return release.assets.find((asset) => asset.name === name) ?? null;
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

/** Numeric dotted-version compare tolerant of a leading v. Returns <0, 0, >0. */
export function compareVersions(a: string, b: string): number {
  const partsA = normalizeVersion(a).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const partsB = normalizeVersion(b).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(partsA.length, partsB.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
