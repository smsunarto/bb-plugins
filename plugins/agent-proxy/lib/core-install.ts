import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ensureDir, readTextOr, writeAtomic } from "./fsx.ts";
import type { Paths } from "./paths.ts";
import {
  assetName,
  normalizeVersion,
  parseChecksums,
  parseRelease,
  pickAsset,
  releaseApiUrl,
  type Release,
} from "./release.ts";

const GH_HEADERS = {
  "User-Agent": "bb-plugin-agent-proxy",
  Accept: "application/vnd.github+json",
};

export type InstallStage = "downloading" | "verifying" | "extracting" | "installing" | "done";

export interface InstallDeps {
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  onProgress?: (stage: InstallStage) => void;
}

export async function fetchRelease(
  version: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<Release> {
  const response = await fetchImpl(releaseApiUrl(version), { headers: GH_HEADERS });
  if (!response.ok) {
    throw new Error(
      version
        ? `CLIProxyAPI release v${normalizeVersion(version)} not found (HTTP ${response.status})`
        : `GitHub release lookup failed: HTTP ${response.status}`,
    );
  }
  return parseRelease(await response.json());
}

/** The binary file is the source of truth; a surviving marker without a binary
    reads as not installed. */
export function installedVersion(paths: Paths): string | null {
  if (!existsSync(paths.binPath)) return null;
  return readTextOr(paths.versionMarker)?.trim() || "unknown";
}

export function cleanStaleStaging(coreDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(coreDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith("tmp-")) rmSync(join(coreDir, entry), { recursive: true, force: true });
  }
}

async function downloadTo(url: string, dest: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": GH_HEADERS["User-Agent"], Accept: "application/octet-stream" },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status} for ${url}`);
  }
  const body = Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream);
  await pipeline(body, createWriteStream(dest));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
      yield;
    }
  });
  return hash.digest("hex");
}

function runTar(archive: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archive, "-C", cwd], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar extraction failed (exit ${code}): ${stderr.trim()}`));
    });
    child.on("error", (error) => reject(new Error(`could not run tar: ${String(error)}`)));
  });
}

const NON_BINARY_EXTENSIONS = new Set([".txt", ".md", ".yaml", ".yml", ".json", ".gz", ".zip"]);

/** Find the extracted proxy binary anywhere under the staging dir. */
export function findExtractedBinary(stagingDir: string, archiveName: string): string {
  const candidates: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || entry.name === archiveName) continue;
      if (NON_BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      if (/cli-?proxy-?api/i.test(basename(entry.name))) candidates.push(full);
    }
  };
  walk(stagingDir);
  if (candidates.length === 0) {
    throw new Error(`no CLIProxyAPI binary found inside ${archiveName}`);
  }
  // Prefer the largest candidate if the archive somehow ships several matches.
  candidates.sort((a, b) => statSync(b).size - statSync(a).size);
  return candidates[0]!;
}

/** Download → verify → extract → atomically land. Any failure leaves the
    previously installed binary untouched; staging is always cleaned up. */
export async function installCore(
  paths: Paths,
  release: Release,
  deps: InstallDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? (() => {});
  const onProgress = deps.onProgress ?? (() => {});
  const name = assetName(release.version);
  const asset = pickAsset(release, name);
  if (!asset) {
    throw new Error(`release v${release.version} has no asset named ${name}`);
  }
  const staging = join(paths.coreDir, `tmp-${process.pid}-${Date.now()}`);
  ensureDir(staging);
  try {
    onProgress("downloading");
    const archivePath = join(staging, name);
    await downloadTo(asset.url, archivePath, fetchImpl);

    onProgress("verifying");
    const checksumsAsset = pickAsset(release, "checksums.txt");
    if (checksumsAsset) {
      const checksumsResponse = await fetchImpl(checksumsAsset.url, {
        headers: { "User-Agent": GH_HEADERS["User-Agent"] },
        redirect: "follow",
      });
      if (!checksumsResponse.ok) throw new Error(`checksums.txt download failed: HTTP ${checksumsResponse.status}`);
      const expected = parseChecksums(await checksumsResponse.text()).get(name);
      if (!expected) {
        log(`checksums.txt has no entry for ${name}; skipping verification`);
      } else {
        const actual = await sha256File(archivePath);
        if (actual !== expected) {
          throw new Error(`checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
        }
      }
    } else {
      log(`release v${release.version} ships no checksums.txt; skipping verification`);
    }

    onProgress("extracting");
    await runTar(archivePath, staging);
    const extracted = findExtractedBinary(staging, name);
    chmodSync(extracted, 0o755);

    onProgress("installing");
    ensureDir(paths.binDir);
    renameSync(extracted, paths.binPath);
    const version = normalizeVersion(release.version);
    writeAtomic(paths.versionMarker, `${version}\n`);
    onProgress("done");
    return version;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
