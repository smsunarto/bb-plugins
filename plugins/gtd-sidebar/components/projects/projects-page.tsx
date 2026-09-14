import { useEffect, useMemo, useState } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useProviders as useProviders,
  useBbNavigate,
  useRpc,
  type ExperimentalProviderModelPickerValue,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { Initiative, InitiativeWorkspace } from "@/lib/initiative-types";
import type { initiativeRpcContract } from "@/lib/initiative-rpc";
import {
  projectDescendantCount,
  resolveNewProjectWorkspaceMode,
  workspaceSummary,
  type NewProjectWorkspaceMode,
} from "@/lib/initiative-ui";
import { useInitiatives } from "@/hooks/use-initiatives";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InitiativeIcon, InitiativeIconPicker } from "@/components/projects/icons";
import {
  SharedDirectoryPreview,
  useSharedDirectoryPreview,
  type SharedDirectoryPreviewController,
} from "@/components/projects/shared-directory";

const DEFAULT_ENVIRONMENT = "__default__";

/**
 * The Projects navPanel: `/plugins/<id>/projects` is the management index
 * (active + archived projects, restore lives here), `.../new` is the create
 * form. Kept deliberately flat — project chrome for a live project happens
 * on its coordinator thread route, not here.
 */
export function ProjectsPage({ subPath }: PluginNavPanelProps) {
  if (subPath === "new") return <CreateProjectForm />;
  return <ProjectsIndex />;
}

