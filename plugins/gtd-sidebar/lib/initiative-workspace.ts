import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type {
  SharedDirectoryPreviewError,
  SharedDirectoryRepositoryPreview,
  SharedDirectoryWorkspacePreview,
} from "./initiative-types.ts";
import type {
  InspectSharedDirectoryInput,
  InspectSharedDirectoryOutput,
} from "./shared-directory-host.ts";
import {
  SHARED_DIRECTORY_MAX_PATH_LENGTH,
  SHARED_DIRECTORY_MAX_REPOSITORIES,
} from "./shared-directory-host.ts";

type Projects = Pick<BbPluginApi["sdk"]["projects"], "get">;
type Hosts = Pick<BbPluginApi["sdk"]["hosts"], "get">;

export interface SharedDirectoryCandidate {
  hostId?: string;
  rootPath?: string;
}

export interface InitiativeWorkspaceResolverDeps {
  projects: Projects;
  hosts: Hosts;
  inspectSharedDirectory(
    hostId: string,
    input: InspectSharedDirectoryInput,
  ): Promise<InspectSharedDirectoryOutput>;
}

export interface PreviewInitiativeWorkspaceInput {
  workspaceProjectIds: string[];
  candidate?: SharedDirectoryCandidate | null;
}

const error = (
  code: SharedDirectoryPreviewError["code"],
  message: string,
  details: Pick<SharedDirectoryPreviewError, "projectId" | "path"> = {},
): SharedDirectoryPreviewError => ({ code, message, ...details });

const unavailableRepository = (
  projectId: string,
  name = projectId,
): SharedDirectoryRepositoryPreview => ({ projectId, name, hostId: null, path: null });

