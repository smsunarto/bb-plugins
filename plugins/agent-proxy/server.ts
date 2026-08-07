import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir, timestampedBackup, writeAtomic } from "./lib/fsx.ts";
import { loadOrCreateKey } from "./lib/keys.ts";
import { buildPaths, type Paths } from "./lib/paths.ts";
import {
  cleanStaleStaging,
  fetchRelease,
  installCore,
  installedVersion,
} from "./lib/core-install.ts";
import { compareVersions } from "./lib/release.ts";
import { renderInitialConfig, setConfigManagementKey, setConfigPort } from "./lib/core-config.ts";
import { Supervisor } from "./lib/core-process.ts";
import {
  ManagementClient,
  ManagementError,
  RESOURCES,
  type OAuthProvider,
} from "./lib/management-client.ts";
import {
  applyClaudeEnv,
  claudeApplied,
  renderCodexConfig,
  stripClaudeEnv,
  CODEX_ENV_KEY,
} from "./lib/agents-config.ts";

const DEFAULT_PORT = 8317;
const LATEST_CACHE_KEY = "latest-release";
const LATEST_CACHE_TTL_MS = 3_600_000;
const CLAUDE_BACKUP_BASE = "claude-settings.json";

interface LatestCache {
  version: string;
  checkedAt: number;
}

