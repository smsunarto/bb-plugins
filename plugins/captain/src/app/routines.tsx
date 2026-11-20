/**
 * The Overview's Routines section: each routine as a row with its schedule in
 * words and a switch, opening to its instruction, last runs and actions, and
 * the inline form that creates or edits one. The section's read lives in
 * `overview.tsx`; this file renders it and owns the writes.
 */
import {
  experimental_Icon as Icon,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  cronProblem,
  describeCron,
  describeSchedule,
  ROUTINE_INSTRUCTION_MAX,
  ROUTINE_NAME_MAX,
  validTimezone,
  type RoutineAction,
  type RoutineRun,
  type RoutineView,
} from "../contract/routines.ts";
import { captainContract, type RoutineDraft } from "../contract/rpc.ts";
import { TAP } from "./banner.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { cn } from "./lib/utils.ts";

export type RoutinesListing = { routines: RoutineView[]; serverTimezone: string };

/** Schedules the form offers by name; anything else is a custom cron. */
const PRESET_CRONS = ["0 9 * * 1-5", "0 9 * * *", "0 10 * * 1", "0 16 * * 5", "0 * * * *"];
const CUSTOM = "custom";
const ONCE = "once";

/** A form field, by the name its focus is kept under. */
type Field = "name" | "instruction" | "preset" | "cron" | "timezone" | "at";

/** What the form holds while it is open: text as typed, not yet parsed. */
type Draft = {
  /** Null for a new routine. */
  routineId: string | null;
  name: string;
  instruction: string;
  /** A preset cron, `custom` or `once`. */
  preset: string;
  cron: string;
  timezone: string;
  /** A `datetime-local` value in the browser's zone. */
  at: string;
};

/**
 * One Captain's Routines state: the open row, the form, a pending delete
 * confirmation and the field being typed in. Kept outside the components: bb
 * remounts a panel tab when its width crosses a breakpoint, and a half-typed
 * routine must keep its text and focus through that.
 */
type RoutinesUi = {
  open: string | null;
  form: Draft | null;
  confirm: string | null;
  focus: { field: Field; start: number | null; end: number | null } | null;
};
const CLOSED: RoutinesUi = { open: null, form: null, confirm: null, focus: null };
const uiStates = new Map<string, RoutinesUi>();
const uiListeners = new Set<() => void>();
function patchUi(captainId: string, patch: Partial<RoutinesUi>): void {
  uiStates.set(captainId, { ...(uiStates.get(captainId) ?? CLOSED), ...patch });
  for (const listener of uiListeners) listener();
}
function subscribeUi(listener: () => void): () => void {
  uiListeners.add(listener);
  return () => uiListeners.delete(listener);
}
function useRoutinesUi(captainId: string): RoutinesUi {
  return useSyncExternalStore(subscribeUi, () => uiStates.get(captainId) ?? CLOSED);
}

const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Open the form for a new routine, its Name field focused. */
function startNew(captainId: string): void {
  patchUi(captainId, {
    form: {
      routineId: null,
      name: "",
      instruction: "",
      preset: PRESET_CRONS[0] as string,
      cron: PRESET_CRONS[0] as string,
      timezone: browserTimezone(),
      at: "",
    },
    confirm: null,
    focus: { field: "name", start: null, end: null },
  });
}

function editDraft(routine: RoutineView): Draft {
  const schedule = routine.schedule;
  if ("at" in schedule) {
    return {
      routineId: routine.id,
      name: routine.name,
      instruction: routine.instruction,
      preset: ONCE,
      cron: PRESET_CRONS[0] as string,
      timezone: browserTimezone(),
      at: localInput(schedule.at),
    };
  }
  return {
    routineId: routine.id,
    name: routine.name,
    instruction: routine.instruction,
    preset: PRESET_CRONS.includes(schedule.cron) ? schedule.cron : CUSTOM,
    cron: schedule.cron,
    timezone: schedule.timezone,
    at: "",
  };
}

