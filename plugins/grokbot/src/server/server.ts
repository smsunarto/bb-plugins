import {
  cliCommand,
  defineCli,
  experimental_PluginRpcRefusal as PluginRpcRefusal,
  PluginCliError,
  type BbPluginApi,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import {
  contract,
  LOG_LIMIT,
  SEND_LOG_TAG,
  type LogEntry,
  type SendOutcome,
} from "../shared/contract.ts";
import { createSendLog } from "./send-log.ts";
import {
  createGrokbotService,
  GrokbotRefusal,
  sdkThreadLookup,
  type GrokbotService,
  type RefusalCode,
} from "./service.ts";

export { contract };

export default function plugin(bb: BbPluginApi): void {
  const log = createSendLog(bb.storage.kv);
  const service = createGrokbotService({
    lookupThread: sdkThreadLookup(bb),
    log: {
      recent: (limit) => log.recent(limit),
      // CLI and agent sends share this path, so an open panel's log refreshes for them too.
      async append(entry) {
        await log.append(entry);
        bb.rpc.experimental_invalidate([SEND_LOG_TAG]);
      },
    },
  });
  bb.rpc.register(contract, {
    status: () => service.status(),
    threadContext: ({ threadId }) => service.threadContext(threadId),
    send: (input) => rpcRefusals(() => service.send(input)),
    log: async (input) => ({ entries: await service.recent(input?.limit) }),
  });
  bb.cli.register(grokbotCli(service));
}

export function grokbotCli(service: GrokbotService) {
  return defineCli({
    name: "grokbot",
    summary: "Send messages and pings to the Grok Bot webhook",
    commands: {
      status: cliCommand({
        summary: "Show whether the config file is usable and which bots it lists",
        options: { json: { type: "boolean", description: "Print JSON" } },
        async run({ options }) {
          const status = await service.status();
          if (options.json) return json(status, status.state === "ready" ? 0 : 1);
          if (status.state !== "ready") {
            return { exitCode: 1, stdout: `Not configured: ${status.reason}\n` };
          }
          const bots = status.bots.map((bot) => `  ${bot.id}  ${bot.name}`).join("\n");
          return {
            exitCode: 0,
            stdout: `Configured from ${status.configPath}\n${bots ? `Bots:\n${bots}\n` : "Bots: none (the router decides)\n"}`,
          };
        },
      }),
      ping: cliCommand({
        summary: 'POST {action: "ping"} to the webhook once and report the HTTP status',
        options: {
          bot: { type: "string", description: "Target bot id from the config's bots list" },
          json: { type: "boolean", description: "Print JSON" },
        },
        async run({ options }) {
          return report(
            await refusals(() => service.send({ action: "ping", targetBot: options.bot ?? null })),
            options.json,
          );
        },
      }),
      send: cliCommand({
        summary: "Send a message to Grok Bot",
        positionals: [{ name: "text", description: "The message", required: true }],
        options: {
          bot: { type: "string", description: "Target bot id from the config's bots list" },
          thread: {
            type: "string",
            description:
              'Attach a bb thread\'s context: a thread id, or "here" for the calling thread',
          },
          json: { type: "boolean", description: "Print JSON" },
        },
        async run({ positionals, options }, cli) {
          const threadId = options.thread === "here" ? cli.threadId : options.thread;
          if (options.thread === "here" && !threadId) {
            throw new PluginCliError('"here" only works inside a bb thread', { code: "no_thread" });
          }
          return report(
            await refusals(() =>
              service.send({
                action: "message",
                text: positionals.text,
                targetBot: options.bot ?? null,
                threadId: threadId ?? null,
              }),
            ),
            options.json,
          );
        },
      }),
      log: cliCommand({
        summary: "Show recent sends, newest first (no URL or key is stored)",
        options: {
          limit: { type: "integer", min: 1, max: LOG_LIMIT, default: 20, description: "Entries" },
          json: { type: "boolean", description: "Print JSON" },
        },
        async run({ options }) {
          const entries = await service.recent(options.limit);
          if (options.json) return json({ entries });
          if (entries.length === 0) return { exitCode: 0, stdout: "No sends yet\n" };
          return { exitCode: 0, stdout: `${entries.map(formatEntry).join("\n")}\n` };
        },
      }),
    },
  });
}

const RPC_REFUSAL_CODES: Record<RefusalCode, PluginRpcRefusal["code"]> = {
  not_configured: "conflict",
  unknown_bot: "invalid",
  empty_text: "invalid",
  too_long: "invalid",
  thread_unavailable: "not_found",
};

/** A refusal tells the panel nothing was sent, unlike a lost response. */
async function rpcRefusals<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GrokbotRefusal) {
      throw new PluginRpcRefusal({ code: RPC_REFUSAL_CODES[error.code], message: error.message });
    }
    throw error;
  }
}

async function refusals<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GrokbotRefusal) {
      throw new PluginCliError(error.message, {
        code: error.code,
        ...(error.code === "not_configured"
          ? { hint: "See the grokbot README for the config file format." }
          : {}),
      });
    }
    throw error;
  }
}

function report(
  { outcome, entry, logged }: { outcome: SendOutcome; entry: LogEntry; logged: boolean },
  asJson: boolean | undefined,
): PluginCliResult {
  if (asJson) return json({ outcome, entry, logged }, outcome.ok ? 0 : 1);
  const status = outcome.status === null ? "no response" : `HTTP ${outcome.status}`;
  const line = outcome.ok
    ? `Sent ${entry.action}: ${status} in ${outcome.durationMs}ms\n`
    : `Failed ${entry.action}: ${outcome.error ?? status} (${outcome.durationMs}ms)\n`;
  return {
    exitCode: outcome.ok ? 0 : 1,
    stdout: line,
    ...(logged ? {} : { stderr: "The send log could not be written.\n" }),
  };
}

function formatEntry(entry: LogEntry): string {
  const result = entry.ok ? `ok ${entry.status}` : `failed ${entry.error ?? entry.status}`;
  const target = entry.target_bot ? ` → ${entry.target_bot}` : "";
  const thread = entry.context ? ` [${entry.context.thread_id}]` : "";
  const text = entry.action === "message" ? `  ${entry.textPreview}` : "";
  return `${entry.ts}  ${entry.action}${target}${thread}  ${result}${text}`;
}

function json(value: unknown, exitCode = 0): PluginCliResult {
  return { exitCode, stdout: `${JSON.stringify(value, null, 2)}\n` };
}
