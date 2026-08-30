import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureDir, readTextOr, timestampedBackup, writeAtomic } from "./lib/fsx.ts";
import { loadOrCreateKey } from "./lib/keys.ts";
import { buildPaths, systemdUserUnitPath, type Paths } from "./lib/paths.ts";
import {
  cleanStaleStaging,
  fetchSourceRevision,
  installCore,
  installedVersion,
  migrateLegacyInstall,
} from "./lib/core-install.ts";
import { normalizeCoreRef, normalizeCoreSource, type CoreSource } from "./lib/release.ts";
import { reconcileConfigFile, renderInitialConfig } from "./lib/core-config.ts";
import {
  LaunchdSupervisor,
  SystemdSupervisor,
  type CoreSupervisor,
  type SupervisorSnapshot,
} from "./lib/core-process.ts";
import {
  createCloudflareTunnelService,
  deriveTunnelStatus,
  discoverCloudflared,
  installTunnelRuntime,
  loadBundledTunnelRuntime,
  monitorTunnelObservation,
  readTunnelObservation,
  renderTunnelDesiredConfig,
  resolveTunnelHostRuntime,
  type BundledTunnelRuntime,
  type CloudflaredDiscovery,
  type TunnelHostRuntime,
  type TunnelStatus,
} from "./lib/cloudflare-tunnel.ts";
import type { PersistentService } from "./lib/persistent-service.ts";
import { resolveAgentProxyInstance } from "./lib/instance.ts";
import { planRuntimeReconciliation, runtimeConfigFingerprint } from "./lib/runtime-state.ts";
import {
  createAgentProxyDefaults,
  migrateAgentProxySettings,
  ROUTING_STRATEGIES,
  type AgentProxySettings,
} from "./lib/plugin-settings.ts";
import { retireCurrentDevOwnedSharedServices } from "./lib/shared-service-retirement.ts";
import {
  ManagementClient,
  ManagementError,
  RESOURCES,
  type OAuthProvider,
} from "./lib/management-client.ts";
import {
  applyClaudeEnv,
  captureClaudeEnvState,
  claudeApplied,
  renderCodexConfig,
  restoreClaudeEnv,
  CODEX_ENV_KEY,
  type ClaudeEnvState,
} from "./lib/agents-config.ts";

const LATEST_CACHE_KEY = "latest-source-revision-v1";
const SETTINGS_STORAGE_KEY = "configuration-v1";
const LATEST_CACHE_TTL_MS = 3_600_000;
const CLAUDE_BACKUP_BASE = "claude-settings.json";
const SHARED_SERVICE_LABEL = "com.bb.plugin.agent-proxy";
const SHARED_TUNNEL_SERVICE_LABEL = "com.bb.plugin.agent-proxy.cloudflare-tunnel";
/** Labels earlier versions installed. Retired once on initialize so an upgraded
    install keeps exactly one login service. Never derive this from the plugin
    id: a rename or reinstall would orphan the service already on disk. */
const LEGACY_SERVICE_LABELS = ["com.smsunarto.bb.agent-proxy"] as const;

interface LatestCache {
  repo: string;
  ref: string;
  version: string;
  checkedAt: number;
}

function endpointsFor(port: number) {
  const base = `http://127.0.0.1:${port}`;
  return { openai: `${base}/v1`, anthropic: base, gemini: `${base}/v1beta` };
}

function resourceRevision(value: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const previousClaudeValueSchema = z.object({ present: z.boolean(), value: z.unknown().optional() });
const claudeEnvStateSchema = z.object({
  version: z.literal(1),
  applied: z.object({ baseUrl: z.string(), token: z.string() }),
  previous: z.object({
    baseUrl: previousClaudeValueSchema,
    token: previousClaudeValueSchema,
  }),
});

// ---------------------------------------------------------------------------
// RPC contract (imported type-only by app.tsx)
// ---------------------------------------------------------------------------

const stateSchema = z.enum([
  "not-installed",
  "stopped",
  "starting",
  "running",
  "stopping",
  "crashed",
]);

const endpointsSchema = z.object({
  openai: z.string(),
  anthropic: z.string(),
  gemini: z.string(),
});

const sourceSchema = z.object({
  repository: z.string(),
  branch: z.string(),
  error: z.string().nullable(),
});

const configurationValuesSchema = z.object({
  autostart: z.boolean(),
  cloudflareQuickTunnelForCursor: z.boolean(),
  port: z.number().int().min(1).max(65_535),
  sourceRepository: z.string(),
  sourceBranch: z.string(),
  routingStrategy: z.enum(ROUTING_STRATEGIES),
});

const configurationViewSchema = z.object({
  values: configurationValuesSchema,
  defaults: configurationValuesSchema,
  managementKeyConfigured: z.boolean(),
  sourceError: z.string().nullable(),
});

const managementKeyUpdateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep") }).strict(),
  z.object({ action: z.literal("clear") }).strict(),
  z.object({ action: z.literal("set"), value: z.string().min(1) }).strict(),
]);

const statusSchema = z.object({
  state: stateSchema,
  pid: z.number().nullable(),
  port: z.number(),
  installedVersion: z.string().nullable(),
  crashCount: z.number(),
  lastExit: z
    .object({ code: z.number().nullable(), signal: z.string().nullable(), at: z.number() })
    .nullable(),
  endpoints: endpointsSchema,
  service: z.object({
    manager: z.enum(["launchd", "systemd"]),
    label: z.string(),
    definitionPath: z.string(),
    loaded: z.boolean(),
  }),
  source: sourceSchema,
  latest: z.object({ version: z.string(), checkedAt: z.number() }).nullable(),
  tunnel: z.discriminatedUnion("state", [
    z.object({ state: z.literal("disabled") }),
    z.object({ state: z.literal("missing-binary"), detail: z.string() }),
    z.object({
      state: z.literal("stopped"),
      reason: z.enum(["core-stopped", "disabled"]),
    }),
    z.object({
      state: z.literal("stopping"),
      pid: z.number().nullable(),
      detail: z.string(),
    }),
    z.object({
      state: z.literal("starting"),
      pid: z.number().nullable(),
      detail: z.string(),
    }),
    z.object({
      state: z.literal("running-without-url"),
      pid: z.number(),
      detail: z.string(),
    }),
    z.object({ state: z.literal("ready"), pid: z.number(), openaiBaseUrl: z.string() }),
    z.object({
      state: z.literal("crashed"),
      lastExit: z
        .object({ code: z.number().nullable(), signal: z.string().nullable(), at: z.number() })
        .nullable(),
      detail: z.string(),
    }),
  ]),
});

