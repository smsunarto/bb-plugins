// Registers Amp as a bb provider (bb.providers.register). The executable
// implementation is the plugin's own provider bridge — the
// `experimental_providerBridge` export of the `bb.host` artifact — which
// spawns the Amp CLI directly and drives it over its stream-json execute
// wire. No separate bridge process, no launch spec.
import { cliCommand, defineCli, defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { type SentryPluginReporter } from "@bb-plugins/sentry/node";
import { sentryPluginTelemetry } from "@bb-plugins/sentry/telemetry";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildAmpProviderDeclaration, threadLinkStateSchema } from "./lib/declaration.js";
import {
  cleanupLegacyAmpEntry,
  inspectLegacyAmpEntry,
  BRIDGE_BUILD_HINT,
  type LegacyCleanupResult,
  type LegacyConfigPaths,
} from "./lib/provision.js";
import { AMP_THREAD_LINK_KIND } from "./src/bridge/kinds.js";
import { AMP_AGENT } from "./src/execution-target.js";
import { ampHostContract, oracleReportSchema } from "./src/host-contract.js";
import { createOrbIntent } from "./src/orb-intent.js";
import { threadLinkToOrbUsageView } from "./src/orb-usage.js";
import { PLUGIN_TELEMETRY } from "./shared/telemetry.js";

// Amp's source entry lives at the plugin root. Published bundles have their
// metadata beside this module, while source runs need the older nested-entry
// fallback until every loaded @bb-plugins/sentry copy knows the root-source layout.
const telemetryEntryUrl = existsSync(new URL("./server.meta.json", import.meta.url))
  ? import.meta.url
  : new URL("./server/server.ts", import.meta.url);

const telemetry = sentryPluginTelemetry({
  ...PLUGIN_TELEMETRY,
  serverEntryUrl: telemetryEntryUrl,
});

const orbUsageViewSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("hidden") }).strict(),
  z.object({ state: z.literal("unlinked") }).strict(),
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
    experimental_description:
      "Which Amp thread a bb thread maps to and whether it runs on an Orb machine; hidden for non-Amp and local threads, unlinked until the bridge links an Amp thread.",
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: orbUsageViewSchema,
  },
  getOrbIntent: {
    experimental_description: "Whether the next new Amp thread is armed to run on an Orb machine.",
    input: z.object({}).strict(),
    output: z.object({ armed: z.boolean() }).strict(),
  },
  setOrbIntent: {
    experimental_description: "Arm or disarm Orb execution for the next new Amp thread.",
    input: z.object({ armed: z.boolean() }).strict(),
    output: z.object({ armed: z.boolean() }).strict(),
  },
  getOracleReport: {
    experimental_description:
      "Load a stored Amp Oracle report (request, response, and trace) by the id an amp/oracle timeline row carries, from the host that ran the thread.",
    input: z.object({ reportId: z.string().uuid(), threadId: z.string().min(1) }).strict(),
    output: z.object({
      report: oracleReportSchema.nullable(),
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

/** One call to a host entry. An Oracle card waits on the answer, so a host
 *  that does not answer fails the card fast. */
const HOST_CALL_TIMEOUT_MS = 5_000;
/** How many reports' hosts are remembered. */
const MAX_REPORT_HOSTS = 4_096;

const ORACLE_UNAVAILABLE =
  "The Oracle report is unavailable. Open the native tool call to view its output.";

export function createAmpPlugin(errorReporter = telemetry.errorReporter) {
  return async function plugin(bb: BbPluginApi) {
    let reporter = errorReporter({ pluginId: PLUGIN_TELEMETRY.pluginId, host: bb });
    if (reporter !== undefined) {
      try {
        bb.onDispose(() => reporter?.dispose(2_000));
      } catch {
        void reporter.dispose(2_000);
        reporter = undefined;
      }
    }
    try {
      await registerPlugin(bb, reporter);
    } catch (error) {
      reporter?.capture({ boundary: "plugin.factory", error });
      await reporter?.dispose(2_000);
      throw error;
    }
  };
}

export default createAmpPlugin();

async function registerPlugin(bb: BbPluginApi, reporter: SentryPluginReporter | undefined) {
  bb.log.info("loaded");

  const orb = createOrbIntent(
    async (threadId) => (await bb.sdk.threads.get({ threadId })).createdAt,
  );
  /** The `host.ts` entry on each host daemon: the machine that runs a thread
   *  holds its Oracle reports and its Amp CLI, not the bb server. */
  const ampHost = bb.hosts.experimental_client({ contract: ampHostContract });

  async function hostName(hostId: string): Promise<string> {
    try {
      return (await bb.sdk.hosts.get({ hostId })).name;
    } catch {
      return hostId;
    }
  }

  function askHost(hostId: string, reportId: string) {
    return ampHost.call("oracleReport", { reportId }, { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS });
  }

  /** Which host answered for each report. A report never leaves the host
   *  that wrote it, so a later read goes straight there. The oldest go first
   *  past the cap; a forgotten one is found again. */
  const reportHosts = new Map<string, string>();
  const rememberReportHost = (reportId: string, hostId: string) => {
    reportHosts.delete(reportId);
    reportHosts.set(reportId, hostId);
    for (const oldest of reportHosts.keys()) {
      if (reportHosts.size <= MAX_REPORT_HOSTS) break;
      reportHosts.delete(oldest);
    }
  };

  /** The bridge wrote the report on the host that ran the thread at the time,
   *  and it stays there. The host that answered before asks first, else the
   *  thread's current host, which covers a running report. Only a miss there,
   *  from a thread that has moved since or ACP-era history with no
   *  environment, asks every other connected host at once, and the first
   *  that has the report answers. */
  async function fetchOracleReport(reportId: string, threadId: string) {
    let hostId = reportHosts.get(reportId);
    if (hostId === undefined) {
      const thread = await bb.sdk.threads.get({ threadId, include: "environment" });
      hostId = "environment" in thread ? thread.environment?.hostId : undefined;
    }
    let hostUnreachable = false;
    if (hostId !== undefined) {
      try {
        const { report } = await askHost(hostId, reportId);
        if (report !== null) {
          rememberReportHost(reportId, hostId);
          return { report, error: null };
        }
      } catch {
        hostUnreachable = true;
      }
    }
    const otherHosts = (await bb.sdk.hosts.list()).filter(
      (host) => host.status === "connected" && host.id !== hostId,
    );
    const found = await Promise.any(
      otherHosts.map(async (host) => {
        const { report } = await askHost(host.id, reportId);
        if (report === null) throw new Error(`no Oracle report on ${host.id}`);
        rememberReportHost(reportId, host.id);
        return report;
      }),
    ).catch(() => null);
    if (found !== null) return { report: found, error: null };
    if (hostId !== undefined && hostUnreachable) {
      return {
        report: null,
        error: `The Oracle report is stored on ${await hostName(hostId)}, which bb cannot reach right now. Open the native tool call to view its output.`,
      };
    }
    return { report: null, error: ORACLE_UNAVAILABLE };
  }

  /** Thread id → provider id. A thread's provider never changes, so a
   *  banner on another provider's thread costs no bb read after the first. */
  const threadProviders = new Map<string, string>();

  async function providerOf(threadId: string): Promise<string> {
    let providerId = threadProviders.get(threadId);
    if (providerId === undefined) {
      providerId = (await bb.sdk.threads.get({ threadId })).providerId;
      threadProviders.set(threadId, providerId);
    }
    return providerId;
  }

  bb.rpc.register(
    rpcContract,
    {
      async getOrbUsage({ threadId }) {
        return observeFailure(reporter, "rpc.execute", "getOrbUsage", async () => {
          if ((await providerOf(threadId)) !== AMP_AGENT.providerId) {
            return { state: "hidden" as const };
          }
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
            return link.success
              ? threadLinkToOrbUsageView(link.data)
              : { state: "hidden" as const };
          }
          return { state: "unlinked" as const };
        });
      },
      // The Orb toggle arms the next thread here. The next Amp thread bb
      // creates claims it, and deriveProviderOptions carries the choice to
      // the bridge on that thread's host (src/orb-intent.ts).
      getOrbIntent() {
        return observeFailure(reporter, "rpc.execute", "getOrbIntent", () => ({
          armed: orb.armed(),
        }));
      },
      setOrbIntent({ armed }) {
        return observeFailure(reporter, "rpc.execute", "setOrbIntent", () => {
          orb.setArmed(armed);
          return { armed };
        });
      },
      getOracleReport({ reportId, threadId }) {
        return observeFailure(reporter, "rpc.execute", "getOracleReport", () =>
          fetchOracleReport(reportId, threadId),
        );
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Amp provider state: Orb execution intent and usage per thread, and stored Oracle reports.",
    },
  );

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
    "Install it with the Install button in bb's composer, or from https://ampcode.com/docs/cli " +
    "(on Windows, inside WSL), then run `amp login`.";

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
  // without throwing simply stops. The Amp CLI is not looked up here: the
  // bridge finds it on each thread's host, reports it as not installed where
  // it is missing, and bb's composer offers Install (src/bridge/installation.ts).
  bb.background.service("register", {
    async start() {
      return observeFailure(reporter, "background.service", "register", async () => {
        try {
          bb.providers.register(buildAmpProviderDeclaration(orb));
        } catch (error) {
          bb.log.error(`Could not register the Amp provider: ${String(error)}`);
          bb.status.needsConfiguration(
            `Could not register the Amp provider: ${String(error)}. Fix the problem, then run \`bb plugin reload amp\`.`,
          );
          return;
        }
        await removeLegacyEntry();
      });
    },
  });

  /** One line per host: Amp threads run on the host that owns their
   *  environment, so each host answers for its own Amp CLI. */
  async function cliLines(): Promise<string[]> {
    let hosts: Awaited<ReturnType<typeof bb.sdk.hosts.list>>;
    try {
      hosts = await bb.sdk.hosts.list();
    } catch (error) {
      return [`Amp CLI: unknown (${String(error)})`];
    }
    return Promise.all(
      hosts.map(async (host) => {
        const label = `Amp CLI on ${host.name}`;
        if (host.status !== "connected") return `${label}: host not connected`;
        try {
          const { path } = await ampHost.call(
            "cliStatus",
            {},
            { hostId: host.id, timeoutMs: HOST_CALL_TIMEOUT_MS },
          );
          return `${label}: ${path ?? `NOT FOUND. ${AMP_CLI_HINT}`}`;
        } catch (error) {
          return `${label}: unknown (${String(error)})`;
        }
      }),
    );
  }

  async function statusLines(): Promise<string[]> {
    const lines = [
      ...(await cliLines()),
      `bridge bundle on the bb server: ${existsSync(HOST_BUNDLE) ? HOST_BUNDLE : `MISSING (${HOST_BUNDLE}); ${BRIDGE_BUILD_HINT}`}`,
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

  const status = cliCommand({
    summary:
      "Check the Amp CLI on each host, the bridge bundle, bb config, and provider registrations",
    async run() {
      return observeFailure(reporter, "command.execute", "status", async () => ({
        exitCode: 0,
        stdout: `${(await statusLines()).join("\n")}\n`,
      }));
    },
  });
  bb.cli.register(
    defineCli({
      name: "amp",
      summary: "Inspect the Amp provider integration.",
      // Bare `bb amp` has always printed the status report; keep that.
      root: status,
      commands: { status },
    }),
  );

  bb.events.on("thread.created", ({ thread }) => {
    observeFailure(reporter, "event.handler", "thread.created", () => {
      if (thread.providerId === AMP_AGENT.providerId) orb.claim(thread.id);
    });
  });

  // ACP-era kv rows (thread links, orb usage, archive watches). New state
  // lives on the thread's own extension-state events, which leave with the
  // thread; this sweep only clears leftovers from before the migration.
  bb.events.on("thread.deleted", async ({ thread }) => {
    return observeFailure(reporter, "event.handler", "thread.deleted", async () => {
      orb.forget(thread.id);
      threadProviders.delete(thread.id);
      await Promise.all([
        bb.storage.kv.delete(`amp-thread-link:${thread.id}`),
        bb.storage.kv.delete(`orb-usage:${thread.id}`),
        bb.storage.kv.delete(`amp-archive-watch:${thread.id}`),
      ]);
    });
  });
}

function observeFailure<T>(
  reporter: SentryPluginReporter | undefined,
  boundary: string,
  operation: string,
  callback: () => T,
): T {
  try {
    const result = callback();
    if (result instanceof Promise) {
      return result.catch((error: unknown) => {
        reporter?.capture({ boundary, operation, error });
        throw error;
      }) as T;
    }
    return result;
  } catch (error) {
    reporter?.capture({ boundary, operation, error });
    throw error;
  }
}
