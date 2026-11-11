/**
 * Commit from the tab: the uncommitted files the reader sees, onto a branch
 * of the checkout, with their message. The host commits exactly those paths
 * while the branch is still at the head the reader saw; anything else
 * uncommitted stays. Plain git commits onto its checked-out branch only.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { Branch, FileChange, Revision, VcsAction } from "../core/change.ts";
import { plural } from "./format.ts";
import type { Dispatch } from "./branch-actions.tsx";
import { Button, Pending } from "./ui.tsx";

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
  const field = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Opening moves focus to the message; closing returns it to Commit.
  useEffect(() => {
    if (open) field.current?.focus();
    else if (wasOpen.current) opener.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const fallback = branches.find((branch) => branch.name === preferred) ?? branches[0];
  const branch = branches.find((each) => each.name === chosen) ?? fallback;
  const pending = [...running.values()].includes("commit");
  if (!branch || changes.length === 0) return null;
  if (!open)
    return (
      <div className="flex min-w-0 border-t border-border-hairline px-3 py-2">
        <Button
          ref={opener}
          disabled={busy}
          data-testid="sc-commit-open"
          aria-label={`Commit ${plural(changes.length, "file")}`}
          onClick={() => setOpen(true)}
        >
          <Pending pending={pending} icon="GitCommitHorizontal" />
          Commit
        </Button>
      </div>
    );
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
      className="flex min-w-0 flex-col gap-2 border-t border-border-hairline px-3 py-2"
      aria-label="Commit uncommitted changes"
      onSubmit={(event) => {
        event.preventDefault();
        if (message.trim() && !busy) send();
      }}
    >
      <label htmlFor={`${id}-message`} className="text-[12px] leading-4 text-muted-foreground">
        Commit message
      </label>
      <textarea
        id={`${id}-message`}
        data-testid="sc-commit-message"
        ref={field}
        rows={3}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        className="w-full min-w-0 resize-y rounded-[6px] border border-border-hairline bg-background px-2 py-1 text-[12px] leading-normal text-foreground focus-visible:outline-1"
      />
      {branches.length > 1 ? (
        <label className="flex min-w-0 flex-wrap items-center gap-2 text-[12px] leading-4 text-muted-foreground">
          Onto
          <select
            data-testid="sc-commit-branch"
            value={branch.name}
            onChange={(event) => setChosen(event.target.value)}
            className="h-7 min-w-0 max-w-full rounded-[6px] border border-border-hairline bg-background px-2 text-[12px] text-foreground"
          >
            {branches.map((each) => (
              <option key={each.name} value={each.name}>
                {each.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p className="m-0 text-[12px] leading-4 text-muted-foreground">
        Commits the {plural(changes.length, "file")} listed onto{" "}
        <span className="font-mono text-foreground">{branch.name}</span>
        {more > 0 ? `; ${plural(more, "more file")} stay uncommitted.` : "."}
      </p>
      <div className="flex min-w-0 flex-wrap justify-end gap-2">
        <Button onClick={() => setOpen(false)}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          data-testid="sc-commit-confirm"
          disabled={busy || !message.trim()}
        >
          Commit
        </Button>
      </div>
    </form>
  );
}
