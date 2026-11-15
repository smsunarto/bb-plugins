import { describe, expect, it } from "vitest";
import {
  environmentChoices,
  environmentForHost,
  placementOf,
  type EnvironmentProvider,
  type Project,
} from "./machine-options";

function provider(
  id: string,
  overrides: Partial<Omit<EnvironmentProvider, "requires">> & {
    requires?: Partial<EnvironmentProvider["requires"]>;
  } = {},
): EnvironmentProvider {
  const { requires, ...rest } = overrides;
  return {
    id,
    displayName: id,
    machineProviderId: null,
    machineAvailability: {},
    requires: {
      gitCheckout: false,
      gitRemote: false,
      projectCheckout: false,
      projectless: false,
      ...requires,
    },
    ...rest,
  } as EnvironmentProvider;
}

const project: Pick<Project, "kind" | "sources" | "gitRemoteUrl"> = {
  kind: "standard",
  gitRemoteUrl: null,
  sources: [{ hostId: "mac" } as Project["sources"][number]],
};

describe("environmentChoices", () => {
  it("lists a checkout environment only on machines with the project checked out", () => {
    const checkout = provider("checkout", { requires: { projectCheckout: true } });
    expect(environmentChoices([checkout], project, "mac").map((c) => c.provider.id)).toEqual([
      "checkout",
    ]);
    expect(environmentChoices([checkout], project, "pc")).toEqual([]);
  });

  it("leaves out environments that bring their own machine or need a missing git remote", () => {
    const cloud = provider("cloud", { machineProviderId: "sandbox" });
    const remote = provider("remote", { requires: { gitRemote: true } });
    expect(environmentChoices([cloud, remote], project, "mac")).toEqual([]);
    expect(
      environmentChoices([remote], { ...project, gitRemoteUrl: "git@x:y.git" }, "mac"),
    ).toHaveLength(1);
  });

  it("offers only projectless environments outside a project", () => {
    const personal = provider("personal", { requires: { projectless: true } });
    const worktree = provider("worktree");
    const choices = environmentChoices(
      [personal, worktree],
      { ...project, kind: "personal" },
      "mac",
    );
    expect(choices.map((c) => c.provider.id)).toEqual(["personal"]);
  });

  it("reads the machine's availability into a disabled reason or a setup note", () => {
    const blocked = provider("blocked", {
      machineAvailability: { mac: { status: "unavailable", message: "No Docker" } },
    });
    const setup = provider("setup", {
      machineAvailability: { mac: { status: "setup-required", message: "Sign in first" } },
    });
    const [first, second] = environmentChoices([blocked, setup], project, "mac");
    expect(first).toMatchObject({ disabledReason: "No Docker", note: null });
    expect(second).toMatchObject({ disabledReason: null, note: "Sign in first" });
  });
});

describe("environmentForHost", () => {
  const choices = environmentChoices(
    [
      provider("off", { machineAvailability: { mac: { status: "unavailable", message: "x" } } }),
      provider("worktree"),
      provider("checkout"),
    ],
    project,
    "mac",
  );

  it("keeps the chosen environment when the machine offers it", () => {
    expect(environmentForHost(choices, "checkout")?.id).toBe("checkout");
  });

  it("falls back to the machine's first usable environment", () => {
    expect(environmentForHost(choices, "off")?.id).toBe("worktree");
    expect(environmentForHost([], "checkout")).toBeNull();
  });
});

describe("placementOf", () => {
  it("reads the machine and environment from a provider selection", () => {
    expect(
      placementOf({
        type: "provider",
        environmentProviderId: "checkout",
        inputs: null,
        machine: { type: "existing", hostId: "mac" },
      }),
    ).toEqual({ hostId: "mac", providerId: "checkout" });
  });

  it("has no machine for an environment that creates one", () => {
    expect(
      placementOf({
        type: "provider",
        environmentProviderId: "cloud",
        inputs: null,
        machine: { type: "new", machineProviderId: "sandbox", inputs: null },
      }),
    ).toEqual({ hostId: null, providerId: "cloud" });
  });
});
