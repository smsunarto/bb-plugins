import { cliCommand, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createProjectTitleRulesCache } from "./lib/project-title-rules.ts";
import { renderAgentRenameInstructions, selectProjectTitleRules } from "./lib/thread-naming.ts";
import {
  createThreadNamer,
  loadProjectTitleInstructions,
  type ThreadNamer,
} from "./thread-namer.ts";
import type { ThreadTitleInference } from "./thread-title-inference.ts";

interface NamingSettings {
  get(): Promise<{ automaticallyNameThreads: boolean }>;
  onChange(listener: (next: { automaticallyNameThreads: boolean }) => void): void;
}

/**
 * Thread naming end to end: the thread's agent titles it on the first request
 * and renames it when the work changes direction, through
 * `bb gtd-sidebar rename --title`, guided by instructions this registers for
 * root threads. Without --title the command regenerates a title through Codex.
 */
export function registerThreadNaming(
  bb: BbPluginApi,
  options: { settings: NamingSettings; inference: ThreadTitleInference },
): { threadNamer: ThreadNamer; renameCommand: ReturnType<typeof cliCommand> } {
  const { settings } = options;
  const projectTitleRules = createProjectTitleRulesCache(
    (environmentId) => loadProjectTitleInstructions(bb, environmentId),
    { onError: (error) => bb.log.warn(`could not read project title rules: ${String(error)}`) },
  );
  const threadNamer = createThreadNamer(bb, { inference: options.inference });

  // `configure` is synchronous, so it reads the setting from this copy.
  let namingEnabled = false;
  void settings.get().then((values) => {
    namingEnabled = values.automaticallyNameThreads;
    return undefined;
  });
  settings.onChange((next) => {
    namingEnabled = next.automaticallyNameThreads;
  });
  // Threads whose latest session started before the project rules loaded.
  const sessionsWithoutRules = new Set<string>();
  const agentRenames = createAgentRenameGuard(bb);
  // Selecting nothing would drop the manifest skill from every thread.
  const agentSelection = { tools: [], skills: ["configure-gtd-naming"] };
  bb.agents.configure((session) => {
    // Child threads are named by their parent; side chats are plugin-owned forks.
    if (
      !namingEnabled ||
      session.thread.parentThreadId !== null ||
      session.origin.pluginId !== null
    ) {
      return agentSelection;
    }
    try {
      const rules = projectTitleRules.peek(session.project.id, session.environment.id);
      if (rules === undefined) sessionsWithoutRules.add(session.thread.id);
      else sessionsWithoutRules.delete(session.thread.id);
      return { ...agentSelection, instructions: renderAgentRenameInstructions(rules) };
    } catch (error) {
      // A throw here would reject the whole selection, skill included.
      bb.log.warn(`could not render rename instructions: ${String(error)}`);
      return agentSelection;
    }
  });

  const readProjectTitleRules = async (thread: {
    projectId: string;
    environmentId: string | null;
  }): Promise<string> =>
    projectTitleRules.peek(thread.projectId, null) ??
    (thread.environmentId === null
      ? ""
      : ((await loadProjectTitleInstructions(bb, thread.environmentId)) ?? ""));

  const renameCommand = cliCommand({
    summary:
      "Rename a thread: set --title, or generate a title from its latest request with Codex.",
    options: {
      title: {
        type: "string",
        description:
          "Title to set, at most 48 characters, following the thread's title rules. Omit it to generate one.",
      },
    },
    positionals: [
      {
        name: "threadId",
        description: "Thread to rename (thr_…); defaults to the thread this command runs from.",
      },
    ],
    async run({ options: { title }, positionals }, context) {
      if (positionals.threadId !== undefined && !positionals.threadId.startsWith("thr_")) {
        throw new PluginCliError(
          `"${positionals.threadId}" is not a thread id. Pass the title with --title.`,
          {
            code: "not_a_thread_id",
            exitCode: 2,
            hint: 'bb gtd-sidebar rename --title "<new title>"',
          },
        );
      }
      const threadId = positionals.threadId ?? context.threadId;
      if (threadId === undefined) {
        throw new PluginCliError("Pass a thread id or run this command from a thread.", {
          code: "missing_thread",
          exitCode: 2,
        });
      }
      if (title === undefined) {
        const result = await threadNamer.regenerateTitle(threadId);
        if (!result.ok) throw new PluginCliError(result.error, { code: "rename_failed" });
        return { exitCode: 0, stdout: `${result.title}\n` };
      }

      // An agent titling its own thread. So is a background agent in the same
      // provider process, such as Codex memory consolidation.
      const turn = threadId === context.threadId ? await agentRenames.check(threadId) : null;
      if (turn?.allowed === false) return { exitCode: 0, stdout: `${turn.reason}\n` };

      const renamed = await threadNamer.renameThread(threadId, title);
      if (!renamed.ok) throw new PluginCliError(renamed.error, { code: "rename_failed" });
      // For a session whose instructions were built before the rules loaded.
      const selectedRules = selectProjectTitleRules(await readProjectTitleRules(renamed));
      // The rules-unloaded instructions ask for one more rename if these rules call for it.
      if (turn) {
        const corrections = selectedRules && sessionsWithoutRules.has(threadId) ? 1 : 0;
        agentRenames.record(threadId, turn.requestSeq, corrections);
      }
      return {
        exitCode: 0,
        stdout:
          `Renamed "${renamed.previousTitle ?? ""}" → "${renamed.title}"\n` +
          (selectedRules
            ? `\nProject title rules, from .agents/GTD_NAMING.md:\n${selectedRules}\n`
            : ""),
      };
    },
  });

  return { threadNamer, renameCommand };
}

type AgentRenameCheck =
  | { allowed: true; requestSeq: number | null }
  | { allowed: false; reason: string };

/**
 * Lets a thread rename itself only while a turn runs, once per user request.
 * The record lives in memory, so a plugin reload forgets earlier renames.
 */
function createAgentRenameGuard(bb: BbPluginApi) {
  // Per thread: the request whose turn renamed it, and the renames it has left.
  const renames = new Map<string, { requestSeq: number | null; remaining: number }>();

  return {
    async check(threadId: string): Promise<AgentRenameCheck> {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.status !== "active") {
        return {
          allowed: false,
          reason: "Not renamed: no turn is running in this thread, so its title stays.",
        };
      }
      const latestRequest = await bb.sdk.threads.events.list({
        threadId,
        types: ["client/turn/requested"],
        order: "desc",
        limit: "1",
      });
      const requestSeq = latestRequest[0]?.seq ?? null;
      const previous = renames.get(threadId);
      if (previous?.requestSeq === requestSeq && previous.remaining === 0) {
        return {
          allowed: false,
          reason: "Not renamed: this thread was already renamed for this request.",
        };
      }
      return { allowed: true, requestSeq };
    },
    record(threadId: string, requestSeq: number | null, corrections: number) {
      const previous = renames.get(threadId);
      renames.set(threadId, {
        requestSeq,
        remaining:
          previous?.requestSeq === requestSeq ? Math.max(0, previous.remaining - 1) : corrections,
      });
    },
  };
}
