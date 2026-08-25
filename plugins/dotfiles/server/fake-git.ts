import { bindGit, type DotfilesGit, type ManagedDotfilesGit } from "./git.ts";

/** The all-green fake plus the command strings `run` received, in order. */
export interface FakeDotfilesGit extends DotfilesGit {
  readonly commands: readonly string[];
}

/**
 * All-green defaults for every git method (repoPath "/dotfiles"),
 * with each `run` command recorded on `commands`. Override the methods a
 * test cares about.
 */
export function createFakeGit(
  overrides: Partial<DotfilesGit> = {},
): FakeDotfilesGit {
  const commands: string[] = [];
  return {
    commands,
    getRepoPath: async () => "/dotfiles",
    repoExists: () => true,
    pathExists: () => true,
    discoverSkills: () => [],
    gitStatus: async () => ({ branch: "main", entries: [] }),
    readFile: async () => ({ content: "working", sha256: "sha-working" }),
    readHeadFile: async () => "head",
    writeFile: async () => ({ outcome: "written", sha256: "sha-next" }),
    run: async (_repoPath, command) => {
      commands.push(command);
      return { exitCode: 0, output: "ok" };
    },
    removeSkill: async () => ({ exitCode: 0, output: "removed" }),
    ...overrides,
  };
}

/** Bind a fake git collaborator to a host so `gitFor(context.bb)` finds it. */
export function provideFakeGit(
  bb: object,
  overrides: Partial<DotfilesGit> = {},
): FakeDotfilesGit {
  const fake = createFakeGit(overrides);
  bindGit(bb, Object.assign(fake, { dispose() {} }) as ManagedDotfilesGit);
  return fake;
}
