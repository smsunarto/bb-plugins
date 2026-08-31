import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { SourceMap, type SourceMapPayload, type SourceMapping } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ampSentryRelease } from "../plugins/amp/lib/telemetry.ts";
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
  readonly artifactDigest: string;
  readonly files: readonly string[];
  cleanup(): void;
}

interface HostArtifactMeta {
  readonly pluginId: string;
  readonly pluginVersion: string;
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
    throw new Error(`Amp source-map upload requires ${missing.join(", ")}`);
  }
  return values;
}

export function prepareSentryRelease(
  pluginDirectory: string,
  cliPath = defaultSentryCliPath(),
): PreparedSentryRelease {
  const pluginDir = resolve(pluginDirectory);
  const distDir = join(pluginDir, "dist");
  const bundlePaths = [join(distDir, "host.js"), join(distDir, "server.js")];
  const mapPaths = bundlePaths.map((bundlePath) => `${bundlePath}.map`);
  const metaPath = join(distDir, "host.meta.json");
  const manifestPath = join(pluginDir, "package.json");

  for (const path of [...bundlePaths, ...mapPaths, metaPath, manifestPath]) readFileSync(path);
  const meta = readHostArtifactMeta(metaPath);
  const manifest = readPluginReleaseManifest(manifestPath);
  if (manifest.version !== meta.pluginVersion) {
    throw new Error(
      `Amp host metadata version ${meta.pluginVersion} does not match package version ${manifest.version}`,
    );
  }
  const manifestPluginId = derivePluginId(manifest.name);
  if (manifestPluginId !== meta.pluginId) {
    throw new Error(
      `Amp host metadata plugin ${meta.pluginId} does not match package plugin ${manifestPluginId}`,
    );
  }
  execFileSync(cliPath, ["sourcemaps", "inject", ...bundlePaths, ...mapPaths], {
    stdio: "inherit",
  });

  const artifactDigest = sha256(bundlePaths[0]!);
  meta.artifactDigest = artifactDigest;
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  if (readHostArtifactMeta(metaPath).artifactDigest !== sha256(bundlePaths[0]!)) {
    throw new Error("Amp host artifact digest does not match the injected host bundle");
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
    }
    checkLocalSourceMap(join(stageDir, "host.js"), join(stageDir, "host.js.map"));

    return {
      release: ampSentryRelease(meta),
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

function readHostArtifactMeta(path: string): HostArtifactMeta {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { pluginId?: unknown }).pluginId !== "string" ||
    typeof (value as { pluginVersion?: unknown }).pluginVersion !== "string" ||
    typeof (value as { artifactDigest?: unknown }).artifactDigest !== "string"
  ) {
    throw new Error("Amp host metadata has no complete artifact identity");
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
    throw new Error("Amp package manifest has no complete plugin identity");
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
    if (
      isSourceMapping(entry) &&
      entry.originalSource.replaceAll("\\", "/").endsWith("/src/bridge/entry.ts")
    ) {
      return;
    }
  }
  throw new Error("the staged host source map cannot resolve a position to src/bridge/entry.ts");
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
    throw new Error("the staged host map has an unsupported source-map shape");
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
