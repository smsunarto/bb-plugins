import type { ComposerSelection, PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

export type Host = Awaited<ReturnType<PluginBrowserBbSdk["hosts"]["list"]>>[number];
export type EnvironmentProvider = Awaited<
  ReturnType<PluginBrowserBbSdk["environments"]["listProviders"]>
>[number];
export type Project = Awaited<ReturnType<PluginBrowserBbSdk["projects"]["get"]>>;
type Environment = NonNullable<ComposerSelection["environment"]>;

/** Where the new thread will run, read from the composer's selection. */
export interface Placement {
  /** Null for an environment that brings its own machine, or none chosen yet. */
  hostId: string | null;
  /** Null when BB names a workspace rather than an environment provider. */
  providerId: string | null;
}

export function placementOf(environment: Environment | undefined): Placement {
  if (!environment) return { hostId: null, providerId: null };
  switch (environment.type) {
    case "provider":
      return {
        hostId: environment.machine?.type === "existing" ? environment.machine.hostId : null,
        providerId: environment.environmentProviderId,
      };
    case "host":
      return { hostId: environment.hostId ?? null, providerId: null };
    default:
      return { hostId: null, providerId: null };
  }
}

/** The machines BB's new-thread picker lists: every one but short-lived sandboxes. */
export function pickableHosts(hosts: readonly Host[]): Host[] {
  return hosts.filter((host) => host.type !== "ephemeral");
}

export interface EnvironmentChoice {
  provider: EnvironmentProvider;
  /** Why the row cannot be picked on this machine, or null. */
  disabledReason: string | null;
  /** What setup the provider still needs on this machine, or null. */
  note: string | null;
}

/**
 * The environments BB's new-thread picker offers on one machine, by its rules: a provider
 * that brings its own machine is not listed under one, a checkout provider needs this project
 * checked out there, a remote provider needs the project's git remote, and the project
 * catalog's availability for the machine decides whether it can be picked.
 */
export function environmentChoices(
  providers: readonly EnvironmentProvider[],
  project: Pick<Project, "kind" | "sources" | "gitRemoteUrl">,
  hostId: string,
): EnvironmentChoice[] {
  const projectless = project.kind === "personal";
  const checkedOutHere = project.sources.some((source) => source.hostId === hostId);
  return providers
    .filter(
      (provider) =>
        !provider.machineProviderId &&
        (projectless
          ? provider.requires.projectless &&
            !provider.requires.projectCheckout &&
            !provider.requires.gitRemote
          : !provider.requires.projectless) &&
        (!(provider.requires.projectCheckout || provider.requires.gitCheckout) || checkedOutHere) &&
        (!provider.requires.gitRemote || project.gitRemoteUrl != null),
    )
    .map((provider) => {
      const availability = provider.machineAvailability[hostId] ?? null;
      return {
        provider,
        disabledReason: availability?.status === "unavailable" ? availability.message : null,
        note: availability?.status === "setup-required" ? availability.message : null,
      };
    });
}

/**
 * What picking a machine applies: the environment already chosen, when that machine offers
 * it, or else the machine's first usable one. BB's own picker follows the same rule.
 */
export function environmentForHost(
  choices: readonly EnvironmentChoice[],
  currentProviderId: string | null,
): EnvironmentProvider | null {
  const usable = choices.filter((choice) => choice.disabledReason === null);
  return (
    usable.find((choice) => choice.provider.id === currentProviderId)?.provider ??
    usable[0]?.provider ??
    null
  );
}

export function placementSelection(hostId: string, providerId: string): ComposerSelection {
  return {
    environment: {
      type: "provider",
      environmentProviderId: providerId,
      inputs: null,
      machine: { type: "existing", hostId },
    },
  };
}
