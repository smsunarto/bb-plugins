import type { OperationHandlersFor } from "../../lib/bb-kit/operations.js";
import type { GitEntry, TaskResult } from "./contract.js";
import { dotfilesOperations } from "./generated/operations.js";
import {
  groupDefinitions,
  isAllowedPath,
  isValidSkillName,
  needsRender,
  publishTask,
  taskDefinitions,
  toOverviewGroup,
  type TweakableDefinition,
} from "./model.js";

export interface DotfilesRepository {
  getRepoPath(): Promise<string>;
  repoExists(repoPath: string): boolean;
  pathExists(repoPath: string, path: string): boolean;
  discoverSkills(repoPath: string): readonly TweakableDefinition[];
  gitStatus(repoPath: string): Promise<{
    branch: string;
    entries: GitEntry[];
  }>;
  readFile(
    repoPath: string,
    path: string,
  ): Promise<{
    content: string;
    sha256: string;
  }>;
  readHeadFile(repoPath: string, path: string): Promise<string | null>;
  writeFile(
    repoPath: string,
    path: string,
    content: string,
    expectedSha256: string,
  ): Promise<{ outcome: "written"; sha256: string } | { outcome: "conflict" }>;
  run(repoPath: string, command: string): Promise<TaskResult>;
  removeSkill(repoPath: string, name: string): Promise<TaskResult>;
}

export interface DotfilesServiceDependencies {
  readonly repository: DotfilesRepository;
  readonly log: (message: string) => void;
}

export function createDotfilesService({
  repository,
  log,
}: DotfilesServiceDependencies): OperationHandlersFor<typeof dotfilesOperations> {
  async function definitions(repoPath: string): Promise<readonly TweakableDefinition[]> {
    return repository.repoExists(repoPath) ? repository.discoverSkills(repoPath) : [];
  }

  async function requireAllowedPath(repoPath: string, path: string): Promise<void> {
    const skills = await definitions(repoPath);
    if (!isAllowedPath(path, skills)) {
      throw new Error(`not a tweakable file: ${path}`);
    }
  }

  return {
    async overview() {
      const repoPath = await repository.getRepoPath();
      const repoExists = repository.repoExists(repoPath);
      const skills = await definitions(repoPath);
      const status = repoExists
        ? await repository.gitStatus(repoPath)
        : { branch: "missing", entries: [] };
      const dirtyPaths = new Set(status.entries.map((entry) => entry.path));
      return {
        repoPath,
        repoExists,
        branch: status.branch,
        gitEntries: status.entries,
        groups: groupDefinitions(skills).map((group) =>
          toOverviewGroup(group, (path) => repository.pathExists(repoPath, path), dirtyPaths),
        ),
      };
    },

    async readFile({ path }) {
      const repoPath = await repository.getRepoPath();
      await requireAllowedPath(repoPath, path);
      const [file, headContent] = await Promise.all([
        repository.readFile(repoPath, path),
        repository.readHeadFile(repoPath, path),
      ]);
      return { ...file, headContent };
    },

    async saveFile({ path, content, expectedSha256 }) {
      const repoPath = await repository.getRepoPath();
      await requireAllowedPath(repoPath, path);
      const result = await repository.writeFile(repoPath, path, content, expectedSha256);
      if (result.outcome === "conflict") return result;
      return {
        outcome: "written",
        sha256: result.sha256,
        renderHint: needsRender(path),
      };
    },

    async runTask({ task }) {
      const repoPath = await repository.getRepoPath();
      const definition = taskDefinitions[task];
      log(`running task ${task}: ${definition.command}`);
      return repository.run(repoPath, definition.command);
    },

    async publish() {
      const repoPath = await repository.getRepoPath();
      log(`running publish: ${publishTask.command}`);
      return repository.run(repoPath, publishTask.command);
    },

    async removeSkill({ name }) {
      if (!isValidSkillName(name)) throw new Error(`invalid skill name: ${name}`);
      const repoPath = await repository.getRepoPath();
      const skillExists = repository.discoverSkills(repoPath).some((skill) => skill.title === name);
      if (!skillExists) return { outcome: "not-found" };
      log(`removing skill ${name} via npx skills`);
      const result = await repository.removeSkill(repoPath, name);
      return { outcome: "completed", ...result };
    },
  };
}

export type DotfilesService = ReturnType<typeof createDotfilesService>;
