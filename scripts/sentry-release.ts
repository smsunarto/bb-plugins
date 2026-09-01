import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { SourceMap, type SourceMapPayload, type SourceMapping } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sentryPluginRelease } from "../packages/bb-kit-sentry/src/telemetry.ts";
import { derivePluginId } from "./plugin-package.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEBUG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const REQUIRED_SENTRY_ENV = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"] as const;

type RequiredSentryEnv = (typeof REQUIRED_SENTRY_ENV)[number];

export interface SentryUploadCredentials {
  readonly SENTRY_AUTH_TOKEN: string;
  readonly SENTRY_ORG: string;
  readonly SENTRY_PROJECT: string;
}

export interface PreparedSentryRelease {
  readonly release: string;
  readonly stageDir: string;
  /** Digest of the injected host bundle; absent for plugins without a host. */
  readonly artifactDigest: string | undefined;
  readonly files: readonly string[];
  cleanup(): void;
}

interface ArtifactIdentityMeta {
  readonly pluginId: string;
  readonly pluginVersion: string;
}

interface HostArtifactMeta extends ArtifactIdentityMeta {
  artifactDigest: string;
}

interface PluginReleaseManifest {
  readonly name: string;
  readonly version: string;
}

export function requireSentryUploadCredentials(env: NodeJS.ProcessEnv): SentryUploadCredentials {
  const values = {} as Record<RequiredSentryEnv, string>;
  const missing: RequiredSentryEnv[] = [];
  for (const name of REQUIRED_SENTRY_ENV) {
    const value = env[name]?.trim();
    if (value === undefined || value.length === 0) missing.push(name);
    else values[name] = value;
  }
  if (missing.length > 0) {
    throw new Error(`Sentry source-map upload requires ${missing.join(", ")}`);
  }
  return values;
}

export function prepareSentryRelease(
  pluginDirectory: string,
  cliPath = defaultSentryCliPath(),
): PreparedSentryRelease {
  const pluginDir = resolve(pluginDirectory);
  const distDir = join(pluginDir, "dist");
  const serverBundlePath = join(distDir, "server.js");
  const hostBundlePath = join(distDir, "host.js");
  const hasHost = existsSync(hostBundlePath);
  const bundlePaths = hasHost ? [hostBundlePath, serverBundlePath] : [serverBundlePath];
  const mapPaths = bundlePaths.map((bundlePath) => `${bundlePath}.map`);
  const serverMetaPath = join(distDir, "server.meta.json");
  const hostMetaPath = join(distDir, "host.meta.json");
  const metaPaths = hasHost ? [serverMetaPath, hostMetaPath] : [serverMetaPath];
  const manifestPath = join(pluginDir, "package.json");

  for (const path of [...bundlePaths, ...mapPaths, ...metaPaths, manifestPath]) readFileSync(path);
  const manifest = readPluginReleaseManifest(manifestPath);
  const manifestPluginId = derivePluginId(manifest.name);
  for (const metaPath of metaPaths) {
    const identity = readArtifactIdentityMeta(metaPath);
    if (manifest.version !== identity.pluginVersion) {
      throw new Error(
        `${basename(metaPath)} version ${identity.pluginVersion} does not match package version ${manifest.version}`,
      );
    }
    if (manifestPluginId !== identity.pluginId) {
      throw new Error(
        `${basename(metaPath)} plugin ${identity.pluginId} does not match package plugin ${manifestPluginId}`,
      );
    }
  }
  execFileSync(cliPath, ["sourcemaps", "inject", ...bundlePaths, ...mapPaths], {
    stdio: "inherit",
  });

  // Only the host sidecar carries an artifact digest; bb checks it at load
  // time, so it must be restamped after injection rewrites the bundle.
  let artifactDigest: string | undefined;
  if (hasHost) {
    const hostMeta = readHostArtifactMeta(hostMetaPath);
    artifactDigest = sha256(hostBundlePath);
    hostMeta.artifactDigest = artifactDigest;
    writeFileSync(hostMetaPath, `${JSON.stringify(hostMeta, null, 2)}\n`);
    if (readHostArtifactMeta(hostMetaPath).artifactDigest !== sha256(hostBundlePath)) {
      throw new Error("the host artifact digest does not match the injected host bundle");
    }
  }

  const stageDir = mkdtempSync(join(tmpdir(), "bb-sentry-sourcemaps-"));
  try {
    const stagedFiles: string[] = [];
    for (const sourcePath of [...bundlePaths, ...mapPaths]) {
      const stagedPath = join(stageDir, basename(sourcePath));
      copyFileSync(sourcePath, stagedPath);
      stagedFiles.push(stagedPath);
    }
    for (const mapPath of stagedFiles.filter((path) => path.endsWith(".map"))) {
      removeSourcesContent(mapPath);
    }
    for (const bundlePath of stagedFiles.filter((path) => path.endsWith(".js"))) {
      checkDebugIdPair(bundlePath, `${bundlePath}.map`);
      checkLocalSourceMap(bundlePath, `${bundlePath}.map`);
    }

    return {
      release: sentryPluginRelease(readArtifactIdentityMeta(serverMetaPath)),
      stageDir,
      artifactDigest,
      files: stagedFiles,
      cleanup: () => rmSync(stageDir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}

export function uploadSentryRelease(
  prepared: PreparedSentryRelease,
  credentials: SentryUploadCredentials,
  cliPath = defaultSentryCliPath(),
): void {
  execFileSync(
    cliPath,
    [
      "sourcemaps",
      "upload",
      prepared.stageDir,
      "--release",
      prepared.release,
      "--no-rewrite",
      "--validate",
      "--strict",
      "--wait",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, ...credentials },
    },
  );
}

export function runSentryRelease(
  pluginDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  cliPath = defaultSentryCliPath(),
): void {
  const credentials = requireSentryUploadCredentials(env);
  const prepared = prepareSentryRelease(pluginDirectory, cliPath);
  try {
    uploadSentryRelease(prepared, credentials, cliPath);
  } finally {
    prepared.cleanup();
  }
}

function defaultSentryCliPath(): string {
  return join(ROOT, "node_modules", ".bin", "sentry-cli");
}

function readArtifactIdentityMeta(path: string): ArtifactIdentityMeta {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { pluginId?: unknown }).pluginId !== "string" ||
    typeof (value as { pluginVersion?: unknown }).pluginVersion !== "string"
  ) {
    throw new Error(`${basename(path)} has no complete plugin identity`);
  }
  return value as ArtifactIdentityMeta;
}

