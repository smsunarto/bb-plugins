import { useEffect, useId, useState } from "react";
import { experimental_useRpcQuery as useRpcQuery } from "@get-bb/plugin-sdk/app";
import { Button } from "@bb-plugins/ui/button";
import { Input } from "@bb-plugins/ui/input";
import { Textarea } from "@bb-plugins/ui/textarea";
import { BOTS_PLUGIN_ID, rpcContract } from "../contract";
import { useBotsRpc } from "../lib/rpc";
import { describeCron, relativeTime } from "../lib/routine-format";
import {
  ROUTINE_INSTRUCTION_MAX,
  ROUTINE_NAME_MAX,
  type RoutineAction,
  type RoutineView,
} from "../lib/routine-schema";
import { cn } from "../lib/utils";
import { Field, keepTypingKeys } from "./editor-fields";
import { Icon } from "./ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

type Project = { id: string; name: string };
type Draft = {
  routineId?: string;
  name: string;
  instruction: string;
  cron: string;
  timezone: string;
  projectId: string;
};

const SCHEDULE_PRESETS = [
  { label: "Weekdays 9:00", cron: "0 9 * * 1-5" },
  { label: "Daily 8:00", cron: "0 8 * * *" },
  { label: "Mondays 9:00", cron: "0 9 * * 1" },
  { label: "Every hour", cron: "0 * * * *" },
] as const;
const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * A bot's routines: scheduled instructions that Automations runs, each in its
 * own subthread of the bot's main chat. Changes apply immediately, apart from the editor's Save.
 */
