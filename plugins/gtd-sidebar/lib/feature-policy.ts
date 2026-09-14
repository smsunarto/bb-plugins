/** Live effective settings supplied by the SDK settings handle. */
export interface ProjectFeatures {
  projects(): boolean;
  subscriptions(): boolean;
}

export function requireProjects(features: ProjectFeatures): void {
  if (!features.projects())
    throw new Error("Enable Projects coordination in GTD Sidebar settings first.");
}

export function requireSubscriptions(features: ProjectFeatures): void {
  requireProjects(features);
  if (!features.subscriptions())
    throw new Error("Enable Project subscriptions in GTD Sidebar settings first.");
}
