import { argv, CommandError, defineCommand } from "@bb-kit/core/command";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { parseAgentTraceSettings } from "../../shared/settings.ts";
import { fetchLangfuseObservations, langfuseTraceUrl } from "../exporters/langfuse.ts";
import { agentTraceSettings } from "../lib/settings.ts";
import { turnTraceId, type ThreadEventRow } from "../turn-trace.ts";

const EVENT_PAGE_SIZE = 200;

async function latestTurnId(
  bb: BbPluginApi,
  threadId: string,
  signal: AbortSignal,
): Promise<string | null> {
  let turnId: string | null = null;
  let cursor = 0;
  while (!signal.aborted) {
    const input: Parameters<BbPluginApi["sdk"]["threads"]["events"]["list"]>[0] = {
      threadId,
      order: "asc",
      limit: String(EVENT_PAGE_SIZE),
      signal,
    };
    if (cursor !== 0) input.afterSeq = String(cursor);
    const page: ThreadEventRow[] = await bb.sdk.threads.events.list(input);
    for (const event of page) {
      if (event.type === "turn/completed") {
        turnId = event.scope.kind === "turn" ? event.scope.turnId : event.id;
      }
    }
    const nextCursor = page.at(-1)?.seq;
    if (nextCursor === undefined || nextCursor === cursor || page.length < EVENT_PAGE_SIZE) break;
    cursor = nextCursor;
  }
  return turnId;
}

function preview(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").slice(0, 80);
}

export const check = defineCommand({
  summary: "Fetch a thread's latest turn from Langfuse and print its observation tree",
  input: z.object({
    thread: argv.option(z.string().min(1).optional(), {
      description: "BB thread ID; defaults to the current thread",
    }),
    turn: argv.option(z.string().min(1).optional(), {
      description: "BB turn ID; defaults to the thread's latest completed turn",
    }),
    raw: argv.flag(z.boolean().default(false), {
      description: "Print the raw Langfuse observations as JSON",
    }),
  }),
  async execute(ctx, { thread: requestedThreadId, turn: requestedTurnId, raw }) {
    const threadId = requestedThreadId ?? ctx.threadId;
    if (threadId === undefined) {
      throw new CommandError("Pass --thread when this command is not run from a BB thread.", {
        exitCode: 2,
      });
    }
    const parsed = parseAgentTraceSettings(await agentTraceSettings(ctx.bb).get());
    if (!parsed.ok) throw new CommandError(parsed.message, { exitCode: 2 });
    const langfuse = parsed.value.langfuse;
    if (langfuse === null) {
      throw new CommandError("Set the Langfuse key pair to check exported traces.", {
        exitCode: 2,
      });
    }

    const signal = ctx.signal ?? new AbortController().signal;
    const turnId = requestedTurnId ?? (await latestTurnId(ctx.bb, threadId, signal));
    if (turnId === null) {
      throw new CommandError(`Thread ${threadId} has no completed turn.`, { exitCode: 1 });
    }
    const traceId = turnTraceId(turnId);
    const observations = await fetchLangfuseObservations(langfuse, traceId, signal);
    if (observations.length === 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Langfuse has no observations for trace ${traceId} (turn ${turnId}) yet.\n`,
      };
    }

    if (raw) return { exitCode: 0, stdout: `${JSON.stringify(observations, null, 2)}\n` };

    const byId = new Map(observations.map((observation) => [observation.id, observation]));
    const depth = (observation: (typeof observations)[number]): number => {
      let count = 0;
      let parent = observation.parentObservationId;
      while (parent !== null && parent !== undefined) {
        count += 1;
        parent = byId.get(parent)?.parentObservationId;
      }
      return count;
    };
    const t0 = Math.min(...observations.map((observation) => Date.parse(observation.startTime)));
    const lines = [...observations]
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
      .map((observation) => {
        const start = ((Date.parse(observation.startTime) - t0) / 1000).toFixed(2).padStart(8);
        const end = ((Date.parse(observation.endTime ?? observation.startTime) - t0) / 1000)
          .toFixed(2)
          .padStart(8);
        const usage =
          observation.usageDetails === undefined || observation.usageDetails === null
            ? ""
            : ` usage=${JSON.stringify(observation.usageDetails)}`;
        const model = observation.model ? ` model=${observation.model}` : "";
        const io = [preview(observation.input), preview(observation.output)]
          .filter(Boolean)
          .join(" -> ");
        return `${start}s ${end}s ${"  ".repeat(depth(observation))}${observation.type.toLowerCase()} ${observation.name}${model}${usage}${io ? ` | ${io}` : ""}`;
      });

    return {
      exitCode: 0,
      stdout: `${langfuseTraceUrl(langfuse.baseUrl, traceId)}\n${lines.join("\n")}\n`,
    };
  },
});