/** Epoch ms as a `datetime-local` value in the browser's zone. */
function localInput(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The schedule a draft names, as the server takes it. */
function draftSchedule(draft: Draft): RoutineDraft["schedule"] {
  if (draft.preset === ONCE) return { at: draft.at === "" ? Number.NaN : Date.parse(draft.at) };
  return { cron: draft.preset === CUSTOM ? draft.cron : draft.preset, timezone: draft.timezone };
}

/** The draft's schedule in words, or why it cannot run; the server has the last word. */
function draftWords(draft: Draft, now: number): { text: string; problem: boolean } {
  const schedule = draftSchedule(draft);
  if ("at" in schedule) {
    if (Number.isNaN(schedule.at)) return { text: "Pick a date and time", problem: true };
    const text = describeSchedule(schedule);
    return schedule.at <= now
      ? { text: `${text} · that time has passed`, problem: true }
      : { text, problem: false };
  }
  const problem = cronProblem(schedule.cron);
  if (problem !== null) return { text: `Cron ${problem}`, problem: true };
  if (!validTimezone(schedule.timezone.trim()))
    return { text: `Unknown time zone ${JSON.stringify(schedule.timezone)}`, problem: true };
  return { text: `${describeCron(schedule.cron)} (${schedule.timezone.trim()})`, problem: false };
}

/** A time as rows show it, in the browser's zone. */
function formatWhen(at: number): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
}

/** What a row's subline says, and whether its switch applies. */
function rowState(routine: RoutineView): {
  line: string;
  problem: boolean;
  enabled: boolean | null;
} {
  if (routine.done) return { line: `Ran once · ${routine.when}`, problem: false, enabled: null };
  if (routine.missed)
    return { line: "Missed its one run · give it a new time", problem: true, enabled: null };
  const automation = routine.automation;
  if (automation === null) return { line: "Schedule unavailable", problem: true, enabled: null };
  if (!automation.enabled) return { line: "Paused", problem: false, enabled: false };
  const next = automation.nextRunAt === null ? "" : ` · next ${formatWhen(automation.nextRunAt)}`;
  return { line: `${routine.when}${next}`, problem: false, enabled: true };
}

const RUN_STATUS: Record<RoutineRun["status"], string> = {
  sent: "Sent",
  queued: "Queued behind a turn",
  skipped: "Skipped",
  failed: "Failed",
};

/** The Overview's controls on its 4px grid: 32px tall, 44px under a coarse pointer. */
const CONTROL = cn(TAP, "h-8 leading-4");

/** + in the section header: opens the form for a new routine. */
export function NewRoutineButton({
  captainId,
  onOpen,
}: {
  captainId: string;
  /** Expand the section, when it is collapsed. */
  onOpen: () => void;
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label="New routine"
      className={cn(TAP, "size-6 text-muted-foreground")}
      onClick={() => {
        onOpen();
        startNew(captainId);
      }}
    >
      <Icon name="Plus" aria-hidden className="size-4" />
    </Button>
  );
}

