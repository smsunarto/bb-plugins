// Registers Amp as a bb provider (bb.providers.register). The executable
// implementation is the plugin's own provider bridge — the
// `experimental_providerBridge` export of the `bb.host` artifact — which
// spawns the Amp CLI directly and drives it over its stream-json execute
// wire. No separate bridge process, no launch spec.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildAmpProviderDeclaration, threadLinkStateSchema } from "./lib/declaration.js";
import {
  cleanupLegacyAmpEntry,
  inspectLegacyAmpEntry,
  resolveAmpCli,
  BRIDGE_BUILD_HINT,
  type LegacyCleanupResult,
  type LegacyConfigPaths,
} from "./lib/provision.js";
import { AMP_THREAD_LINK_KIND } from "./src/bridge/shapes.js";
import { AMP_AGENT } from "./src/execution-target.js";
import { loadOracleReport } from "./src/oracle-report-store.js";
import { threadLinkToOrbUsageView } from "./src/orb-usage.js";

const orbUsageViewSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("hidden") }).strict(),
  z.object({ state: z.literal("starting") }).strict(),
  z
    .object({
      state: z.literal("active"),
      ampThreadId: z.string(),
      syncCommand: z.string(),
    })
    .strict(),
]);

export const rpcContract = defineRpcContract({
  getOrbUsage: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: orbUsageViewSchema,
  },
  getOracleReport: {
    input: z.object({ reportId: z.string().uuid() }).strict(),
    output: z.object({
      report: z
        .object({
          id: z.string(),
          request: z.string().nullable(),
          response: z.string(),
          status: z.enum(["running", "completed", "error"]),
          trace: z.array(
            z.object({
              id: z.string(),
              toolCallId: z.string().nullable(),
              kind: z.enum(["thinking", "message", "tool"]),
              title: z.string(),
              content: z.string().nullable(),
              status: z.enum(["running", "completed", "error"]).nullable(),
              createdAt: z.string(),
            }),
          ),
          createdAt: z.string(),
        })
        .nullable(),
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
 * (plugin-runtime.ts `resolveServerEntry`). So `import.meta.url` is the root
 * in one case and `dist/` in the other. Diagnostics only: registration does
 * not gate on it, because a path-source dev flow may build it later.
 */
const HOST_BUNDLE = existsSync(join(MODULE_DIR, "host.js"))
  ? join(MODULE_DIR, "host.js")
  : join(MODULE_DIR, "dist", "host.js");

/** How many extension-state rows to scan for the latest `amp/thread-link`.
 *  Other kinds may interleave; the thread-link row is normally first. */
const THREAD_LINK_SCAN_LIMIT = 50;

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  /** Amp CLI path the registration resolved; `bb amp status` reuses it. */
  let ampCliPath: string | null = null;

  bb.rpc.register(rpcContract, {
    async getOrbUsage({ threadId }) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.providerId !== AMP_AGENT.providerId) return { state: "hidden" as const };
      const rows = await bb.sdk.threads.events.list({
        threadId,
        types: ["thread/extensionState/updated"],
        order: "desc",
        limit: String(THREAD_LINK_SCAN_LIMIT),
      });
      for (const row of rows) {
        if (row.type !== "thread/extensionState/updated") continue;
        if (row.data.kind !== AMP_THREAD_LINK_KIND) continue;
        // Ingest already validated the payload against this same schema; a
        // miss here means the schemas drifted, and hiding is the safe answer.
        const link = threadLinkStateSchema.safeParse(row.data.payload);
        return link.success ? threadLinkToOrbUsageView(link.data) : { state: "hidden" as const };
      }
      return { state: "hidden" as const };
    },
    getOracleReport({ reportId }) {
      const report = loadOracleReport(reportId);
      return report === null
        ? {
            report: null,
            error:
              "The Oracle report is unavailable. Open the native tool call to view its output.",
          }
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

  async function legacyPaths(): Promise<LegacyConfigPaths> {
    const dataDir = await resolveDataDir();
    return {
      configPath: join(dataDir, "config.json"),
      logoPath: join(dataDir, "logos", "amp.svg"),
    };
  }

  const AMP_CLI_HINT =
    "Install the Amp CLI from https://ampcode.com/manual#get-started, " +
    "run `amp login`, then run `bb plugin reload amp`.";

  // A leftover customAcpAgents "amp" entry from the provisioning era shadows
  // this registration, so a purely plugin-managed one is removed here; a
  // customized one is the user's and only reported.
  async function removeLegacyEntry(): Promise<void> {
    const resolvedPaths = await legacyPaths();
    let result: LegacyCleanupResult;
    try {
      result = cleanupLegacyAmpEntry(resolvedPaths);
    } catch (error) {
      bb.log.warn(`Could not inspect ${resolvedPaths.configPath}: ${String(error)}`);
      return;
    }
    if (result.kind === "removed") {
      bb.log.info(`removed the legacy customAcpAgents entry ${AMP_AGENT.agentId}`);
      try {
        await bb.sdk.system.reloadConfig();
      } catch (error) {
        bb.log.error(
          `The legacy entry was removed, but bb could not reload its config: ${String(error)}. Restart bb.`,
        );
      }
    } else if (result.kind === "kept") {
      bb.log.warn(
        `left the customized customAcpAgents entry ${AMP_AGENT.agentId} (${result.deviations.join(", ")}); ` +
          "it overrides the plugin registration, and bb is retiring customAcpAgents; see `bb amp status`",
      );
    }
  }

  // Register the provider on first load, so installing the plugin is the whole
  // install. A background service is the seam for it: bb starts one after the
  // factory resolves, when `bb.sdk` is bound, and a service that returns
  // without throwing simply stops. The one prerequisite this cannot supply —
  // the Amp CLI — is reported as needs-configuration rather than as a load
  // failure, so the plugin stays installed and says what is missing.
  bb.background.service("register", {
    async start() {
      const amp = resolveAmpCli(process.env);
      if (amp === null) {
        bb.status.needsConfiguration(`The Amp CLI was not found. ${AMP_CLI_HINT}`);
        return;
      }
      ampCliPath = amp;
      try {
        bb.providers.register(buildAmpProviderDeclaration({ ampCliPath: amp }));
      } catch (error) {
        bb.log.error(`Could not register the Amp provider: ${String(error)}`);
        bb.status.needsConfiguration(
          `Could not register the Amp provider: ${String(error)}. Fix the problem, then run \`bb plugin reload amp\`.`,
        );
        return;
      }
      await removeLegacyEntry();
    },
  });

  async function statusLines(): Promise<string[]> {
    const amp = ampCliPath ?? resolveAmpCli(process.env);
    const lines = [
      `Amp CLI: ${amp ?? "NOT FOUND"}`,
      `bridge bundle: ${existsSync(HOST_BUNDLE) ? HOST_BUNDLE : `MISSING (${HOST_BUNDLE}); ${BRIDGE_BUILD_HINT}`}`,
    ];
    try {
      const providers = await bb.sdk.providers.list();
      lines.push(
        `bb provider ${AMP_AGENT.providerId}: ${providers.some((provider) => provider.id === AMP_AGENT.providerId) ? "registered" : "NOT registered"}`,
      );
    } catch (error) {
      lines.push(`bb provider ${AMP_AGENT.providerId}: unknown (${String(error)})`);
    }
    const resolvedPaths = await legacyPaths();
    try {
      const legacy = inspectLegacyAmpEntry(resolvedPaths.configPath);
      if (legacy.entry === "managed") {
        lines.push(
          `legacy config entry ${AMP_AGENT.agentId}: present (plugin-managed); run \`bb plugin reload amp\` to remove it`,
        );
      } else if (legacy.entry === "customized") {
        lines.push(
          `legacy config entry ${AMP_AGENT.agentId}: present with customized ${legacy.deviations.join(", ")} — ` +
            "it overrides the plugin registration, and bb is retiring customAcpAgents; " +
            "move the customization into your environment, then delete the entry",
        );
      } else {
        lines.push(`legacy config entry ${AMP_AGENT.agentId}: absent`);
      }
    } catch (error) {
      lines.push(`legacy config entry ${AMP_AGENT.agentId}: unknown (${String(error)})`);
    }
    lines.push(
      "auth: handled by the Amp CLI — run `amp login` once, or export AMP_API_KEY in your environment",
    );
    return lines;
  }

  bb.cli.register({
    name: "amp",
    summary: "Inspect the Amp provider integration.",
    commands: [
      {
        name: "status",
        summary: "Check the Amp CLI, the bridge bundle, bb config, and provider registrations",
        usage: "amp status",
      },
    ],
    async run(argv) {
      const command = argv[0] ?? "status";
      if (command === "status") {
        return { exitCode: 0, stdout: `${(await statusLines()).join("\n")}\n` };
      }
      return { exitCode: 2, stderr: `Unknown subcommand "${command}". Use "bb amp status".\n` };
    },
  });

  // ACP-era kv rows (thread links, orb usage, archive watches). New state
  // lives on the thread's own extension-state events, which leave with the
  // thread; this sweep only clears leftovers from before the migration.
  bb.events.on("thread.deleted", async ({ thread }) => {
    await Promise.all([
      bb.storage.kv.delete(`amp-thread-link:${thread.id}`),
      bb.storage.kv.delete(`orb-usage:${thread.id}`),
      bb.storage.kv.delete(`amp-archive-watch:${thread.id}`),
    ]);
  });
}
