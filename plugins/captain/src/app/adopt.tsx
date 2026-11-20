import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  type PluginThreadAction,
  type PluginThreadActionDataInput,
  type PluginThreadActionItemInput,
} from "@get-bb/plugin-sdk/app";
import {
  ADOPT_TITLE_MAX,
  captainContract,
  type AdoptInput,
  type AdoptOptions,
  type AdoptResult,
} from "../contract/rpc.ts";
import { Button } from "./components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import { Input } from "./components/ui/input.tsx";
import { Label } from "./components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";

/**
 * Adopt into Captain: a thread-menu action that opens a dialog picking the
 * Captain, the task and the role, then calls the `adopt` RPC, which runs the
 * path `bb captain dispatch <task> --role <role> --thread <id>` runs.
 */

export const ADOPT_LABEL = "Adopt into Captain…";
export const ADOPT_ICON = "UserRoundPlus";
const NO_INPUT = {};
const NEW_TASK = "new";
/** 44 px controls where the dialog is a bottom sheet or the pointer is coarse. */
const TOUCH = "max-md:h-11 pointer-coarse:h-11";

type Role = AdoptInput["role"];
type CaptainOption = AdoptOptions["captains"][number];
type TaskOption = CaptainOption["tasks"][number];

/** What every thread menu row reads: the live Captains, and whose crew each shown thread is. */
export type AdoptData = {
  captains: ReadonlySet<string>;
  /** Thread id → the Captain it is crew of on a task; null, or absent while unread, otherwise. */
  crewOf: Readonly<Record<string, string | null>>;
};

const NO_CREW: Readonly<Record<string, string | null>> = {};

/** One shared `captains` read, and one batched `crewOf` read over the rows on screen. */
export function useAdoptData({ threadIds }: PluginThreadActionDataInput): AdoptData | null {
  const read = useRpcQuery({ contract: captainContract, method: "captains", input: NO_INPUT });
  // Keyed by content, so a refetch with the same Captains keeps every row's item stable.
  const shape = read.data?.ids.join(",");
  const captains = useMemo(
    () => (shape === undefined ? null : new Set(shape === "" ? [] : shape.split(","))),
    [shape],
  );
  const crew = useRpcKeyedQuery({
    contract: captainContract,
    method: "crewOf",
    keys: threadIds,
    enabled: captains !== null && captains.size > 0,
  });
  const crewOf = crew.data ?? NO_CREW;
  return useMemo(() => (captains === null ? null : { captains, crewOf }), [captains, crewOf]);
}

const disabledItem = (detail: string): PluginThreadAction => ({
  label: ADOPT_LABEL,
  detail,
  icon: ADOPT_ICON,
  disabled: true,
  run: () => {},
});

/**
 * Hidden while no Captain is live and for a Captain's own thread; disabled for
 * an archived thread and for its parent Captain's crew on a task. A Captain's
 * child on no task, such as one whose adopt stopped before the attach, stays
 * enabled so the dialog can finish it.
 */
export function adoptItem({
  thread,
  data,
}: Pick<
  PluginThreadActionItemInput<AdoptData | null>,
  "thread" | "data"
>): PluginThreadAction | null {
  if (data === null || data === undefined || data.captains.size === 0) return null;
  if (data.captains.has(thread.id)) return null;
  const parent = thread.parentThreadId;
  if (parent !== null && data.captains.has(parent) && data.crewOf[thread.id] === parent) {
    return disabledItem("Already a Captain's crew");
  }
  if (thread.archivedAt !== null) return disabledItem("Archived");
  return { label: ADOPT_LABEL, icon: ADOPT_ICON, run: () => openAdopt(thread.id) };
}

// The dialog outlives the menu that opened it, so it mounts in an app overlay
// that reads which thread to adopt from here. Each open gets its own key.
let request: { threadId: string; opened: number } | null = null;
let opens = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
function setRequest(threadId: string | null): void {
  request = threadId === null ? null : { threadId, opened: ++opens };
  for (const listener of listeners) listener();
}
export const openAdopt = (threadId: string) => setRequest(threadId);
const closeAdopt = () => setRequest(null);

