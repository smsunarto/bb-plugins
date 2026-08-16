// Registers Amp as a custom ACP provider in bb via the plugin's own bundled
// ACP bridge (dist/bridge.js), which drives the Amp CLI through the official
// @ampcode/sdk. No third-party adapter required.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  inspectInstallation,
  needsProvisioning,
  provisionInstallation,
  resolveAmpCli,
  resolveAmpCliLaunch,
  resolveNodeRuntime,
  BRIDGE_BUILD_HINT,
  type ProvisionPaths,
} from "./lib/provision.js";
import {
  AMP_AGENT,
  OBSOLETE_AMP_ORB_AGENT,
} from "./src/execution-target.js";
import { loadOracleReport } from "./src/oracle-report-store.js";
import {
  findLatestProviderSessionId,
  mergeOrbUsageRecord,
  ORB_USAGE_CHANNEL,
  orbUsageKey,
  parseOrbUsageRecord,
  toOrbUsageView,
} from "./src/orb-usage.js";
import {
  ampThreadLinkKey,
  archiveAmpThread,
  currentAmpThreadId,
  mergeAmpThreadLinkRecord,
  parseAmpThreadLinkRecord,
  parseSessionLinkReport,
  type SessionLinkReport,
} from "./src/amp-thread-link.js";

const orbUsageViewSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("hidden") }).strict(),
  z.object({ state: z.literal("starting") }).strict(),
  z.object({
    state: z.literal("active"),
    ampThreadId: z.string(),
    syncCommand: z.string(),
  }).strict(),
]);

export const rpcContract = defineRpcContract({
  getOrbUsage: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: orbUsageViewSchema,
  },
  getOracleReport: {
    input: z.object({ reportId: z.string().uuid() }).strict(),
    output: z.object({
      report: z.object({
        id: z.string(),
        request: z.string().nullable(),
        response: z.string(),
        status: z.enum(["running", "completed", "error"]),
        trace: z.array(z.object({
          id: z.string(),
          toolCallId: z.string().nullable(),
          kind: z.enum(["thinking", "message", "tool"]),
          title: z.string(),
          content: z.string().nullable(),
          status: z.enum(["running", "completed", "error"]).nullable(),
          createdAt: z.string(),
        })),
        createdAt: z.string(),
      }).nullable(),
      error: z.string().nullable(),
    }),
  },
});

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/**
 * Where the bridge bundle sits relative to whichever module bb loaded.
 *
 * bb picks the entry by install kind: a path source runs `server.ts` from the
 * plugin root, while a managed npm install runs the prebuilt `dist/server.js`
 * (plugin-runtime.ts `resolveServerEntry`). So `import.meta.url` is the root in
 * one case and `dist/` in the other, and a single hard-coded `dist/bridge.js`
 * resolves to `dist/dist/bridge.js` on every npm install.
 */
