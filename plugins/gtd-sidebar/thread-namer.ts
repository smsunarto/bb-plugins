import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  normalizeProjectTitleInstructions,
  planThreadNaming,
  sanitizeGeneratedTitle,
  type ThreadNamingEvent,
  type ThreadNamingSkipReason,
} from "./lib/thread-naming.ts";
import type { ThreadTitleInference } from "./thread-title-inference.ts";
import { GTD_TAGS } from "./lib/rpc-contract.ts";

const EVENT_PAGE_SIZE = 100;
const PROJECT_TITLE_INSTRUCTIONS_PATH = ".agents/GTD_NAMING.md";

export type ThreadNamingResult = { ok: true; title: string } | { ok: false; error: string };

export type ThreadRenameResult =
  | {
      ok: true;
      previousTitle: string | null;
      title: string;
      projectId: string;
      environmentId: string | null;
    }
  | { ok: false; error: string };

export interface ThreadNamer {
  /** Generates a title from the latest user request; `bb gtd-sidebar rename` without --title. */
  regenerateTitle(threadId: string): Promise<ThreadNamingResult>;
  /** Sets a title the thread's agent chose. */
  renameThread(threadId: string, title: string): Promise<ThreadRenameResult>;
  /** Threads whose regeneration is in flight, for the sidebar's naming shimmer. */
  listNamingThreads(): string[];
}

export function createThreadNamer(
  bb: BbPluginApi,
  options: { inference: ThreadTitleInference },
): ThreadNamer {
  const naming = new Set<string>();
  bb.onDispose(() => {
    naming.clear();
    bb.rpc.experimental_invalidate([GTD_TAGS.naming]);
  });

  return {
    listNamingThreads: () => [...naming],
    async regenerateTitle(threadId) {
      if (naming.has(threadId)) return { ok: false, error: "This thread is already being named." };
      naming.add(threadId);
      bb.rpc.experimental_invalidate([GTD_TAGS.naming]);
      try {
        return await regenerate(bb, options.inference, threadId);
      } finally {
        naming.delete(threadId);
        bb.rpc.experimental_invalidate([GTD_TAGS.naming]);
      }
    },
    async renameThread(threadId, requested) {
      const title = sanitizeGeneratedTitle(requested);
      if (title === null) {
        return {
          ok: false,
          error: "The title needs at least one letter or digit after any emoji or [scope] prefix.",
        };
      }
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        const previousTitle = thread.title;
        if (title !== previousTitle) await bb.sdk.threads.update({ threadId, title });
        return {
          ok: true,
          previousTitle,
          title,
          projectId: thread.projectId,
          environmentId: thread.environmentId,
        };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    },
  };
}

async function regenerate(
  bb: BbPluginApi,
  inference: ThreadTitleInference,
  threadId: string,
): Promise<ThreadNamingResult> {
  try {
    const [thread, events] = await Promise.all([
      bb.sdk.threads.get({ threadId }),
      loadNamingEvents(bb, threadId),
    ]);
    const projectInstructions =
      (await loadProjectTitleInstructions(bb, thread.environmentId)) ?? "";
    const plan = planThreadNaming({ events, projectInstructions, thread });
    if (plan.kind === "skip") return { ok: false, error: describeSkip(plan.reason) };
    const title = sanitizeGeneratedTitle(
      await inference.complete({ environmentId: thread.environmentId, prompt: plan.prompt }),
    );
    if (title === null) {
      return { ok: false, error: "The naming agent returned no usable task title." };
    }
    if (title !== thread.title) await bb.sdk.threads.update({ threadId, title });
    return { ok: true, title };
  } catch (error) {
    const message = describeError(error);
    bb.log.warn(`could not name thread ${threadId}: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * The project's `.agents/GTD_NAMING.md` rules: "" when it has none or the file
 * is unusable, `null` while the workspace is still provisioning.
 */
export async function loadProjectTitleInstructions(
  bb: BbPluginApi,
  environmentId: string | null,
): Promise<string | null> {
  if (environmentId === null) return "";

  try {
    const environment = await bb.sdk.environments.get({ environmentId });
    if (environment.status !== "ready") return null;
    if (environment.path === null) return "";

    const file = await bb.sdk.files.read({
      hostId: environment.hostId,
      path: join(environment.path, PROJECT_TITLE_INSTRUCTIONS_PATH),
      rootPath: environment.path,
    });
    if (file.contentEncoding !== "utf8") {
      bb.log.warn(
        `${PROJECT_TITLE_INSTRUCTIONS_PATH} is not UTF-8; using default title instructions`,
      );
      return "";
    }
    return normalizeProjectTitleInstructions(file.content);
  } catch (error) {
    if (!isMissingFileError(error)) {
      bb.log.warn(
        `could not read naming rules for environment ${environmentId}: ${describeError(error)}`,
      );
    }
    return "";
  }
}

function isMissingFileError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return true;
  return /ENOENT|ENOTDIR|no such file|not found|does not exist/iu.test(describeError(error));
}

async function loadNamingEvents(bb: BbPluginApi, threadId: string): Promise<ThreadNamingEvent[]> {
  const events: ThreadNamingEvent[] = [];
  let afterSeq: number | undefined;

  while (true) {
    const page = await bb.sdk.threads.events.list({
      threadId,
      types: ["client/turn/requested"],
      order: "asc",
      limit: String(EVENT_PAGE_SIZE),
      ...(afterSeq === undefined ? {} : { afterSeq: String(afterSeq) }),
    });

    for (const event of page) {
      if (event.type !== "client/turn/requested") continue;
      events.push(event);
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
    case "child-thread":
      return "Child threads are named by their parent.";
    case "deleted-thread":
      return "Deleted threads cannot be named.";
    case "hidden-thread":
      return "Hidden threads cannot be named.";
    case "missing-user-prompt":
      return "This thread has no user request to name.";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