export function createInitiativeWorkspaceResolver(deps: InitiativeWorkspaceResolverDeps) {
  return async function previewInitiativeWorkspace(
    input: PreviewInitiativeWorkspaceInput,
  ): Promise<SharedDirectoryWorkspacePreview> {
    const errors: SharedDirectoryPreviewError[] = [];
    const requestedHostId = input.candidate?.hostId?.trim() || undefined;
    const requestedRootPath = input.candidate?.rootPath?.trim() || undefined;
    const ids = input.workspaceProjectIds;

    if (ids.length < 2) {
      errors.push(
        error(
          "not-enough-repositories",
          "Shared directory mode requires at least two repository projects.",
        ),
      );
    }
    if (ids.length > SHARED_DIRECTORY_MAX_REPOSITORIES) {
      errors.push(
        error(
          "too-many-repositories",
          `Shared directory mode supports at most ${SHARED_DIRECTORY_MAX_REPOSITORIES} repository projects.`,
        ),
      );
    }
    const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    for (const projectId of duplicateIds) {
      errors.push(
        error(
          "duplicate-project",
          `Repository project ${JSON.stringify(projectId)} is selected twice.`,
          {
            projectId,
          },
        ),
      );
    }
    if (ids.length < 2 || ids.length > SHARED_DIRECTORY_MAX_REPOSITORIES) {
      return {
        eligible: false,
        suggested: null,
        selection: null,
        repositories: ids.map((projectId) => unavailableRepository(projectId)),
        errors,
      };
    }

    const loaded = await Promise.all(
      ids.map(async (projectId) => {
        try {
          return { projectId, project: await deps.projects.get({ projectId }) } as const;
        } catch {
          return { projectId, project: null } as const;
        }
      }),
    );

    const repositories: SharedDirectoryRepositoryPreview[] = [];
    for (const entry of loaded) {
      if (entry.project === null) {
        repositories.push(unavailableRepository(entry.projectId));
        errors.push(
          error(
            "project-not-found",
            `Repository project ${JSON.stringify(entry.projectId)} was not found.`,
            {
              projectId: entry.projectId,
            },
          ),
        );
        continue;
      }
      const sources = requestedHostId
        ? entry.project.sources.filter((source) => source.hostId === requestedHostId)
        : entry.project.sources.filter((source) => source.isDefault);
      if (sources.length === 0) {
        repositories.push(unavailableRepository(entry.project.id, entry.project.name));
        errors.push(
          error(
            "source-missing",
            requestedHostId
              ? `Repository ${JSON.stringify(entry.project.name)} has no checkout on machine ${JSON.stringify(requestedHostId)}.`
              : `Repository ${JSON.stringify(entry.project.name)} has no default checkout.`,
            { projectId: entry.project.id },
          ),
        );
        continue;
      }
      if (sources.length > 1) {
        repositories.push(unavailableRepository(entry.project.id, entry.project.name));
        errors.push(
          error(
            "source-ambiguous",
            `Repository ${JSON.stringify(entry.project.name)} has more than one matching checkout.`,
            { projectId: entry.project.id },
          ),
        );
        continue;
      }
      const source = sources[0]!;
      repositories.push({
        projectId: entry.project.id,
        name: entry.project.name,
        hostId: source.hostId,
        path: source.path,
      });
    }

    const sourceHostIds = [
      ...new Set(repositories.flatMap((repository) => repository.hostId ?? [])),
    ];
    if (sourceHostIds.length > 1) {
      errors.push(
        error(
          "cross-host",
          "Selected repository checkouts are on different machines; one shared environment cannot span machines.",
        ),
      );
      return { eligible: false, suggested: null, selection: null, repositories, errors };
    }
    const hostId = requestedHostId ?? sourceHostIds[0];
    if (hostId === undefined || repositories.some((repository) => repository.path === null)) {
      return { eligible: false, suggested: null, selection: null, repositories, errors };
    }
    if (
      requestedRootPath !== undefined &&
      requestedRootPath.length > SHARED_DIRECTORY_MAX_PATH_LENGTH
    ) {
      errors.push(
        error(
          "invalid-path",
          `The selected shared directory path exceeds ${SHARED_DIRECTORY_MAX_PATH_LENGTH} characters.`,
          { path: requestedRootPath },
        ),
      );
    }
    for (const repository of repositories) {
      if (repository.path !== null && repository.path.length > SHARED_DIRECTORY_MAX_PATH_LENGTH) {
        errors.push(
          error(
            "invalid-path",
            `Repository ${JSON.stringify(repository.name)} checkout path exceeds ${SHARED_DIRECTORY_MAX_PATH_LENGTH} characters.`,
            { projectId: repository.projectId },
          ),
        );
      }
    }
    if (errors.some((entry) => entry.code === "invalid-path")) {
      return { eligible: false, suggested: null, selection: null, repositories, errors };
    }

    let hostName: string;
    try {
      const host = await deps.hosts.get({ hostId });
      hostName = host.name;
      if (host.status !== "connected") {
        errors.push(
          error("host-unavailable", `Machine ${JSON.stringify(host.name)} is not connected.`),
        );
        return { eligible: false, suggested: null, selection: null, repositories, errors };
      }
    } catch {
      errors.push(error("host-unavailable", `Machine ${JSON.stringify(hostId)} is unavailable.`));
      return { eligible: false, suggested: null, selection: null, repositories, errors };
    }

    let inspection: InspectSharedDirectoryOutput;
    try {
      inspection = await deps.inspectSharedDirectory(hostId, {
        repositoryPaths: repositories.map((repository) => repository.path!),
        ...(requestedRootPath === undefined ? {} : { rootPath: requestedRootPath }),
      });
    } catch (cause) {
      errors.push(
        error(
          "host-unavailable",
          `Machine ${JSON.stringify(hostName)} could not validate its directories: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
      return { eligible: false, suggested: null, selection: null, repositories, errors };
    }

    inspection.repositories.forEach((entry, index) => {
      const repository = repositories[index];
      if (repository === undefined) return;
      repository.path = entry.canonicalPath;
      if (entry.kind !== "directory" || entry.canonicalPath === null) {
        errors.push(
          error(
            "source-missing",
            `Repository ${JSON.stringify(repository.name)} checkout is not an existing directory.`,
            { projectId: repository.projectId, path: entry.requestedPath },
          ),
        );
      }
    });

    const canonicalPaths = repositories.flatMap((repository) => repository.path ?? []);
    const duplicatePaths = [
      ...new Set(canonicalPaths.filter((path, index) => canonicalPaths.indexOf(path) !== index)),
    ];
    for (const path of duplicatePaths) {
      errors.push(
        error("duplicate-path", `More than one repository resolves to ${JSON.stringify(path)}.`, {
          path,
        }),
      );
    }

    const suggested =
      inspection.suggestedRootPath === null
        ? null
        : { hostId, hostName, rootPath: inspection.suggestedRootPath };

    let selectedRootPath = inspection.suggestedRootPath;
    if (requestedRootPath !== undefined) {
      const root = inspection.root;
      if (root === null || root.kind === "missing" || root.canonicalPath === null) {
        errors.push(
          error(
            root?.kind === "error" ? "invalid-path" : "root-missing",
            root?.message ?? "The selected shared directory does not exist.",
            {
              path: requestedRootPath,
            },
          ),
        );
        selectedRootPath = null;
      } else if (root.kind !== "directory") {
        errors.push(
          error("root-not-directory", "The selected shared path is not a directory.", {
            path: requestedRootPath,
          }),
        );
        selectedRootPath = null;
      } else {
        selectedRootPath = root.canonicalPath;
      }
    }

    if (
      selectedRootPath !== null &&
      (selectedRootPath === inspection.homePath ||
        selectedRootPath === inspection.filesystemRootPath)
    ) {
      errors.push(
        error(
          "unsafe-root",
          "The shared directory cannot be the machine home directory or filesystem root.",
          { path: selectedRootPath },
        ),
      );
    }

    if (selectedRootPath !== null) {
      for (const [index, repository] of repositories.entries()) {
        if (repository.path !== null && inspection.rootContainsRepositories[index] !== true) {
          errors.push(
            error(
              "outside-root",
              `Repository ${JSON.stringify(repository.name)} is outside the selected shared directory.`,
              { projectId: repository.projectId, path: repository.path },
            ),
          );
        }
      }
    }

    const eligible = errors.length === 0 && selectedRootPath !== null;
    return {
      eligible,
      suggested,
      selection:
        eligible && selectedRootPath !== null
          ? { hostId, hostName, rootPath: selectedRootPath }
          : null,
      repositories,
      errors,
    };
  };
}
