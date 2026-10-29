import { useEffect, useRef, useState } from "react";
import {
  experimental_PermissionModePicker as PermissionModePicker,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalProviderModelPickerRouting } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import type { ThreadRequest } from "./lib/types";
import { Button } from "./components/ui/button";

const targetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reuse"), environmentId: z.string() }),
  z.object({ type: z.literal("project-default") }),
  z.object({
    type: z.literal("host"),
    hostId: z.string().optional(),
    workspace: z.object({ type: z.string() }),
  }),
  z.object({
    type: z.literal("provider"),
    environmentProviderId: z.string(),
    machine: z.object({ type: z.literal("existing"), hostId: z.string() }),
    inputs: z.object({ path: z.string().optional() }).nullable().optional(),
  }),
]);
const reasoningSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const permissionSchema = z.enum(["auto", "full", "accept-edits"]);

function describeTarget(environment: unknown) {
  const target = targetSchema.safeParse(environment);
  let routing: ExperimentalProviderModelPickerRouting | undefined;
  let label = environment ? "Saved workspace configuration" : "Choose a machine";
  if (target.success) {
    switch (target.data.type) {
      case "reuse":
        routing = { kind: "environment", environmentId: target.data.environmentId };
        label = "Saved shared workspace";
        break;
      case "provider":
        routing = { kind: "host", hostId: target.data.machine.hostId };
        label = target.data.inputs?.path ?? target.data.environmentProviderId;
        break;
      case "host":
        if (target.data.hostId) routing = { kind: "host", hostId: target.data.hostId };
        label =
          target.data.workspace.type === "managed-worktree" ? "Fresh worktree" : "Saved workspace";
        break;
      case "project-default":
        label = "Project default";
        break;
    }
  }
  return { routing, label };
}

