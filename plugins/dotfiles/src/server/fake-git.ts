import { mock, type Mock } from "bun:test";
import type { DotfilesGit, Repo, Target } from "./git.ts";

export interface FakeDotfilesGit extends DotfilesGit {
  readonly target: Mock<DotfilesGit["target"]>;
  readonly run: Mock<DotfilesGit["run"]>;
}

/** The bb server's own machine, which the fake resolves when no host is asked for. */
export const serverTarget: Target = {
  hostId: "host_server",
  hostName: "linux-builder",
  connected: true,
  repoPath: "~/git/dotfiles",
};

/** Another connected machine, for tests that target one explicitly. */
export const macTarget: Target = {
  hostId: "host_mac",
  hostName: "Local Mac",
  connected: true,
  repoPath: "~/git/dotfiles",
};

/** A clean checkout on `target` with every fixed file present and no skills. */
export function cleanRepo(target: Target = serverTarget, overrides: Partial<Repo> = {}): Repo {
  return {
    ...target,
    repoPath: "/dotfiles",
    repoExists: true,
    branch: "main",
    entries: [],
    skills: [],
    missingPaths: [],
    ...overrides,
  };
}

export function createFakeGit(overrides: Partial<DotfilesGit> = {}): FakeDotfilesGit {
  const target = mock<DotfilesGit["target"]>(
    overrides.target ??
      (async (hostId) => (hostId === macTarget.hostId ? macTarget : serverTarget)),
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
