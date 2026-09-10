import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MODELS, ROUTES } from "../../../shared/autorouter/policy.ts";

export async function loadRouteCatalog(
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