export function ExecutionSettings({
  value,
  onChange,
}: {
  value: ThreadRequest;
  onChange: (value: ThreadRequest) => void;
}) {
  const sdk = useSdk();
  const [editing, setEditing] = useState(!value.model);
  const [machines, setMachines] = useState<Awaited<ReturnType<typeof sdk.hosts.list>>>([]);
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof sdk.projects.list>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  const generation = useRef(0);
  const { routing, label } = describeTarget(value.environment);
  const targetLabel =
    routing?.kind === "host" && ["Fresh worktree", "Saved workspace"].includes(label)
      ? `${label} · ${machines.find((machine) => machine.id === routing.hostId)?.name ?? "Selected machine"}`
      : label;
  const project = projects.find((item) => item.id === value.projectId);
  const hosts = [...new Set(project?.sources.map((source) => source.hostId) ?? [])];
  if (project?.kind === "personal") hosts.push(...machines.map((machine) => machine.id));

  useEffect(() => {
    if (!editing) return;
    const controller = new AbortController();
    void sdk.hosts
      .list({ signal: controller.signal })
      .then((items) => {
        if (!controller.signal.aborted) setMachines(items);
        return items;
      })
      .catch(() => undefined);
    void sdk.projects
      .list({ includePersonal: true, signal: controller.signal })
      .then((items) => {
        if (!controller.signal.aborted) setProjects(items);
        return items;
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Could not load projects. Close and reopen agent settings to retry.");
      });
    return () => controller.abort();
  }, [sdk, editing]);

  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  async function changeProject(projectId: string) {
    const current = ++generation.current;
    const next = { ...value, projectId, environment: undefined, model: "" };
    onChange(next);
    setLoadingDefaults(true);
    setError(null);
    try {
      const defaults = await sdk.projects.defaultExecutionOptions({
        projectId,
        signal: AbortSignal.timeout(10_000),
      });
      if (generation.current !== current) return;
      if (defaults)
        onChange({
          ...next,
          ...defaults,
          sessionOptions: undefined,
          executionInputSources: {
            providerId: "explicit",
            model: "explicit",
            reasoningLevel: "explicit",
            serviceTier: "explicit",
            permissionMode: "explicit",
          },
        });
      else setError("This project has no saved agent defaults. Choose a model below.");
    } catch {
      if (generation.current === current)
        setError(
          "Could not load agent defaults. Choose a model below or select the project again.",
        );
    } finally {
      if (generation.current === current) setLoadingDefaults(false);
    }
  }

  const projectName = projects.find((item) => item.id === value.projectId)?.name ?? value.projectId;
  return (
    <section className="min-w-0 space-y-3 border-t border-border pt-4" aria-label="Agent settings">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Agent settings</h3>
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing(!editing)}>
          {editing ? "Close agent settings" : "Change agent settings"}
        </Button>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        <p className="break-words">
          {value.model
            ? `${value.providerId} · ${value.model} · ${String(value.reasoningLevel ?? "default")} reasoning`
            : "Select an agent and model below."}
        </p>
        <p className="break-all">{targetLabel}</p>
      </div>
      {editing ? (
        <div className="space-y-3">
          <div className="grid min-w-0 grid-cols-1 gap-3 @min-[480px]:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium">
              Project
              <select
                className="h-9 min-w-0 rounded-md border border-input bg-card px-2"
                value={value.projectId}
                onChange={(event) => void changeProject(event.target.value)}
              >
                <option value="">Choose a project</option>
                {value.projectId && !projects.some((item) => item.id === value.projectId) ? (
                  <option value={value.projectId}>{projectName} (saved)</option>
                ) : null}
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium">
              Workspace
              <select
                className="h-9 min-w-0 rounded-md border border-input bg-card px-2"
                value="saved"
                disabled={!value.projectId}
                onChange={(event) => {
                  generation.current++;
                  setLoadingDefaults(false);
                  const environment = {
                    type: "host",
                    hostId: event.target.value,
                    workspace:
                      project?.kind === "personal"
                        ? { type: "personal" }
                        : { type: "managed-worktree", baseBranch: { kind: "default" } },
                  };
                  onChange({ ...value, environment });
                }}
              >
                <option value="saved">{targetLabel}</option>
                {hosts.map((hostId) => (
                  <option key={hostId} value={hostId}>
                    Fresh worktree ·{" "}
                    {machines.find((machine) => machine.id === hostId)?.name ??
                      "Saved project machine"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Saved checkout settings are preserved. Fresh worktrees create a separate checkout for
            each review.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-medium">Model &amp; reasoning</p>
              <ProviderModelPicker
                disabled={loadingDefaults || !value.projectId || !routing}
                routing={routing}
                value={{
                  providerId: value.providerId,
                  model: value.model,
                  reasoningLevel: reasoningSchema.catch("high").parse(value.reasoningLevel),
                  ...(typeof value.serviceTier === "string"
                    ? { serviceTier: value.serviceTier }
                    : {}),
                }}
                onChange={(next) =>
                  onChange({
                    ...value,
                    ...next,
                    serviceTier: next.serviceTier,
                    ...(next.providerId !== value.providerId
                      ? { sessionOptions: undefined, permissionMode: "auto" }
                      : {}),
                    executionInputSources: {
                      providerId: "explicit",
                      model: "explicit",
                      reasoningLevel: "explicit",
                      serviceTier: "explicit",
                      permissionMode: "explicit",
                    },
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium">Permissions</p>
              <PermissionModePicker
                routing={routing}
                disabled={loadingDefaults || !value.projectId || !routing}
                providerId={value.providerId}
                value={permissionSchema.catch("auto").parse(value.permissionMode)}
                onChange={(permissionMode) =>
                  onChange({
                    ...value,
                    permissionMode,
                    executionInputSources: {
                      providerId: "explicit",
                      model: "explicit",
                      reasoningLevel: "explicit",
                      serviceTier: "explicit",
                      permissionMode: "explicit",
                    },
                  })
                }
              />
            </div>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive-text">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
