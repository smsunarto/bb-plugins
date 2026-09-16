import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readAutorouterSettings } from "./settings.ts";
import { loadRouteCatalog } from "./catalog.ts";
import { availableRoutesForUsage } from "./usage.ts";
import { ROUTES } from "../../../shared/autorouter/policy.ts";

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
