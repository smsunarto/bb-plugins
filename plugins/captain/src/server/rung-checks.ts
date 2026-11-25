import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { LadderRole, Rung } from "../contract/ladder.ts";
import { ROLE_SPECS } from "./roles.ts";
import type { TasksPreset } from "./tasks-client.ts";

/**
 * What bb would refuse when a rung's thread starts, read before Captain asks
 * Tasks to start it: the provider must be available on the machine the
 * thread spawns on, and take the permission mode its preset gives it. ACP
 * agents such as Antigravity take `full` and `accept-edits`, not `auto`.
 * The Account Pooler check lives in `ladder.ts`.
 */

/** What bb's provider list says about one provider, as eligibility reads it. */
export type ProviderView = { available: boolean; permissionModes: readonly string[] };
/** Each provider bb lists on one machine, by id. */
export type ProviderViews = ReadonlyMap<string, ProviderView>;

/** What one rung is checked against. */
export type RungCheck = {
  /** Providers on the machine the rung's thread spawns on; null when that machine or its list is unknown. */
  providers: ProviderViews | null;
  /** The mode the role preset gives the rung's preset; null when the role preset is not read. */
  permissionMode: string | null;
  /** The role preset that mode comes from, such as `Implement`. */
  presetName: string;
  /** The machine the providers were read on, for the fix text. */
  hostId: string | null;
};
/** Each rung's check, by 1-based rung number. */
export type RungChecks = (rung: number) => RungCheck;

export type Refusal = { reason: string; fix: string };

/** Why bb would refuse to start this rung's thread, or null when nothing stops it. */
export function rungRefusal(spec: Rung, check: RungCheck): Refusal | null {
  if (check.providers === null) return null;
  const provider = check.providers.get(spec.providerId);
  const where = check.hostId === null ? "" : ` on ${check.hostId}`;
  if (provider === undefined || !provider.available) {
    return {
      reason: `${spec.providerId} is not available${where}`,
      fix: `install, enable or sign in to ${spec.providerId}${where}, or use another rung`,
    };
  }
  const mode = check.permissionMode;
  if (mode !== null && !provider.permissionModes.includes(mode)) {
    return {
      reason: `${spec.providerId} does not take permission mode ${mode}`,
      fix: `set the ${check.presetName} preset's permission to ${provider.permissionModes.join(" or ")}, or use another rung`,
    };
  }
  return null;
}

const DEADLINE_MS = 5_000;

/** bb's providers on one machine, or null when bb does not answer in time. */
export async function readProviders(
  bb: Pick<BbPluginApi, "sdk" | "log">,
  hostId: string,
): Promise<ProviderViews | null> {
  try {
    const providers = await bb.sdk.providers.list({
      hostId,
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    return new Map(
      providers.map((provider) => [
        provider.id,
        {
          available: provider.available,
          permissionModes: [...provider.capabilities.permissionModes],
        },
      ]),
    );
  } catch (error) {
    bb.log.warn(`provider list on ${hostId} not read: ${(error as Error).message}`);
    return null;
  }
}

type Project = Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["get"]>>;
type Hosts = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>;

/**
 * The machine Tasks spawns a preset's thread on, as its delegate decides it:
 * the preset's machine, else the linked project's default source folder on a
 * connected machine, else its first. Null when it cannot be told, such as a
 * personal project's own checkout, or no connected source.
 */
export function spawnHost(
  preset: Pick<TasksPreset, "machineId" | "environmentKind">,
  project: Project | null,
  hosts: Hosts | null,
): string | null {
  if (preset.machineId !== null && preset.machineId !== undefined) return preset.machineId;
  if (project === null || hosts === null) return null;
  if (preset.environmentKind === "project-default" && project.kind === "personal") return null;
  const connected = new Set(
    hosts.filter((host) => host.status === "connected").map((host) => host.id),
  );
  const sources = project.sources.filter((source) => connected.has(source.hostId));
  return (sources.find((source) => source.isDefault) ?? sources[0])?.hostId ?? null;
}

export type ReadChecks = {
  checks: RungChecks;
  /** Whether a read the checks need failed: the role preset, or a machine's provider list. */
  unread: boolean;
};

/**
 * Each rung's check for one role, task project and ladder. A rung spawns
 * through its own `Captain <Role> · <N>` preset when it exists (its machine),
 * else one copied from the role preset; its permission mode is the role
 * preset's, which `ensureRungPreset` keeps rung presets on. Reads each
 * machine's providers once.
 */
export async function readRungChecks(
  bb: Pick<BbPluginApi, "sdk" | "log">,
  input: {
    role: LadderRole;
    ladderLength: number;
    /** Tasks' presets, or null when they could not be read. */
    presets: readonly TasksPreset[] | null;
    /** The bb project the task's thread spawns in; null when not known. */
    bbProjectId: string | null;
    rungPresetName: (rung: number) => string;
  },
): Promise<ReadChecks> {
  const presetName = ROLE_SPECS[input.role].preset?.name ?? "";
  const named = (name: string) =>
    input.presets?.find((preset) => preset.name.toLowerCase() === name.toLowerCase());
  const template = named(presetName);
  const rungs = Array.from({ length: input.ladderLength }, (_, index) => index + 1);
  const presetOf = (rung: number) => named(input.rungPresetName(rung)) ?? template;

  const needsProject = rungs.some((rung) => {
    const preset = presetOf(rung);
    return preset !== undefined && (preset.machineId ?? null) === null;
  });
  const [project, hosts] =
    needsProject && input.bbProjectId !== null
      ? await Promise.all([
          bb.sdk.projects.get({ projectId: input.bbProjectId }).catch(() => null),
          bb.sdk.hosts.list().catch(() => null),
        ])
      : [null, null];

  const hostOf = new Map<number, string | null>();
  for (const rung of rungs) {
    const preset = presetOf(rung);
    hostOf.set(rung, preset === undefined ? null : spawnHost(preset, project, hosts));
  }
  const hostIds = [...new Set([...hostOf.values()].filter((id): id is string => id !== null))];
  const lists = new Map(
    await Promise.all(
      hostIds.map(async (hostId) => [hostId, await readProviders(bb, hostId)] as const),
    ),
  );
  const unread = input.presets === null || [...lists.values()].some((list) => list === null);
  return {
    unread,
    checks: (rung) => {
      const hostId = hostOf.get(rung) ?? null;
      return {
        providers: hostId === null ? null : (lists.get(hostId) ?? null),
        permissionMode: template?.permissionMode ?? null,
        presetName,
        hostId,
      };
    },
  };
}
