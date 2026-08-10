import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
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
const CORE_EXECUTABLE = "cli-proxy-api";

export type InstallStage = "downloading" | "verifying" | "extracting" | "installing" | "done";

export interface InstallDeps {
  fetchImpl?: typeof fetch;
  onProgress?: (stage: InstallStage) => void;
  beforeInstall?: () => Promise<void>;
  signal?: AbortSignal;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function fetchRelease(
  version: string | undefined,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Release> {
  const response = await fetchImpl(releaseApiUrl(version), {
    headers: GH_HEADERS,
    signal: requestSignal(signal, 30_000),
  });
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

/** One-time compatibility bridge from the pre-pointer layout. Copy first and
    publish the pointer last so an interrupted migration leaves the legacy
    installation runnable and retryable. */
export function migrateLegacyInstall(paths: Paths): void {
  if (existsSync(paths.binPath) || !existsSync(paths.legacyBinPath)) return;
  const version = readTextOr(paths.legacyVersionMarker)?.trim() || "unknown";
  const releaseDir = join(paths.versionsDir, `legacy-${randomUUID()}`);
  const temporaryLink = `${paths.currentLink}.migrate-${randomUUID()}`;
  ensureDir(releaseDir);
  try {
    copyFileSync(paths.legacyBinPath, join(releaseDir, CORE_EXECUTABLE));
    chmodSync(join(releaseDir, CORE_EXECUTABLE), 0o755);
    writeAtomic(join(releaseDir, ".version"), `${version}\n`);
    symlinkSync(releaseDir, temporaryLink, "dir");
    renameSync(temporaryLink, paths.currentLink);
  } catch (error) {
    rmSync(temporaryLink, { force: true });
    rmSync(releaseDir, { recursive: true, force: true });
    throw error;
  }
}

async function downloadTo(
  url: string,
  dest: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<void> {
  const requestAbort = requestSignal(signal, 120_000);
  const response = await fetchImpl(url, {
    headers: { "User-Agent": GH_HEADERS["User-Agent"], Accept: "application/octet-stream" },
    redirect: "follow",
    signal: requestAbort,
  });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status} for ${url}`);
  }
  const body = Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream);
  await pipeline(body, createWriteStream(dest), { signal: requestAbort });
}

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), async function* (source) {
    for await (const chunk of source) {
      signal?.throwIfAborted();
      hash.update(chunk as Buffer);
      yield;
    }
  }, { signal });
  return hash.digest("hex");
}

function runTar(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolve(stdout);
      else reject(new Error(`tar extraction failed (exit ${code}): ${stderr.trim()}`));
    });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(new Error(`could not run tar: ${String(error)}`));
    });
  });
}

function normalizedArchivePath(path: string): string {
  let normalized = path;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized.replace(/\/$/, "");
}

/** Refuse paths that can escape staging and links that can redirect extraction
    outside it. Require the one upstream executable at the archive root. */
async function validateArchive(archive: string, signal?: AbortSignal): Promise<void> {
  const entries = (await runTar(["-tzf", archive], signal)).split("\n").filter(Boolean);
  let binaryCount = 0;
  for (const entry of entries) {
    const normalized = normalizedArchivePath(entry);
    if (entry.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error(`unsafe archive path: ${entry}`);
    }
    if (normalized === CORE_EXECUTABLE) binaryCount += 1;
  }
  if (binaryCount !== 1) {
    throw new Error(`archive must contain exactly one root ${CORE_EXECUTABLE} executable`);
  }

  const verbose = await runTar(["-tvzf", archive], signal);
  for (const line of verbose.split("\n")) {
    if (line.startsWith("l") || line.startsWith("h")) {
      throw new Error("archive contains an unsafe link entry");
    }
  }
}

/** Locate the exact executable validated at the archive root. */
export function findExtractedBinary(stagingDir: string, archiveName: string): string {
  const candidate = join(stagingDir, CORE_EXECUTABLE);
  try {
    if (lstatSync(candidate).isFile()) return candidate;
  } catch {
    // Fall through to the stable install error below.
  }
  throw new Error(`no CLIProxyAPI binary found inside ${archiveName}`);
}

/** Download → verify → extract → atomically land. Any failure leaves the
    previously installed binary untouched; staging is always cleaned up. */
export async function installCore(
  paths: Paths,
  release: Release,
  deps: InstallDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const onProgress = deps.onProgress ?? (() => {});
  const name = assetName(release.version);
  const asset = pickAsset(release, name);
  if (!asset) {
    throw new Error(`release v${release.version} has no asset named ${name}`);
  }
  const checksumsAsset = pickAsset(release, "checksums.txt");
  if (!checksumsAsset) {
    throw new Error(`release v${release.version} ships no checksums.txt; refusing unverified install`);
  }
  const staging = join(paths.coreDir, `tmp-${process.pid}-${randomUUID()}`);
  let landedRelease: string | null = null;
  let pointerCommitted = false;
  ensureDir(staging);
  try {
    onProgress("downloading");
    const archivePath = join(staging, name);
    await downloadTo(asset.url, archivePath, fetchImpl, deps.signal);

    onProgress("verifying");
    const checksumsResponse = await fetchImpl(checksumsAsset.url, {
      headers: { "User-Agent": GH_HEADERS["User-Agent"] },
      redirect: "follow",
      signal: requestSignal(deps.signal, 30_000),
    });
    if (!checksumsResponse.ok) throw new Error(`checksums.txt download failed: HTTP ${checksumsResponse.status}`);
    const expected = parseChecksums(await checksumsResponse.text()).get(name);
    if (!expected) {
      throw new Error(`checksums.txt has no entry for ${name}; refusing unverified install`);
    }
    const actual = await sha256File(archivePath, deps.signal);
    if (actual !== expected) {
      throw new Error(`checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
    }

    onProgress("extracting");
    await validateArchive(archivePath, deps.signal);
    await runTar(["-xzf", archivePath, "-C", staging], deps.signal);
    const extracted = findExtractedBinary(staging, name);
    chmodSync(extracted, 0o755);

    const version = normalizeVersion(release.version);
    const candidateRelease = join(staging, "release");
    ensureDir(candidateRelease);
    renameSync(extracted, join(candidateRelease, CORE_EXECUTABLE));
    writeAtomic(join(candidateRelease, ".version"), `${version}\n`);
    ensureDir(paths.versionsDir);
    landedRelease = join(paths.versionsDir, `${version}-${randomUUID()}`);
    renameSync(candidateRelease, landedRelease);

    onProgress("installing");
    await deps.beforeInstall?.();
    ensureDir(paths.binDir);
    const temporaryLink = `${paths.currentLink}.install-${randomUUID()}`;
    try {
      symlinkSync(landedRelease, temporaryLink, "dir");
      renameSync(temporaryLink, paths.currentLink);
      pointerCommitted = true;
    } finally {
      rmSync(temporaryLink, { force: true });
    }
    onProgress("done");
    return version;
  } finally {
    if (landedRelease !== null && !pointerCommitted) {
      rmSync(landedRelease, { recursive: true, force: true });
    }
    rmSync(staging, { recursive: true, force: true });
  }
}
