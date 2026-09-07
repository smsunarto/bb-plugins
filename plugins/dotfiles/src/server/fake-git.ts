import { mock, type Mock } from "bun:test";
import { bindGit, type DotfilesGit, type ManagedDotfilesGit } from "./git.ts";

export interface FakeDotfilesGit extends DotfilesGit {
  readonly run: Mock<DotfilesGit["run"]>;
}

export function createFakeGit(overrides: Partial<DotfilesGit> = {}): FakeDotfilesGit {
  const run = mock<DotfilesGit["run"]>(
    overrides.run ?? (async () => ({ exitCode: 0, output: "ok" })),
  );
  return {
    getRepoPath: async () => "/dotfiles",
    repoExists: () => true,
    pathExists: () => true,
    discoverSkills: () => [],
    gitStatus: async () => ({ branch: "main", entries: [] }),
    readFile: async () => ({ content: "working", sha256: "sha-working" }),
    readHeadFile: async () => "head",
    writeFile: async () => ({ outcome: "written", sha256: "sha-next" }),
    removeSkill: async () => ({ exitCode: 0, output: "removed" }),
    ...overrides,
    run,
  };
}

/** Bind a fake git collaborator to a host so `gitFor(ctx.bb)` finds it. */
export function provideFakeGit(bb: object, overrides: Partial<DotfilesGit> = {}): FakeDotfilesGit {
  const fake = createFakeGit(overrides);
  bindGit(bb, Object.assign(fake, { dispose() {} }) as ManagedDotfilesGit);
  return fake;
}
