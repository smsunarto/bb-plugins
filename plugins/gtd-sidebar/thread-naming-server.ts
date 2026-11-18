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
      const slot = threadId === context.threadId ? await agentRenames.claim(threadId) : null;
      if (slot?.claimed === false) return { exitCode: 0, stdout: `${slot.reason}\n` };

      const renamed = await threadNamer.renameThread(threadId, title);
      if (!renamed.ok) {
        // A rejected title leaves the slot open, so the agent can fix it.
        slot?.release();
        throw new PluginCliError(renamed.error, { code: "rename_failed" });
      }
      // For a session whose instructions were built before the rules loaded.
      const selectedRules = selectProjectTitleRules(await readProjectTitleRules(renamed));
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

type AgentRenameSlot = { claimed: true; release(): void } | { claimed: false; reason: string };

/**
 * Lets a thread rename itself only while a turn runs, once per user request.
 * A call claims its request's slot before it writes, so concurrent calls
 * cannot both rename. The record lives in memory; a plugin reload forgets it.
 */
function createAgentRenameGuard(bb: BbPluginApi) {
  // Per thread: the latest user request whose turn claimed a rename.
  const claims = new Map<string, number | null>();

  return {
    async claim(threadId: string): Promise<AgentRenameSlot> {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.status !== "active") {
        return {
          claimed: false,
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
      // No await from here on: checking and claiming happen in one step.
      if (claims.has(threadId) && claims.get(threadId) === requestSeq) {
        return {
          claimed: false,
          reason: "Not renamed: this thread was already renamed for this request.",
        };
      }
      claims.set(threadId, requestSeq);
      return {
        claimed: true,
        release() {
          if (claims.get(threadId) === requestSeq) claims.delete(threadId);
        },
      };
    },
  };
}
