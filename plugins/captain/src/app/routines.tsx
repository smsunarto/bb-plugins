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
  useEffect,
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
import { captainContract, type RoutineDraft, type RoutineRow } from "../contract/rpc.ts";
import { TAP } from "./banner.tsx";
import { Alert, AlertDescription } from "./components/ui/alert.tsx";
import { Button } from "./components/ui/button.tsx";
import { FieldDescription, FieldLabel, Field as KitField } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import { Item } from "./components/ui/item.tsx";
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

export type RoutinesListing = { routines: RoutineRow[]; serverTimezone: string };

/** Schedules the form offers by name; anything else is a custom cron. */
const PRESET_CRONS = ["0 9 * * 1-5", "0 9 * * *", "0 10 * * 1", "0 16 * * 5", "0 * * * *"];
const CUSTOM = "custom";
const ONCE = "once";

/** A form field, by the name its focus is kept under. */
type Field = "name" | "instruction" | "preset" | "cron" | "timezone" | "at";

/** What the form holds while it is open: text as typed, not yet parsed. */
type Draft = {
  /** Tells drafts apart, so a save that finishes late lands only on its own draft. */
  key: number;
  /** Null for a new routine. */
  routineId: string | null;
  /** The routine's `updatedAt` this edit opened from; null for a new routine. */
  updatedAt: number | null;
  name: string;
  instruction: string;
  /** A preset cron, `custom` or `once`. */
  preset: string;
  cron: string;
  timezone: string;
  /** A `datetime-local` value in the browser's zone. */
  at: string;
  /**
   * The stored one-shot time, to the millisecond. `at` drops the seconds, so
   * the stored time is sent back unchanged until the date field is edited.
   */
  atMs: number | null;
  /** The draft owns its save lock across section remounts. */
  saving?: boolean;
  /** Why the last save of this draft was refused, kept with it through a remount. */
  refusal: readonly string[];
  /** The last save was refused because the routine changed elsewhere. */
  stale: boolean;
};

/**
 * One Captain's Routines list state: the open row, a pending delete
 * confirmation, each row's last failed action and Test requests. Kept outside
 * the components: bb remounts a panel tab when its width crosses a
 * breakpoint, and none of this may reset under the user.
 */
type RoutineTest = {
  runId: string;
  outcome: Pick<RoutineRun, "status" | "reason"> | null;
};

type RoutinesUi = {
  open: string | null;
  confirm: string | null;
  /** The last failed action per routine, so a row restored after a failed delete shows it. */
  errors: Readonly<Record<string, string>>;
  /** The most recent Test this client requested for each routine. */
  tests: Readonly<Record<string, RoutineTest>>;
};
const CLOSED: RoutinesUi = { open: null, confirm: null, errors: {}, tests: {} };
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

/**
 * One Captain's open form: its draft and the field being typed in. A store
 * apart from the list's, so a keystroke re-renders the form and not the rows.
 */
type FormState = {
  draft: Draft;
  focus: { field: Field; start: number | null; end: number | null } | null;
};
const formStates = new Map<string, FormState>();
const formListeners = new Set<() => void>();
let draftKeys = 0;
function setForm(captainId: string, next: FormState | null): void {
  if (next === null) formStates.delete(captainId);
  else formStates.set(captainId, next);
  for (const listener of formListeners) listener();
}
function patchDraft(captainId: string, key: number, patch: Partial<Draft>): void {
  const current = formStates.get(captainId);
  if (current === undefined || current.draft.key !== key) return;
  setForm(captainId, { ...current, draft: { ...current.draft, ...patch } });
}
function subscribeForm(listener: () => void): () => void {
  formListeners.add(listener);
  return () => formListeners.delete(listener);
}
const NEW = "new";
/** Which form is open: `new`, a routine id, or null. A string, so typing changes nothing here. */
function useFormTarget(captainId: string): string | null {
  return useSyncExternalStore(subscribeForm, () => {
    const draft = formStates.get(captainId)?.draft;
    return draft === undefined ? null : (draft.routineId ?? NEW);
  });
}
function useForm(captainId: string): FormState | null {
  return useSyncExternalStore(subscribeForm, () => formStates.get(captainId) ?? null);
}

const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Open the form for a new routine, its Name field focused. */
function startNew(captainId: string): void {
  patchUi(captainId, { confirm: null });
  setForm(captainId, {
    draft: {
      key: ++draftKeys,
      routineId: null,
      updatedAt: null,
      name: "",
      instruction: "",
      preset: PRESET_CRONS[0] as string,
      cron: PRESET_CRONS[0] as string,
      timezone: browserTimezone(),
      at: "",
      atMs: null,
      refusal: [],
      stale: false,
    },
    focus: { field: "name", start: null, end: null },
  });
}

