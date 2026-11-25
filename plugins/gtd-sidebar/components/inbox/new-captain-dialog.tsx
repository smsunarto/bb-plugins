import { useId, useState, type FormEvent } from "react";
import { experimental_useRpcMutation as useRpcMutation } from "@get-bb/plugin-sdk/app";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { cn } from "../../lib/utils";
import { CAPTAIN_PLUGIN_ID, captainContract } from "../../lib/captain-contract";
import { newCaptainProblems, type RepoChoice } from "../../lib/new-captain";

/** Which form is open: the project it was opened from, if any, starts picked. */
export interface NewCaptainRequest {
  /** Bumped on every open, so each open starts a fresh form. */
  seq: number;
  projectId: string | null;
}

/**
 * New Captain: a name and the repos it directs, picked from bb's projects.
 * Submitting asks Captain to start one through the path `bb captain new`
 * takes, then opens its thread. Captain's refusals show as they come back.
 */
export function NewCaptainDialog({
  request,
  repos,
  onClose,
  onStarted,
}: {
  request: NewCaptainRequest | null;
  repos: readonly RepoChoice[];
  onClose: () => void;
  onStarted: (threadId: string) => void;
}) {
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        {request === null ? null : (
          <NewCaptainForm
            key={request.seq}
            initialProjectId={request.projectId}
            repos={repos}
            onCancel={onClose}
            onStarted={onStarted}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type Shown = "none" | "problems";

export function NewCaptainForm({
  initialProjectId,
  repos,
  onCancel,
  onStarted,
}: {
  initialProjectId: string | null;
  repos: readonly RepoChoice[];
  onCancel: () => void;
  onStarted: (threadId: string) => void;
}) {
  const nameId = useId();
  const nameErrorId = useId();
  const reposId = useId();
  const reposErrorId = useId();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<readonly string[]>(() =>
    initialProjectId !== null && repos.some((repo) => repo.id === initialProjectId)
      ? [initialProjectId]
      : [],
  );
  // Field problems show once a submit has tried, then follow the edits.
  const [shown, setShown] = useState<Shown>("none");
  const [refusal, setRefusal] = useState<readonly string[]>([]);
  const start = useRpcMutation({
    contract: captainContract,
    pluginId: CAPTAIN_PLUGIN_ID,
    method: "newCaptain",
  });
  const problems = newCaptainProblems(name, picked);
  const nameProblem = shown === "problems" ? problems.name : null;
  const reposProblem = shown === "problems" ? problems.repos : null;

  const toggle = (projectId: string, on: boolean) => {
    setPicked((current) =>
      on
        ? current.includes(projectId)
          ? current
          : [...current, projectId]
        : current.filter((id) => id !== projectId),
    );
  };

  const send = async (input: { name: string; repos: string[] }) => {
    try {
      const result = await start.mutate(input);
      if (result.ok) onStarted(result.threadId);
      else setRefusal(result.blockers.map((blocker) => `${blocker.reason}; ${blocker.fix}`));
    } catch (error) {
      setRefusal([error instanceof Error ? error.message : "Captain did not answer."]);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (start.isPending) return;
    setShown("problems");
    setRefusal([]);
    if (problems.name !== null || problems.repos !== null) return;
    void send({ name: name.trim(), repos: [...picked] });
  };

  return (
    <form className="flex min-w-0 flex-col gap-4" onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>New Captain</DialogTitle>
        <DialogDescription>
          A long-lived thread that directs crew threads across the repos you pick.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className="text-sm font-medium">
          Name
        </label>
        <Input
          id={nameId}
          value={name}
          autoComplete="off"
          placeholder="Plugins"
          aria-invalid={nameProblem !== null || undefined}
          aria-describedby={nameProblem === null ? undefined : nameErrorId}
          onChange={(event) => setName(event.target.value)}
        />
        {nameProblem === null ? null : (
          <p id={nameErrorId} className="text-xs text-destructive">
            {nameProblem}
          </p>
        )}
      </div>
      <fieldset
        className="flex min-w-0 flex-col gap-1.5"
        aria-describedby={reposProblem === null ? undefined : reposErrorId}
      >
        <legend id={reposId} className="mb-1.5 text-sm font-medium">
          Repos
        </legend>
        {repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bb projects to pick yet.</p>
        ) : (
          <ul
            aria-labelledby={reposId}
            className="flex max-h-56 flex-col overflow-y-auto rounded-md border"
          >
            {repos.map((repo) => (
              <RepoRow
                key={repo.id}
                repo={repo}
                checked={picked.includes(repo.id)}
                invalid={reposProblem !== null}
                onCheckedChange={toggle}
              />
            ))}
          </ul>
        )}
        {reposProblem === null ? null : (
          <p id={reposErrorId} className="text-xs text-destructive">
            {reposProblem}
          </p>
        )}
      </fieldset>
      {refusal.length === 0 ? null : (
        <div role="alert" className="flex flex-col gap-1 text-xs text-destructive">
          {refusal.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={start.isPending} aria-busy={start.isPending || undefined}>
          {start.isPending ? "Starting…" : "Start Captain"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RepoRow({
  repo,
  checked,
  invalid,
  onCheckedChange,
}: {
  repo: RepoChoice;
  checked: boolean;
  invalid: boolean;
  onCheckedChange: (projectId: string, checked: boolean) => void;
}) {
  const id = useId();
  return (
    <li className="border-t first:border-t-0">
      <label
        htmlFor={id}
        className={cn(
          "flex min-h-9 cursor-pointer items-center gap-2 px-3 text-sm",
          "pointer-coarse:min-h-11 hover:bg-accent",
        )}
      >
        <Checkbox
          id={id}
          checked={checked}
          aria-invalid={invalid || undefined}
          onCheckedChange={(state) => onCheckedChange(repo.id, state === true)}
        />
        <span className="min-w-0 flex-1 truncate">{repo.name}</span>
      </label>
    </li>
  );
}