export function RoutinesPanel({ botId, botName }: { botId: string; botName: string }) {
  const query = useRpcQuery({
    contract: rpcContract,
    pluginId: BOTS_PLUGIN_ID,
    method: "routines_list",
    input: { botId },
  });
  const rpc = useBotsRpc();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const routines = query.data?.routines ?? [];
  const projects = query.data?.projects ?? [];

  async function run<T>(key: string, operation: () => Promise<T>) {
    if (pending) return;
    setPending(key);
    setError(null);
    setNotice(null);
    try {
      return await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  }
  const act = (routine: RoutineView, action: RoutineAction) =>
    run(`${routine.id}:${action}`, async () => {
      const result = await rpc.call("routine_action", { routineId: routine.id, action });
      if (action === "run")
        setNotice(
          result.run?.status === "failed"
            ? `Test run failed: ${result.run.error ?? "no reason given"}`
            : `Test run started. Its result appears under the routine's recent runs.`,
        );
    });
  const save = (value: Draft) =>
    run("save", async () => {
      await rpc.call("routine_save", { botId, ...value });
      setDraft(null);
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-[11px] leading-4 text-muted-foreground">
          Scheduled instructions {botName || "the bot"} runs through Automations. Each routine runs
          in its own subthread, which reports to the main chat. Changes here apply immediately.
        </p>
        {draft ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1"
            disabled={!query.data || Boolean(pending)}
            onClick={() =>
              setDraft({
                name: "",
                instruction: "",
                cron: SCHEDULE_PRESETS[0].cron,
                timezone: localTimezone(),
                projectId: projects[0]?.id ?? "",
              })
            }
          >
            <Icon name="Plus" className="size-3.5" />
            Add routine
          </Button>
        )}
      </div>
      {draft ? (
        <RoutineForm
          key={draft.routineId ?? "new"}
          draft={draft}
          projects={projects}
          saving={pending === "save"}
          onCancel={() => setDraft(null)}
          onSave={(value) => void save(value)}
        />
      ) : null}
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
          <Icon name="CircleX" className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
      {notice ? <output className="block text-xs text-muted-foreground">{notice}</output> : null}
      {query.data === undefined && query.error === null ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading routines">
          {[0, 1].map((index) => (
            <div key={index} className="h-14 animate-pulse rounded-md bg-muted/60" />
          ))}
        </div>
      ) : query.data === undefined ? (
        <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
          Routines could not be loaded.
          <Button type="button" size="sm" variant="ghost" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : routines.length === 0 && !draft ? (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No routines yet. Add one here, or ask {botName || "the bot"} in chat: “Every weekday at
          9:00, summarize new support tickets.”
        </div>
      ) : (
        <ul className="space-y-2">
          {routines.map((routine) => (
            <RoutineRow
              key={routine.id}
              routine={routine}
              projectName={projects.find((project) => project.id === routine.projectId)?.name}
              pending={pending}
              onAction={(action) => void act(routine, action)}
              onEdit={() =>
                setDraft({
                  routineId: routine.id,
                  name: routine.name,
                  instruction: routine.instruction,
                  cron: routine.cron,
                  timezone: routine.timezone,
                  projectId: routine.projectId,
                })
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function RoutineRow({
  routine,
  projectName,
  pending,
  onAction,
  onEdit,
}: {
  routine: RoutineView;
  projectName: string | undefined;
  pending: string | null;
  onAction: (action: RoutineAction) => void;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const automation = routine.automation;
  const busy = Boolean(pending);
  const state = !automation
    ? "Unavailable"
    : automation.enabled
      ? automation.nextRunAt
        ? `Next ${relativeTime(automation.nextRunAt)}`
        : "Scheduled"
      : "Paused";
  return (
    <li className="rounded-md border border-border">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon
            name={open ? "ChevronDown" : "ChevronRight"}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium">{routine.name}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {describeCron(routine.cron)} · {routine.timezone}
            </span>
          </span>
        </button>
        <span
          className={cn(
            "text-[11px] tabular-nums",
            automation?.enabled ? "text-muted-foreground" : "text-foreground",
            !automation && "text-destructive",
          )}
        >
          {state}
        </span>
        <Switch
          aria-label={automation?.enabled ? `Pause ${routine.name}` : `Resume ${routine.name}`}
          checked={Boolean(automation?.enabled)}
          disabled={busy || !automation}
          onCheckedChange={(checked) => onAction(checked ? "resume" : "pause")}
        />
      </div>
      {open ? (
        <div className="space-y-3 border-t border-border px-3 py-2.5">
          {routine.automationError ? (
            <p className="text-xs text-destructive">{routine.automationError}</p>
          ) : null}
          <p className="text-xs whitespace-pre-wrap">{routine.instruction}</p>
          <p className="text-[11px] text-muted-foreground">
            Runs in {projectName ?? "an unavailable project"} ·{" "}
            {routine.threadId
              ? "posts to its conversation"
              : "starts its conversation on first run"}
            {automation?.lastError ? ` · Last error: ${automation.lastError}` : ""}
          </p>
          <RoutineRuns routineId={routine.id} />
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1"
              disabled={busy || !automation}
              onClick={() => onAction("run")}
            >
              <Icon
                name={pending === `${routine.id}:run` ? "Loading" : "Play"}
                className={cn("size-3.5", pending === `${routine.id}:run` && "animate-spin")}
              />
              Test
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1"
              disabled={busy}
              onClick={onEdit}
            >
              <Icon name="Pencil" className="size-3.5" />
              Edit
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1 text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete the routine “${routine.name}”? Its schedule stops; its conversation stays.`,
                  )
                )
                  onAction("delete");
              }}
            >
              <Icon name="Trash" className="size-3.5" />
              Delete routine
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function RoutineRuns({ routineId }: { routineId: string }) {
  // Tagged with routines, so each run or change the server publishes refreshes it.
  const query = useRpcQuery({
    contract: rpcContract,
    pluginId: BOTS_PLUGIN_ID,
    method: "routine_runs",
    input: { routineId, limit: 5 },
  });
  // Automations finishes a run in the background without telling Bots, so
  // refresh while one is running, for at most two minutes.
  const running = query.data?.runs.some((run) => run.status === "running") ?? false;
  const { refetch } = query;
  useEffect(() => {
    if (!running) return;
    let ticks = 0;
    const timer = setInterval(() => {
      if (++ticks > 40) clearInterval(timer);
      else void refetch();
    }, 3000);
    return () => clearInterval(timer);
  }, [running, refetch]);
  if (query.data === undefined && query.error === null)
    return <div className="h-8 animate-pulse rounded bg-muted/60" />;
  if (query.data === undefined)
    return <p className="text-[11px] text-destructive">Run history unavailable.</p>;
  const runs = query.data?.runs ?? [];
  if (!runs.length) return <p className="text-[11px] text-muted-foreground">No runs yet.</p>;
  return (
    <ul className="space-y-1" aria-label="Recent runs">
      {runs.map((run) => (
        <li key={run.id} className="flex min-w-0 items-center gap-2 text-[11px]">
          <Icon
            name={
              run.status === "succeeded"
                ? "CheckCircle"
                : run.status === "running"
                  ? "Loading"
                  : "CircleX"
            }
            className={cn(
              "size-3.5 shrink-0",
              run.status === "running" && "animate-spin",
              run.status === "failed" && "text-destructive",
            )}
          />
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {relativeTime(run.startedAt)}
          </span>
          <span className="shrink-0">{run.trigger === "manual" ? "Test" : "Scheduled"}</span>
          {run.error ? <span className="truncate text-destructive">{run.error}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function RoutineForm({
  draft,
  projects,
  saving,
  onCancel,
  onSave,
}: {
  draft: Draft;
  projects: Project[];
  saving: boolean;
  onCancel: () => void;
  onSave: (value: Draft) => void;
}) {
  const id = useId();
  const [value, setValue] = useState(draft);
  const set = (patch: Partial<Draft>) => setValue((current) => ({ ...current, ...patch }));
  const ready =
    value.name.trim() &&
    value.instruction.trim() &&
    value.cron.trim() &&
    value.timezone.trim() &&
    value.projectId;
  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            className="h-8"
            value={value.name}
            maxLength={ROUTINE_NAME_MAX}
            placeholder="Morning brief"
            onChange={(event) => set({ name: event.target.value })}
          />
        </Field>
        <Field label="Runs in" htmlFor={`${id}-project`}>
          <Select value={value.projectId} onValueChange={(projectId) => set({ projectId })}>
            <SelectTrigger id={`${id}-project`} className="h-8 text-xs">
              <SelectValue placeholder="Choose a project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field
        label="Instruction"
        htmlFor={`${id}-instruction`}
        detail="What to do on each run. Write it as a standalone request."
        aside={
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {value.instruction.length}/{ROUTINE_INSTRUCTION_MAX}
          </span>
        }
      >
        <Textarea
          id={`${id}-instruction`}
          className="min-h-20 resize-y text-xs"
          value={value.instruction}
          maxLength={ROUTINE_INSTRUCTION_MAX}
          placeholder="Summarize new support tickets and flag anything urgent."
          onKeyDown={keepTypingKeys}
          onKeyUp={keepTypingKeys}
          onChange={(event) => set({ instruction: event.target.value })}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Schedule" htmlFor={`${id}-cron`} detail={describeCron(value.cron)}>
          <Input
            id={`${id}-cron`}
            className="h-8 font-mono text-xs"
            value={value.cron}
            placeholder="0 9 * * 1-5"
            onChange={(event) => set({ cron: event.target.value })}
          />
          <div className="flex flex-wrap gap-1">
            {SCHEDULE_PRESETS.map((preset) => (
              <Button
                key={preset.cron}
                type="button"
                size="sm"
                variant={value.cron === preset.cron ? "secondary" : "ghost"}
                className="h-6 px-1.5 text-[11px]"
                onClick={() => set({ cron: preset.cron })}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </Field>
        <Field
          label="Timezone"
          htmlFor={`${id}-timezone`}
          detail="IANA name, such as America/New_York."
        >
          <Input
            id={`${id}-timezone`}
            className="h-8 text-xs"
            value={value.timezone}
            onChange={(event) => set({ timezone: event.target.value })}
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={saving || !ready}
          onClick={() =>
            onSave({
              ...value,
              name: value.name.trim(),
              instruction: value.instruction.trim(),
              cron: value.cron.trim(),
              timezone: value.timezone.trim(),
            })
          }
        >
          {saving ? <Icon name="Loading" className="size-3.5 animate-spin" /> : null}
          {value.routineId ? "Save routine" : "Create routine"}
        </Button>
      </div>
    </div>
  );
}