/** Renders nothing and reads nothing until an Adopt action names a thread. */
export function AdoptOverlay() {
  const current = useSyncExternalStore(subscribe, () => request);
  if (current === null) return null;
  return <AdoptDialog key={current.opened} threadId={current.threadId} open={current.opened} />;
}

function AdoptDialog({ threadId, open }: { threadId: string; open: number }) {
  // Keyed by the open, so the form always seeds from a read made for this open.
  const options = useRpcQuery({
    contract: captainContract,
    method: "adoptOptions",
    input: { threadId, open },
  });
  const data = options.data;
  return (
    <Dialog open onOpenChange={(open) => !open && closeAdopt()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adopt into Captain</DialogTitle>
          <DialogDescription>
            The thread joins the Captain's crew on a task, as{" "}
            <code>bb captain dispatch --thread</code> does.
          </DialogDescription>
        </DialogHeader>
        {data !== undefined ? (
          <AdoptForm options={data} />
        ) : options.error !== null ? (
          <LoadError message={options.error.message} retry={() => void options.refetch()} />
        ) : (
          <FormSkeleton />
        )}
      </DialogContent>
    </Dialog>
  );
}

function LoadError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <>
      <p className="text-sm text-destructive" role="alert">
        {message}
      </p>
      <DialogFooter>
        <Button variant="outline" className={TOUCH} onClick={retry}>
          Retry
        </Button>
      </DialogFooter>
    </>
  );
}

/** The form's own shape (Task, Title, Role, buttons), so the dialog keeps its height when it loads. */
function FormSkeleton() {
  const field = (
    <div className="flex flex-col gap-1.5">
      <div className="h-3.5 w-16 animate-pulse rounded bg-muted" />
      <div className={`h-9 animate-pulse rounded-md bg-muted ${TOUCH}`} />
    </div>
  );
  return (
    <div className="flex flex-col gap-4" aria-busy aria-label="Loading">
      {field}
      {field}
      {field}
      <div className="flex justify-end gap-2">
        <div className={`h-9 w-20 animate-pulse rounded-md bg-muted ${TOUCH}`} />
        <div className={`h-9 w-20 animate-pulse rounded-md bg-muted ${TOUCH}`} />
      </div>
    </div>
  );
}

/** The Captain whose repos include the thread's project, else the first. */
function defaultCaptain(options: AdoptOptions): CaptainOption | undefined {
  const own = options.captains.find((captain) =>
    captain.repos.some((repo) => repo.bbProjectId === options.thread.projectId),
  );
  return own ?? options.captains[0];
}

/** The repo a new task goes in: the thread's own project's, else the Captain's first. */
function defaultRepo(captain: CaptainOption | undefined, projectId: string): string {
  const own = captain?.repos.find((repo) => repo.bbProjectId === projectId);
  return own?.key ?? captain?.repos[0]?.key ?? "";
}

const roleLabel = (options: AdoptOptions, role: Role) =>
  options.roles.find((each) => each.value === role)?.label ?? role;

type Submitted = { captain: string; role: string; result: AdoptResult };

type Fields = {
  captain: CaptainOption;
  threadId: string;
  task: string;
  title: string;
  repo: string;
  role: Role;
};

/** What Adopt sends for the fields, and whether it may: the Captain can take it and the task is free. */
function adoptInput(fields: Fields): { input: AdoptInput; valid: boolean } {
  const { captain, task, title, repo, role } = fields;
  const creating = task === NEW_TASK;
  const picked = captain.tasks.find((each) => each.key === task);
  const free = creating
    ? title.trim() !== "" && repo !== ""
    : picked?.held.includes(role) === false;
  return {
    input: {
      captainId: captain.id,
      threadId: fields.threadId,
      role,
      task: creating
        ? { kind: "new", projectKey: repo, title: title.trim() }
        : { kind: "existing", key: task },
    },
    valid: captain.blockers.length === 0 && free,
  };
}