export type CoreStatus = z.infer<typeof statusSchema>;

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
  coreLogs: { input: z.null(), output: z.object({ lines: z.array(z.string()) }) },
  connectivity: {
    input: z.null(),
    output: z.object({ ok: z.boolean(), detail: z.string() }),
  },
  checkLatest: {
    input: z.null(),
    output: z.object({
      latest: z.string(),
      installed: z.string().nullable(),
      updateAvailable: z.boolean(),
    }),
  },
  install: {
    input: z.object({ ref: z.string().optional() }).strict(),
    output: z.object({ installedVersion: z.string() }),
  },
  start: { input: z.null(), output: statusSchema },
  stop: { input: z.null(), output: statusSchema },
  restart: { input: z.null(), output: statusSchema },
  endpoints: {
    input: z.null(),
    output: endpointsSchema.extend({ apiKey: z.string(), publicOpenai: z.string().nullable() }),
  },
  configuration: { input: z.null(), output: configurationViewSchema },
  configurationUpdate: {
    input: configurationValuesSchema.extend({ managementKey: managementKeyUpdateSchema }).strict(),
    output: configurationViewSchema,
  },

  oauthStart: {
    input: z.object({ provider: z.enum(["anthropic", "codex"]) }).strict(),
    output: z.object({ url: z.string(), state: z.string() }),
  },
  oauthPoll: {
    input: z.object({ state: z.string() }).strict(),
    output: z.object({
      status: z.enum(["pending", "ok", "error"]),
      detail: z.string().nullable(),
    }),
  },
  authFiles: {
    input: z.null(),
    output: z.object({ files: z.array(z.record(z.string(), z.unknown())) }),
  },
  authFileStatus: {
    input: z.object({ name: z.string(), disabled: z.boolean() }).strict(),
    output: z.null(),
  },
  authFileDelete: {
    input: z.object({ name: z.string() }).strict(),
    output: z.null(),
  },
  resetQuota: {
    input: z.object({ authIndex: z.string() }).strict(),
    output: z.null(),
  },

  resourceGet: {
    input: z.object({ resource: z.enum(RESOURCES) }).strict(),
    output: z.object({ value: z.array(z.unknown()), revision: z.string() }),
  },
  resourcePut: {
    input: z
      .object({ resource: z.enum(RESOURCES), value: z.array(z.unknown()), revision: z.string() })
      .strict(),
    output: z.null(),
  },

  usage: { input: z.null(), output: z.object({ data: z.unknown() }) },

  agentsStatus: {
    input: z.null(),
    output: z.object({
      claude: z.object({
        applied: z.boolean(),
        canRestore: z.boolean(),
        settingsPath: z.string(),
        lastBackup: z.string().nullable(),
      }),
      codex: z.object({
        codexHomePath: z.string(),
        generated: z.boolean(),
        envKey: z.string(),
      }),
    }),
  },
  agentsApply: {
    input: z.object({ agent: z.enum(["claude", "codex"]) }).strict(),
    output: z.object({ backupPath: z.string().nullable() }),
  },
  agentsRestore: {
    input: z.object({ agent: z.enum(["claude", "codex"]) }).strict(),
    output: z.object({ detail: z.string() }),
  },
});

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  async function resolveDataDir(): Promise<string> {
    try {
      const config = await bb.sdk.system.config();
      if (config.dataDir.length > 0) return config.dataDir;
    } catch (error) {
      bb.log.warn(`Could not read bb data directory from SDK: ${String(error)}`);
    }
    return process.env.BB_DATA_DIR ?? join(homedir(), ".bb");
  }

  const homeDir = homedir();
  const dataDir = await resolveDataDir();
  const instance = resolveAgentProxyInstance(dataDir, { homeDir });
  const instanceDefaults = createAgentProxyDefaults(instance.defaultPort);
  const paths: Paths = buildPaths(dataDir);
  function serviceDefinitionPath(label: string): string {
    return process.platform === "darwin"
      ? join(homeDir, "Library", "LaunchAgents", `${label}.plist`)
      : systemdUserUnitPath(homeDir, label);
  }
  function secureAuthDirectory(): void {
    ensureDir(paths.authDir);
    chmodSync(paths.authDir, 0o700);
    for (const entry of readdirSync(paths.authDir, { withFileTypes: true })) {
      if (entry.isFile()) chmodSync(join(paths.authDir, entry.name), 0o600);
    }
  }

  ensureDir(paths.binDir);
  secureAuthDirectory();
  ensureDir(paths.secretsDir);
  ensureDir(paths.backupsDir);

  const generatedManagementKey = loadOrCreateKey(paths.managementKeyPath);
  const localApiKey = loadOrCreateKey(paths.localApiKeyPath);

  let migratedLegacySettings = false;
  const storedConfiguration = await bb.storage.kv.get<unknown>(SETTINGS_STORAGE_KEY);
  let configuration: AgentProxySettings;
  if (storedConfiguration === undefined) {
    const legacySettings = bb.settings.define({
      autostart: {
        type: "boolean",
        label: "Autostart",
        default: instanceDefaults.autostart,
      },
      cloudflareQuickTunnelForCursor: {
        type: "boolean",
        label: "Cloudflare Quick Tunnel for Cursor",
        default: instanceDefaults.cloudflareQuickTunnelForCursor,
      },
      port: {
        type: "string",
        label: "Proxy listen port",
        default: String(instanceDefaults.port),
      },
      sourceRepository: {
        type: "string",
        label: "Core source repository",
        default: instanceDefaults.sourceRepository,
      },
      sourceBranch: {
        type: "string",
        label: "Core source branch",
        default: instanceDefaults.sourceBranch,
      },
      managementKey: { type: "string", label: "Management API key", secret: true },
      routingStrategy: {
        type: "string",
        label: "Credential routing strategy",
        default: instanceDefaults.routingStrategy,
      },
    });
    const legacyValues = await legacySettings.get();
    configuration = migrateAgentProxySettings(legacyValues, instanceDefaults);
    const legacyManagementKey = legacyValues.managementKey?.trim();
    if (legacyManagementKey) {
      writeAtomic(paths.managementKeyOverridePath, `${legacyManagementKey}\n`, 0o600);
    }
    await bb.storage.kv.set(SETTINGS_STORAGE_KEY, configuration);
    migratedLegacySettings = true;
  } else {
    configuration = migrateAgentProxySettings(storedConfiguration, instanceDefaults);
    if (JSON.stringify(configuration) !== JSON.stringify(storedConfiguration)) {
      await bb.storage.kv.set(SETTINGS_STORAGE_KEY, configuration);
    }
  }

  function managementKeyOverride(): string | null {
    return readTextOr(paths.managementKeyOverridePath)?.trim() || null;
  }

  async function effectiveSettings(): Promise<{
    port: number;
    managementKey: string;
    autostart: boolean;
    cloudflareQuickTunnelForCursor: boolean;
    routingStrategy: string;
  }> {
    return {
      port: configuration.port,
      managementKey: managementKeyOverride() ?? generatedManagementKey,
      autostart: configuration.autostart,
      cloudflareQuickTunnelForCursor: configuration.cloudflareQuickTunnelForCursor,
      routingStrategy: configuration.routingStrategy,
    };
  }

  async function sourceSettingsView() {
    const repository = configuration.sourceRepository;
    const branch = configuration.sourceBranch;
    try {
      const source = normalizeCoreSource(repository, branch);
      return {
        repository: source.repo,
        branch: source.ref,
        error: null,
      };
    } catch (error) {
      return {
        repository,
        branch,
        error: String(error instanceof Error ? error.message : error),
      };
    }
  }

  async function configuredSource(): Promise<CoreSource> {
    return normalizeCoreSource(configuration.sourceRepository, configuration.sourceBranch);
  }

  async function configurationView() {
    const source = await sourceSettingsView();
    return {
      values: configuration,
      defaults: instanceDefaults,
      managementKeyConfigured: managementKeyOverride() !== null,
      sourceError: source.error,
    };
  }

  const initial = await effectiveSettings();
  const initialSource = await sourceSettingsView();
  const tunnelHostRuntime: TunnelHostRuntime = resolveTunnelHostRuntime();
  let bundledTunnelRuntime: BundledTunnelRuntime | null = null;
  let bundledTunnelRuntimeError: string | null = null;
  try {
    bundledTunnelRuntime = loadBundledTunnelRuntime({ runtimeDir: paths.tunnelRuntimeDir });
  } catch (error) {
    bundledTunnelRuntimeError = String(error instanceof Error ? error.message : error);
  }
  let currentPort = initial.port;
  let currentManagementKey = initial.managementKey;
  let tunnelEnabled = initial.cloudflareQuickTunnelForCursor;
  let desiredRunning = initial.autostart || tunnelEnabled;
  let tunnelDiscovery: CloudflaredDiscovery | null = null;
  let tunnelPreparationError: string | null = bundledTunnelRuntimeError;
  let tunnelStopError: string | null = null;
  let tunnelRuntimeValidated = false;
  let acceptingOperations = true;
  let initialized = false;
  let operationTail: Promise<void> = Promise.resolve();
  let initializationTask: Promise<void> | null = null;
  let currentRuntimeFingerprint = runtimeConfigFingerprint(initial);
  let supervisor: CoreSupervisor;
  let tunnelSupervisor: PersistentService;
  const pluginAbort = new AbortController();

  function enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    if (!acceptingOperations)
      return Promise.reject(new Error("agent-proxy plugin is shutting down"));
    const result = operationTail.then(async () => {
      if (pluginAbort.signal.aborted) throw new Error("agent-proxy plugin is shutting down");
      return operation();
    });
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function persistCoreConfig(effective: {
    port: number;
    managementKey: string;
    autostart: boolean;
    routingStrategy: string;
  }): void {
    const config = {
      port: effective.port,
      managementKey: effective.managementKey,
      localApiKey,
      authDir: paths.authDir,
      routingStrategy: effective.routingStrategy,
    };
    if (existsSync(paths.configPath)) {
      reconcileConfigFile(paths.configPath, config);
    } else {
      writeAtomic(paths.configPath, renderInitialConfig(config), 0o600);
      bb.log.info(`wrote initial core config at ${paths.configPath}`);
    }
    adoptCoreSettings(effective);
  }

  function adoptCoreSettings(effective: {
    port: number;
    managementKey: string;
    routingStrategy: string;
  }): void {
    currentPort = effective.port;
    currentManagementKey = effective.managementKey;
    currentRuntimeFingerprint = runtimeConfigFingerprint(effective);
  }

  function markRuntimeApplied(): void {
    writeAtomic(paths.runtimeFingerprintPath, `${currentRuntimeFingerprint}\n`, 0o600);
  }

  async function startManagedService(): Promise<SupervisorSnapshot> {
    const snapshot = await supervisor.start();
    if (snapshot.loaded) markRuntimeApplied();
    return snapshot;
  }

  async function restartManagedService(): Promise<SupervisorSnapshot> {
    const snapshot = await supervisor.restart();
    if (snapshot.loaded) markRuntimeApplied();
    return snapshot;
  }

  function persistTunnelConfig(cloudflaredPath: string): void {
    writeAtomic(
      paths.tunnelConfigPath,
      renderTunnelDesiredConfig({
        version: 1,
        corePort: currentPort,
        cloudflaredPath,
        localApiKeyPath: paths.localApiKeyPath,
      }),
      0o600,
    );
  }

  async function tryStopTunnel(): Promise<unknown | null> {
    try {
      await tunnelSupervisor.stop();
      tunnelStopError = null;
      return null;
    } catch (error) {
      tunnelStopError = `Could not stop the public tunnel: ${String(
        error instanceof Error ? error.message : error,
      )}`;
      bb.realtime.publish("status", { tunnelChanged: true });
      return error;
    }
  }

  async function startTunnel(): Promise<void> {
    await tunnelSupervisor.start();
    tunnelStopError = null;
  }

  async function prepareTunnel(): Promise<boolean> {
    if (!tunnelEnabled) return false;
    tunnelDiscovery = discoverCloudflared();
    if (tunnelDiscovery.state === "missing") {
      tunnelPreparationError = null;
      await tryStopTunnel();
      return false;
    }
    if (bundledTunnelRuntime === null) {
      tunnelPreparationError =
        bundledTunnelRuntimeError ?? "the packaged Cloudflare tunnel helper source is missing";
      await tryStopTunnel();
      return false;
    }
    if (!tunnelRuntimeValidated) {
      const installed = await installTunnelRuntime({
        runtime: bundledTunnelRuntime,
        hostRuntime: tunnelHostRuntime,
      });
      if (installed.state === "blocked") {
        tunnelPreparationError = installed.detail;
        await tryStopTunnel();
        return false;
      }
      tunnelRuntimeValidated = true;
    }
    tunnelPreparationError = null;
    persistTunnelConfig(tunnelDiscovery.path);
    return true;
  }

  async function reconcileTunnelForCore(snapshot: SupervisorSnapshot): Promise<void> {
    if (!tunnelEnabled || !snapshot.loaded) return;
    if (await prepareTunnel()) {
      await startTunnel();
      return;
    }
    if (tunnelStopError !== null) {
      await supervisor.stop();
      throw new Error(tunnelStopError);
    }
  }

  async function startManagedStack(): Promise<SupervisorSnapshot> {
    if (!tunnelEnabled && tunnelStopError !== null) {
      const stopError = await tryStopTunnel();
      if (stopError !== null) {
        await supervisor.stop();
        throw stopError;
      }
    }
    const snapshot = await startManagedService();
    await reconcileTunnelForCore(snapshot);
    return snapshot;
  }

  async function stopManagedStack(): Promise<SupervisorSnapshot> {
    const tunnelError = await tryStopTunnel();
    const snapshot = await supervisor.stop();
    if (tunnelError !== null) throw tunnelError;
    return snapshot;
  }

  /** One-time retirement of login services installed under an older label. Stops
      each one through the same supervisor that installed it, then deletes its
      definition so reconciliation installs only the current label. Idempotent:
      a missing definition is skipped, and a service the operating system no
      longer knows never blocks the removal.

      Returns true when a legacy definition was actually removed. The caller
      needs that: reconciliation only starts a service it found already loaded,
      so retiring one without saying so would take the core down and leave
      nothing in its place until someone pressed Start. */
  async function retireLegacyServices(): Promise<boolean> {
    let retired = false;
    for (const label of LEGACY_SERVICE_LABELS) {
      const definitionPath = serviceDefinitionPath(label);
      if (!existsSync(definitionPath)) continue;
      try {
        await createSupervisor(label).stop();
      } catch (error) {
        bb.log.warn(`could not stop the legacy login service ${label}: ${String(error)}`);
      }
      rmSync(definitionPath, { force: true });
      retired = true;
      bb.log.info(`removed the legacy login service ${label} at ${definitionPath}`);
    }
    return retired;
  }

  async function retireCurrentDevelopmentSharedServices(): Promise<boolean> {
    if (instance.kind !== "development") return false;

    const sharedCore = createSupervisor(SHARED_SERVICE_LABEL);
    const sharedTunnel = createTunnelSupervisor(SHARED_TUNNEL_SERVICE_LABEL);
    const retired = await retireCurrentDevOwnedSharedServices({
      tunnel: {
        name: "tunnel",
        label: sharedTunnel.label,
        definitionPath: sharedTunnel.definitionPath,
        expectedDefinition: sharedTunnel.definition(),
        requiredOwnedPaths: [
          bundledTunnelRuntime?.targetPath ??
            join(paths.tunnelRuntimeDir, "unavailable-runtime.mjs"),
          paths.tunnelConfigPath,
          paths.tunnelObservationPath,
          paths.tunnelDir,
          paths.tunnelLogPath,
        ],
        stop: () => sharedTunnel.stop(),
      },
      core: {
        name: "core",
        label: sharedCore.label,
        definitionPath: sharedCore.definitionPath,
        expectedDefinition: sharedCore.definition(),
        requiredOwnedPaths: [
          paths.binPath,
          paths.configPath,
          dirname(paths.configPath),
          paths.serviceLogPath,
        ],
        stop: () => sharedCore.stop(),
      },
    });
    if (retired.retiredTunnel) {
      bb.log.info(
        `moved the development tunnel service from ${SHARED_TUNNEL_SERVICE_LABEL} to ${instance.tunnelLabel}`,
      );
    }
    if (retired.retiredCore) {
      bb.log.info(
        `moved the development core service from ${SHARED_SERVICE_LABEL} to ${instance.coreLabel}`,
      );
    }
    return retired.retiredTunnel || retired.retiredCore;
  }

  function initialize(): Promise<void> {
    if (initialized) return Promise.resolve();
    initializationTask ??= enqueue(async () => {
      cleanStaleStaging(paths.coreDir);
      migrateLegacyInstall(paths);
      const retiredLegacyService = await retireLegacyServices();
      const retiredSharedDevelopmentService = await retireCurrentDevelopmentSharedServices();
      if (!tunnelEnabled && (await tryStopTunnel()) !== null) await supervisor.stop();
      secureAuthDirectory();
      const effective = await effectiveSettings();
      const desiredFingerprint = runtimeConfigFingerprint(effective);
      const snapshot = await supervisor.snapshot();
      const plan = planRuntimeReconciliation({
        appliedFingerprint: readTextOr(paths.runtimeFingerprintPath)?.trim() || null,
        desiredFingerprint,
        desiredRunning,
        serviceLoaded: snapshot.loaded,
      });
      if (plan.stopBeforeWrite) await supervisor.stop();
      if (plan.writeConfig) persistCoreConfig(effective);
      else adoptCoreSettings(effective);
      if (tunnelEnabled) await prepareTunnel();
      // The planner starts only a service it found loaded, which is right for a
      // fresh install and wrong straight after a retirement: the core WAS
      // running, under the old label. Re-adopt it under the new one.
      const replaceRetiredService =
        (retiredLegacyService || retiredSharedDevelopmentService) &&
        desiredRunning &&
        !snapshot.loaded;
      if (plan.startAfterWrite || replaceRetiredService) {
        await startManagedStack();
      } else if (tunnelEnabled && desiredRunning) {
        await reconcileTunnelForCore(snapshot);
      }
      initialized = true;
    });
    return initializationTask;
  }

  function createSupervisor(
    label: string,
    hooks: {
      onChange?: (snapshot: SupervisorSnapshot) => void;
      onError?: (error: unknown) => void;
    } = {},
  ): CoreSupervisor {
    const supervisorOptions = {
      label,
      binPath: paths.binPath,
      configPath: paths.configPath,
      logPath: paths.serviceLogPath,
      isInstalled: () => installedVersion(paths) !== null,
      probeUrl: () => `http://127.0.0.1:${currentPort}/`,
      ...hooks,
    };
    switch (process.platform) {
      case "darwin": {
        const uid = process.getuid?.();
        if (uid === undefined) {
          throw new Error("agent-proxy launchd service requires a POSIX user id");
        }
        return new LaunchdSupervisor({
          ...supervisorOptions,
          uid,
          plistPath: serviceDefinitionPath(label),
        });
      }
      case "linux":
        return new SystemdSupervisor({
          ...supervisorOptions,
          unitPath: serviceDefinitionPath(label),
        });
      default:
        throw new Error(`agent-proxy does not support persistent services on ${process.platform}`);
    }
  }

  function createTunnelSupervisor(
    label: string,
    hooks: {
      onChange?: (snapshot: SupervisorSnapshot) => void;
      onError?: (error: unknown) => void;
    } = {},
  ): PersistentService {
    return createCloudflareTunnelService({
      label,
      definitionPath: serviceDefinitionPath(label),
      runtimePath:
        bundledTunnelRuntime?.targetPath ?? join(paths.tunnelRuntimeDir, "unavailable-runtime.mjs"),
      hostRuntime: tunnelHostRuntime,
      configPath: paths.tunnelConfigPath,
      observationPath: paths.tunnelObservationPath,
      workingDirectory: paths.tunnelDir,
      logPath: paths.tunnelLogPath,
      readinessUrl: () => `http://127.0.0.1:${currentPort}/`,
      uid: process.getuid?.(),
      ...hooks,
    });
  }

  supervisor = createSupervisor(instance.coreLabel, {
    onChange: (snapshot: SupervisorSnapshot) => {
      bb.realtime.publish("status", snapshot);
    },
    onError: (error: unknown) => {
      bb.log.error(`service monitor failed: ${String(error)}`);
    },
  });
  tunnelSupervisor = createTunnelSupervisor(instance.tunnelLabel, {
    onChange: () => {
      bb.realtime.publish("status", { tunnelChanged: true });
    },
    onError: (error: unknown) => {
      bb.log.error(`Cloudflare tunnel service monitor failed: ${String(error)}`);
    },
  });

  bb.background.service("core", {
    async start(signal) {
      await initialize();
      if (desiredRunning) await startManagedStack();
      else if (installedVersion(paths) !== null) await stopManagedStack();
      await Promise.all([
        supervisor.monitor(signal),
        tunnelSupervisor.monitor(signal),
        monitorTunnelObservation({
          path: paths.tunnelObservationPath,
          signal,
          onChange: () => bb.realtime.publish("status", { tunnelChanged: true }),
        }),
      ]);
    },
  });
  bb.onDispose(async () => {
    acceptingOperations = false;
    pluginAbort.abort(new Error("agent-proxy plugin disposed"));
    await operationTail;
  });

  async function managementClient(): Promise<ManagementClient> {
    await initialize();
    return new ManagementClient({ port: currentPort, key: currentManagementKey });
  }

  async function cachedLatest(source: CoreSource): Promise<LatestCache | null> {
    const cached = (await bb.storage.kv.get<LatestCache>(LATEST_CACHE_KEY)) ?? null;
    return cached?.repo === source.repo && cached.ref === source.ref ? cached : null;
  }

  async function refreshLatest(): Promise<LatestCache> {
    const source = await configuredSource();
    const cached = await cachedLatest(source);
    if (cached && Date.now() - cached.checkedAt < LATEST_CACHE_TTL_MS) return cached;
    const revision = await fetchSourceRevision(source, fetch, pluginAbort.signal);
    const next: LatestCache = {
      repo: source.repo,
      ref: source.ref,
      version: revision.version,
      checkedAt: Date.now(),
    };
    await bb.storage.kv.set(LATEST_CACHE_KEY, next);
    return next;
  }

  async function computeStatus(): Promise<CoreStatus> {
    await initialize();
    const snapshot = await supervisor.snapshot();
    let tunnel: TunnelStatus;
    try {
      const tunnelSnapshot = await tunnelSupervisor.snapshot();
      tunnel = deriveTunnelStatus({
        enabled: tunnelEnabled,
        coreDesiredRunning: desiredRunning,
        coreLoaded: snapshot.loaded,
        discovery: tunnelDiscovery,
        preparationError: tunnelPreparationError,
        stopError: tunnelStopError,
        service: tunnelSnapshot,
        observation: readTunnelObservation(paths.tunnelObservationPath),
      });
    } catch (error) {
      tunnel = {
        state: "crashed",
        lastExit: null,
        detail:
          tunnelStopError ??
          `Could not inspect the public tunnel service: ${String(
            error instanceof Error ? error.message : error,
          )}`,
      };
    }
    const sourceView = await sourceSettingsView();
    const latest =
      sourceView.error === null
        ? await cachedLatest({ repo: sourceView.repository, ref: sourceView.branch })
        : null;
    return {
      state: snapshot.state,
      pid: snapshot.pid,
      port: currentPort,
      installedVersion: installedVersion(paths),
      crashCount: snapshot.crashCount,
      lastExit: snapshot.lastExit,
      endpoints: endpointsFor(currentPort),
      service: {
        manager: supervisor.manager,
        label: supervisor.label,
        definitionPath: supervisor.definitionPath,
        loaded: snapshot.loaded,
      },
      source: {
        repository: sourceView.repository,
        branch: sourceView.branch,
        error: sourceView.error,
      },
      latest,
      tunnel,
    };
  }

  async function runInstall(ref: string | undefined): Promise<string> {
    const configured = await configuredSource();
    const source = ref === undefined ? configured : { ...configured, ref: normalizeCoreRef(ref) };
    const revision = await fetchSourceRevision(source, fetch, pluginAbort.signal);
    let stoppedForSwap = false;
    try {
      const installed = await installCore(paths, revision, {
        signal: pluginAbort.signal,
        onProgress: (stage) => bb.realtime.publish("install", { stage, version: revision.version }),
        beforeInstall: async () => {
          stoppedForSwap = true;
          await supervisor.stop();
        },
      });
      if (source.repo === configured.repo && source.ref === configured.ref) {
        await bb.storage.kv.set(LATEST_CACHE_KEY, {
          repo: source.repo,
          ref: source.ref,
          version: revision.version,
          checkedAt: Date.now(),
        } satisfies LatestCache);
      }
      bb.log.info(`installed CLIProxyAPI ${installed}`);
      return installed;
    } finally {
      if (stoppedForSwap && desiredRunning) await startManagedStack();
      else await supervisor.snapshot();
    }
  }

  async function requestInstall(ref: string | undefined): Promise<string> {
    await initialize();
    return enqueue(() => runInstall(ref));
  }

  async function requestStart(): Promise<CoreStatus> {
    desiredRunning = true;
    await initialize();
    return enqueue(async () => {
      await startManagedStack();
      return computeStatus();
    });
  }

  async function requestStop(): Promise<CoreStatus> {
    desiredRunning = false;
    await initialize();
    return enqueue(async () => {
      await stopManagedStack();
      return computeStatus();
    });
  }

  async function requestRestart(): Promise<CoreStatus> {
    desiredRunning = true;
    await initialize();
    return enqueue(async () => {
      const snapshot = await restartManagedService();
      await reconcileTunnelForCore(snapshot);
      return computeStatus();
    });
  }

  async function updateConfiguration(
    requested: AgentProxySettings,
    managementKeyUpdate:
      | { action: "keep" }
      | { action: "clear" }
      | { action: "set"; value: string },
  ) {
    const source = normalizeCoreSource(requested.sourceRepository, requested.sourceBranch);
    const next: AgentProxySettings = {
      ...requested,
      sourceRepository: source.repo,
      sourceBranch: source.ref,
    };
    const nextManagementKey =
      managementKeyUpdate.action === "set" ? managementKeyUpdate.value.trim() : null;
    if (managementKeyUpdate.action === "set" && !nextManagementKey) {
      throw new Error("Management API key cannot be empty");
    }

    await initialize();
    return enqueue(async () => {
      const previous = configuration;
      const previousManagementKey = managementKeyOverride();
      const resolvedManagementKey =
        managementKeyUpdate.action === "keep"
          ? previousManagementKey
          : managementKeyUpdate.action === "clear"
            ? null
            : nextManagementKey;
      const managementKeyChanged = resolvedManagementKey !== previousManagementKey;

      await bb.storage.kv.set(SETTINGS_STORAGE_KEY, next);
      try {
        if (resolvedManagementKey === null) {
          rmSync(paths.managementKeyOverridePath, { force: true });
        } else if (managementKeyChanged) {
          writeAtomic(paths.managementKeyOverridePath, `${resolvedManagementKey}\n`, 0o600);
        }
      } catch (error) {
        await bb.storage.kv.set(SETTINGS_STORAGE_KEY, previous);
        throw error;
      }
      configuration = next;

      const sourceChanged =
        next.sourceRepository !== previous.sourceRepository ||
        next.sourceBranch !== previous.sourceBranch;
      if (sourceChanged) {
        await bb.storage.kv.delete(LATEST_CACHE_KEY);
        bb.realtime.publish("status", { sourceChanged: true });
      }
      const runtimeChanged =
        next.port !== previous.port ||
        managementKeyChanged ||
        next.routingStrategy !== previous.routingStrategy;
      const autostartChanged = next.autostart !== previous.autostart;
      const tunnelChanged =
        next.cloudflareQuickTunnelForCursor !== previous.cloudflareQuickTunnelForCursor;
      if (autostartChanged || tunnelChanged) {
        tunnelEnabled = next.cloudflareQuickTunnelForCursor;
        desiredRunning = next.autostart || tunnelEnabled;
      }
      if (runtimeChanged || autostartChanged || tunnelChanged) {
        const tunnelStopFailure = !tunnelEnabled || !desiredRunning ? await tryStopTunnel() : null;
        if (!tunnelEnabled && tunnelStopFailure !== null) {
          await supervisor.stop();
        } else {
          if (runtimeChanged) {
            const effective = await effectiveSettings();
            await supervisor.stop();
            try {
              persistCoreConfig(effective);
              if (tunnelEnabled && tunnelDiscovery?.state === "found") {
                persistTunnelConfig(tunnelDiscovery.path);
              }
              bb.log.info(`core settings reconciled on port ${effective.port}`);
            } finally {
              if (desiredRunning) await startManagedService();
            }
          } else if (desiredRunning) {
            await startManagedService();
          }
          if (!desiredRunning) {
            await stopManagedStack();
          } else if (tunnelEnabled) {
            const snapshot = await supervisor.snapshot();
            await reconcileTunnelForCore(snapshot);
          }
        }
      }

      bb.realtime.publish("status", { configurationChanged: true });
      return configurationView();
    });
  }

  // -------------------------------------------------------------------------
  // Agents wiring helpers
  // -------------------------------------------------------------------------

  const claudeSettingsPath = join(homedir(), ".claude", "settings.json");

  async function readClaudeSettings(): Promise<{ content: string | null; sha256: string | null }> {
    if (!existsSync(claudeSettingsPath)) return { content: null, sha256: null };
    const file = await bb.sdk.files.read({ path: claudeSettingsPath });
    if (file.contentEncoding !== "utf8") {
      throw new Error(`${claudeSettingsPath} is not a text file`);
    }
    return { content: file.content, sha256: file.sha256 };
  }

  async function writeClaudeSettings(
    content: string,
    expectedSha256: string | null,
  ): Promise<void> {
    const saved = await bb.sdk.files.write({
      path: claudeSettingsPath,
      content,
      expectedSha256,
      createParents: true,
      mode: 0o600,
    });
    if (saved.outcome === "conflict") {
      throw new Error(`${claudeSettingsPath} changed while applying; retry`);
    }
  }

  function readClaudeState(path: string): ClaudeEnvState | null {
    const raw = readTextOr(path);
    if (raw === null) return null;
    try {
      const parsed = claudeEnvStateSchema.safeParse(JSON.parse(raw));
      return parsed.success ? (parsed.data as ClaudeEnvState) : null;
    } catch {
      return null;
    }
  }

  /** Recover an Apply interrupted between the user-file CAS and ownership-state
      commit. The prior committed state remains untouched until the CAS wins. */
  function reconcileClaudeState(content: string | null): ClaudeEnvState | null {
    if (existsSync(paths.claudePendingStatePath)) {
      const pending = readClaudeState(paths.claudePendingStatePath);
      if (pending !== null && claudeApplied(content, pending.applied)) {
        renameSync(paths.claudePendingStatePath, paths.claudeStatePath);
        return pending;
      }
      rmSync(paths.claudePendingStatePath, { force: true });
    }
    return readClaudeState(paths.claudeStatePath);
  }

  function lastClaudeBackup(): string | null {
    try {
      const backups = readdirSync(paths.backupsDir)
        .filter((name) => name.startsWith(`${CLAUDE_BACKUP_BASE}.`))
        .sort();
      const newest = backups.at(-1);
      return newest ? join(paths.backupsDir, newest) : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // RPC handlers
  // -------------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    status: () => computeStatus(),
    coreLogs: () => ({ lines: supervisor.logs() }),
    async connectivity() {
      await initialize();
      const port = currentPort;
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
      } catch {
        return { ok: false, detail: `nothing is listening on 127.0.0.1:${port}` };
      }
      try {
        const client = await managementClient();
        await client.authFiles();
        return {
          ok: true,
          detail: `core is up and the management API accepts the key on port ${port}`,
        };
      } catch (error) {
        const detail =
          error instanceof ManagementError
            ? `port ${port} answers but the management API does not: ${error.message}`
            : String(error);
        return { ok: false, detail };
      }
    },
    async checkLatest() {
      await bb.storage.kv.delete(LATEST_CACHE_KEY);
      const latest = await refreshLatest();
      const installed = installedVersion(paths);
      return {
        latest: latest.version,
        installed,
        updateAvailable: installed !== latest.version,
      };
    },
    async install({ ref }) {
      return { installedVersion: await requestInstall(ref) };
    },
    async start() {
      return requestStart();
    },
    async stop() {
      return requestStop();
    },
    async restart() {
      return requestRestart();
    },
    async endpoints() {
      const status = await computeStatus();
      return {
        ...endpointsFor(currentPort),
        apiKey: localApiKey,
        publicOpenai: status.tunnel.state === "ready" ? status.tunnel.openaiBaseUrl : null,
      };
    },
    configuration: () => configurationView(),
    async configurationUpdate({ managementKey, ...values }) {
      return updateConfiguration(values, managementKey);
    },

    async oauthStart({ provider }) {
      const client = await managementClient();
      return client.authUrl(provider as OAuthProvider);
    },
    async oauthPoll({ state }) {
      const client = await managementClient();
      return client.authStatus(state);
    },
    async authFiles() {
      const client = await managementClient();
      return { files: await client.authFiles() };
    },
    async authFileStatus({ name, disabled }) {
      await initialize();
      return enqueue(async () => {
        const client = await managementClient();
        await client.setAuthFileStatus(name, disabled);
        return null;
      });
    },
    async authFileDelete({ name }) {
      await initialize();
      return enqueue(async () => {
        const client = await managementClient();
        await client.deleteAuthFile(name);
        return null;
      });
    },
    async resetQuota({ authIndex }) {
      await initialize();
      return enqueue(async () => {
        const client = await managementClient();
        await client.resetQuota(authIndex);
        return null;
      });
    },

    async resourceGet({ resource }) {
      const client = await managementClient();
      const value = await client.getResource(resource);
      return { value, revision: resourceRevision(value) };
    },
    async resourcePut({ resource, value, revision }) {
      await initialize();
      return enqueue(async () => {
        const client = new ManagementClient({ port: currentPort, key: currentManagementKey });
        const current = await client.getResource(resource);
        if (resourceRevision(current) !== revision) {
          throw new Error(`${resource} changed since it was loaded; reload before saving`);
        }
        const next =
          resource === "api-keys" && !value.includes(localApiKey) ? [localApiKey, ...value] : value;
        await client.putResource(resource, next);
        return null;
      });
    },

    async usage() {
      const client = await managementClient();
      return { data: await client.usage() };
    },

    async agentsStatus() {
      await initialize();
      const { content } = await readClaudeSettings();
      const target = { baseUrl: endpointsFor(currentPort).anthropic, token: localApiKey };
      const state = reconcileClaudeState(content);
      return {
        claude: {
          applied:
            state !== null &&
            state.applied.baseUrl === target.baseUrl &&
            state.applied.token === target.token &&
            claudeApplied(content, target),
          canRestore: state !== null,
          settingsPath: claudeSettingsPath,
          lastBackup: lastClaudeBackup(),
        },
        codex: {
          codexHomePath: paths.codexHomeDir,
          generated: existsSync(paths.codexConfigPath),
          envKey: CODEX_ENV_KEY,
        },
      };
    },
    async agentsApply({ agent }) {
      await initialize();
      return enqueue(async () => {
        if (agent === "claude") {
          const { content, sha256 } = await readClaudeSettings();
          const target = { baseUrl: endpointsFor(currentPort).anthropic, token: localApiKey };
          const backupPath =
            content !== null
              ? timestampedBackup(content, paths.backupsDir, CLAUDE_BACKUP_BASE)
              : null;
          const state = captureClaudeEnvState(content, target, reconcileClaudeState(content));
          writeAtomic(paths.claudePendingStatePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
          try {
            await writeClaudeSettings(applyClaudeEnv(content, target), sha256);
          } catch (error) {
            rmSync(paths.claudePendingStatePath, { force: true });
            throw error;
          }
          renameSync(paths.claudePendingStatePath, paths.claudeStatePath);
          bb.log.info(`applied proxy env to ${claudeSettingsPath}`);
          return { backupPath };
        }
        writeAtomic(
          paths.codexConfigPath,
          renderCodexConfig(endpointsFor(currentPort).openai),
          0o600,
        );
        bb.log.info(`generated Codex home at ${paths.codexHomeDir}`);
        return { backupPath: null };
      });
    },
    async agentsRestore({ agent }) {
      await initialize();
      return enqueue(async () => {
        if (agent === "claude") {
          const { content, sha256 } = await readClaudeSettings();
          const state = reconcileClaudeState(content);
          if (state === null) return { detail: "no plugin-owned Claude settings to restore" };
          if (content === null) {
            rmSync(paths.claudeStatePath, { force: true });
            return { detail: "settings file does not exist; cleared stale restore state" };
          }
          const restored = restoreClaudeEnv(content, state);
          if (restored.changed) await writeClaudeSettings(restored.content, sha256);
          rmSync(paths.claudeStatePath, { force: true });
          return {
            detail: restored.preservedUserChanges
              ? `restored plugin-owned values in ${claudeSettingsPath}; preserved later user changes`
              : `restored previous values in ${claudeSettingsPath}`,
          };
        }
        if (!existsSync(paths.codexConfigPath)) {
          return { detail: "no generated Codex config to remove" };
        }
        rmSync(paths.codexConfigPath, { force: true });
        try {
          if (readdirSync(paths.codexHomeDir).length === 0) rmdirSync(paths.codexHomeDir);
        } catch {
          // Codex may have created state beside config.toml; preserve it.
        }
        return {
          detail: `removed generated config at ${paths.codexConfigPath}; preserved other Codex state`,
        };
      });
    },
  });

  // -------------------------------------------------------------------------
  // CLI
  // -------------------------------------------------------------------------

  bb.cli.register({
    name: "agent-proxy",
    summary:
      "Manage the local CLIProxyAPI core (status, lifecycle, endpoints, OAuth, providers, usage)",
    commands: [
      {
        name: "status",
        summary: "Core and tunnel state, versions, and endpoints",
        usage: "bb agent-proxy status",
      },
      { name: "start", summary: "Start the proxy core", usage: "bb agent-proxy start" },
      { name: "stop", summary: "Stop the proxy core", usage: "bb agent-proxy stop" },
      { name: "restart", summary: "Restart the proxy core", usage: "bb agent-proxy restart" },
      {
        name: "endpoints",
        summary: "Print local endpoints, the API key, and the ready public endpoint",
        usage: "bb agent-proxy endpoints",
      },
      {
        name: "install",
        summary:
          "Build and install the CLIProxyAPI core from the configured source (or another ref)",
        usage: "bb agent-proxy install [ref]",
      },
      {
        name: "oauth",
        summary: "Run a browser OAuth flow for an account",
        usage: "bb agent-proxy oauth <claude|codex>",
      },
      {
        name: "providers",
        summary: "List configured provider credentials and OAuth auth files",
        usage: "bb agent-proxy providers",
      },
      {
        name: "usage",
        summary: "Recent request buckets per provider key",
        usage: "bb agent-proxy usage",
      },
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;
      try {
        switch (command) {
          case "status": {
            const status = await computeStatus();
            const lines = [
              `state: ${status.state}${status.pid !== null ? ` (pid ${status.pid})` : ""}`,
              `port: ${status.port}`,
              `service: ${status.service.manager} (${status.service.loaded ? "loaded" : "not loaded"})`,
              `service definition: ${status.service.definitionPath}`,
              `installed: ${status.installedVersion ?? "not installed"}`,
              `source: ${status.source.repository}#${status.source.branch}`,
              `latest: ${status.latest?.version ?? "unknown (run: bb agent-proxy install)"}`,
              `openai: ${status.endpoints.openai}`,
              `anthropic: ${status.endpoints.anthropic}`,
              `gemini: ${status.endpoints.gemini}`,
              `tunnel: ${status.tunnel.state}`,
            ];
            if ("detail" in status.tunnel) lines.push(`tunnel detail: ${status.tunnel.detail}`);
            if (status.tunnel.state === "ready") {
              lines.push(`public openai: ${status.tunnel.openaiBaseUrl}`);
            }
            if (status.lastExit) {
              lines.push(
                `last exit: code ${status.lastExit.code ?? "null"} signal ${status.lastExit.signal ?? "null"} (${new Date(status.lastExit.at).toISOString()})`,
              );
            }
            if (status.source.error) lines.push(`source error: ${status.source.error}`);
            return { exitCode: 0, stdout: lines.join("\n") };
          }
          case "start": {
            await requestStart();
            return { exitCode: 0, stdout: "start requested" };
          }
          case "stop": {
            await requestStop();
            return { exitCode: 0, stdout: "stopped" };
          }
          case "restart": {
            await requestRestart();
            return { exitCode: 0, stdout: "restart requested" };
          }
          case "endpoints": {
            const status = await computeStatus();
            const endpoints = endpointsFor(currentPort);
            const lines = [
              `openai: ${endpoints.openai}`,
              `anthropic: ${endpoints.anthropic}`,
              `gemini: ${endpoints.gemini}`,
              `api key: ${localApiKey}`,
              `tunnel: ${status.tunnel.state}`,
            ];
            if (status.tunnel.state === "ready") {
              lines.push(`public openai: ${status.tunnel.openaiBaseUrl}`);
            }
            return { exitCode: 0, stdout: lines.join("\n") };
          }
          case "install": {
            const version = await requestInstall(rest[0]);
            return { exitCode: 0, stdout: `installed CLIProxyAPI ${version}` };
          }
          case "oauth": {
            const which = rest[0];
            if (which !== "claude" && which !== "codex") {
              return { exitCode: 2, stderr: "usage: bb agent-proxy oauth <claude|codex>" };
            }
            const client = await managementClient();
            const { url, state } = await client.authUrl(which === "claude" ? "anthropic" : "codex");
            const started = Date.now();
            const signal = (ctx as { signal?: AbortSignal }).signal;
            let outcome = `open this URL in your browser to authorize:\n${url}\n`;
            while (Date.now() - started < 180_000) {
              if (signal?.aborted) return { exitCode: 130, stderr: "cancelled" };
              await new Promise((resolve) => setTimeout(resolve, 2_000));
              const status = await client.authStatus(state);
              if (status.status === "ok") {
                return { exitCode: 0, stdout: `${outcome}\nauthorized — credentials saved` };
              }
              if (status.status === "error") {
                return { exitCode: 1, stderr: `authorization failed: ${status.detail}` };
              }
            }
            return { exitCode: 1, stderr: `${outcome}\ntimed out waiting for authorization` };
          }
          case "providers": {
            const client = await managementClient();
            const lines: string[] = [];
            for (const resource of RESOURCES) {
              const value = await client.getResource(resource);
              lines.push(`${resource}: ${value.length} configured`);
            }
            const files = await client.authFiles();
            lines.push(`auth files: ${files.length}`);
            for (const file of files) {
              const name = typeof file.name === "string" ? file.name : "(unnamed)";
              const disabled = file.disabled === true ? " [disabled]" : "";
              lines.push(`  ${name}${disabled}`);
            }
            return { exitCode: 0, stdout: lines.join("\n") };
          }
          case "usage": {
            const client = await managementClient();
            const data = await client.usage();
            return { exitCode: 0, stdout: JSON.stringify(data, null, 2) };
          }
          default:
            return {
              exitCode: 2,
              stderr:
                "usage: bb agent-proxy <status|start|stop|restart|endpoints|install|oauth|providers|usage>\n" +
                "  status              core and tunnel state, versions, endpoints\n" +
                "  start|stop|restart  control the proxy core\n" +
                "  endpoints           local endpoints, API key, tunnel state, and public endpoint\n" +
                "  install [ref]       build and install the configured GitHub source\n" +
                "  oauth <claude|codex> run a browser OAuth flow\n" +
                "  providers           configured credentials + auth files\n" +
                "  usage               recent request buckets",
            };
        }
      } catch (error) {
        return { exitCode: 1, stderr: String(error instanceof Error ? error.message : error) };
      }
    },
  });

  if (migratedLegacySettings) {
    const migrationReload = setTimeout(() => {
      void bb.sdk.plugins.reload({ pluginId: bb.pluginId }).catch((error: unknown) => {
        bb.log.error(`failed to finish the settings migration reload: ${String(error)}`);
      });
    }, 0);
    bb.onDispose(() => clearTimeout(migrationReload));
  }

  bb.log.info(
    `loaded (core ${installedVersion(paths) ?? "not installed"}, source ${initialSource.repository}#${initialSource.branch}, port ${initial.port}, routing ${initial.routingStrategy}, autostart ${String(initial.autostart)}, Cloudflare tunnel ${String(initial.cloudflareQuickTunnelForCursor)})`,
  );
}