const BRIDGE_PATH = existsSync(join(MODULE_DIR, "bridge.js"))
  ? join(MODULE_DIR, "bridge.js")
  : join(MODULE_DIR, "dist", "bridge.js");

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const sessionLinkWriteQueues = new Map<string, Promise<void>>();

  async function latestAmpProviderSessionId(threadId: string): Promise<string | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.providerId !== AMP_AGENT.providerId) return null;

    return findLatestProviderSessionId(async (afterSeq) => {
      const row = await bb.sdk.threads.events.wait({
        threadId,
        type: "thread/identity",
        waitMs: "0",
        ...(afterSeq === undefined ? {} : { afterSeq }),
      });
      if (row === null) return null;
      if (row.type !== "thread/identity") {
        return { providerSessionId: "", seq: -1 };
      }
      return {
        providerSessionId: row.data.providerThreadId,
        seq: row.seq,
      };
    });
  }

  async function persistSessionLink(
    threadId: string,
    incoming: SessionLinkReport,
  ): Promise<void> {
    const previous = sessionLinkWriteQueues.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const linkKey = ampThreadLinkKey(threadId);
      const currentLink = parseAmpThreadLinkRecord(
        await bb.storage.kv.get<unknown>(linkKey),
      );
      const mergedLink = mergeAmpThreadLinkRecord(currentLink, incoming);
      if (JSON.stringify(mergedLink) !== JSON.stringify(currentLink)) {
        await bb.storage.kv.set(linkKey, mergedLink);
      }

      const usageKey = orbUsageKey(threadId);
      const currentUsage = parseOrbUsageRecord(
        await bb.storage.kv.get<unknown>(usageKey),
      );
      const mergedUsage = mergeOrbUsageRecord(currentUsage, incoming.usage);
      if (JSON.stringify(mergedUsage) !== JSON.stringify(currentUsage)) {
        await bb.storage.kv.set(usageKey, mergedUsage);
        bb.realtime.publish(ORB_USAGE_CHANNEL, { threadId });
      }
      return undefined;
    });
    sessionLinkWriteQueues.set(threadId, next);
    try {
      await next;
    } finally {
      if (sessionLinkWriteQueues.get(threadId) === next) {
        sessionLinkWriteQueues.delete(threadId);
      }
    }
  }

  bb.rpc.register(rpcContract, {
    async getOrbUsage({ threadId }) {
      const providerSessionId = await latestAmpProviderSessionId(threadId);
      if (providerSessionId === null) return { state: "hidden" as const };
      const record = parseOrbUsageRecord(
        await bb.storage.kv.get<unknown>(orbUsageKey(threadId)),
      );
      if (record?.providerSessionId !== providerSessionId) {
        return { state: "hidden" as const };
      }
      return toOrbUsageView(record);
    },
    getOracleReport({ reportId }) {
      const report = loadOracleReport(reportId);
      return report === null
        ? { report: null, error: "The Oracle report is unavailable. Open the native tool call to view its output." }
        : { report, error: null };
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

  async function paths(): Promise<ProvisionPaths> {
    const dataDir = await resolveDataDir();
    return {
      dataDir,
      configPath: join(dataDir, "config.json"),
      logoPath: join(dataDir, "logos", "amp.svg"),
    };
  }

  async function reloadConfig(): Promise<void> {
    try {
      await bb.sdk.system.reloadConfig();
    } catch (error) {
      throw new Error(
        `The provider config was written, but bb could not reload it: ${String(error)}. Restart bb.`,
        { cause: error },
      );
    }
  }

  const AMP_CLI_HINT =
    "Install the Amp CLI from https://ampcode.com/manual#get-started, "
    + "run `amp login`, then run `bb plugin reload amp`.";

  /**
   * Write the managed provider entry and pick it up in the running server.
   */
  async function applyProvision(amp: string): Promise<string[]> {
    const runtime = resolveNodeRuntime(process.execPath);
    const result = provisionInstallation(await paths(), {
      node: runtime.node,
      electron: runtime.electron,
      bridge: BRIDGE_PATH,
      amp,
    });
    const messages = [...result.messages];
    if (result.changed) {
      await reloadConfig();
      messages.push("reloaded running bb server config");
    } else {
      messages.push("configuration is already up to date");
    }
    return messages;
  }

  // Register the provider on first load, so installing the plugin is the whole
  // install. A background service is the seam for it: bb starts one after the
  // factory resolves, when `bb.sdk` is bound, and a service that returns
  // without throwing simply stops. Every prerequisite this cannot supply — the
  // Amp CLI, the bundle — is reported as needs-configuration rather than as a
  // load failure, so the plugin stays installed and says what is missing.
  bb.background.service("provision", {
    async start() {
      let resolvedPaths: ProvisionPaths;
      try {
        resolvedPaths = await paths();
      } catch (error) {
        bb.log.warn(`Could not locate the bb data directory: ${String(error)}`);
        return;
      }
      if (!existsSync(BRIDGE_PATH)) {
        bb.status.needsConfiguration(
          `The bridge bundle is missing at ${BRIDGE_PATH}. ${BRIDGE_BUILD_HINT}`,
        );
        return;
      }
      let provisioningRequired: boolean;
      try {
        provisioningRequired = needsProvisioning(resolvedPaths, {
          node: process.execPath,
          bridge: BRIDGE_PATH,
        });
      } catch (error) {
        const message = `Could not inspect ${resolvedPaths.configPath}: ${String(error)}`;
        bb.log.error(message);
        bb.status.needsConfiguration(
          `${message}. Fix the config or its permissions, then run \`bb plugin reload amp\`.`,
        );
        return;
      }
      if (!provisioningRequired) return;
      const amp = resolveAmpCli(process.env);
      if (amp === null) {
        bb.status.needsConfiguration(`The Amp CLI was not found. ${AMP_CLI_HINT}`);
        return;
      }
      try {
        for (const message of await applyProvision(amp)) bb.log.info(message);
      } catch (error) {
        bb.log.error(`Could not register the Amp provider: ${String(error)}`);
        bb.status.needsConfiguration(
          `Could not register the Amp provider: ${String(error)}. Fix the problem, then run \`bb plugin reload amp\`.`,
        );
      }
    },
  });

  async function statusLines(): Promise<string[]> {
    const resolvedPaths = await paths();
    const installation = inspectInstallation(resolvedPaths);
    const amp = resolveAmpCli(process.env);
    const lines = [
      `Amp CLI: ${amp ?? "NOT FOUND"}`,
      `bridge bundle: ${existsSync(BRIDGE_PATH) ? BRIDGE_PATH : `MISSING (${BRIDGE_PATH}); ${BRIDGE_BUILD_HINT}`}`,
      `node runtime: ${process.execPath}${resolveNodeRuntime(process.execPath).electron ? " (Electron; entry sets ELECTRON_RUN_AS_NODE=1)" : ""}`,
      `config entry ${AMP_AGENT.providerId}: ${installation.configured ? "present" : "missing"}`,
      `obsolete config entry ${OBSOLETE_AMP_ORB_AGENT.providerId}: ${installation.obsoleteOrbConfigured ? "present; run bb plugin reload amp to migrate" : "absent"}`,
      `logo: ${existsSync(resolvedPaths.logoPath) ? "present" : "missing"}`,
    ];
    try {
      const providers = await bb.sdk.providers.list();
      lines.push(
        `bb provider ${AMP_AGENT.providerId}: ${providers.some((provider) => provider.id === AMP_AGENT.providerId) ? "registered" : "NOT registered"}`,
      );
    } catch (error) {
      lines.push(`bb provider ${AMP_AGENT.providerId}: unknown (${String(error)})`);
    }
    lines.push(
      "auth: handled by the Amp CLI — run `amp login` once, or set AMP_API_KEY in the entry env",
    );
    if (installation.error) lines.push(`config error: ${installation.error}`);
    return lines;
  }

  bb.cli.register({
    name: "amp",
    summary: "Inspect the Amp ACP provider integration.",
    commands: [
      {
        name: "status",
        summary: "Check the Amp CLI, bridge bundle, bb config, assets, and provider registrations",
        usage: "amp status",
      },
    ],
    async run(argv, ctx) {
      const command = argv[0] ?? "status";
      if (command === "link-session") {
        const report = parseSessionLinkReport(argv);
        if (ctx.threadId === undefined || report === null) {
          return { exitCode: 2, stderr: "Invalid Amp session link report.\n" };
        }
        try {
          const providerSessionId = await latestAmpProviderSessionId(ctx.threadId);
          if (providerSessionId !== report.providerSessionId) {
            return { exitCode: 1, stderr: "The Amp session link is not current for this bb thread.\n" };
          }
          await persistSessionLink(ctx.threadId, report);
          return { exitCode: 0 };
        } catch (error) {
          bb.log.warn(`Could not link Amp session usage: ${String(error)}`);
          return { exitCode: 1, stderr: "Could not update the Amp session link.\n" };
        }
      }
      if (command === "status") {
        return { exitCode: 0, stdout: `${(await statusLines()).join("\n")}\n` };
      }
      return { exitCode: 2, stderr: `Unknown subcommand "${command}". Use "bb amp status".\n` };
    },
  });

  bb.events.on("thread.archived", async ({ thread }) => {
    if (thread.providerId !== AMP_AGENT.providerId) return;
    try {
      await sessionLinkWriteQueues.get(thread.id)?.catch(() => undefined);
      const providerSessionId = await latestAmpProviderSessionId(thread.id);
      if (providerSessionId === null) return;

      const link = parseAmpThreadLinkRecord(
        await bb.storage.kv.get<unknown>(ampThreadLinkKey(thread.id)),
      );
      const usage = parseOrbUsageRecord(
        await bb.storage.kv.get<unknown>(orbUsageKey(thread.id)),
      );
      const ampThreadId = currentAmpThreadId(providerSessionId, link, usage);
      if (ampThreadId === null) {
        bb.log.warn(`Could not archive the linked Amp thread for bb thread ${thread.id}: no current Amp thread link`);
        return;
      }

      const launch = resolveAmpCliLaunch(await paths());
      if (launch === null) {
        bb.log.warn(`Could not archive Amp thread ${ampThreadId}: the Amp CLI was not found`);
        return;
      }
      await archiveAmpThread(launch.command, ampThreadId, launch.env);
      bb.log.info(`Archived Amp thread ${ampThreadId} with bb thread ${thread.id}`);
    } catch (error) {
      bb.log.error(`Could not archive the linked Amp thread for bb thread ${thread.id}: ${String(error)}`);
    }
  });

  bb.events.on("thread.deleted", async ({ thread }) => {
    await Promise.all([
      bb.storage.kv.delete(ampThreadLinkKey(thread.id)),
      bb.storage.kv.delete(orbUsageKey(thread.id)),
    ]);
    bb.realtime.publish(ORB_USAGE_CHANNEL, { threadId: thread.id });
  });
}