function AdoptForm({ options }: { options: AdoptOptions }) {
  const [pickedCaptain, setPickedCaptain] = useState(() => defaultCaptain(options)?.id ?? "");
  // A Captain archived while the dialog is open falls back to the default one.
  const captain =
    options.captains.find((each) => each.id === pickedCaptain) ?? defaultCaptain(options);
  const [task, setTask] = useState(NEW_TASK);
  const [title, setTitle] = useState(() => options.thread.title.slice(0, ADOPT_TITLE_MAX));
  const [repo, setRepo] = useState(() => defaultRepo(captain, options.thread.projectId));
  const [role, setRole] = useState<Role>("implement");
  const adopt = useRpcMutation({ contract: captainContract, method: "adopt" });
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);

  if (captain === undefined) {
    return <p className="text-sm text-muted-foreground">No live Captain to adopt into.</p>;
  }
  if (submitted?.result.ok === true) return <Adopted submitted={submitted} />;

  const pickCaptain = (id: string) => {
    setPickedCaptain(id);
    setTask(NEW_TASK);
    setRepo(
      defaultRepo(
        options.captains.find((each) => each.id === id),
        options.thread.projectId,
      ),
    );
    setSubmitted(null);
  };
  const fields = { captain, threadId: options.thread.id, task, title, repo, role };
  const { input, valid } = adoptInput(fields);
  const ready = valid && !adopt.isPending;
  const creating = task === NEW_TASK;
  const submit = async () => {
    setSubmitted(null);
    // The names shown on success are the ones sent, not whatever the fields hold by then.
    const sent = { captain: captain.name, role: roleLabel(options, role) };
    try {
      setSubmitted({ ...sent, result: await adopt.mutate(input) });
    } catch {
      // `adopt.error` holds the failure; the form shows it.
    }
  };
  const blockers = submitted?.result.ok === false ? submitted.result.blockers : captain.blockers;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void submit();
      }}
    >
      <fieldset disabled={adopt.isPending} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
        {options.captains.length > 1 ? (
          <CaptainField
            options={options}
            value={captain.id}
            onChange={pickCaptain}
            focusRef={first}
          />
        ) : null}
        <TaskField
          captain={captain}
          role={role}
          roleName={roleLabel(options, role)}
          value={task}
          onChange={setTask}
          tasksError={options.tasksError}
          focusRef={options.captains.length > 1 ? undefined : first}
        />
        {creating ? (
          <NewTaskFields
            captain={captain}
            title={title}
            onTitle={setTitle}
            repo={repo}
            onRepo={setRepo}
          />
        ) : null}
        <RoleField options={options} value={role} onChange={setRole} />
      </fieldset>
      <Problems blockers={blockers} error={adopt.error?.message ?? null} />
      <DialogFooter>
        <Button type="button" variant="outline" className={TOUCH} onClick={closeAdopt}>
          Cancel
        </Button>
        <Button type="submit" className={TOUCH} disabled={!ready}>
          {adopt.isPending ? "Adopting…" : "Adopt"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Adopted({ submitted }: { submitted: Submitted }) {
  const done = useRef<HTMLButtonElement>(null);
  useEffect(() => done.current?.focus(), []);
  const { result } = submitted;
  if (!result.ok) return null;
  return (
    <>
      <output className="block text-sm">
        Adopted into {submitted.captain} as {submitted.role} on {result.task}
        {result.created ? " (new task)" : ""}. {result.detail}
      </output>
      {result.warnings.map((warning) => (
        <p key={warning} className="text-xs text-muted-foreground">
          {warning}
        </p>
      ))}
      <DialogFooter>
        <Button ref={done} className={TOUCH} onClick={closeAdopt}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

function Problems({
  blockers,
  error,
}: {
  blockers: readonly { reason: string; fix: string }[];
  error: string | null;
}) {
  if (blockers.length === 0 && error === null) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm text-destructive" role="alert">
      {blockers.map((blocker) => (
        <li key={blocker.reason}>
          {blocker.reason}
          <span className="block text-xs text-muted-foreground">Fix: {blocker.fix}</span>
        </li>
      ))}
      {error === null ? null : <li>{error}</li>}
    </ul>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

/** A select whose list stays inside the window and truncates long rows. */
function Picker({
  id,
  value,
  onChange,
  focusRef,
  children,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  focusRef?: RefObject<HTMLButtonElement | null> | undefined;
  children: ReactNode;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} ref={focusRef} className={TOUCH}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-w-[min(32rem,calc(100vw-2rem))]">
        <SelectGroup>{children}</SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** One row of a picker: a truncated label, and an optional reason it is unavailable. */
function Row({
  value,
  label,
  note,
  disabled,
}: {
  value: string;
  label: string;
  note?: string;
  disabled?: boolean;
}) {
  return (
    <SelectItem value={value} disabled={disabled === true} className="[&>span]:min-w-0">
      <span className="block truncate">{label}</span>
      {note === undefined ? null : (
        <span className="block truncate text-xs text-muted-foreground">{note}</span>
      )}
    </SelectItem>
  );
}

function CaptainField({
  options,
  value,
  onChange,
  focusRef,
}: {
  options: AdoptOptions;
  value: string;
  onChange: (id: string) => void;
  focusRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Field label="Captain" id="captain-adopt-captain">
      <Picker id="captain-adopt-captain" value={value} onChange={onChange} focusRef={focusRef}>
        {options.captains.map((each) => (
          <Row key={each.id} value={each.id} label={each.name} />
        ))}
      </Picker>
    </Field>
  );
}

function TaskField({
  captain,
  role,
  roleName,
  value,
  onChange,
  tasksError,
  focusRef,
}: {
  captain: CaptainOption;
  role: Role;
  roleName: string;
  value: string;
  onChange: (key: string) => void;
  tasksError: string | null;
  focusRef: RefObject<HTMLButtonElement | null> | undefined;
}) {
  const heldNote = (each: TaskOption) =>
    each.held.includes(role) ? `Has a live ${roleName} thread` : undefined;
  return (
    <Field label="Task" id="captain-adopt-task">
      <Picker id="captain-adopt-task" value={value} onChange={onChange} focusRef={focusRef}>
        <Row value={NEW_TASK} label="New task from the thread's title" />
        {captain.tasks.map((each) => {
          const note = heldNote(each);
          return (
            <Row
              key={each.key}
              value={each.key}
              label={`${each.key} · ${each.title}`}
              disabled={note !== undefined}
              {...(note === undefined ? {} : { note })}
            />
          );
        })}
      </Picker>
      {tasksError === null ? null : (
        <p className="text-xs text-muted-foreground">Open tasks not listed: {tasksError}</p>
      )}
    </Field>
  );
}

function NewTaskFields({
  captain,
  title,
  onTitle,
  repo,
  onRepo,
}: {
  captain: CaptainOption;
  title: string;
  onTitle: (title: string) => void;
  repo: string;
  onRepo: (key: string) => void;
}) {
  return (
    <>
      <Field label="Title" id="captain-adopt-title">
        <Input
          id="captain-adopt-title"
          className={TOUCH}
          value={title}
          maxLength={ADOPT_TITLE_MAX}
          onChange={(event) => onTitle(event.target.value)}
        />
      </Field>
      {captain.repos.length > 1 ? (
        <Field label="Repo" id="captain-adopt-repo">
          <Picker id="captain-adopt-repo" value={repo} onChange={onRepo}>
            {captain.repos.map((each) => (
              <Row key={each.key} value={each.key} label={`${each.name} (${each.key})`} />
            ))}
          </Picker>
        </Field>
      ) : null}
    </>
  );
}

function RoleField({
  options,
  value,
  onChange,
}: {
  options: AdoptOptions;
  value: Role;
  onChange: (role: Role) => void;
}) {
  return (
    <Field label="Role" id="captain-adopt-role">
      <Picker id="captain-adopt-role" value={value} onChange={(next) => onChange(next as Role)}>
        {options.roles.map((each) => (
          <Row key={each.value} value={each.value} label={each.label} />
        ))}
      </Picker>
    </Field>
  );
}
