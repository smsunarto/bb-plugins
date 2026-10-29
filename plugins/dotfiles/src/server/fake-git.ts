import { mock, type Mock } from "bun:test";
import type { Checkout, ConnectedTarget, DotfilesGit, Repo } from "./git.ts";

export interface FakeDotfilesGit extends DotfilesGit {
  readonly target: Mock<DotfilesGit["target"]>;
  readonly run: Mock<DotfilesGit["run"]>;
}

/** The bb server's own machine, which the fake resolves when no host is asked for. */
export const serverTarget: ConnectedTarget = {
  hostId: "host_server",
  hostName: "linux-builder",
  repoPath: "~/git/dotfiles",
};

/** Another connected machine, for tests that target one explicitly. */
export const macTarget: ConnectedTarget = {
  hostId: "host_mac",
  hostName: "Local Mac",
  repoPath: "~/git/dotfiles",
};

/** A clean checkout on `target` with every fixed file present and no skills. */
export function cleanRepo(
  target: ConnectedTarget = serverTarget,
  overrides: Partial<Repo> = {},
): Repo {
  return {
    ...target,
    repo: "found",
    repoPath: "/dotfiles",
    branch: "main",
    entries: [],
    skills: [],
    missingPaths: [],
    ...overrides,
  };
}

/** `target` with nothing at its repo path. */
export function missingRepo(target: ConnectedTarget = serverTarget): Checkout {
  return { ...target, repo: "missing", repoPath: "/dotfiles" };
}

export function createFakeGit(overrides: Partial<DotfilesGit> = {}): FakeDotfilesGit {
  const target = mock<DotfilesGit["target"]>(
    overrides.target ??
      (async (hostId) => ({
        state: "connected",
        ...(hostId === macTarget.hostId ? macTarget : serverTarget),
      })),
  );
  const run = mock<DotfilesGit["run"]>(
    overrides.run ?? (async () => ({ exitCode: 0, output: "ok" })),
  );
  return {
    hosts: async () => ({
      selectedHostId: serverTarget.hostId,
      hosts: [{ id: serverTarget.hostId, name: serverTarget.hostName, connected: true }],
    }),
    selectHost: async () => {},
    threadHostId: async () => undefined,
    inspect: async (resolved) => cleanRepo(resolved),
    readFile: async () => ({ content: "working", sha256: "sha-working" }),
    readHeadFile: async () => "head",
    writeFile: async () => ({ outcome: "written", sha256: "sha-next" }),
    removeSkill: async () => ({ exitCode: 0, output: "removed" }),
    ...overrides,
    target,
    run,
  };
}