function ProjectsIndex() {
  const initiatives = useInitiatives();
  const { threads } = useSidebarThreads();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof initiativeRpcContract>();
  const [restoreError, setRestoreError] = useState<string | null>(null);

  if (initiatives.status === "loading") {
    return <p className="p-4 text-xs text-muted-foreground">Loading projects…</p>;
  }
  if (initiatives.status === "error" && initiatives.active.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 p-4">
        <p className="text-xs text-muted-foreground">Couldn’t load projects.</p>
        <Button variant="outline" size="sm" onClick={initiatives.retry}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4" data-projects-index="">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-semibold">Projects</h1>
        <Button
          size="sm"
          variant="outline"
          onClick={() => navigate.toPluginPanel("projects", { subPath: "new" })}
        >
          <Icon name="Plus" className="size-3.5" aria-hidden />
          New project
        </Button>
      </div>
      {initiatives.active.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
          No projects yet. A project gives a coordinator chat persistent context, agents, and
          subscriptions.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {initiatives.active.map((initiative) => (
            <IndexRow
              key={initiative.id}
              initiative={initiative}
              agentCount={projectDescendantCount(threads, initiative.coordinatorThreadId)}
              onOpen={() => navigate.toThread(initiative.coordinatorThreadId)}
            />
          ))}
        </ul>
      )}
      {initiatives.archived.length > 0 ? (
        <section aria-label="Archived projects">
          <h2 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Archived
          </h2>
          <ul className="flex flex-col gap-1">
            {initiatives.archived.map((initiative) => (
              <li
                key={initiative.id}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground"
              >
                <InitiativeIcon icon={initiative.icon} className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">{initiative.name}</span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setRestoreError(null);
                    rpc
                      .call("unarchiveInitiative", { initiativeId: initiative.id })
                      .catch((error: unknown) =>
                        setRestoreError(error instanceof Error ? error.message : "Restore failed"),
                      );
                  }}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
          {restoreError !== null ? (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {restoreError}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function IndexRow({
  initiative,
  agentCount,
  onOpen,
}: {
  initiative: Initiative;
  agentCount: number;
  onOpen: () => void;
}) {
  const { projects } = useSidebarThreads();
  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-accent/50"
      >
        <InitiativeIcon icon={initiative.icon} className="size-4" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{initiative.name}</span>
          <span className="block truncate text-2xs text-muted-foreground">
            {workspaceSummary(initiative, projectNameById)}
            {agentCount > 0 ? ` · ${agentCount} ${agentCount === 1 ? "agent" : "agents"}` : ""}
          </span>
        </span>
        <Icon name="ChevronRight" className="size-3.5 text-muted-foreground" aria-hidden />
      </button>
    </li>
  );
}

/**
 * Cursor's create form, adapted: icon, name, workspace (multi or scratch),
 * environment for the coordinator, provider/model, then spawn + navigate.
 */
function CreateProjectForm() {
  const rpc = useRpc<typeof initiativeRpcContract>();
  const navigate = useBbNavigate();
  const { projects } = useSidebarThreads();
  const { providers } = useProviders();

  const [name, setName] = useState("");
  const [icon, setIcon] = useState("folder");
  const [description, setDescription] = useState("");
  const [workspaceIds, setWorkspaceIds] = useState<readonly string[]>([]);
  const [preferredWorkspaceMode, setPreferredWorkspaceMode] =
    useState<NewProjectWorkspaceMode>("shared-directory");
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [environments, setEnvironments] = useState<
    readonly { id: string; name: string | null; status: string }[]
  >([]);
  const [model, setModel] = useState<ExperimentalProviderModelPickerValue>(() => ({
    providerId: providers[0]?.id ?? "",
    model: "",
    reasoningLevel: "high",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workspaceMode = resolveNewProjectWorkspaceMode(preferredWorkspaceMode, workspaceIds.length);
  const sharedDirectory = useSharedDirectoryPreview({
    workspaceProjectIds: workspaceIds,
    enabled: workspaceMode === "shared-directory",
  });
  const selectedWorkspaceIds = useMemo(() => new Set(workspaceIds), [workspaceIds]);
  const primaryWorkspaceId = workspaceIds[0] ?? null;
  // Coordinator environments come from the primary bound repo; scratch
  // initiatives run on the personal project's default environment.
  const environmentsProjectId = workspaceMode === "legacy" ? primaryWorkspaceId : null;
  useEffect(() => {
    setEnvironmentId(null);
    setEnvironments([]);
    if (environmentsProjectId === null) return;
    let cancelled = false;
    rpc
      .call("listInitiativeEnvironments", { projectId: environmentsProjectId })
      .then((result) => {
        if (!cancelled) setEnvironments(result.environments);
        return;
      })
      .catch(() => {
        if (!cancelled) setEnvironments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [environmentsProjectId, rpc]);

  const toggleWorkspace = (id: string) => {
    setWorkspaceIds((previous) =>
      previous.includes(id) ? previous.filter((existing) => existing !== id) : [...previous, id],
    );
  };

  const canSubmit =
    name.trim() !== "" &&
    !busy &&
    (workspaceMode === "legacy" || sharedDirectory.confirmedDirectory !== null);
  const submit = () => {
    if (!canSubmit) return;
    let workspace: InitiativeWorkspace = { mode: "legacy" };
    if (workspaceMode === "shared-directory") {
      const confirmedDirectory = sharedDirectory.confirmedDirectory;
      if (confirmedDirectory === null) return;
      workspace = {
        mode: "shared-directory",
        hostId: confirmedDirectory.hostId,
        rootPath: confirmedDirectory.rootPath,
      };
    }
    setBusy(true);
    setError(null);
    rpc
      .call("createInitiative", {
        name: name.trim(),
        icon,
        ...(description.trim() !== "" ? { description: description.trim() } : {}),
        workspaceProjectIds: [...workspaceIds],
        workspace,
        ...(workspaceMode === "legacy" ? { environmentId } : {}),
        providerId: model.providerId || null,
        model: model.model || null,
        reasoningLevel: model.reasoningLevel ?? null,
      })
      .then((result) => navigate.toThread(result.threadId))
      .catch((createError: unknown) =>
        setError(createError instanceof Error ? createError.message : "Create failed"),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex justify-center overflow-y-auto p-4 sm:p-6">
      <div className="flex w-full max-w-[480px] flex-col gap-4" data-create-project-form="">
        <div>
          <h1 className="text-sm font-semibold">Create Project</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Create a focused chat where agents coordinate work.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Icon</span>
          <InitiativeIconPicker value={icon} onChange={setIcon} />
        </div>
        <label className="flex flex-col gap-1.5 text-xs">
          <span className="font-medium text-muted-foreground">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Project name"
            className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-ring"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-xs">
          <span className="font-medium text-muted-foreground">
            Description <span className="font-normal">(optional)</span>
          </span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            placeholder="What is this project about?"
            className="resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-ring"
          />
        </label>
        <fieldset className="flex flex-col gap-1.5 text-xs">
          <legend className="mb-1 font-medium text-muted-foreground">Repositories</legend>
          <ul className="flex flex-col gap-1" aria-label="Repositories">
            <li>
              <label
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
                  workspaceIds.length === 0 ? "border-ring bg-accent/50" : "border-border",
                )}
              >
                <input
                  type="checkbox"
                  checked={workspaceIds.length === 0}
                  onChange={() => setWorkspaceIds([])}
                  className="accent-primary"
                />
                Start from scratch
              </label>
            </li>
            {projects
              .filter((project) => !project.isPersonal)
              .map((project) => (
                <li key={project.id}>
                  <label
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
                      selectedWorkspaceIds.has(project.id)
                        ? "border-ring bg-accent/50"
                        : "border-border",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selectedWorkspaceIds.has(project.id)}
                      onChange={() => toggleWorkspace(project.id)}
                      className="accent-primary"
                    />
                    {project.name}
                  </label>
                </li>
              ))}
          </ul>
        </fieldset>
        <CreateEnvironmentControls
          repositoryCount={workspaceIds.length}
          workspaceMode={workspaceMode}
          onWorkspaceModeChange={setPreferredWorkspaceMode}
          sharedDirectory={sharedDirectory}
          environmentId={environmentId}
          environments={environments}
          environmentDisabled={environmentsProjectId === null}
          onEnvironmentChange={setEnvironmentId}
          model={model}
          onModelChange={setModel}
        />
        {error !== null ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button size="sm" disabled={!canSubmit} onClick={submit}>
            <Icon
              name={busy ? "Loading" : "Check"}
              className={cn("size-3.5", busy && "animate-spin")}
              aria-hidden
            />
            {busy ? "Creating…" : "Create Project"}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface CreateEnvironment {
  id: string;
  name: string | null;
  status: string;
}

function CreateEnvironmentControls({
  repositoryCount,
  workspaceMode,
  onWorkspaceModeChange,
  sharedDirectory,
  environmentId,
  environments,
  environmentDisabled,
  onEnvironmentChange,
  model,
  onModelChange,
}: {
  repositoryCount: number;
  workspaceMode: NewProjectWorkspaceMode;
  onWorkspaceModeChange: (mode: NewProjectWorkspaceMode) => void;
  sharedDirectory: SharedDirectoryPreviewController;
  environmentId: string | null;
  environments: readonly CreateEnvironment[];
  environmentDisabled: boolean;
  onEnvironmentChange: (environmentId: string | null) => void;
  model: ExperimentalProviderModelPickerValue;
  onModelChange: (model: ExperimentalProviderModelPickerValue) => void;
}) {
  const routing =
    workspaceMode === "shared-directory" && sharedDirectory.confirmedDirectory !== null
      ? { kind: "host" as const, hostId: sharedDirectory.confirmedDirectory.hostId }
      : environmentId === null
        ? undefined
        : { kind: "environment" as const, environmentId };

  return (
    <>
      {repositoryCount >= 2 ? (
        <fieldset className="flex flex-col gap-1.5 text-xs">
          <legend className="font-medium text-muted-foreground">Environment</legend>
          <WorkspaceModeOption
            mode="shared-directory"
            selected={workspaceMode === "shared-directory"}
            title="Shared directory"
            description="Reuse one existing common directory for the coordinator and every agent."
            onChange={onWorkspaceModeChange}
          />
          <WorkspaceModeOption
            mode="legacy"
            selected={workspaceMode === "legacy"}
            title="Separate environments"
            description="Keep the original flow where agents choose a repository environment."
            onChange={onWorkspaceModeChange}
          />
        </fieldset>
      ) : null}
      {workspaceMode === "shared-directory" ? (
        <SharedDirectoryPreview controller={sharedDirectory} editable />
      ) : (
        <div className="flex flex-col gap-1.5 text-xs">
          <span className="font-medium text-muted-foreground">Environment</span>
          <Select
            value={environmentId ?? DEFAULT_ENVIRONMENT}
            onValueChange={(value) =>
              onEnvironmentChange(value === DEFAULT_ENVIRONMENT ? null : value)
            }
            disabled={environmentDisabled}
          >
            <SelectTrigger className="h-8 w-full" aria-label="Environment">
              <SelectValue placeholder="Project default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_ENVIRONMENT}>Project default</SelectItem>
              {environments.map((environment) => (
                <SelectItem
                  key={environment.id}
                  value={environment.id}
                  disabled={environment.status !== "ready"}
                >
                  {environment.name ?? environment.id}
                  {environment.status === "ready" ? "" : ` (${environment.status})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="flex flex-col gap-1.5 text-xs">
        <span className="font-medium text-muted-foreground">Model</span>
        <ProviderModelPicker value={model} onChange={onModelChange} routing={routing} />
      </div>
    </>
  );
}

function WorkspaceModeOption({
  mode,
  selected,
  title,
  description,
  onChange,
}: {
  mode: NewProjectWorkspaceMode;
  selected: boolean;
  title: string;
  description: string;
  onChange: (mode: NewProjectWorkspaceMode) => void;
}) {
  return (
    <label
      aria-label={`Use ${title.toLowerCase()}`}
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2",
        selected ? "border-ring bg-accent/50" : "border-border",
      )}
    >
      <input
        type="radio"
        name="project-workspace-mode"
        value={mode}
        checked={selected}
        onChange={() => onChange(mode)}
        className="mt-0.5 accent-primary"
      />
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="block text-2xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}
