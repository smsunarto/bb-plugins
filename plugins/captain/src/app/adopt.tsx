import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  type PluginThreadAction,
  type PluginThreadActionItemInput,
} from "@get-bb/plugin-sdk/app";
import {
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

/** The live Captains' ids, from the read the Needs you banner shares. */
export function useAdoptData(): ReadonlySet<string> | null {
  const captains = useRpcQuery({ contract: captainContract, method: "captains", input: NO_INPUT });
  // Keyed by content, so a refetch with the same Captains keeps every row's item stable.
  const shape = captains.data?.ids.join(",");
  return useMemo(
    () => (shape === undefined ? null : new Set(shape === "" ? [] : shape.split(","))),
    [shape],
  );
}

/**
 * Hidden while no Captain is live and for a Captain's own thread; disabled for
 * a thread that is already a Captain's crew, since its parent is that Captain.
 */
export function adoptItem({
  thread,
  data: captains,
}: Pick<
  PluginThreadActionItemInput<ReadonlySet<string> | null>,
  "thread" | "data"
>): PluginThreadAction | null {
  if (captains === null || captains === undefined || captains.size === 0) return null;
  if (captains.has(thread.id)) return null;
  if (thread.parentThreadId !== null && captains.has(thread.parentThreadId)) {
    return {
      label: ADOPT_LABEL,
      detail: "Already a Captain's crew",
      icon: ADOPT_ICON,
      disabled: true,
      run: () => {},
    };
  }
  if (thread.archivedAt !== null) {
    return {
      label: ADOPT_LABEL,
      detail: "Archived",
      icon: ADOPT_ICON,
      disabled: true,
      run: () => {},
    };
  }
  return { label: ADOPT_LABEL, icon: ADOPT_ICON, run: () => openAdopt(thread.id) };
}

// The dialog outlives the menu that opened it, so it mounts in an app overlay
// that reads which thread to adopt from here.
let request: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
function setRequest(threadId: string | null): void {
  request = threadId;
  for (const listener of listeners) listener();
}
export const openAdopt = (threadId: string) => setRequest(threadId);

/** Renders nothing and reads nothing until an Adopt action names a thread. */
export function AdoptOverlay() {
  const threadId = useSyncExternalStore(subscribe, () => request);
  if (threadId === null) return null;
  return <AdoptDialog key={threadId} threadId={threadId} onClose={() => setRequest(null)} />;
}

function AdoptDialog({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const options = useRpcQuery({
    contract: captainContract,
    method: "adoptOptions",
    input: { threadId },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adopt into Captain</DialogTitle>
          <DialogDescription>
            The thread joins the Captain's crew on a task, as{" "}
            <code>bb captain dispatch --thread</code> does.
          </DialogDescription>
        </DialogHeader>
        {options.data !== undefined ? (
          <AdoptForm options={options.data} onClose={onClose} />
        ) : options.error !== null ? (
          <>
            <p className="text-sm text-destructive">{options.error.message}</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => void options.refetch()}>
                Retry
              </Button>
            </DialogFooter>
          </>
        ) : (
          <div className="flex flex-col gap-3" aria-busy>
            {[0, 1, 2].map((row) => (
              <div key={row} className="h-9 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The Captain whose repos include the thread's project, else the first. */
function defaultCaptain(options: AdoptOptions): string {
  const own = options.captains.find((captain) =>
    captain.repos.some((repo) => repo.bbProjectId === options.thread.projectId),
  );
  return (own ?? options.captains[0])?.id ?? "";
}

function AdoptForm({ options, onClose }: { options: AdoptOptions; onClose: () => void }) {
  const [captainId, setCaptainId] = useState(() => defaultCaptain(options));
  const captain = options.captains.find((each) => each.id === captainId);
  const [task, setTask] = useState(NEW_TASK);
  const [title, setTitle] = useState(options.thread.title);
  const ownRepo = captain?.repos.find((repo) => repo.bbProjectId === options.thread.projectId);
  const [projectKey, setProjectKey] = useState(ownRepo?.key ?? captain?.repos[0]?.key ?? "");
  const [role, setRole] = useState<AdoptInput["role"]>("implement");
  const adopt = useRpcMutation({ contract: captainContract, method: "adopt" });
  const [result, setResult] = useState<AdoptResult | null>(null);

  if (captain === undefined) {
    return <p className="text-sm text-muted-foreground">No live Captain to adopt into.</p>;
  }
  if (result?.ok === true && result.adopted) {
    const label = options.roles.find((each) => each.value === role)?.label ?? role;
    return (
      <>
        <output className="block text-sm">
          Adopted into {captain.name} as {label} on {result.task}
          {result.created ? " (new task)" : ""}. {result.detail}
        </output>
        {result.warnings.map((warning) => (
          <p key={warning} className="text-xs text-muted-foreground">
            {warning}
          </p>
        ))}
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </>
    );
  }

  const pickCaptain = (id: string) => {
    setCaptainId(id);
    setTask(NEW_TASK);
    const next = options.captains.find((each) => each.id === id);
    const repo = next?.repos.find((each) => each.bbProjectId === options.thread.projectId);
    setProjectKey(repo?.key ?? next?.repos[0]?.key ?? "");
    setResult(null);
  };
  const creating = task === NEW_TASK;
  const ready =
    captain.blockers.length === 0 &&
    !adopt.isPending &&
    (creating ? title.trim() !== "" && projectKey !== "" : true);
  const submit = async () => {
    setResult(null);
    try {
      const input: AdoptInput = {
        captainId: captain.id,
        threadId: options.thread.id,
        role,
        task: creating
          ? { kind: "new", projectKey, title: title.trim() }
          : { kind: "existing", key: task },
      };
      setResult(await adopt.mutate(input));
    } catch {
      // `adopt.error` holds the failure; the form shows it.
    }
  };
  const blockers = result?.blockers.length ? result.blockers : captain.blockers;
  const notAdopted = result?.ok === true && !result.adopted ? result.detail : null;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void submit();
      }}
    >
      {options.captains.length > 1 ? (
        <Field label="Captain" id="captain-adopt-captain">
          <Select value={captain.id} onValueChange={pickCaptain}>
            <SelectTrigger id="captain-adopt-captain">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {options.captains.map((each) => (
                  <SelectItem key={each.id} value={each.id}>
                    {each.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      <Field label="Task" id="captain-adopt-task">
        <Select value={task} onValueChange={setTask}>
          <SelectTrigger id="captain-adopt-task">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={NEW_TASK}>New task from the thread's title</SelectItem>
              {captain.tasks.map((each) => (
                <SelectItem key={each.key} value={each.key}>
                  {each.key} · {each.title}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {options.tasksError !== null ? (
          <p className="text-xs text-muted-foreground">
            Open tasks not listed: {options.tasksError}
          </p>
        ) : null}
      </Field>
      {creating ? (
        <>
          <Field label="Title" id="captain-adopt-title">
            <Input
              id="captain-adopt-title"
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          {captain.repos.length > 1 ? (
            <Field label="Repo" id="captain-adopt-repo">
              <Select value={projectKey} onValueChange={setProjectKey}>
                <SelectTrigger id="captain-adopt-repo">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {captain.repos.map((repo) => (
                      <SelectItem key={repo.key} value={repo.key}>
                        {repo.name} ({repo.key})
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
        </>
      ) : null}
      <Field label="Role" id="captain-adopt-role">
        <Select value={role} onValueChange={(value) => setRole(value as AdoptInput["role"])}>
          <SelectTrigger id="captain-adopt-role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {options.roles.map((each) => (
                <SelectItem key={each.value} value={each.value}>
                  {each.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {blockers.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm text-destructive" role="alert">
          {blockers.map((blocker) => (
            <li key={blocker.reason}>
              {blocker.reason}
              <span className="block text-xs text-muted-foreground">Fix: {blocker.fix}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {notAdopted !== null ? (
        <output className="block text-sm text-muted-foreground">Not adopted: {notAdopted}</output>
      ) : null}
      {adopt.error !== null ? (
        <p className="text-sm text-destructive" role="alert">
          {adopt.error.message}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready}>
          {adopt.isPending ? "Adopting…" : "Adopt"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
