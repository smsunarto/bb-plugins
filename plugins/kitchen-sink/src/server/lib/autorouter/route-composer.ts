import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  autorouterHostContract,
  routeAutorouterPromptInputSchema,
} from "../../../shared/autorouter/contract.ts";
import type { z } from "zod";
import { ROUTES, resolveRoutingDecision } from "../../../shared/autorouter/policy.ts";
import { loadRouteCatalog } from "./catalog.ts";
import { readAutorouterSettings } from "./settings.ts";
import { routePrompt, type RouterInference } from "./router.ts";
import { availableRoutesForUsage } from "./usage.ts";

export async function routeComposerPrompt(
  bb: BbPluginApi,
  input: z.infer<typeof routeAutorouterPromptInputSchema>,
) {
  const context = await loadRoutingContext(bb, input);
  const { settings, projects, thread, currentProjectId, environment, hostId, inferenceHostId } =
    context;
  const projectRouting = settings.projectRouting && !thread;
  if (!settings.modelRouting && !projectRouting) return null;
  const catalog = await loadRouteCatalog(bb, hostId, environment?.id, thread?.providerId);
  const eligible = settings.modelRouting
    ? await availableRoutesForUsage(bb, hostId, settings.enabledRoutes)
    : new Set<string>();
  const constraints = constrainFollowup(input.scope, catalog, eligible);
  if (!constraints) return null;
  const { availableRouteIds, currentRoute } = constraints;
  if (thread && availableRouteIds.size === 0) return null;
  const routingSettings = { ...settings, projectRouting: settings.projectRouting && !thread };
  const started = performance.now();
  const result = await routePrompt({
    prompt: input.prompt,
    currentProjectId,
    projects: routingProjects(projects, settings.projects, thread ? currentProjectId : undefined),
    settings: routingSettings,
    availableRouteIds,
    followup: Boolean(thread),
    preserveRoute: currentRoute?.id,
    inference: createInference(bb, inferenceHostId),
    onInferenceFailure: (error) => bb.log.warn(`autorouter inference: ${String(error)}`),
  });
  const resolved = await resolveDestination(
    bb,
    result,
    context,
    catalog,
    eligible,
    currentRoute?.id,
  );
  bb.log.info(
    `autorouter ${JSON.stringify({ route: resolved.execution?.route, projectId: resolved.projectId, usedFallback: resolved.usedFallback, elapsedMs: Math.round(performance.now() - started) })}`,
  );
  return resolved;
}

async function loadRoutingContext(
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
  return {
    settings,
    projects,
    config,
    thread,
    currentProjectId,
    environment,
    hostId,
    inferenceHostId,
  };
}

async function resolveDestination(
  bb: BbPluginApi,
  result: Awaited<ReturnType<typeof routePrompt>>,
  context: Awaited<ReturnType<typeof loadRoutingContext>>,
  catalog: Awaited<ReturnType<typeof loadRouteCatalog>>,
  eligible: ReadonlySet<string>,
  currentRoute?: string,
) {
  const { settings, projects, environment, hostId, config } = context;
  const destinationHost =
    environment?.hostId ?? projectHostId(projects, result.projectId, config.primaryHostId);
  if (!destinationHost) throw new Error("The selected project has no available machine.");
  const destinationCatalog =
    destinationHost === hostId ? catalog : await loadRouteCatalog(bb, destinationHost);
  const destinationEligible =
    destinationHost === hostId
      ? eligible
      : await availableRoutesForUsage(bb, destinationHost, settings.enabledRoutes);
  if (
    result.execution &&
    (!destinationCatalog.has(result.execution.route) ||
      (!currentRoute && !destinationEligible.has(result.execution.route)))
  ) {
    result = resolveRoutingDecision({
      decision: null,
      currentProjectId: result.projectId,
      projectIds: new Set(projects.map((project) => project.id)),
      availableRouteIds: new Set(
        [...destinationCatalog.keys()].filter((id) => destinationEligible.has(id)),
      ),
      fallback: settings.fallback,
      modelRouting: settings.modelRouting,
      projectRouting: false,
      preserveRoute: currentRoute,
    });
  }
  const labels = result.execution ? destinationCatalog.get(result.execution.route) : null;
  if (result.execution && !labels)
    throw new Error("The autorouter selection is unavailable on the selected machine.");
  return {
    ...result,
    execution: result.execution && labels ? { ...result.execution, ...labels } : null,
    projectName: projects.find((project) => project.id === result.projectId)?.name ?? null,
  };
}

/** Native draft selections include manual edits that are not yet saved on the thread. */
function constrainFollowup(
  scope: z.infer<typeof routeAutorouterPromptInputSchema>["scope"],
  catalog: Awaited<ReturnType<typeof loadRouteCatalog>>,
  enabled: ReadonlySet<string>,
) {
  if (scope.kind === "new-thread")
    return {
      availableRouteIds: new Set([...catalog.keys()].filter((id) => enabled.has(id))),
      currentRoute: null,
    };
  const astraRoutes = ROUTES.filter(
    (route) => route.model === "gpt-6-astra" && catalog.has(route.id),
  );
  const currentRoute = ROUTES.filter(
    (route) => (route.key === "astra" || route.id === "luna/max") && catalog.has(route.id),
  ).find((route) => {
    const labels = catalog.get(route.id)!;
    return (
      scope.selectionTitle ===
      `${labels.providerLabel}: ${labels.modelLabel} · ${labels.reasoningLabel} reasoning`
    );
  });
  if (!currentRoute) return null;
  return {
    availableRouteIds: new Set(
      astraRoutes.filter((route) => enabled.has(route.id)).map((route) => route.id),
    ),
    currentRoute,
  };
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
