import {
  ROUTER_MODEL,
  ROUTER_REASONING,
  buildRoutingPrompt,
  decisionSchema,
  resolveRoutingDecision,
  type RoutingProject,
} from "../../../shared/autorouter/policy.ts";
import type { AutorouterSettings } from "./settings.ts";
import { z } from "zod";

export interface RouterInference {
  complete(input: {
    model: typeof ROUTER_MODEL;
    reasoningEffort: typeof ROUTER_REASONING;
    prompt: string;
    outputSchema: Record<string, unknown>;
  }): Promise<unknown>;
}

/** One inference decides both dimensions. No second model call on failure. */
export async function routePrompt(input: {
  prompt: string;
  currentProjectId: string | null;
  projects: RoutingProject[];
  settings: AutorouterSettings;
  availableRouteIds: ReadonlySet<string>;
  inference: RouterInference;
  followup?: boolean;
  preserveRoute?: string;
  onInferenceFailure?: (error: unknown) => void;
}) {
  let decision: unknown = null;
  if (input.prompt.trim()) {
    try {
      decision = await input.inference.complete({
        model: ROUTER_MODEL,
        reasoningEffort: ROUTER_REASONING,
        prompt: buildRoutingPrompt({
          prompt: input.prompt,
          currentProjectId: input.currentProjectId,
          projects: input.projects,
          rules: input.settings.rules.filter((rule) => input.availableRouteIds.has(rule.route)),
          fallback: input.settings.fallback,
          followup: input.followup,
          modelRouting: input.settings.modelRouting,
          projectRouting: input.settings.projectRouting,
          generalRule: input.settings.generalRule,
        }),
        outputSchema: z.toJSONSchema(decisionSchema),
      });
    } catch (error) {
      input.onInferenceFailure?.(error);
    }
  }
  return resolveRoutingDecision({
    decision,
    currentProjectId: input.currentProjectId,
    projectIds: new Set(input.projects.map((project) => project.id)),
    availableRouteIds: input.availableRouteIds,
    fallback: input.settings.fallback,
    modelRouting: input.settings.modelRouting,
    projectRouting: input.settings.projectRouting,
    preserveRoute: input.preserveRoute,
  });
}
