import type { DotfilesRepository } from "./repository.ts";

/** The all-green fake plus the command strings `run` received, in order. */
export interface FakeDotfilesRepository extends DotfilesRepository {
  readonly commands: readonly string[];
}

/**
 * All-green defaults for every repository method (repoPath "/dotfiles"),
 * with each `run` command recorded on `commands`. Override the methods a
 * test cares about.
 */
export function createFakeRepository(
  overrides: Partial<DotfilesRepository> = {},
): FakeDotfilesRepository {
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