/** The routine rows, the new-routine form above them, or the empty state. */
export function RoutinesBody({
  captainId,
  listing,
  visible,
  onRetry,
}: {
  captainId: string;
  listing: RoutinesListing;
  visible: boolean;
  /** Read the list again, for a row whose schedule did not load. */
  onRetry: () => void;
}) {
  const ui = useRoutinesUi(captainId);
  const creating = ui.form !== null && ui.form.routineId === null;
  return (
    <div className="flex min-w-0 flex-col">
      {creating ? <RoutineForm captainId={captainId} draft={ui.form as Draft} /> : null}
      {listing.routines.length === 0 ? (
        creating ? null : (
          <div className="flex min-w-0 flex-col items-start gap-2 px-2 py-2">
            <p className="m-0 text-xs leading-4 text-muted-foreground">
              Ask the Captain to set a routine, such as “every weekday at 9, sweep stalled crew”.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={cn(CONTROL, "gap-1 px-3")}
              onClick={() => startNew(captainId)}
            >
              <Icon name="Plus" aria-hidden className="size-4" />
              New routine
            </Button>
          </div>
        )
      ) : (
        <ul className="m-0 flex list-none flex-col p-0" aria-label="Routines">
          {listing.routines.map((routine) => (
            <RoutineRow
              key={routine.id}
              captainId={captainId}
              routine={routine}
              ui={ui}
              visible={visible}
              onRetry={onRetry}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Pause, resume, test and delete, each updating the cached list before the server replies. */
function useRoutineAction(captainId: string) {
  return useRpcMutation({
    contract: captainContract,
    method: "routineAction",
    optimistic({ routineId, action }, cache) {
      cache.update("routines", { captainId }, (current) => ({
        ...current,
        routines:
          action === "delete"
            ? current.routines.filter((routine) => routine.id !== routineId)
            : current.routines.map((routine) =>
                routine.id === routineId &&
                routine.automation !== null &&
                (action === "pause" || action === "resume")
                  ? {
                      ...routine,
                      automation: { ...routine.automation, enabled: action === "resume" },
                    }
                  : routine,
              ),
      }));
    },
  });
}

function RoutineRow({
  captainId,
  routine,
  ui,
  visible,
  onRetry,
}: {
  captainId: string;
  routine: RoutineView;
  ui: RoutinesUi;
  visible: boolean;
  onRetry: () => void;
}) {
  const open = ui.open === routine.id;
  const editing = ui.form?.routineId === routine.id;
  const panel = useId();
  const state = rowState(routine);
  const action = useRoutineAction(captainId);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = (kind: RoutineAction) => {
    setError(null);
    setNotice(null);
    if (kind === "delete") patchUi(captainId, { confirm: null, open: null });
    void action.mutate({ captainId, routineId: routine.id, action: kind }).then(
      () =>
        kind === "run"
          ? setNotice("Test sent · the Captain gets it in a few seconds and does the work for real")
          : undefined,
      (failure: unknown) => setError((failure as Error).message),
    );
  };
  const pendingAction = action.pendingInputs.find((input) => input.routineId === routine.id);
  return (
    <li className="flex min-w-0 flex-col" data-routine={routine.id}>
      <div className="flex min-w-0 items-start">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => patchUi(captainId, { open: open ? null : routine.id, confirm: null })}
          className={cn(
            TAP,
            "flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-2 text-start outline-none hover:bg-muted/40 focus-visible:outline-1",
          )}
        >
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
            <Icon
              name="Clock"
              aria-hidden
              className={cn(
                "size-4",
                state.enabled === true ? "text-foreground" : "text-muted-foreground",
              )}
            />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate leading-5 font-medium text-foreground [unicode-bidi:plaintext]">
              {routine.name}
            </span>
            <span
              className={cn(
                "truncate text-xs leading-4",
                state.problem ? "text-destructive" : "text-muted-foreground",
              )}
              title={state.line}
            >
              {state.line}
            </span>
          </span>
        </button>
        <Switch
          checked={state.enabled === true}
          disabled={state.enabled === null || pendingAction !== undefined}
          aria-label={`${routine.name}: ${state.enabled === true ? "active" : "paused"}`}
          className="me-1 self-center"
          onCheckedChange={(checked) => run(checked ? "resume" : "pause")}
        />
      </div>
      {open ? (
        <div
          id={panel}
          className="flex min-w-0 flex-col gap-3 ps-8 pe-2 pb-2 text-xs leading-4"
          data-testid="captain-routine-panel"
        >
          {editing ? (
            <RoutineForm captainId={captainId} draft={ui.form as Draft} />
          ) : (
            <RoutineDetails
              captainId={captainId}
              routine={routine}
              state={state}
              confirming={ui.confirm === routine.id}
              pending={pendingAction}
              visible={visible}
              notice={notice}
              error={error}
              run={run}
              onRetry={onRetry}
            />
          )}
        </div>
      ) : null}
    </li>
  );
}

/** An opened routine: why its schedule is missing, its instruction, when it runs, its runs and actions. */
function RoutineDetails({
  captainId,
  routine,
  state,
  confirming,
  pending,
  visible,
  notice,
  error,
  run,
  onRetry,
}: {
  captainId: string;
  routine: RoutineView;
  state: ReturnType<typeof rowState>;
  /** Delete was pressed and waits for its confirmation. */
  confirming: boolean;
  /** The action on its way to the server, if any. */
  pending: { action: RoutineAction } | undefined;
  visible: boolean;
  notice: string | null;
  error: string | null;
  run: (action: RoutineAction) => void;
  onRetry: () => void;
}) {
  return (
    <>
      {routine.automationError === null ? null : (
        <div className="flex min-w-0 items-center gap-2 text-destructive">
          <span className="min-w-0 flex-1 break-words">{routine.automationError}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn(TAP, "h-6 shrink-0 px-2")}
            onClick={onRetry}
          >
            Retry
          </Button>
        </div>
      )}
      <Detail label="Instruction">
        <p className="m-0 min-w-0 break-words whitespace-pre-wrap text-foreground [unicode-bidi:plaintext]">
          {routine.instruction}
        </p>
      </Detail>
      <Detail label="When to run">
        <p className="m-0 text-foreground">
          {routine.when}
          {"timezone" in routine.schedule ? (
            <span className="text-muted-foreground"> · {routine.schedule.timezone}</span>
          ) : null}
        </p>
        {routine.automation?.enabled === true && routine.automation.nextRunAt !== null ? (
          <p className="m-0 text-muted-foreground">
            Next run {formatWhen(routine.automation.nextRunAt)}
          </p>
        ) : null}
      </Detail>
      <Detail label="Last runs">
        <RoutineRuns captainId={captainId} routineId={routine.id} visible={visible} />
      </Detail>
      {confirming ? (
        <fieldset
          aria-label={`Delete ${routine.name}?`}
          className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0"
        >
          <span className="min-w-0 text-foreground">
            Delete this routine? Its schedule stops; the thread keeps its past runs.
          </span>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className={cn(CONTROL, "px-3")}
            onClick={() => run("delete")}
          >
            Delete routine
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn(CONTROL, "px-3")}
            onClick={() => patchUi(captainId, { confirm: null })}
          >
            Cancel
          </Button>
        </fieldset>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {state.enabled === null ? null : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={cn(CONTROL, "gap-1 px-3")}
              disabled={pending !== undefined}
              onClick={() => run(state.enabled === true ? "pause" : "resume")}
            >
              <Icon
                name={state.enabled === true ? "Pause" : "Play"}
                aria-hidden
                className="size-4"
              />
              {state.enabled === true ? "Pause" : "Resume"}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={cn(CONTROL, "px-3")}
            disabled={routine.automationId === null || pending !== undefined}
            onClick={() => run("run")}
          >
            {pending?.action === "run" ? "Running…" : "Test"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={cn(CONTROL, "gap-1 px-3")}
            onClick={() =>
              patchUi(captainId, {
                form: editDraft(routine),
                confirm: null,
                focus: { field: "name", start: null, end: null },
              })
            }
          >
            <Icon name="Pencil" aria-hidden className="size-4" />
            Edit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn(CONTROL, "gap-1 px-3 text-destructive hover:text-destructive")}
            onClick={() => patchUi(captainId, { confirm: routine.id })}
          >
            <Icon name="Trash2" aria-hidden className="size-4" />
            Delete
          </Button>
        </div>
      )}
      {notice === null ? null : (
        <output className="block min-w-0 break-words text-muted-foreground">{notice}</output>
      )}
      {error === null ? null : (
        <p role="alert" className="m-0 min-w-0 break-words text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** An opened routine's last five runs, newest first. */
function RoutineRuns({
  captainId,
  routineId,
  visible,
}: {
  captainId: string;
  routineId: string;
  visible: boolean;
}) {
  const runs = useRpcQuery({
    contract: captainContract,
    method: "routineRuns",
    input: { captainId, routineId, limit: 5 },
    enabled: visible,
  });
  if (runs.data === undefined) {
    return runs.error === null ? (
      <span aria-busy className="h-4 w-1/2 animate-pulse rounded bg-muted" />
    ) : (
      <p className="m-0 text-destructive">Couldn't load runs · {runs.error.message}</p>
    );
  }
  if (runs.data.runs.length === 0)
    return <p className="m-0 text-muted-foreground">None yet · a new routine waits for its time</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Last runs">
      {runs.data.runs.map((run) => {
        const text = `${formatWhen(run.at)} · ${run.trigger === "test" ? "Test" : "Scheduled"} · ${RUN_STATUS[run.status]}${run.reason === null ? "" : `: ${run.reason}`}`;
        return (
          <li
            key={run.id}
            className={cn(
              "min-w-0 truncate tabular-nums",
              run.status === "failed" ? "text-destructive" : "text-foreground",
            )}
            title={text}
          >
            {text}
          </li>
        );
      })}
    </ul>
  );
}

let timezones: string[] | null = null;
function allTimezones(): string[] {
  timezones ??= (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf?.("timeZone") ?? [browserTimezone()];
  return timezones;
}

/**
 * Create or edit one routine: Name, Instruction, Schedule and Time zone, with
 * the schedule in words as it is typed and the server's reasons when a save
 * is refused. Its text and focus live in `uiStates`, so a remount keeps them.
 */
function RoutineForm({ captainId, draft }: { captainId: string; draft: Draft }) {
  const id = useId();
  const root = useRef<HTMLFormElement>(null);
  const save = useRpcMutation({ contract: captainContract, method: "saveRoutine" });
  const [refusal, setRefusal] = useState<string[]>([]);
  const set = (patch: Partial<Draft>) =>
    patchUi(captainId, { form: { ...(uiStates.get(captainId)?.form ?? draft), ...patch } });
  // Put focus back where it was when bb remounted the tab, caret and all.
  useLayoutEffect(() => {
    const focus = uiStates.get(captainId)?.focus;
    if (focus === null || focus === undefined) return;
    const field = root.current?.querySelector<HTMLElement>(`[data-routine-field="${focus.field}"]`);
    if (field === null || field === undefined) return;
    field.focus();
    if (
      (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
      focus.start !== null &&
      field.type !== "datetime-local"
    ) {
      field.setSelectionRange(focus.start, focus.end ?? focus.start);
    }
  }, [captainId]);
  const track = (field: Field) => ({
    "data-routine-field": field,
    onFocus: (event: FocusEvent<HTMLElement>) => remember(field, event.currentTarget),
    onSelect: (event: SyntheticEvent<HTMLElement>) => remember(field, event.currentTarget),
    // Focus moving to another element forgets the field; an unmount has no related target.
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (event.relatedTarget !== null && uiStates.get(captainId)?.focus?.field === field)
        patchUi(captainId, { focus: null });
    },
  });
  const remember = (field: Field, element: HTMLElement) => {
    const text =
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element
        : null;
    let start: number | null = null;
    let end: number | null = null;
    try {
      start = text?.selectionStart ?? null;
      end = text?.selectionEnd ?? null;
    } catch {
      // Inputs such as datetime-local have no selection.
    }
    uiStates.set(captainId, {
      ...(uiStates.get(captainId) ?? CLOSED),
      focus: { field, start, end },
    });
  };
  const close = () => patchUi(captainId, { form: null, focus: null });
  // When the form opened is near enough for "that time has passed".
  const [now] = useState(Date.now);
  const words = draftWords(draft, now);
  const ready = draft.name.trim() !== "" && draft.instruction.trim() !== "";
  const submit = () => {
    setRefusal([]);
    void save
      .mutate({
        captainId,
        ...(draft.routineId === null ? {} : { routineId: draft.routineId }),
        routine: {
          name: draft.name,
          instruction: draft.instruction,
          schedule: draftSchedule(draft),
        },
      })
      .then(
        (result) => {
          if (!result.ok) return setRefusal(result.blockers.map((blocker) => blocker.reason));
          return patchUi(captainId, { form: null, focus: null, open: result.routine.id });
        },
        (failure: unknown) => setRefusal([(failure as Error).message]),
      );
  };
  const label = "text-xs leading-4 font-medium text-muted-foreground";
  const field = cn(TAP, "h-8 text-sm");
  return (
    <form
      ref={root}
      aria-label={draft.routineId === null ? "New routine" : `Edit ${draft.name}`}
      data-testid="captain-routine-form"
      className={cn(
        "flex min-w-0 flex-col gap-3 text-xs leading-4",
        draft.routineId === null && "mx-2 my-1 rounded-lg border border-border p-2",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !save.isPending) submit();
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${id}-name`} className={label}>
          Name
        </label>
        <Input
          id={`${id}-name`}
          value={draft.name}
          maxLength={ROUTINE_NAME_MAX}
          placeholder="Stalled crew sweep"
          className={field}
          onChange={(event) => {
            set({ name: event.target.value });
            remember("name", event.currentTarget);
          }}
          {...track("name")}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${id}-instruction`} className={label}>
          Instruction
        </label>
        <Textarea
          id={`${id}-instruction`}
          value={draft.instruction}
          rows={4}
          maxLength={ROUTINE_INSTRUCTION_MAX}
          placeholder="What the Captain does on each run"
          className="min-h-24 resize-y text-sm"
          onChange={(event) => {
            set({ instruction: event.target.value });
            remember("instruction", event.currentTarget);
          }}
          {...track("instruction")}
        />
        <span className="self-end text-muted-foreground tabular-nums">
          {draft.instruction.length} / {ROUTINE_INSTRUCTION_MAX}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${id}-preset`} className={label}>
          Schedule
        </label>
        <Select
          value={draft.preset}
          onValueChange={(preset) =>
            // Custom starts from the preset it replaces, so the user edits a working cron.
            set(
              preset === CUSTOM && PRESET_CRONS.includes(draft.preset)
                ? { preset, cron: draft.preset }
                : { preset },
            )
          }
        >
          <SelectTrigger id={`${id}-preset`} className={field} {...track("preset")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-w-[min(32rem,calc(100vw-2rem))]">
            <SelectGroup>
              {PRESET_CRONS.map((cron) => (
                <SelectItem key={cron} value={cron}>
                  {describeCron(cron)}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM}>Custom cron…</SelectItem>
              <SelectItem value={ONCE}>Once, at a time…</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        {draft.preset === CUSTOM ? (
          <Input
            aria-label="Cron"
            value={draft.cron}
            placeholder="0 9 * * 1-5"
            spellCheck={false}
            className={cn(field, "font-mono")}
            onChange={(event) => {
              set({ cron: event.target.value });
              remember("cron", event.currentTarget);
            }}
            {...track("cron")}
          />
        ) : null}
        {draft.preset === ONCE ? (
          <Input
            aria-label="Date and time"
            type="datetime-local"
            value={draft.at}
            className={field}
            onChange={(event) => set({ at: event.target.value })}
            {...track("at")}
          />
        ) : null}
      </div>
      {draft.preset === ONCE ? null : (
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${id}-timezone`} className={label}>
            Time zone
          </label>
          <Input
            id={`${id}-timezone`}
            value={draft.timezone}
            list={`${id}-timezones`}
            spellCheck={false}
            className={field}
            onChange={(event) => {
              set({ timezone: event.target.value });
              remember("timezone", event.currentTarget);
            }}
            {...track("timezone")}
          />
          <datalist id={`${id}-timezones`}>
            {allTimezones().map((zone) => (
              <option key={zone} value={zone} aria-label={zone} />
            ))}
          </datalist>
        </div>
      )}
      <output
        aria-live="polite"
        data-testid="captain-routine-words"
        className={cn(
          "block min-w-0 break-words",
          words.problem ? "text-destructive" : "text-foreground",
        )}
      >
        {words.problem ? words.text : `When to run · ${words.text}`}
      </output>
      {refusal.length === 0 ? null : (
        <ul
          role="alert"
          aria-label="Not saved"
          className="m-0 flex list-none flex-col gap-1 p-0 text-destructive"
        >
          {refusal.map((reason) => (
            <li key={reason} className="min-w-0 break-words">
              Not saved · {reason}
            </li>
          ))}
        </ul>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          className={cn(CONTROL, "px-3")}
          disabled={!ready || save.isPending}
        >
          {save.isPending ? "Saving…" : draft.routineId === null ? "Create routine" : "Save"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn(CONTROL, "px-3")}
          onClick={close}
        >
          Cancel
        </Button>
        {draft.routineId === null ? (
          <span className="min-w-0 text-muted-foreground">
            It waits for its first time; Test runs it now.
          </span>
        ) : null}
      </div>
    </form>
  );
}
