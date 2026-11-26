import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { LadderRole, Rung } from "../contract/ladder.ts";
import { ROLE_SPECS } from "./roles.ts";
import type { TasksPreset } from "./tasks-client.ts";

/**
 * What bb would refuse when a rung's thread starts, read before Captain asks
 * Tasks to start it: the machine the thread spawns on must be connected, and
 * the provider must be available there and take the permission mode its
 * preset gives it. ACP agents such as Antigravity take `full` and
 * `accept-edits`, not `auto`. The Account Pooler check lives in `ladder.ts`.
 */

/** What bb's provider list says about one provider, as eligibility reads it. */
export type ProviderView = { available: boolean; permissionModes: readonly string[] };
/** Each provider bb lists on one machine, by id. */
export type ProviderViews = ReadonlyMap<string, ProviderView>;

export type Refusal = { reason: string; fix: string };

/** What one rung is checked against. */
export type RungCheck = {
  /** A read this check needs failed or timed out: the presets, the machine list, the project, or the machine's providers. */
  unread: boolean;
  /** Why the rung's machine cannot take the thread, whatever its provider. */
  hostRefusal: Refusal | null;
  /** Providers on the machine the thread spawns on; null when that machine is unknown or unread. */
  providers: ProviderViews | null;
  /** The mode the role preset gives the rung's preset. */
  permissionMode: string | null;
  /** The role preset that mode comes from, such as `Implement`. */
  presetName: string;
  /** The machine the thread spawns on, when known. */
  hostId: string | null;
};

/** Why bb would refuse to start this rung's thread, or null when nothing stops it or it is unread. */
export function rungRefusal(spec: Rung, check: RungCheck): Refusal | null {
  if (check.hostRefusal !== null) return check.hostRefusal;
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

type Project = Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["get"]>>;
type Hosts = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>;
type PresetFields = Pick<TasksPreset, "machineId" | "environmentKind" | "permissionMode">;

export type RungCheckInput = {
  role: LadderRole;
  rung: number;
  /** Tasks' presets, or null when they could not be read. */
  presets: readonly TasksPreset[] | null;
  /** The bb project the task's thread spawns in; null when not known. */
  bbProjectId: string | null;
  rungPresetName: (rung: number) => string;
};

/**
 * Reads what rung checks need, each at most once for the reader's life (one
 * dispatch call, or one background pass): the machine list, each project,
 * and each machine's providers, every read with a deadline. A rung is read
 * only when asked, so a machine no candidate rung uses is never contacted.
 */
export function createCheckReader(bb: Pick<BbPluginApi, "sdk" | "log">) {
  let hosts: Promise<Hosts | null> | undefined;
  const projects = new Map<string, Promise<Project | null>>();
  const lists = new Map<string, Promise<ProviderViews | null>>();

  const read = <T>(what: string, call: (signal: AbortSignal) => Promise<T>) =>
    call(AbortSignal.timeout(DEADLINE_MS)).catch((error: unknown) => {
      bb.log.warn(`${what} not read: ${(error as Error).message}`);
      return null;
    });
  const hostList = () =>
    (hosts ??= read("machine list", (signal) => bb.sdk.hosts.list({ signal })));
  const project = (projectId: string) => {
    let entry = projects.get(projectId);
    if (entry === undefined) {
      entry = read(`project ${projectId}`, (signal) => bb.sdk.projects.get({ projectId, signal }));
      projects.set(projectId, entry);
    }
    return entry;
  };
  const providers = (hostId: string) => {
    let entry = lists.get(hostId);
    if (entry === undefined) {
      entry = read(`provider list on ${hostId}`, async (signal) => {
        const listed = await bb.sdk.providers.list({ hostId, signal });
        return new Map(
          listed.map((provider) => [
            provider.id,
            {
              available: provider.available,
              permissionModes: [...provider.capabilities.permissionModes],
            },
          ]),
        ) as ProviderViews;
      });
      lists.set(hostId, entry);
    }
    return entry;
  };

  return {
    /**
     * One rung's check. Its preset is its own `Captain <Role> · <N>` when
     * that exists, else the one `ensureRungPreset` would copy from the role
     * preset, or from Captain's role spec when that preset is gone. Its mode
     * is the role preset's, which `ensureRungPreset` keeps rung presets on.
     */
    async rungCheck(input: RungCheckInput): Promise<RungCheck> {
      const spec = ROLE_SPECS[input.role].preset;
      const presetName = spec?.name ?? "";
      const base = { presetName, hostId: null, providers: null, hostRefusal: null };
      if (input.presets === null) return { ...base, unread: true, permissionMode: null };
      const named = (name: string) =>
        input.presets?.find((preset) => preset.name.toLowerCase() === name.toLowerCase());
      const template: PresetFields = named(presetName) ?? {
        machineId: null,
        environmentKind: spec?.environmentKind,
        permissionMode: spec?.permissionMode,
      };
      const preset: PresetFields = named(input.rungPresetName(input.rung)) ?? template;
      const permissionMode = template.permissionMode ?? spec?.permissionMode ?? null;
      const unread: RungCheck = { ...base, unread: true, permissionMode };

      const place = await spawnPlace(preset, input.bbProjectId, hostList, project);
      if (place.kind === "unread") return unread;
      if (place.kind === "unknown") return { ...base, unread: false, permissionMode };
      if (place.kind === "refused") {
        return { ...base, unread: false, permissionMode, hostRefusal: place.refusal };
      }
      const list = await providers(place.hostId);
      if (list === null) return { ...unread, hostId: place.hostId };
      return { ...base, unread: false, permissionMode, hostId: place.hostId, providers: list };
    },
  };
}
export type CheckReader = ReturnType<typeof createCheckReader>;

type Place =
  | { kind: "host"; hostId: string }
  | { kind: "refused"; refusal: Refusal }
  | { kind: "unread" }
  /** Captain cannot tell, such as a personal project's own checkout: nothing is refused. */
  | { kind: "unknown" };

/**
 * The machine Tasks spawns a preset's thread on, as its delegate decides it:
 * the preset's machine, else the linked project's default source folder on a
 * connected machine, else its first. A known machine that is not connected,
 * or a project with no connected source, is refused: Tasks would refuse it.
 */
async function spawnPlace(
  preset: PresetFields,
  bbProjectId: string | null,
  hostList: () => Promise<Hosts | null>,
  project: (projectId: string) => Promise<Project | null>,
): Promise<Place> {
  const machineId = preset.machineId ?? null;
  if (machineId === null && bbProjectId === null) return { kind: "unknown" };
  const hosts = await hostList();
  if (hosts === null) return { kind: "unread" };
  const connected = new Set(
    hosts.filter((host) => host.status === "connected").map((host) => host.id),
  );
  if (machineId !== null) {
    return connected.has(machineId)
      ? { kind: "host", hostId: machineId }
      : {
          kind: "refused",
          refusal: {
            reason: `${machineId} is not connected`,
            fix: `reconnect ${machineId}, or use another rung`,
          },
        };
  }
  const found = await project(bbProjectId as string);
  if (found === null) return { kind: "unread" };
  if (preset.environmentKind === "project-default" && found.kind === "personal") {
    return { kind: "unknown" };
  }
  const sources = found.sources.filter((source) => connected.has(source.hostId));
  const source = sources.find((candidate) => candidate.isDefault) ?? sources[0];
  if (source !== undefined) return { kind: "host", hostId: source.hostId };
  return {
    kind: "refused",
    refusal: {
      reason: `no connected machine holds ${found.name}`,
      fix: `connect a machine with ${found.name}'s checkout`,
    },
  };
}