/** Open the form on a routine as it is now, its Name field focused. */
function startEdit(captainId: string, routine: RoutineView): void {
  patchUi(captainId, { confirm: null });
  setForm(captainId, {
    draft: editDraft(routine),
    focus: { field: "name", start: null, end: null },
  });
}

const EDIT_BASE = (routine: RoutineView) => ({
  key: ++draftKeys,
  routineId: routine.id,
  updatedAt: routine.updatedAt,
  name: routine.name,
  instruction: routine.instruction,
  refusal: [] as readonly string[],
  stale: false,
});

function editDraft(routine: RoutineView): Draft {
  const schedule = routine.schedule;
  if ("at" in schedule) {
    return {
      ...EDIT_BASE(routine),
      preset: ONCE,
      cron: PRESET_CRONS[0] as string,
      timezone: browserTimezone(),
      at: localInput(schedule.at),
      atMs: schedule.at,
    };
  }
  return {
    ...EDIT_BASE(routine),
    preset: PRESET_CRONS.includes(schedule.cron) ? schedule.cron : CUSTOM,
    cron: schedule.cron,
    timezone: schedule.timezone,
    at: "",
    atMs: null,
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
  if (draft.preset === ONCE) {
    if (draft.atMs !== null && draft.at === localInput(draft.atMs)) return { at: draft.atMs };
    return { at: draft.at === "" ? Number.NaN : Date.parse(draft.at) };
  }
  return { cron: draft.preset === CUSTOM ? draft.cron : draft.preset, timezone: draft.timezone };
}

/** The draft's schedule in words, or why it cannot run; the server has the last word. */
function draftWords(draft: Draft, now: number): { text: string; problem: boolean } {
  const schedule = draftSchedule(draft);
  if ("at" in schedule) {
    if (Number.isNaN(schedule.at)) return { text: "Pick a date and time", problem: true };
    const text = describeSchedule(schedule);
    // Its own stored time: renaming a one-shot that ran keeps it as it is.
    if (schedule.at === draft.atMs && schedule.at <= now)
      return { text: `${text} · already due; pick a new time to run it again`, problem: false };
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
const WHEN_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
function formatWhen(at: number): string {
  return WHEN_FORMAT.format(new Date(at));
}

/** The schedule in words; a one-shot in the browser's zone, as the form takes it. */
function whenOf(routine: RoutineView): string {
  return "at" in routine.schedule ? describeSchedule(routine.schedule) : routine.when;
}

/** The newest run as the closed row's second line, or null before the first. */
function lastRunLine(routine: RoutineView): { text: string; failed: boolean } | null {
  const run = routine.lastRun;
  if (run === null) return null;
  const reason = run.reason === null ? "" : `: ${run.reason}`;
  return {
    text: `Last run ${formatWhen(run.at)} · ${run.trigger === "test" ? "Test · " : ""}${RUN_STATUS[run.status]}${reason}`,
    failed: run.status === "failed",
  };
}

/** What a row's subline says, and whether its switch applies. */
function rowState(routine: RoutineRow): {
  line: string;
  problem: boolean;
  enabled: boolean | null;
} {
  // A one-shot's words start "Once, …"; one that ran reads "Ran once, …".
  if (routine.done)
    return { line: whenOf(routine).replace(/^Once/u, "Ran once"), problem: false, enabled: null };
  if (routine.scheduleLoading)
    return { line: `${whenOf(routine)} · loading schedule…`, problem: false, enabled: null };
  if (routine.missed)
    return { line: "Missed its one run · give it a new time", problem: true, enabled: null };
  const automation = routine.automation;
  if (automation === null) return { line: "Schedule unavailable", problem: true, enabled: null };
  if (!automation.enabled) return { line: "Paused", problem: false, enabled: false };
  const next = automation.nextRunAt === null ? "" : ` · next ${formatWhen(automation.nextRunAt)}`;
  return { line: `${whenOf(routine)}${next}`, problem: false, enabled: true };
}

const RUN_STATUS: Record<RoutineRun["status"], string> = {
  sent: "Sent",
  queued: "Queued behind a turn",
  skipped: "Skipped",
  failed: "Failed",
};

/** The Overview's controls on its 4px grid: 32px tall, 44px under a coarse pointer. */
const CONTROL = cn(TAP, "h-8 leading-4");
/** A Schedule option: 44px tall on a touch or compact layout. */
const OPTION = "max-md:min-h-11 pointer-coarse:min-h-11";

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
  const target = useFormTarget(captainId);
  const creating = target === NEW;
  return (
    <div className="flex min-w-0 flex-col">
      {creating ? <RoutineForm captainId={captainId} latest={null} /> : null}
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
              editing={target === routine.id}
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
  editing,
  visible,
  onRetry,
}: {
  captainId: string;
  routine: RoutineRow;
  ui: RoutinesUi;
  /** This routine's edit form is open. */
  editing: boolean;
  visible: boolean;
  onRetry: () => void;
}) {
  const open = ui.open === routine.id;
  const panel = useId();
  const state = rowState(routine);
  const action = useRoutineAction(captainId);
  const error = ui.errors[routine.id] ?? null;
  const setError = (text: string | null) => {
    const { [routine.id]: _, ...rest } = uiStates.get(captainId)?.errors ?? {};
    patchUi(captainId, { errors: text === null ? rest : { ...rest, [routine.id]: text } });
  };
  const last = lastRunLine(routine);
  const run = (kind: RoutineAction) => {
    if (error !== null) setError(null);
    if (kind === "delete") patchUi(captainId, { confirm: null, open: null });
    void action.mutate({ captainId, routineId: routine.id, action: kind }).then(
      ({ runId }) =>
        kind === "run" && runId !== null
          ? patchUi(captainId, {
              tests: {
                ...uiStates.get(captainId)?.tests,
                [routine.id]: { runId, outcome: null },
              },
            })
          : undefined,
      (failure: unknown) => setError((failure as Error).message),
    );
  };
  const pendingAction = action.pendingInputs.find((input) => input.routineId === routine.id);
  return (
    <li className="flex min-w-0 flex-col" data-routine={routine.id}>
      <div className="flex min-w-0 items-start">
        <Item asChild size="xs" className={cn(TAP, "min-w-0 flex-1 flex-nowrap items-start")}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panel}
            onClick={() => {
              // Closing a row forgets its Test request; its runs stay listed.
              const { [routine.id]: _, ...tests } = uiStates.get(captainId)?.tests ?? {};
              patchUi(captainId, { open: open ? null : routine.id, confirm: null, tests });
            }}
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
              {last === null ? null : (
                <span
                  className={cn(
                    "truncate text-xs leading-4",
                    last.failed ? "text-destructive" : "text-muted-foreground",
                  )}
                  title={last.text}
                >
                  {last.text}
                </span>
              )}
            </span>
          </button>
        </Item>
        {/* The track sits in a 32px cell on the Overview's grid; the switch's
            ::after grows its hit area to that cell, and to 44px on a coarse pointer. */}
        <span className="me-1 inline-flex size-8 shrink-0 items-center justify-center self-center pointer-coarse:size-11">
          <Switch
            checked={state.enabled === true}
            disabled={state.enabled === null || pendingAction !== undefined}
            aria-label={`${routine.name}: ${state.enabled === true ? "active" : "paused"}`}
            className="relative after:absolute after:-inset-x-0.5 after:-inset-y-2 pointer-coarse:after:-inset-x-2 pointer-coarse:after:-inset-y-3.5"
            onCheckedChange={(checked) => run(checked ? "resume" : "pause")}
          />
        </span>
      </div>
      {open ? (
        <div
          id={panel}
          className="flex min-w-0 flex-col gap-3 ps-8 pe-2 pb-2 text-xs leading-4"
          data-testid="captain-routine-panel"
        >
          {editing ? (
            <RoutineForm captainId={captainId} latest={routine} />
          ) : (
            <RoutineDetails
              captainId={captainId}
              routine={routine}
              state={state}
              confirming={ui.confirm === routine.id}
              pending={pendingAction}
              test={ui.tests[routine.id] ?? null}
              visible={visible}
              run={run}
              onRetry={onRetry}
            />
          )}
        </div>
      ) : null}
      {error === null ? null : (
        <div className="min-w-0 ps-8 pe-2 pb-2">
          <Alert variant="destructive" role="alert">
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        </div>
      )}
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
  test,
  visible,
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
  test: RoutineTest | null;
  visible: boolean;
  run: (action: RoutineAction) => void;
  onRetry: () => void;
}) {
  const runs = useRpcQuery({
    contract: captainContract,
    method: "routineRuns",
    input: { captainId, routineId: routine.id, limit: 5 },
    enabled: visible,
  });
  return (
    <>
      {routine.automationError === null ? null : (
        <div className="flex min-w-0 items-center gap-2">
          <Alert variant="destructive" role="none" className="w-auto min-w-0 flex-1">
            <AlertDescription className="break-words">{routine.automationError}</AlertDescription>
          </Alert>
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
          {whenOf(routine)}
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
        <RoutineRuns runs={runs} />
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
            onClick={() => startEdit(captainId, routine)}
          >
            <Icon name="Edit" aria-hidden className="size-4" />
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
      {test === null ? null : (
        <TestOutcome captainId={captainId} routineId={routine.id} test={test} visible={visible} />
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

type RunsRead = {
  data: { runs: RoutineRun[] } | undefined;
  error: { message: string } | null;
};

function runText(run: RoutineRun): string {
  const reason = run.reason === null ? "" : `: ${run.reason}`;
  return `${formatWhen(run.at)} · ${run.trigger === "test" ? "Test" : "Scheduled"} · ${RUN_STATUS[run.status]}${reason}`;
}

/** An opened routine's last five runs, newest first, each wrapped whole. */
function RoutineRuns({ runs }: { runs: RunsRead }) {
  if (runs.data === undefined) {
    return runs.error === null ? (
      <span aria-busy className="h-4 w-1/2 animate-pulse rounded bg-muted" />
    ) : (
      <Alert variant="destructive" role="none">
        <AlertDescription>Couldn't load runs · {runs.error.message}</AlertDescription>
      </Alert>
    );
  }
  if (runs.data.runs.length === 0)
    return <p className="m-0 text-muted-foreground">None yet · a new routine waits for its time</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Last runs">
      {runs.data.runs.map((run) => (
        <li
          key={run.id}
          className={cn(
            "min-w-0 break-words tabular-nums",
            run.status === "failed" ? "text-destructive" : "text-foreground",
          )}
        >
          {runText(run)}
        </li>
      ))}
    </ul>
  );
}

const TEST_OUTCOME: Record<RoutineRun["status"], string> = {
  sent: "Test sent · the Captain is running it, for real",
  queued: "Test queued · the Captain runs it after its current turn",
  skipped: "Test skipped",
  failed: "Test failed",
};

/**
 * What became of the panel's last Test: requested until fire records a test
 * run with the matching Automations ID, then that run's delivery state and reason.
 */
function TestOutcome({
  captainId,
  routineId,
  test,
  visible,
}: {
  captainId: string;
  routineId: string;
  test: RoutineTest;
  visible: boolean;
}) {
  const { runId, outcome } = test;
  const result = useRpcQuery({
    contract: captainContract,
    method: "routineRun",
    input: { captainId, routineId, runId },
    enabled: visible && outcome === null,
  }).data?.run;
  const match = result?.automationRunId === runId ? result : undefined;
  useEffect(() => {
    const tests = uiStates.get(captainId)?.tests;
    const current = tests?.[routineId];
    if (match === undefined || current?.runId !== runId || current.outcome !== null) return;
    const { status, reason } = match;
    patchUi(captainId, {
      tests: { ...tests, [routineId]: { runId, outcome: { status, reason } } },
    });
  }, [captainId, routineId, runId, match]);
  const run = outcome ?? match;
  const text =
    run === undefined
      ? "Test requested · waiting for it to reach the Captain"
      : `${TEST_OUTCOME[run.status]}${run.reason === null ? "" : `: ${run.reason}`}`;
  const problem = run !== undefined && (run.status === "failed" || run.status === "skipped");
  return (
    <output
      aria-live="polite"
      data-testid="captain-routine-test"
      className={cn(
        "block min-w-0 break-words",
        problem ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {text}
    </output>
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
 * is refused. Its draft, refusal and focus live in `formStates`, so a remount
 * keeps them; a save lands only on the draft it was made from.
 */
function RoutineForm({
  captainId,
  latest,
}: {
  captainId: string;
  /** The routine as the list has it now, for Reload after a stale save; null for a new one. */
  latest: RoutineView | null;
}) {
  const form = useForm(captainId);
  if (form === null) return null;
  return <DraftForm captainId={captainId} draft={form.draft} latest={latest} />;
}

function DraftForm({
  captainId,
  draft,
  latest,
}: {
  captainId: string;
  draft: Draft;
  latest: RoutineView | null;
}) {
  const id = useId();
  const root = useRef<HTMLFormElement>(null);
  const save = useRpcMutation({ contract: captainContract, method: "saveRoutine" });
  // An edit answers the last refusal; until then it stays, through remounts too.
  const set = (patch: Partial<Draft>) =>
    patchDraft(captainId, draft.key, { refusal: [], stale: false, ...patch });
  // Put focus back where it was when bb remounted the tab, caret and all.
  useLayoutEffect(() => {
    const focus = formStates.get(captainId)?.focus;
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
  /** Record the focused field without notifying: focus alone re-renders nothing. */
  const keepFocus = (focus: FormState["focus"]) => {
    const current = formStates.get(captainId);
    if (current !== undefined && current.draft.key === draft.key)
      formStates.set(captainId, { ...current, focus });
  };
  const track = (field: Field) => ({
    "data-routine-field": field,
    onFocus: (event: FocusEvent<HTMLElement>) => remember(field, event.currentTarget),
    onSelect: (event: SyntheticEvent<HTMLElement>) => remember(field, event.currentTarget),
    // Focus moving to another element forgets the field; an unmount has no related target.
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (event.relatedTarget !== null && formStates.get(captainId)?.focus?.field === field)
        keepFocus(null);
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
    keepFocus({ field, start, end });
  };
  const close = () => {
    if (formStates.get(captainId)?.draft.key === draft.key) setForm(captainId, null);
  };
  // When the form opened is near enough for "that time has passed".
  const [now] = useState(Date.now);
  const words = draftWords(draft, now);
  const ready =
    draft.name.trim() !== "" &&
    draft.instruction.trim() !== "" &&
    !(draft.preset === ONCE && Number.isNaN(Date.parse(draft.at)));
  const submit = () => {
    const key = draft.key;
    const current = formStates.get(captainId)?.draft;
    if (current?.key !== key || current.saving) return;
    set({ saving: true, refusal: [], stale: false });
    void save
      .mutate({
        captainId,
        ...(draft.routineId === null ? {} : { routineId: draft.routineId }),
        ...(draft.updatedAt === null ? {} : { updatedAt: draft.updatedAt }),
        routine: {
          name: draft.name,
          instruction: draft.instruction,
          schedule: draftSchedule(draft),
        },
      })
      .then(
        (result) => {
          // Only the draft this save came from: a later draft keeps its own text.
          if (formStates.get(captainId)?.draft.key !== key) return undefined;
          if (!result.ok)
            return patchDraft(captainId, key, {
              saving: false,
              refusal: result.blockers.map((blocker) => blocker.reason),
              stale: result.stale,
            });
          setForm(captainId, null);
          return patchUi(captainId, { open: result.routine.id });
        },
        (failure: unknown) =>
          patchDraft(captainId, key, {
            saving: false,
            refusal: [(failure as Error).message],
            stale: false,
          }),
      );
  };
  /** Start the edit again from the routine as it is now. */
  const reload = () => {
    if (latest === null) return;
    setForm(captainId, {
      draft: editDraft(latest),
      focus: { field: "name", start: null, end: null },
    });
  };
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
        if (ready && !draft.saving) submit();
      }}
    >
      {/* Fields lock while a save is on its way: an edit typed meanwhile would not be the one saved. */}
      <fieldset disabled={draft.saving} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <KitField className="min-w-0 gap-1">
          <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
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
        </KitField>
        <KitField className="min-w-0 gap-1">
          <FieldLabel htmlFor={`${id}-instruction`}>Instruction</FieldLabel>
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
          <FieldDescription className="self-end tabular-nums">
            {draft.instruction.length} / {ROUTINE_INSTRUCTION_MAX}
          </FieldDescription>
        </KitField>
        <KitField className="min-w-0 gap-1">
          <FieldLabel htmlFor={`${id}-preset`}>Schedule</FieldLabel>
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
                  <SelectItem key={cron} value={cron} className={OPTION}>
                    {describeCron(cron)}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM} className={OPTION}>
                  Custom cron…
                </SelectItem>
                <SelectItem value={ONCE} className={OPTION}>
                  Once, at a time…
                </SelectItem>
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
        </KitField>
        {draft.preset === ONCE ? null : (
          <KitField className="min-w-0 gap-1">
            <FieldLabel htmlFor={`${id}-timezone`}>Time zone</FieldLabel>
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
          </KitField>
        )}
      </fieldset>
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
      {draft.refusal.length === 0 ? null : (
        <Alert variant="destructive" role="alert" aria-label="Not saved">
          {draft.stale ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <AlertDescription className="min-w-0 break-words">
                Not saved · changed elsewhere since you opened it
              </AlertDescription>
              {latest === null ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={cn(CONTROL, "px-3")}
                  onClick={reload}
                >
                  Reload
                </Button>
              )}
            </div>
          ) : (
            draft.refusal.map((reason) => (
              <AlertDescription key={reason} className="min-w-0 break-words">
                Not saved · {reason}
              </AlertDescription>
            ))
          )}
        </Alert>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          className={cn(CONTROL, "px-3")}
          disabled={!ready || draft.saving}
        >
          {draft.saving ? "Saving…" : draft.routineId === null ? "Create routine" : "Save"}
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
