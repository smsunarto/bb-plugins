/**
 * Commit from the tab: the uncommitted files the reader sees, onto a branch
 * of the checkout, with their message. The host commits exactly those paths
 * while the branch is still at the head the reader saw; anything else
 * uncommitted stays. Plain git commits onto its checked-out branch only.
 */
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { Branch, FileChange, Revision, VcsAction } from "../core/change.ts";
import { useEscapeLayer } from "./escape.ts";
import { useHostGate } from "./host-gate.ts";
import { plural } from "./format.ts";
import type { Dispatch } from "./branch-actions.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { Pending } from "./ui.tsx";

/**
 * Opening moves focus to the message; closing returns it to Commit. Escape
 * inside the form closes it, and the page stays.
 */
function useCommitFocus(open: boolean, setOpen: (open: boolean) => void) {
  const field = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const wasOpen = useRef(false);
  useEscapeLayer(form, () => setOpen(false), { open });
  useEffect(() => {
    if (open) field.current?.focus();
    else if (wasOpen.current) opener.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return { field, opener, form };
}

export function CommitControl({
  changes,
  more,
  branches,
  preferred,
  targetHead,
  running,
  busy,
  dispatch,
}: {
  changes: readonly FileChange[];
  /** Uncommitted files past the listed ones, which stay uncommitted. */
  more: number;
  /** The branches a commit may go onto. */
  branches: readonly Branch[];
  /** The thread's own branch, chosen first when it is one of them. */
  preferred: string | null;
  targetHead: string | null;
  running: ReadonlyMap<string, VcsAction["kind"]>;
  busy: boolean;
  dispatch: Dispatch;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const id = useId();
  const { field, opener, form } = useCommitFocus(open, setOpen);
  const fallback = branches.find((branch) => branch.name === preferred) ?? branches[0];
  const branch = branches.find((each) => each.name === chosen) ?? fallback;
  const pending = [...running.values()].includes("commit");
  const gate = useHostGate();
  if (!branch || changes.length === 0) return null;
  if (!open)
    return (
      <CommitOpener
        opener={opener}
        files={changes.length}
        pending={pending}
        off={busy || gate !== null}
        gate={gate}
        onOpen={() => setOpen(true)}
      />
    );
  const canSend = message.trim() !== "" && !busy && gate === null;
  const send = () => {
    const seen: Revision = { head: branch.head, target: targetHead };
    dispatch.send(
      {
        kind: "commit",
        branch: branch.name,
        message: message.trim(),
        paths: changes.map((change) => change.path),
      },
      seen,
    );
    setOpen(false);
    setMessage("");
  };
  return (
    <form
      ref={form}
      className="flex min-w-0 flex-col gap-2 border-t border-border-hairline px-3 py-2"
      aria-label="Commit uncommitted changes"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) send();
      }}
    >
      <label htmlFor={`${id}-message`} className="text-[12px] leading-4 text-muted-foreground">
        Commit message
      </label>
      <Textarea
        id={`${id}-message`}
        data-testid="sc-commit-message"
        ref={field}
        rows={3}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        className="min-h-0 w-full min-w-0 resize-y border-border-hairline bg-background px-2 py-1 text-[12px] leading-normal"
      />
      {branches.length > 1 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[12px] leading-4 text-muted-foreground">
          <span id={`${id}-branch`}>Onto</span>
          <Select value={branch.name} onValueChange={setChosen}>
            <SelectTrigger
              aria-labelledby={`${id}-branch`}
              data-testid="sc-commit-branch"
              className="max-w-full border-border-hairline bg-background"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {branches.map((each) => (
                <SelectItem key={each.name} value={each.name}>
                  {each.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <p className="m-0 text-[12px] leading-4 text-muted-foreground">
        Commits the {plural(changes.length, "file")} listed onto{" "}
        <span className="font-mono text-foreground">{branch.name}</span>
        {more > 0 ? `; ${plural(more, "more file")} stay uncommitted.` : "."}
      </p>
      <div className="flex min-w-0 flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="default"
          data-host-bound="commit"
          data-testid="sc-commit-confirm"
          title={gate ?? undefined}
          disabled={!canSend}
        >
          Commit
        </Button>
      </div>
    </form>
  );
}

/** Commit, closed: the button that opens the form. */
function CommitOpener({
  opener,
  files,
  pending,
  off,
  gate,
  onOpen,
}: {
  opener: RefObject<HTMLButtonElement | null>;
  files: number;
  pending: boolean;
  off: boolean;
  gate: string | null;
  onOpen: () => void;
}) {
  return (
    // A disabled button takes no hover, so the reason sits on the row.
    <div
      className="flex min-w-0 border-t border-border-hairline px-3 py-2"
      title={gate ?? undefined}
    >
      <Button
        variant="outline"
        ref={opener}
        disabled={off}
        data-host-bound="commit"
        data-testid="sc-commit-open"
        aria-label={`Commit ${plural(files, "file")}`}
        onClick={onOpen}
      >
        <Pending pending={pending} icon="Check" />
        Commit
      </Button>
    </div>
  );
}
