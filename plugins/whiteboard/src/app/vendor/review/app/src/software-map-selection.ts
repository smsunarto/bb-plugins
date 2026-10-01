// Vendored from dev.fast review/app/src/software-map-selection.ts @4ecc570 (MIT).
import type { NormalizedSoftwareModel } from "./software-map/model.ts";

export function selectActiveSoftwareMapModel({
  softwareModels,
  focusElementPath,
}: {
  softwareModels: readonly NormalizedSoftwareModel[];
  focusElementPath?: string;
}): NormalizedSoftwareModel | undefined {
  if (focusElementPath) {
    const focusedModel = softwareModels.find((model) =>
      model.elementsByPath.has(focusElementPath),
    );

    if (focusedModel) return focusedModel;
  }

  return softwareModels[0];
}
