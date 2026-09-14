import type { ComponentType } from "react";
import { useProjectFeatures } from "@/hooks/use-project-features";

export function ProjectsDisabled() {
  return (
    <div className="flex flex-col gap-3 p-6 text-sm" data-projects-disabled="">
      <h2 className="font-semibold">Projects coordination is optional</h2>
      <p>
        Enable Projects coordination in Settings → Plugins → GTD Sidebar to use coordinator threads,
        delegated agents, shared context and workspace bindings.
      </p>
      <p>
        Project subscriptions have a separate opt-in for scheduled prompts and GitHub/Slack polling.
      </p>
      <p>Your saved Projects are preserved. Their native threads remain available in the inbox.</p>
    </div>
  );
}

/** Unmount feature children so disabled surfaces cannot fetch or mutate. */
export function withProjects<P extends object>(Component: ComponentType<P>, explain = false) {
  return function ProjectFeature(props: P) {
    const { projects } = useProjectFeatures();
    return projects ? <Component {...props} /> : explain ? <ProjectsDisabled /> : null;
  };
}
