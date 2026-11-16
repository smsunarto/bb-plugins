/**
 * Which machine gets the new worktree when an agent works on a Change no
 * checkout has, such as a pull request only: the project's source on the
 * machine named in settings, else the project's default source.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Project = Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["list"]>>[number];
type Source = Project["sources"][number];

/** The machine name or ID from settings; empty for the project's default. */
export type WorktreeHost = () => Promise<string>;

export function worktreeHostSetting(bb: BbPluginApi): WorktreeHost {
  const settings = bb.settings.define({
    worktreeHost: {
      type: "string",
      label: "Machine for new worktrees",
      description:
        "Machine name or ID where reviews, guides and fixes start a new worktree when no checkout has the branch. A project with no source on that machine uses its default source. Leave empty for each project's default.",
      default: "",
    },
  });
  return async () => (await settings.get()).worktreeHost.trim();
}

/** The source on the wanted machine, matched by ID or case-insensitive name, else the default. */
export function pickSource(
  sources: readonly Source[],
  wanted: string,
  hosts: readonly { id: string; name: string }[],
): Source | undefined {
  const fallback = sources.find((each) => each.isDefault) ?? sources[0];
  if (!wanted) return fallback;
  const name = wanted.toLowerCase();
  const ids = new Set([
    wanted,
    ...hosts.filter((host) => host.name.toLowerCase() === name).map((host) => host.id),
  ]);
  return sources.find((each) => ids.has(each.hostId)) ?? fallback;
}

/** Lists machines only when the setting names one that is not a source's host ID. */
export async function worktreeSource(
  bb: BbPluginApi,
  project: Project,
  host: WorktreeHost,
): Promise<Source | undefined> {
  const wanted = await host().catch(() => "");
  if (!wanted || project.sources.some((each) => each.hostId === wanted))
    return pickSource(project.sources, wanted, []);
  const hosts = await bb.sdk.hosts.list().catch(() => []);
  return pickSource(project.sources, wanted, hosts);
}
