import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Conditions } from "../../shared/rules.ts";
import type { Target, Targets } from "../../shared/targets.ts";

export async function loadTargets(bb: BbPluginApi): Promise<Targets> {
  const [hosts, providers, projects] = await Promise.all([
    bb.sdk.hosts.list(),
    bb.sdk.providers.list(),
    bb.sdk.projects.list(),
  ]);
  return {
    hosts: hosts.map(({ id, name }) => ({ id, name })),
    providers: providers.map(({ id, displayName }) => ({ id, name: displayName })),
    projects: projects.map(({ id, name }) => ({ id, name })),
  };
}

function names(ids: readonly string[], known: readonly Target[]): string {
  return ids.map((id) => known.find((target) => target.id === id)?.name ?? id).join(" or ");
}

/** `host Dev Mac · provider Codex`, or `always` for an unscoped rule. */
export function describeConditions(when: Conditions, targets: Targets): string {
  const parts = [
    when.hosts.length > 0 && `host ${names(when.hosts, targets.hosts)}`,
    when.providers.length > 0 && `provider ${names(when.providers, targets.providers)}`,
    when.models.length > 0 && `model ${when.models.join(" or ")}`,
    when.projects.length > 0 && `project ${names(when.projects, targets.projects)}`,
  ].filter((part) => part !== false);
  return parts.length > 0 ? parts.join(" · ") : "always";
}
