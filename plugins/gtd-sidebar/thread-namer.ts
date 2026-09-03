import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  planThreadNaming,
  sanitizeGeneratedTitle,
  type NamingIntent,
  type ThreadNamingEvent,
  type ThreadNamingSkipReason,
} from "./lib/thread-naming.ts";
import type { ThreadTitleInference } from "./thread-title-inference.ts";

const EVENT_PAGE_SIZE = 100;

export type ThreadNamingResult = { ok: true; title: string } | { ok: false; error: string };

export interface ThreadNamer {
  nameThread(threadId: string, intent: NamingIntent): Promise<ThreadNamingResult>;
}

export function createThreadNamer(
  bb: BbPluginApi,
  options: {
    automaticallyNameThreads: () => Promise<boolean>;
    inference: ThreadTitleInference;
  },
): ThreadNamer {
  const inFlight = new Map<string, Promise<void>>();

  return {
    async nameThread(threadId, intent) {
      const previous = inFlight.get(threadId);
      if (previous !== undefined && intent.kind === "forced") {
        return { ok: false, error: "This thread is already being named." };
      }

      const operation = (previous ?? Promise.resolve()).then(() =>
        performThreadNaming(bb, options, threadId, intent),
      );
      const tail = operation.then(
        () => undefined,
        () => undefined,
      );
      inFlight.set(threadId, tail);
      try {
        return await operation;
      } finally {
        if (inFlight.get(threadId) === tail) inFlight.delete(threadId);
      }
    },
  };
}

async function performThreadNaming(
  bb: BbPluginApi,
  options: {
    automaticallyNameThreads: () => Promise<boolean>;
    inference: ThreadTitleInference;
  },
  threadId: string,
  intent: NamingIntent,
): Promise<ThreadNamingResult> {
  try {
    const automaticallyNameThreads =
      intent.kind === "automatic" ? await options.automaticallyNameThreads() : true;
    const [thread, events] = await Promise.all([
      bb.sdk.threads.get({ threadId }),
      loadNamingEvents(bb, threadId),
    ]);
    const plan = planThreadNaming({
      automaticallyNameThreads,
      events,
      intent,
      pluginId: bb.pluginId,
      thread,
    });
    if (plan.kind === "skip") {
      return { ok: false, error: describeSkip(plan.reason) };
    }

    const output = await options.inference.complete({
      environmentId: thread.environmentId,
      prompt: plan.prompt,
    });
    const title = sanitizeGeneratedTitle(output);
    if (title === null) {
      return { ok: false, error: "The naming agent returned an empty title." };
    }

    if (plan.writeGuard.kind === "title-unchanged") {
      const current = await bb.sdk.threads.get({ threadId });
      if (current.title !== plan.writeGuard.expectedTitle) {
        return {
          ok: false,
          error: "The thread title changed while naming was in progress.",
        };
      }
    }

    await bb.sdk.threads.update({ threadId, title });
    return { ok: true, title };
  } catch (error) {
    const message = describeError(error);
    bb.log.warn(`could not name thread ${threadId}: ${message}`);
    return { ok: false, error: message };
  }
}

async function loadNamingEvents(bb: BbPluginApi, threadId: string): Promise<ThreadNamingEvent[]> {
  const events: ThreadNamingEvent[] = [];
  let afterSeq: number | undefined;

  while (true) {
    const page = await bb.sdk.threads.events.list({
      threadId,
      types: ["client/turn/requested", "turn/completed"],
      order: "asc",
      limit: String(EVENT_PAGE_SIZE),
      ...(afterSeq === undefined ? {} : { afterSeq: String(afterSeq) }),
    });

    for (const event of page) {
      if (event.type === "turn/completed") {
        events.push({ seq: event.seq, type: event.type });
        continue;
      }
      if (event.type !== "client/turn/requested") continue;
      events.push({
        seq: event.seq,
        type: event.type,
        data: {
          initiator: event.data.initiator,
          ...(event.data.retryOfRequestId === undefined
            ? {}
            : { retryOfRequestId: event.data.retryOfRequestId }),
          target: { kind: event.data.target.kind },
          input: event.data.input.map((input) => {
            const normalized: {
              type: string;
              text?: string;
              visibility?: "agent-only";
            } = { type: input.type };
            if (input.type === "text") normalized.text = input.text;
            if (input.visibility !== undefined) normalized.visibility = input.visibility;
            return normalized;
          }),
        },
      });
    }

    if (page.length < EVENT_PAGE_SIZE) break;
    const nextAfterSeq = page.at(-1)?.seq;
    if (nextAfterSeq === undefined || nextAfterSeq === afterSeq) break;
    afterSeq = nextAfterSeq;
  }

  return events;
}

function describeSkip(reason: ThreadNamingSkipReason): string {
  switch (reason) {
    case "automatic-naming-disabled":
      return "Automatic thread naming is disabled.";
    case "archived-thread":
      return "Automatic naming skips archived threads.";
    case "child-thread":
      return "Child threads are named by their parent.";
    case "deleted-thread":
      return "Deleted threads cannot be named.";
    case "hidden-thread":
      return "Hidden threads cannot be named.";
    case "latest-turn-incomplete":
      return "Automatic naming waits for the latest user turn to complete.";
    case "latest-turn-not-user":
      return "Automatic naming only runs after a user turn.";
    case "missing-user-prompt":
      return "This thread has no initial user prompt to name.";
    case "plugin-worker":
      return "Plugin worker threads cannot be named.";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