function endpointsFor(port: number) {
  const base = `http://127.0.0.1:${port}`;
  return { openai: `${base}/v1`, anthropic: base, gemini: `${base}/v1beta` };
}

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
  latest: z.object({ version: z.string(), checkedAt: z.number() }).nullable(),
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
    input: z.object({ version: z.string().optional() }).strict(),
    output: z.object({ installedVersion: z.string() }),
  },
  start: { input: z.null(), output: statusSchema },
  stop: { input: z.null(), output: statusSchema },
  restart: { input: z.null(), output: statusSchema },
  endpoints: {
    input: z.null(),
    output: endpointsSchema.extend({ apiKey: z.string() }),
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
    output: z.object({ value: z.unknown() }),
  },
  resourcePut: {
    input: z.object({ resource: z.enum(RESOURCES), value: z.array(z.unknown()) }).strict(),
    output: z.null(),
  },

  usage: { input: z.null(), output: z.object({ data: z.unknown() }) },

  agentsStatus: {
    input: z.null(),
    output: z.object({
      claude: z.object({
        applied: z.boolean(),
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
  const settings = bb.settings.define({
    autostart: {
      type: "boolean",
      label: "Start the proxy core when the plugin loads",
      default: true,
    },
    port: { type: "string", label: "Proxy listen port", default: String(DEFAULT_PORT) },
    managementKey: {
      type: "string",
      label: "Management API key override (leave empty to auto-generate)",
      secret: true,
    },
  });

  async function resolveDataDir(): Promise<string> {
    try {
      const config = await bb.sdk.system.config();
      if (config.dataDir.length > 0) return config.dataDir;
    } catch (error) {
      bb.log.warn(`Could not read bb data directory from SDK: ${String(error)}`);
    }
    return process.env.BB_DATA_DIR ?? join(homedir(), ".bb");
  }

  const paths: Paths = buildPaths(await resolveDataDir());
  ensureDir(paths.binDir);
  ensureDir(paths.authDir);
  ensureDir(paths.secretsDir);
  ensureDir(paths.backupsDir);
  cleanStaleStaging(paths.coreDir);

  const generatedManagementKey = loadOrCreateKey(paths.managementKeyPath);
  const localApiKey = loadOrCreateKey(paths.localApiKeyPath);

  async function effectiveSettings(): Promise<{ port: number; managementKey: string; autostart: boolean }> {
    const values = await settings.get();
    const port = Number.parseInt(values.port, 10);
    return {
      port: Number.isFinite(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT,
      managementKey: values.managementKey?.trim() || generatedManagementKey,
      autostart: values.autostart,
    };
  }

  const initial = await effectiveSettings();
  if (!existsSync(paths.configPath)) {
    writeAtomic(
      paths.configPath,
      renderInitialConfig({
        port: initial.port,
        managementKey: initial.managementKey,
        localApiKey,
        authDir: paths.authDir,
      }),
    );
    bb.log.info(`wrote initial core config at ${paths.configPath}`);
  }

  let currentPort = initial.port;

  const supervisor = new Supervisor({
    binPath: paths.binPath,
    configPath: paths.configPath,
    isInstalled: () => installedVersion(paths) !== null,
    probeUrl: () => `http://127.0.0.1:${currentPort}/`,
    onChange: (snapshot) => {
      bb.realtime.publish("status", snapshot);
    },
  });

  bb.background.service("core", {
    start: (signal) => supervisor.run(signal),
  });
  if (initial.autostart && installedVersion(paths) !== null) supervisor.start();
  bb.onDispose(async () => {
    await supervisor.stop();
  });

  async function managementClient(): Promise<ManagementClient> {
    const { port, managementKey } = await effectiveSettings();
    return new ManagementClient({ port, key: managementKey });
  }

  async function cachedLatest(): Promise<LatestCache | null> {
    return (await bb.storage.kv.get<LatestCache>(LATEST_CACHE_KEY)) ?? null;
  }

  async function refreshLatest(): Promise<LatestCache> {
    const cached = await cachedLatest();
    if (cached && Date.now() - cached.checkedAt < LATEST_CACHE_TTL_MS) return cached;
    const release = await fetchRelease(undefined);
    const next: LatestCache = { version: release.version, checkedAt: Date.now() };
    await bb.storage.kv.set(LATEST_CACHE_KEY, next);
    return next;
  }

  async function computeStatus(): Promise<CoreStatus> {
    const snapshot = supervisor.snapshot();
    const { port } = await effectiveSettings();
    return {
      state: snapshot.state,
      pid: snapshot.pid,
      port,
      installedVersion: installedVersion(paths),
      crashCount: snapshot.crashCount,
      lastExit: snapshot.lastExit,
      endpoints: endpointsFor(port),
      latest: await cachedLatest(),
    };
  }

  async function runInstall(version: string | undefined): Promise<string> {
    const release = await fetchRelease(version);
    const wasRunning = supervisor.state === "running" || supervisor.state === "starting";
    if (wasRunning) await supervisor.stop();
    try {
      const installed = await installCore(paths, release, {
        log: (message) => bb.log.warn(message),
        onProgress: (stage) => bb.realtime.publish("install", { stage, version: release.version }),
      });
      bb.log.info(`installed CLIProxyAPI v${installed}`);
      return installed;
    } finally {
      if (wasRunning) supervisor.start();
      else supervisor.poke();
    }
  }

  settings.onChange(async (next, previous) => {
    if (next.port === previous.port && next.managementKey === previous.managementKey) return;
    const effective = await effectiveSettings();
    const wasRunning = supervisor.state === "running" || supervisor.state === "starting";
    if (wasRunning) await supervisor.stop();
    try {
      if (next.port !== previous.port) {
        setConfigPort(paths.configPath, effective.port);
        currentPort = effective.port;
        bb.log.info(`core port changed to ${effective.port}`);
      }
      if (next.managementKey !== previous.managementKey) {
        setConfigManagementKey(paths.configPath, effective.managementKey);
        bb.log.info("management key rotated; core will re-hash it on next start");
      }
    } catch (error) {
      bb.log.error(`failed to apply settings to core config: ${String(error)}`);
    }
    if (wasRunning) supervisor.start();
  });

  // -------------------------------------------------------------------------
  // Agents wiring helpers
  // -------------------------------------------------------------------------

  const claudeSettingsPath = join(homedir(), ".claude", "settings.json");

  async function readClaudeSettings(): Promise<{ content: string | null; sha256: string | null }> {
    try {
      const file = await bb.sdk.files.read({ path: claudeSettingsPath });
      if (file.contentEncoding !== "utf8") {
        throw new Error(`${claudeSettingsPath} is not a text file`);
      }
      return { content: file.content, sha256: file.sha256 };
    } catch {
      return { content: null, sha256: null };
    }
  }

  async function writeClaudeSettings(content: string, expectedSha256: string | null): Promise<void> {
    const saved = await bb.sdk.files.write({
      path: claudeSettingsPath,
      content,
      expectedSha256,
    });
    if (saved.outcome === "conflict") {
      throw new Error(`${claudeSettingsPath} changed while applying; retry`);
    }
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
      const { port } = await effectiveSettings();
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
      } catch {
        return { ok: false, detail: `nothing is listening on 127.0.0.1:${port}` };
      }
      try {
        const client = await managementClient();
        await client.authFiles();
        return { ok: true, detail: `core is up and the management API accepts the key on port ${port}` };
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
        updateAvailable:
          installed !== null && installed !== "unknown"
            ? compareVersions(latest.version, installed) > 0
            : installed === null || installed === "unknown",
      };
    },
    async install({ version }) {
      return { installedVersion: await runInstall(version) };
    },
    async start() {
      supervisor.start();
      return computeStatus();
    },
    async stop() {
      await supervisor.stop();
      return computeStatus();
    },
    async restart() {
      await supervisor.restart();
      return computeStatus();
    },
    async endpoints() {
      const { port } = await effectiveSettings();
      return { ...endpointsFor(port), apiKey: localApiKey };
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
      const client = await managementClient();
      await client.setAuthFileStatus(name, disabled);
      return null;
    },
    async authFileDelete({ name }) {
      const client = await managementClient();
      await client.deleteAuthFile(name);
      return null;
    },
    async resetQuota({ authIndex }) {
      const client = await managementClient();
      await client.resetQuota(authIndex);
      return null;
    },

    async resourceGet({ resource }) {
      const client = await managementClient();
      return { value: await client.getResource(resource) };
    },
    async resourcePut({ resource, value }) {
      const client = await managementClient();
      await client.putResource(resource, value);
      return null;
    },

    async usage() {
      const client = await managementClient();
      return { data: await client.usage() };
    },

    async agentsStatus() {
      const { port } = await effectiveSettings();
      const { content } = await readClaudeSettings();
      return {
        claude: {
          applied: claudeApplied(content, endpointsFor(port).anthropic),
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
      const { port } = await effectiveSettings();
      if (agent === "claude") {
        const { content, sha256 } = await readClaudeSettings();
        const backupPath =
          content !== null ? timestampedBackup(content, paths.backupsDir, CLAUDE_BACKUP_BASE) : null;
        const next = applyClaudeEnv(content, {
          baseUrl: endpointsFor(port).anthropic,
          token: localApiKey,
        });
        await writeClaudeSettings(next, sha256);
        bb.log.info(`applied proxy env to ${claudeSettingsPath}`);
        return { backupPath };
      }
      writeAtomic(paths.codexConfigPath, renderCodexConfig(endpointsFor(port).openai));
      bb.log.info(`generated Codex home at ${paths.codexHomeDir}`);
      return { backupPath: null };
    },
    async agentsRestore({ agent }) {
      if (agent === "claude") {
        const { content, sha256 } = await readClaudeSettings();
        if (content === null) return { detail: "settings file does not exist; nothing to restore" };
        const { content: next, changed } = stripClaudeEnv(content);
        if (!changed) return { detail: "proxy env vars were not present" };
        await writeClaudeSettings(next, sha256);
        return { detail: `removed proxy env vars from ${claudeSettingsPath}` };
      }
      if (!existsSync(paths.codexConfigPath)) {
        return { detail: "no generated Codex home to remove" };
      }
      rmSync(paths.codexHomeDir, { recursive: true, force: true });
      return { detail: `removed generated Codex home at ${paths.codexHomeDir}` };
    },
  });

  // -------------------------------------------------------------------------
  // CLI
  // -------------------------------------------------------------------------

  bb.cli.register({
    name: "agent-proxy",
    summary: "Manage the local CLIProxyAPI core (status, lifecycle, endpoints, OAuth, providers, usage)",
    commands: [
      { name: "status", summary: "Core state, versions, and endpoints", usage: "bb agent-proxy status" },
      { name: "start", summary: "Start the proxy core", usage: "bb agent-proxy start" },
      { name: "stop", summary: "Stop the proxy core", usage: "bb agent-proxy stop" },
      { name: "restart", summary: "Restart the proxy core", usage: "bb agent-proxy restart" },
      {
        name: "endpoints",
        summary: "Print local endpoint URLs and the local API key",
        usage: "bb agent-proxy endpoints",
      },
      {
        name: "install",
        summary: "Install or update the CLIProxyAPI core (latest, or a specific version)",
        usage: "bb agent-proxy install [version]",
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
      { name: "usage", summary: "Recent request buckets per provider key", usage: "bb agent-proxy usage" },
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
              `installed: ${status.installedVersion ?? "not installed"}`,
              `latest: ${status.latest?.version ?? "unknown (run: bb agent-proxy install)"}`,
              `openai: ${status.endpoints.openai}`,
              `anthropic: ${status.endpoints.anthropic}`,
              `gemini: ${status.endpoints.gemini}`,
            ];
            if (status.lastExit) {
              lines.push(
                `last exit: code ${status.lastExit.code ?? "null"} signal ${status.lastExit.signal ?? "null"} (${new Date(status.lastExit.at).toISOString()})`,
              );
            }
            return { exitCode: 0, stdout: lines.join("\n") };
          }
          case "start": {
            supervisor.start();
            return { exitCode: 0, stdout: "start requested" };
          }
          case "stop": {
            await supervisor.stop();
            return { exitCode: 0, stdout: "stopped" };
          }
          case "restart": {
            await supervisor.restart();
            return { exitCode: 0, stdout: "restart requested" };
          }
          case "endpoints": {
            const { port } = await effectiveSettings();
            const endpoints = endpointsFor(port);
            return {
              exitCode: 0,
              stdout: [
                `openai: ${endpoints.openai}`,
                `anthropic: ${endpoints.anthropic}`,
                `gemini: ${endpoints.gemini}`,
                `api key: ${localApiKey}`,
              ].join("\n"),
            };
          }
          case "install": {
            const version = await runInstall(rest[0]);
            return { exitCode: 0, stdout: `installed CLIProxyAPI v${version}` };
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
              const count = Array.isArray(value) ? value.length : value ? 1 : 0;
              lines.push(`${resource}: ${count} configured`);
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
                "  status              core state, versions, endpoints\n" +
                "  start|stop|restart  control the proxy core\n" +
                "  endpoints           local endpoint URLs + API key\n" +
                "  install [version]   install or update the core\n" +
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

  bb.log.info(
    `loaded (core ${installedVersion(paths) ?? "not installed"}, port ${initial.port}, autostart ${String(initial.autostart)})`,
  );
}
