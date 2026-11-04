import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Skill names bb already delivers from plugins or its built-ins, with their
 * owner, and the names in its user tier. bb has one flat namespace, so a
 * catalog skill with one of the owners' names hides theirs, or is hidden.
 * Throws when bb cannot list its skills.
 */
export async function deliveredSkills(bb: BbPluginApi) {
  // Plugin and built-in skills are the same in every project; any project can list them.
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  const project = projects.find((p) => p.kind === "personal") ?? projects[0];
  if (!project) throw new Error("bb has no project to list skills in");
  const { skills } = await bb.sdk.skills.list({ projectId: project.id, environmentId: null });
  const owners = new Map<string, string>();
  const user = new Set<string>();
  for (const skill of skills) {
    if (skill.provider !== null) continue;
    const name = skill.name.split(":").pop()!;
    if (skill.scope === "plugin") owners.set(name, `plugin ${skill.pluginId ?? "unknown"}`);
    else if (skill.scope === "bb-builtin") owners.set(name, "bb's built-in skills");
    else if (skill.scope === "bb-user") user.add(name);
  }
  return { owners, user };
}
