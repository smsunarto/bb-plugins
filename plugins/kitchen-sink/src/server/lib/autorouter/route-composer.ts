import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  autorouterHostContract,
  routeAutorouterPromptInputSchema,
} from "../../../shared/autorouter/contract.ts";
import type { z } from "zod";
import { MODELS, ROUTES, resolveRoutingDecision } from "../../../shared/autorouter/policy.ts";
import { readAutorouterSettings } from "./settings.ts";
import { routePrompt, type RouterInference } from "./router.ts";

export async function routeComposerPrompt(
  bb: BbPluginApi,
  input: z.infer<typeof routeAutorouterPromptInputSchema>,
) {
  const [settings, projects, config, thread] = await Promise.all([
    readAutorouterSettings(bb),
    bb.sdk.projects.list(),
    bb.sdk.system.config(),
    input.scope.kind === "thread" ? bb.sdk.threads.get({ threadId: input.scope.threadId }) : null,
  ]);
  if (!settings.enabled)
    throw new Error("Autorouter is disabled. Submit again to use your selections.");
  const currentProjectId =
    input.scope.kind === "new-thread" ? input.scope.projectId : thread!.projectId;
  const environment = thread?.environmentId
    ? await bb.sdk.environments.get({ environmentId: thread.environmentId })
    : null;
  const hostId =
    environment?.hostId ?? projectHostId(projects, currentProjectId, config.primaryHostId);
  const inferenceHostId = config.primaryHostId ?? hostId;
  if (!hostId || !inferenceHostId) throw new Error("No machine is available for autorouting.");
  const catalog = await loadCatalog(bb, hostId, environment?.id, thread?.providerId);
  const constraints = constrainFollowup(input.scope, catalog);
  if (!constraints) return null;
  const { availableRouteIds, currentRoute } = constraints;
  const routingSettings = currentRoute ? { ...settings, fallback: currentRoute.id } : settings;
  const started = performance.now();
  let result = await routePrompt({
    prompt: input.prompt,
    currentProjectId,
    projects: routingProjects(projects, settings.projects, thread ? currentProjectId : undefined),
    settings: routingSettings,
    availableRouteIds,
    reasoningOnly: Boolean(thread),
    inference: createInference(bb, inferenceHostId),
    onInferenceFailure: (error) => bb.log.warn(`autorouter inference: ${String(error)}`),
  });
  const destinationHost =
    environment?.hostId ?? projectHostId(projects, result.projectId, config.primaryHostId);
  if (!destinationHost) throw new Error("The selected project has no available machine.");
  const destinationCatalog =
    destinationHost === hostId ? catalog : await loadCatalog(bb, destinationHost);
  if (!destinationCatalog.has(result.route)) {
    result = resolveRoutingDecision({
      decision: null,
      currentProjectId: result.projectId,
      projectIds: new Set(projects.map((project) => project.id)),
      availableRouteIds: new Set(destinationCatalog.keys()),
      fallback: routingSettings.fallback,
    });
  }
  const labels = destinationCatalog.get(result.route);
  if (!labels) throw new Error("The autorouter fallback is unavailable on the selected machine.");
  bb.log.info(
    `autorouter ${JSON.stringify({ route: result.route, projectId: result.projectId, usedFallback: result.usedFallback, elapsedMs: Math.round(performance.now() - started) })}`,
  );
  return {
    ...result,
    ...labels,
    projectName: projects.find((project) => project.id === result.projectId)?.name ?? null,
  };
}

/** Native draft selections include manual edits that are not yet saved on the thread. */
function constrainFollowup(
  scope: z.infer<typeof routeAutorouterPromptInputSchema>["scope"],
  catalog: Awaited<ReturnType<typeof loadCatalog>>,
) {
  if (scope.kind === "new-thread")
    return { availableRouteIds: new Set(catalog.keys()), currentRoute: null };
  const astraRoutes = ROUTES.filter(
    (route) => route.model === "gpt-6-astra" && catalog.has(route.id),
  );
  const currentRoute = astraRoutes.find((route) => {
    const labels = catalog.get(route.id)!;
    return (
      scope.selectionTitle ===
      `${labels.providerLabel}: ${labels.modelLabel} · ${labels.reasoningLabel} reasoning`
    );
  });
  if (!currentRoute) return null;
  return { availableRouteIds: new Set(astraRoutes.map((route) => route.id)), currentRoute };
}

async function loadCatalog(
  bb: BbPluginApi,
  hostId: string,
  environmentId?: string,
  threadProviderId?: string,
) {
  const entries = await Promise.all(
    [...new Set(MODELS.map((model) => model.providerId))]
      .filter((providerId) => !threadProviderId || providerId === threadProviderId)
      .map(async (providerId) => {
        try {
          const catalog = await bb.sdk.providers.models({
            providerId,
            ...(environmentId ? { environmentId } : { hostId }),
          });
          const provider = catalog.providers.find(
            (provider) => provider.id === providerId && provider.available,
          );
          if (!provider) return [];
          return ROUTES.filter((route) => route.providerId === providerId).flatMap((route) => {
            const model = catalog.models.find(
              (model) =>
                model.model === route.model &&
                model.supportedReasoningEfforts.some(
                  (effort) => effort.reasoningEffort === route.reasoningLevel,
                ),
            );
            if (!model) return [];
            const prefix = provider.strings?.brandPrefix;
            const modelLabel =
              prefix && model.displayName.toLowerCase().startsWith(prefix.toLowerCase())
                ? model.displayName.slice(prefix.length).trimStart()
                : model.displayName;
            return [
              [
                route.id,
                {
                  providerLabel: provider.displayName,
                  modelLabel,
                  reasoningLabel:
                    provider.reasoningLevels?.find((effort) => effort.id === route.reasoningLevel)
                      ?.label ?? route.reasoningLevel,
                },
              ] as const,
            ];
          });
        } catch {
          return [];
        }
      }),
  );
  return new Map(entries.flat());
}

function createInference(bb: BbPluginApi, hostId: string): RouterInference {
  const host = bb.hosts.experimental_client({ contract: autorouterHostContract });
  return {
    async complete(request) {
      const response = await host.call(
        "complete",
        autorouterHostContract.complete.input.parse({ ...request, timeoutMs: 20_000 }),
        { hostId },
      );
      if (!response.ok) throw new Error(response.message);
      return response.value;
    },
  };
}

function routingProjects(
  projects: Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["list"]>>,
  index: Awaited<ReturnType<typeof readAutorouterSettings>>["projects"],
  fixedProjectId?: string | null,
) {
  return projects
    .filter((project) => fixedProjectId === undefined || project.id === fixedProjectId)
    .map((project) => ({
      id: project.id,
      name: project.name,
      repositories: index.filter((entry) => entry.projectId === project.id),
    }));
}

function projectHostId(
  projects: Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["list"]>>,
  projectId: string | null,
  primaryHostId: string | null,
) {
  const sources = projects.find((project) => project.id === projectId)?.sources ?? [];
  return (sources.find((source) => source.isDefault) ?? sources[0])?.hostId ?? primaryHostId;
}
