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
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ensureDir, readTextOr, writeAtomic } from "./fsx.ts";
import type { Paths } from "./paths.ts";
import {
  commitApiUrl,
  DEFAULT_CORE_SOURCE,
  isLatestReleaseRef,
  latestReleaseApiUrl,
  parseChecksums,
  parseRelease,
  parseSourceRevision,
  pickReleaseBinary,
  releaseTagApiUrl,
  type CoreSource,
  type Release,
  type SourceRevision,
} from "./release.ts";

const GH_HEADERS = {
  "User-Agent": "bb-plugin-agent-proxy",
  Accept: "application/vnd.github+json",
};
export type InstallStage =
  | "downloading"
  | "verifying"
  | "extracting"
  | "building"
  | "installing"
  | "done";

export interface BuildSourceOptions {
  sourceDir: string;
  outputPath: string;
  revision: SourceRevision;
  signal?: AbortSignal;
}

export interface InstallDeps {
  fetchImpl?: typeof fetch;
  onProgress?: (stage: InstallStage) => void;
  beforeInstall?: () => Promise<void>;
  buildSource?: (options: BuildSourceOptions) => Promise<void>;
  signal?: AbortSignal;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Null when the tag names no release. A missing releases/latest is an error
    instead: the user asked for the newest release by name. */
export async function fetchRelease(
  repo: string,
  ref: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Release | null> {
  const latest = isLatestReleaseRef(ref);
  const response = await fetchImpl(
    latest ? latestReleaseApiUrl(repo) : releaseTagApiUrl(repo, ref),
    { headers: GH_HEADERS, signal: requestSignal(signal, 30_000) },
  );
  if (response.status === 404) {
    if (latest) throw new Error(`${repo} has no published release (HTTP 404)`);
    return null;
  }
  if (!response.ok) {
    throw new Error(`GitHub release lookup for ${repo}#${ref} failed (HTTP ${response.status})`);
  }
  return parseRelease(await response.json());
}

/**
 * Resolves the configured ref to an immutable commit, and to a published
 * archive when one exists for this platform. The "latest" sentinel becomes the
 * newest release tag first, so the recorded version names that release instead
 * of a moving branch. A commit SHA never names a release, so it skips the
 * release lookup entirely.
 */
export async function fetchSourceRevision(
  source: CoreSource = DEFAULT_CORE_SOURCE,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<SourceRevision> {
  const release = /^[0-9a-f]{40}$/i.test(source.ref)
    ? null
    : await fetchRelease(source.repo, source.ref, fetchImpl, signal);
  const resolved: CoreSource =
    release && isLatestReleaseRef(source.ref)
      ? { repo: source.repo, ref: release.tag }
      : source;
  const response = await fetchImpl(commitApiUrl(resolved), {
    headers: GH_HEADERS,
    signal: requestSignal(signal, 30_000),
  });
  if (!response.ok) {
    throw new Error(
      `CLIProxyAPI source ${resolved.repo}#${resolved.ref} not found (HTTP ${response.status})`,
    );
  }
  return parseSourceRevision(
    await response.json(),
    resolved,
    release ? pickReleaseBinary(release) : null,
  );
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

function publishReleasePointer(
  currentLink: string,
  releaseDir: string,
  suffix: string,
): void {
  const temporaryLink = `${currentLink}.${suffix}-${randomUUID()}`;
  symlinkSync(releaseDir, temporaryLink, "dir");
  try {
    renameSync(temporaryLink, currentLink);
  } finally {
    rmSync(temporaryLink, { recursive: true, force: true });
  }
}

/** One-time compatibility bridge from the pre-pointer layout. Copy first and
    publish the pointer last so an interrupted migration leaves the legacy
    installation runnable and retryable. */
export function migrateLegacyInstall(paths: Paths): void {
  if (existsSync(paths.binPath) || !existsSync(paths.legacyBinPath)) return;
  const version = readTextOr(paths.legacyVersionMarker)?.trim() || "unknown";
  const releaseDir = join(paths.versionsDir, `legacy-${randomUUID()}`);
  ensureDir(releaseDir);
  try {
    const executable = join(releaseDir, basename(paths.binPath));
    copyFileSync(paths.legacyBinPath, executable);
    chmodSync(executable, 0o755);
    writeAtomic(join(releaseDir, ".version"), `${version}\n`);
    publishReleasePointer(paths.currentLink, releaseDir, "migrate");
  } catch (error) {
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
  await pipeline(
    createReadStream(path),
    async function* (source) {
      for await (const chunk of source) {
        signal?.throwIfAborted();
        hash.update(chunk as Buffer);
        yield;
      }
    },
    { signal },
  );
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

function runGoBuild(options: BuildSourceOptions): Promise<void> {
  const { sourceDir, outputPath, revision } = options;
  const signal = requestSignal(options.signal, 10 * 60_000);
  const buildDate = new Date().toISOString();
  const ldflags = [
    "-s",
    "-w",
    `-X main.Version=${revision.version}`,
    `-X main.Commit=${revision.commit.slice(0, 12)}`,
    `-X main.BuildDate=${buildDate}`,
  ].join(" ");

  return new Promise((resolve, reject) => {
    const child = spawn(
      "go",
      [
        "build",
        "-trimpath",
        "-buildvcs=false",
        `-ldflags=${ldflags}`,
        "-o",
        outputPath,
        "./cmd/server/",
      ],
      { cwd: sourceDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-64_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else reject(new Error(`go build failed (exit ${code}): ${output.trim()}`));
    });
    child.on("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(new Error(`could not run go build: ${String(error)}`));
    });
  });
}

function normalizedArchivePath(path: string): string {
  let normalized = path;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized.replace(/\/$/, "");
}

/** Refuse paths that can escape staging and links that can redirect extraction
    outside it. GitHub source archives must contain exactly one root directory. */
async function validateSourceArchive(archive: string, signal?: AbortSignal): Promise<string> {
  const entries = (await runTar(["-tzf", archive], signal)).split("\n").filter(Boolean);
  const roots = new Set<string>();
  for (const entry of entries) {
    const normalized = normalizedArchivePath(entry);
    if (entry.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error(`unsafe archive path: ${entry}`);
    }
    const root = normalized.split("/")[0];
    if (root) roots.add(root);
  }
  if (roots.size !== 1) {
    throw new Error("source archive must contain exactly one root directory");
  }

  const verbose = await runTar(["-tvzf", archive], signal);
  for (const line of verbose.split("\n")) {
    if (line.startsWith("l") || line.startsWith("h")) {
      throw new Error("archive contains an unsafe link entry");
    }
  }
  return [...roots][0]!;
}

/** Refuse paths that can escape staging and links that can redirect extraction
    outside it. Require the one upstream executable at the archive root. */
async function validateBinaryArchive(
  archive: string,
  executable: string,
  signal?: AbortSignal,
): Promise<void> {
  const entries = (await runTar(["-tzf", archive], signal)).split("\n").filter(Boolean);
  let binaryCount = 0;
  for (const entry of entries) {
    const normalized = normalizedArchivePath(entry);
    if (entry.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error(`unsafe archive path: ${entry}`);
    }
    if (normalized === executable) binaryCount += 1;
  }
  if (binaryCount !== 1) {
    throw new Error(`archive must contain exactly one root ${executable} executable`);
  }

  const verbose = await runTar(["-tvzf", archive], signal);
  for (const line of verbose.split("\n")) {
    if (line.startsWith("l") || line.startsWith("h")) {
      throw new Error("archive contains an unsafe link entry");
    }
  }
}

interface StageOptions {
  staging: string;
  candidateBinary: string;
  revision: SourceRevision;
  fetchImpl: typeof fetch;
  onProgress: (stage: InstallStage) => void;
  signal?: AbortSignal;
}

/** Published release path: the archive is only trusted after its sha256
    matches the release's own checksums.txt. No Go toolchain is involved. */
async function stagePublishedBinary(options: StageOptions): Promise<void> {
  const { staging, candidateBinary, revision, fetchImpl, onProgress, signal } = options;
  const binary = revision.binary!;
  const executable = basename(candidateBinary);

  onProgress("downloading");
  const archivePath = join(staging, binary.assetName);
  await downloadTo(binary.assetUrl, archivePath, fetchImpl, signal);

  onProgress("verifying");
  const checksumsResponse = await fetchImpl(binary.checksumsUrl, {
    headers: { "User-Agent": GH_HEADERS["User-Agent"] },
    redirect: "follow",
    signal: requestSignal(signal, 30_000),
  });
  if (!checksumsResponse.ok) {
    throw new Error(`checksums.txt download failed: HTTP ${checksumsResponse.status}`);
  }
  const expected = parseChecksums(await checksumsResponse.text()).get(binary.assetName);
  if (!expected) {
    throw new Error(
      `checksums.txt has no entry for ${binary.assetName}; refusing unverified install`,
    );
  }
  const actual = await sha256File(archivePath, signal);
  if (actual !== expected) {
    throw new Error(
      `checksum mismatch for ${binary.assetName}: expected ${expected}, got ${actual}`,
    );
  }

  onProgress("extracting");
  await validateBinaryArchive(archivePath, executable, signal);
  const extractDir = join(staging, "extract");
  ensureDir(extractDir);
  await runTar(["-xzf", archivePath, "-C", extractDir], signal);
  const extracted = join(extractDir, executable);
  if (!lstatSync(extracted).isFile()) {
    throw new Error(`no CLIProxyAPI binary found inside ${binary.assetName}`);
  }
  renameSync(extracted, candidateBinary);
}

/** Source path: any ref that names no published archive, including branches,
    commits, and forks. Requires the local Go toolchain. */
async function stageSourceBuild(
  options: StageOptions & { buildSource: (options: BuildSourceOptions) => Promise<void> },
): Promise<void> {
  const { staging, candidateBinary, revision, fetchImpl, onProgress, signal } = options;

  onProgress("downloading");
  const archivePath = join(staging, `CLIProxyAPI-${revision.commit}.tar.gz`);
  await downloadTo(revision.archiveUrl, archivePath, fetchImpl, signal);

  onProgress("verifying");
  const sourceRootName = await validateSourceArchive(archivePath, signal);

  onProgress("extracting");
  await runTar(["-xzf", archivePath, "-C", staging], signal);
  const sourceDir = join(staging, sourceRootName);
  if (!lstatSync(join(sourceDir, "go.mod")).isFile()) {
    throw new Error("CLIProxyAPI source archive has no root go.mod");
  }

  onProgress("building");
  await options.buildSource({ sourceDir, outputPath: candidateBinary, revision, signal });
  if (!lstatSync(candidateBinary).isFile()) {
    throw new Error("go build did not produce the CLIProxyAPI executable");
  }
}

/** Download → verify → stage → publish. Any failure leaves the previously
    installed binary untouched; staging is always cleaned up. */
export async function installCore(
  paths: Paths,
  revision: SourceRevision,
  deps: InstallDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const onProgress = deps.onProgress ?? (() => {});
  const staging = join(paths.coreDir, `tmp-${process.pid}-${randomUUID()}`);
  let landedRelease: string | null = null;
  let pointerCommitted = false;
  ensureDir(staging);
  try {
    const candidateRelease = join(staging, "release");
    ensureDir(candidateRelease);
    const candidateBinary = join(candidateRelease, basename(paths.binPath));
    const stage: StageOptions = {
      staging,
      candidateBinary,
      revision,
      fetchImpl,
      onProgress,
      signal: deps.signal,
    };
    if (revision.binary) await stagePublishedBinary(stage);
    else await stageSourceBuild({ ...stage, buildSource: deps.buildSource ?? runGoBuild });

    chmodSync(candidateBinary, 0o755);
    writeAtomic(join(candidateRelease, ".version"), `${revision.version}\n`);
    ensureDir(paths.versionsDir);
    landedRelease = join(paths.versionsDir, `${revision.commit.slice(0, 12)}-${randomUUID()}`);
    renameSync(candidateRelease, landedRelease);

    onProgress("installing");
    await deps.beforeInstall?.();
    ensureDir(paths.binDir);
    publishReleasePointer(paths.currentLink, landedRelease, "install");
    pointerCommitted = true;
    onProgress("done");
    return revision.version;
  } finally {
    if (landedRelease !== null && !pointerCommitted) {
      rmSync(landedRelease, { recursive: true, force: true });
    }
    rmSync(staging, { recursive: true, force: true });
  }
}
