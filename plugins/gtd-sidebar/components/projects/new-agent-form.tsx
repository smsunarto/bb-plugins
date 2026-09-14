import { useEffect, useMemo, useState } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useProviders as useProviders,
  useRpc,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import type { Initiative, InitiativeEnvironment } from "@/lib/initiative-types";
import type { initiativeRpcContract } from "@/lib/initiative-rpc";
import { cn } from "@/lib/utils";

type ReasoningLevel = ExperimentalProviderModelPickerValue["reasoningLevel"];
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const DEFAULT_ENVIRONMENT = "__default__";
const NO_WORKSPACE = "__none__";

function environmentLabel(environment: InitiativeEnvironment): string {
  if (environment.name !== null && environment.name !== "") return environment.name;
  if (environment.branchName !== null) return environment.branchName;
  return environment.id;
}

/**
 * The spawn-an-agent form, shared by the rail's "New agent" row, the Agents
 * tray, and the panel's Agents tab. Performs a real `spawnInitiativeAgent`
 * call — the child appears under the coordinator via `parentThreadId` and the
 * rail/tray pick it up from the sidebar thread feed, no second roster.
 */
export function NewAgentForm({
  initiative,
  onLaunched,
}: {
  initiative: Initiative;
  /** Called with the new agent's threadId after a successful spawn. */
  onLaunched?: (threadId: string) => void;
}) {
  const rpc = useRpc<typeof initiativeRpcContract>();
  const threadActions = useSidebarThreadActions();
  const { projects } = useSidebarThreads();
  const { providers } = useProviders();

  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const personalProjectId = projects.find((project) => project.isPersonal)?.id ?? "";
  const boundProjectIds = initiative.workspaceProjectIds;
  const sharedDirectory =
    initiative.workspace.mode === "shared-directory" ? initiative.workspace : null;
  const isSharedDirectory = sharedDirectory !== null;
  // Bound repos, or the personal project for a "from scratch" initiative —
  // the empty string stays out of Select values entirely (Radix rejects "").
  const workspaceOptions =
    boundProjectIds.length > 0
      ? boundProjectIds
      : personalProjectId !== ""
        ? [personalProjectId]
        : [];
  const [projectId, setProjectId] = useState(() => workspaceOptions[0] ?? "");
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [environments, setEnvironments] = useState<readonly InitiativeEnvironment[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<ExperimentalProviderModelPickerValue>(() => ({
    providerId: initiative.providerId ?? providers[0]?.id ?? "",
    model: initiative.model ?? "",
    reasoningLevel: (initiative.reasoningLevel as ReasoningLevel | null) ?? "high",
  }));

  const selectWorkspace = (nextProjectId: string) => {
    setProjectId(nextProjectId);
    // A new repo invalidates the picked environment and the model catalog's
    // routing target — clear both before the refetch repopulates them.
    setEnvironmentId(null);
    setEnvironments([]);
  };

  useEffect(() => {
    if (isSharedDirectory || projectId === "") {
      setEnvironments([]);
      return;
    }
    let cancelled = false;
    rpc
      .call("listInitiativeEnvironments", { projectId })
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
  }, [isSharedDirectory, projectId, rpc]);

  const canSubmit = prompt.trim() !== "" && projectId !== "" && !busy;

  const submit = () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    rpc
      .call("spawnInitiativeAgent", {
        initiativeId: initiative.id,
        prompt: prompt.trim(),
        projectId,
        ...(!isSharedDirectory ? { environmentId } : {}),
        providerId: model.providerId || null,
        model: model.model || null,
        reasoningLevel: model.reasoningLevel ?? null,
      })
      .then((result) => {
        setPrompt("");
        threadActions.open(result.threadId);
        onLaunched?.(result.threadId);
        return;
      })
      .catch((spawnError: unknown) =>
        setError(spawnError instanceof Error ? spawnError.message : "Could not start agent"),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-2.5" data-project-new-agent-form="">
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium text-muted-foreground">Task</span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="What should this agent do?"
          rows={3}
          className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-ring"
        />
      </label>
      <WorkspaceSelector
        shared={isSharedDirectory}
        projectId={projectId}
        projectIds={workspaceOptions}
        projectNameById={projectNameById}
        onChange={selectWorkspace}
      />
      <AgentEnvironmentControls
        sharedDirectory={sharedDirectory}
        primaryEnvironmentId={initiative.primaryEnvironmentId}
        environmentId={environmentId}
        environments={environments}
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
            name={busy ? "Loading" : "Send"}
            className={cn("size-3.5", busy && "animate-spin")}
            aria-hidden
          />
          {busy ? "Starting…" : "Start agent"}
        </Button>
      </div>
    </div>
  );
}

function WorkspaceSelector({
  shared,
  projectId,
  projectIds,
  projectNameById,
  onChange,
}: {
  shared: boolean;
  projectId: string;
  projectIds: readonly string[];
  projectNameById: ReadonlyMap<string, string>;
  onChange: (projectId: string) => void;
}) {
  const label = shared ? "Repository focus" : "Workspace";
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      <Select
        value={projectId === "" ? NO_WORKSPACE : projectId}
        onValueChange={(value) => {
          if (value !== NO_WORKSPACE) onChange(value);
        }}
      >
        <SelectTrigger className="h-8 w-full" aria-label={label}>
          <SelectValue placeholder={shared ? "Select repository focus" : "Select workspace"} />
        </SelectTrigger>
        <SelectContent>
          {projectIds.length === 0 ? (
            <SelectItem value={NO_WORKSPACE} disabled>
              No workspace found
            </SelectItem>
          ) : (
            projectIds.map((id) => (
              <SelectItem key={id} value={id}>
                {projectNameById.get(id) ?? "Unknown project"}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

function AgentEnvironmentControls({
  sharedDirectory,
  primaryEnvironmentId,
  environmentId,
  environments,
  onEnvironmentChange,
  model,
  onModelChange,
}: {
  sharedDirectory: Extract<Initiative["workspace"], { mode: "shared-directory" }> | null;
  primaryEnvironmentId: string | null;
  environmentId: string | null;
  environments: readonly InitiativeEnvironment[];
  onEnvironmentChange: (environmentId: string | null) => void;
  model: ExperimentalProviderModelPickerValue;
  onModelChange: (model: ExperimentalProviderModelPickerValue) => void;
}) {
  const shared = sharedDirectory !== null;
  const routing =
    shared && primaryEnvironmentId !== null
      ? { kind: "environment" as const, environmentId: primaryEnvironmentId }
      : environmentId !== null
        ? { kind: "environment" as const, environmentId }
        : undefined;

  return (
    <>
      {shared ? (
        <p className="rounded-md border border-border bg-card p-2 text-2xs text-muted-foreground">
          This agent reuses the project directory{" "}
          <span className="break-all font-mono text-foreground">{sharedDirectory.rootPath}</span>.
          The repository is its task focus, not a filesystem boundary. It can access everything
          under the shared directory.
        </p>
      ) : (
        <div className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-muted-foreground">Environment</span>
          <Select
            value={environmentId ?? DEFAULT_ENVIRONMENT}
            onValueChange={(value) =>
              onEnvironmentChange(value === DEFAULT_ENVIRONMENT ? null : value)
            }
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
                  {environmentLabel(environment)}
                  {environment.status === "ready" ? "" : ` (${environment.status})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {shared && primaryEnvironmentId === null ? (
        <output className="text-xs text-muted-foreground">
          Workspace is still preparing. Start will wait for it to become ready.
        </output>
      ) : null}
      <div className="flex flex-col gap-1 text-xs">
        <span className="font-medium text-muted-foreground">Model</span>
        <ProviderModelPicker value={model} onChange={onModelChange} routing={routing} />
      </div>
    </>
  );
}
