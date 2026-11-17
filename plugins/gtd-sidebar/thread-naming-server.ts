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

      const renamed = await threadNamer.renameThread(threadId, title);
      if (!renamed.ok) throw new PluginCliError(renamed.error, { code: "rename_failed" });
      // For a session whose instructions were built before the rules loaded.
      const rules =
        projectTitleRules.peek(renamed.projectId, null) ??
        (renamed.environmentId === null
          ? ""
          : ((await loadProjectTitleInstructions(bb, renamed.environmentId)) ?? ""));
      const selectedRules = selectProjectTitleRules(rules);
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
