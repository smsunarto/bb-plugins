import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readAutorouterSettings } from "./settings.ts";
import { loadRouteCatalog } from "./catalog.ts";
import { availableRoutesForUsage } from "./usage.ts";
import { ROUTES } from "../../../shared/autorouter/policy.ts";

export const AUTOROUTER_AGENT_INSTRUCTIONS = `Before acting on a new task, read kitchen_sink_autorouter_policy and follow its live general and route rules when enabled. Compare the desired route with currentExecution: if the model already matches, do the work here. In particular, Luna Max executes command tasks itself and never creates another Luna thread for the same task. Independent reviews require a separate review subthread even when the model matches. If isSubthread is true, do the assigned work yourself without delegating it again. Explicit user constraints take precedence.
For a different model, use a BB subthread: Luna Max for command work, Fable for UI work from Codex, or Opus only when returned as eligible. Use only returned routes. Use the returned projectId and environmentId in bb thread spawn --parent-self --project <projectId> --environment <environmentId> --provider <providerId> --model <model> --reasoning-level <reasoningLevel> --title <title> --prompt <self-contained task> --json. Include personal project IDs as returned. Tell the child to do the work itself. Link the child, coordinate using bb thread wait/output/tell, read its actual result, and finish the parent task. Never switch an existing thread to Luna or to another provider.`;

export async function readAgentPolicy(bb: BbPluginApi, threadId: string | null) {
  const settings = await readAutorouterSettings(bb);
  if (!settings.enabled || !settings.modelRouting) return { enabled: false };
  const thread = threadId ? await bb.sdk.threads.get({ threadId: threadId }) : null;
  const execution = threadId ? await bb.sdk.threads.defaultExecutionOptions({ threadId }) : null;
  const environment = thread?.environmentId
    ? await bb.sdk.environments.get({ environmentId: thread.environmentId })
    : null;
  const hostId = environment?.hostId ?? (await bb.sdk.system.config()).primaryHostId;
  const allowed = hostId
    ? await availableRoutesForUsage(bb, hostId, settings.enabledRoutes)
    : new Set<string>();
  const catalog = hostId ? await loadRouteCatalog(bb, hostId, environment?.id) : new Map();
  return {
    enabled: true,
    generalRule: settings.generalRule,
    isSubthread: Boolean(thread?.parentThreadId),
    projectId: thread?.projectId ?? null,
    environmentId: thread?.environmentId ?? null,
    currentExecution:
      execution && thread
        ? {
            providerId: thread.providerId,
            model: execution.model,
            reasoningLevel: execution.reasoningLevel,
            route:
              ROUTES.find(
                (route) =>
                  route.providerId === thread.providerId &&
                  route.model === execution.model &&
                  route.reasoningLevel === execution.reasoningLevel,
              )?.id ?? null,
          }
        : null,
    routes: ROUTES.filter((route) => allowed.has(route.id) && catalog.has(route.id)).map(
      (route) => ({
        route: route.id,
        providerId: route.providerId,
        model: route.model,
        reasoningLevel: route.reasoningLevel,
        rule: settings.rules.find((rule) => rule.route === route.id)?.prompt,
      }),
    ),
  };
}
