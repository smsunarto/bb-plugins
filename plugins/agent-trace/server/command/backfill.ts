import { argv, CommandError, defineCommand } from "@bb-kit/core/command";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { parseAgentTraceSettings } from "../../shared/settings.ts";
import { exportToLaminar, traceIoBackfill } from "../exporters/laminar.ts";
import { agentTraceSettings } from "../lib/settings.ts";
import { assembleTurnTrace, type ThreadEventRow } from "../turn-trace.ts";

const EVENT_PAGE_SIZE = 200;
const BACKFILL_KEY_PREFIX = "backfill:trace-io:v1:";

async function listEvents(
  bb: BbPluginApi,
  threadId: string,
  signal: AbortSignal,
): Promise<ThreadEventRow[]> {
  const events: ThreadEventRow[] = [];
  let cursor = 0;
  while (!signal.aborted) {
    const input: Parameters<BbPluginApi["sdk"]["threads"]["events"]["list"]>[0] = {
      threadId,
      order: "asc",
      limit: String(EVENT_PAGE_SIZE),
      signal,
    };
    if (cursor !== 0) input.afterSeq = String(cursor);
    const page = await bb.sdk.threads.events.list(input);
    events.push(...page);
    const nextCursor = page.at(-1)?.seq;
    if (nextCursor === undefined || nextCursor === cursor || page.length < EVENT_PAGE_SIZE) break;
    cursor = nextCursor;
  }
  return events;
}

export const backfill = defineCommand({
  summary: "Backfill Laminar session-card input and output for a thread",
  input: z.object({
    thread: argv.option(z.string().min(1).optional(), {
      description: "BB thread ID; defaults to the current thread",
    }),
  }),
  async execute(ctx, { thread: requestedThreadId }) {
    const threadId = requestedThreadId ?? ctx.threadId;
    if (threadId === undefined) {
      throw new CommandError("Pass --thread when this command is not run from a BB thread.", {
        exitCode: 2,
      });
    }

    const parsed = parseAgentTraceSettings(await agentTraceSettings(ctx.bb).get());
    if (!parsed.ok) throw new CommandError(parsed.message, { exitCode: 2 });
    const laminar = parsed.value.laminar;
    if (laminar === null) {
      throw new CommandError("Backfill only applies to Laminar; set the Laminar project API key.", {
        exitCode: 2,
      });
    }
    if (parsed.value.contentMode !== "full") {
      throw new CommandError("Set Laminar trace content to full before backfilling.", {
        exitCode: 2,
      });
    }

    const signal = ctx.signal ?? new AbortController().signal;
    const thread = await ctx.bb.sdk.threads.get({ threadId, signal });
    if (thread.visibility === "hidden") {
      throw new CommandError("Hidden threads stay metadata-only and cannot be backfilled.", {
        exitCode: 2,
      });
    }

    const events = await listEvents(ctx.bb, threadId, signal);
    const pending: ThreadEventRow[] = [];
    let patched = 0;
    for (const event of events) {
      pending.push(event);
      if (event.type !== "turn/completed") continue;
      const request = traceIoBackfill(
        assembleTurnTrace({
          contentMode: "full",
          deploymentEnvironment: parsed.value.deploymentEnvironment,
          events: pending,
          historyRevision: 0,
          thread,
        }),
      );
      if (request !== null) {
        const traceId = request.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.traceId;
        if (
          traceId !== undefined &&
          (await ctx.bb.storage.kv.get<boolean>(`${BACKFILL_KEY_PREFIX}${traceId}`)) === true
        ) {
          pending.length = 0;
          continue;
        }
        await exportToLaminar(laminar, request, signal);
        if (traceId !== undefined) {
          await ctx.bb.storage.kv.set(`${BACKFILL_KEY_PREFIX}${traceId}`, true);
        }
        patched += 1;
      }
      pending.length = 0;
    }

    return {
      exitCode: 0,
      stdout: `Backfilled Laminar input/output for ${patched} completed turn${patched === 1 ? "" : "s"} in ${threadId}.\n`,
    };
  },
});