function readHostArtifactMeta(path: string): HostArtifactMeta {
  const value = readArtifactIdentityMeta(path);
  if (typeof (value as { artifactDigest?: unknown }).artifactDigest !== "string") {
    throw new Error(`${basename(path)} has no artifact digest`);
  }
  return value as HostArtifactMeta;
}

function readPluginReleaseManifest(path: string): PluginReleaseManifest {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { name?: unknown }).name !== "string" ||
    typeof (value as { version?: unknown }).version !== "string"
  ) {
    throw new Error("the plugin package manifest has no complete plugin identity");
  }
  return value as PluginReleaseManifest;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function removeSourcesContent(path: string): void {
  const payload = readSourceMap(path);
  delete payload.sourcesContent;
  writeFileSync(path, JSON.stringify(payload));
}

function checkDebugIdPair(bundlePath: string, mapPath: string): void {
  const bundle = readFileSync(bundlePath, "utf8");
  const bundleId = /\/\/# debugId=([0-9a-f-]+)/iu.exec(bundle)?.[1];
  const sourceMap = readSourceMap(mapPath);
  const mapId = sourceMap.debugId ?? sourceMap.debug_id;
  if (
    bundleId === undefined ||
    typeof mapId !== "string" ||
    !DEBUG_ID_PATTERN.test(bundleId) ||
    bundleId.toLowerCase() !== mapId.toLowerCase()
  ) {
    throw new Error(`${basename(bundlePath)} and its source map have different Debug IDs`);
  }
}

function checkLocalSourceMap(bundlePath: string, mapPath: string): void {
  const bundleLines = readFileSync(bundlePath, "utf8").split("\n");
  const payload = readSourceMap(mapPath);
  const sourceMap = new SourceMap(toSourceMapPayload(payload));
  for (let line = 0; line < bundleLines.length; line += 1) {
    const entry = sourceMap.findEntry(line, bundleLines[line]?.length ?? 0);
    if (isSourceMapping(entry) && entry.originalSource.endsWith(".ts")) {
      return;
    }
  }
  throw new Error(`${basename(mapPath)} cannot resolve any position to a TypeScript source`);
}

interface LooseSourceMap {
  version?: unknown;
  file?: unknown;
  sources?: unknown;
  sourcesContent?: unknown;
  names?: unknown;
  mappings?: unknown;
  sourceRoot?: unknown;
  debugId?: unknown;
  debug_id?: unknown;
  [key: string]: unknown;
}

function readSourceMap(path: string): LooseSourceMap {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${basename(path)} is not a source-map object`);
  }
  return value as LooseSourceMap;
}

function toSourceMapPayload(payload: LooseSourceMap): SourceMapPayload {
  if (
    payload.version !== 3 ||
    !Array.isArray(payload.sources) ||
    !payload.sources.every((value) => typeof value === "string") ||
    typeof payload.mappings !== "string"
  ) {
    throw new Error("a staged map has an unsupported source-map shape");
  }
  return {
    version: 3,
    file: typeof payload.file === "string" ? payload.file : "",
    sources: payload.sources,
    sourcesContent:
      Array.isArray(payload.sourcesContent) &&
      payload.sourcesContent.every((value) => typeof value === "string")
        ? payload.sourcesContent
        : [],
    names:
      Array.isArray(payload.names) && payload.names.every((value) => typeof value === "string")
        ? payload.names
        : [],
    mappings: payload.mappings,
    sourceRoot: typeof payload.sourceRoot === "string" ? payload.sourceRoot : "",
  };
}

function isSourceMapping(value: SourceMapping | {}): value is SourceMapping {
  return "originalSource" in value && typeof value.originalSource === "string";
}

if (import.meta.main) {
  const pluginDirectory = process.argv[2];
  if (pluginDirectory === undefined) {
    throw new Error("Usage: bun scripts/sentry-release.ts <plugin-directory>");
  }
  runSentryRelease(pluginDirectory);
}
