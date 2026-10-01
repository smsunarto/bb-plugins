import { useId, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Branch, BranchAction, PushMode } from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import { queryClient } from "./query-client.ts";
import { rpc, defined } from "./rpc.ts";
import { subject } from "./format.ts";

/**
 * The branch card's write side: rename on the name, and Push, Create PR, and
 * Land in a footer, as GitButler desktop puts them. Every action is one `but`
 * command; afterwards the whole cache is dropped, because a push, a land, or
 * a rename can change any branch, the base, and the history below it.
 */

export type WorkspaceTarget = { threadId: string; repositoryKey: string | undefined };

const ACTION = "h-6 gap-1 px-2 text-xs font-normal";
const FIELD =
  "w-full min-w-0 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function useBranchAction(target: WorkspaceTarget) {
  const mutation = rpc.branchAction.useMutation({
    onSettled: () => queryClient.invalidateQueries(),
  });
  return {
    run: (action: BranchAction, onDone?: () => void) =>
      mutation.mutate(defined({ ...target, action }), { onSuccess: () => onDone?.() }),
    pending: mutation.isPending,
    error: mutation.error,
    reset: mutation.reset,
  };
}

/**
 * The branch name, which is also its rename control: click it, type, and
 * Enter or leaving the field applies. Escape puts the old name back.
 */
export function BranchName({ target, name }: { target: WorkspaceTarget; name: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const action = useBranchAction(target);

  const commit = () => {
    const next = draft?.trim() ?? "";
    setDraft(null);
    if (next !== "" && next !== name) action.run({ kind: "rename", branch: name, name: next });
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {draft === null ? (
        <h3 className="m-0 flex min-w-0 text-[13px] font-semibold">
          <button
            type="button"
            className="min-w-0 truncate rounded-sm text-start hover:bg-state-hover disabled:opacity-60"
            title={`${name} (click to rename)`}
            aria-label={`Rename branch ${name}`}
            disabled={action.pending}
            onClick={() => {
              action.reset();
              setDraft(name);
            }}
          >
            {name}
          </button>
        </h3>
      ) : (
        <input
          // The user just asked to edit this field, so focus follows the click.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          className={cn(FIELD, "py-0.5 text-[13px] font-semibold")}
          aria-label={`New name for ${name}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.target.select()}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") setDraft(null);
          }}
        />
      )}
      {action.error ? (
        <p role="alert" className="mt-0.5 text-[11px] text-destructive-text">
          {action.error.message}
        </p>
      ) : null}
    </div>
  );
}

/** What a review starts with: GitButler's default of the lone commit's message, else the branch. */
function reviewDraft(branch: Branch): { title: string; body: string } {
  const only = branch.commits.length === 1 ? branch.commits[0] : undefined;
  if (!only) return { title: branch.name, body: "" };
  const newline = only.message.indexOf("\n");
  return {
    title: subject(only.message),
    body: newline === -1 ? "" : only.message.slice(newline + 1).trim(),
  };
}

function ReviewForm({
  branch,
  pending,
  onSubmit,
  onCancel,
}: {
  branch: Branch;
  pending: boolean;
  onSubmit: (review: { title: string; body: string; draft: boolean }) => void;
  onCancel: () => void;
}) {
  const initial = reviewDraft(branch);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [draft, setDraft] = useState(false);
  const draftId = useId();

  return (
    <form
      className="flex w-full flex-col gap-1.5"
      aria-label="Create PR"
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() !== "") onSubmit({ title: title.trim(), body, draft });
      }}
    >
      <input
        // The form opens in answer to "Create PR", so its first field takes focus.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        className={FIELD}
        aria-label="PR title"
        placeholder="Title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        className={cn(FIELD, "min-h-16 resize-y leading-normal")}
        aria-label="PR description"
        placeholder="Description"
        rows={3}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex items-center gap-1.5">
        <label
          htmlFor={draftId}
          className="me-auto flex items-center gap-1.5 text-muted-foreground"
        >
          <input
            id={draftId}
            type="checkbox"
            className="accent-primary"
            checked={draft}
            onChange={(event) => setDraft(event.target.checked)}
          />
          Draft
        </label>
        <Button type="button" variant="ghost" size="sm" className={ACTION} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className={ACTION}
          disabled={pending || title.trim() === ""}
        >
          <Pending pending={pending} />
          Create PR
        </Button>
      </div>
    </form>
  );
}

type Mode = "idle" | "review" | "land";

function Pending({ pending, icon }: { pending: boolean; icon?: string }) {
  if (pending) return <Icon name="Spinner" className="size-3 animate-spin" aria-hidden />;
  return icon ? <Icon name={icon} className="size-3" aria-hidden /> : null;
}

function ActionButton({
  icon,
  disabled,
  onClick,
  children,
}: {
  icon: string;
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <Button variant="outline" size="sm" className={ACTION} disabled={disabled} onClick={onClick}>
      <Icon name={icon} className="size-3" aria-hidden />
      {children}
    </Button>
  );
}

function PushButton({
  force,
  pending,
  onPush,
}: {
  force: boolean;
  pending: boolean;
  onPush: () => void;
}) {
  return (
    <Button variant="outline" size="sm" className={ACTION} disabled={pending} onClick={onPush}>
      <Pending pending={pending} icon="ArrowUp" />
      {/* Rewritten commits replace the remote branch, so the label says so. */}
      {force ? "Force push" : "Push"}
    </Button>
  );
}

/** Landing moves the target branch itself, so it is asked once more. */
function LandConfirm({
  name,
  pending,
  onLand,
  onCancel,
}: {
  name: string;
  pending: boolean;
  onLand: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <p className="me-auto min-w-0 text-muted-foreground">
        Land <span className="font-semibold text-foreground">{name}</span> straight onto the target,
        without a PR?
      </p>
      <Button variant="ghost" size="sm" className={ACTION} onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" className={ACTION} disabled={pending} onClick={onLand}>
        <Pending pending={pending} />
        Land
      </Button>
    </div>
  );
}

type Available = { push: PushMode; review: boolean; land: boolean };

/** Which buttons a branch gets. Integrated or empty branches have nothing to send. */
function availableFor(branch: Branch, landable: boolean): Available {
  const open = branch.commits.length > 0 && branch.status !== "integrated";
  return { push: branch.push, review: open && branch.reviewId === null, land: open && landable };
}

function ActionRow({
  available,
  pending,
  onPush,
  onChoose,
}: {
  available: Available;
  pending: boolean;
  onPush: () => void;
  onChoose: (mode: Mode) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {available.push === "none" ? null : (
        <PushButton force={available.push === "force"} pending={pending} onPush={onPush} />
      )}
      {available.review ? (
        <ActionButton icon="GitPullRequest" disabled={pending} onClick={() => onChoose("review")}>
          Create PR
        </ActionButton>
      ) : null}
      {available.land ? (
        <ActionButton icon="GitMerge" disabled={pending} onClick={() => onChoose("land")}>
          Land
        </ActionButton>
      ) : null}
    </div>
  );
}

/**
 * The footer under a branch header. Draws nothing when there is nothing to
 * do, so an integrated or empty branch keeps the plain card.
 */
export function BranchActions({
  target,
  branch,
  landable,
}: {
  target: WorkspaceTarget;
  branch: Branch;
  /** `but land` refuses a branch with other branches below it in its stack. */
  landable: boolean;
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const action = useBranchAction(target);
  const available = availableFor(branch, landable);
  const nothing = available.push === "none" && !available.review && !available.land;
  if (nothing && !action.error) return null;

  const choose = (next: Mode) => {
    action.reset();
    setMode(next);
  };
  const idle = () => setMode("idle");

  return (
    <div className="flex flex-col gap-1.5 border-t border-border bg-secondary/40 px-2.5 py-2">
      {mode === "review" ? (
        <ReviewForm
          branch={branch}
          pending={action.pending}
          onCancel={() => choose("idle")}
          onSubmit={(review) =>
            action.run({ kind: "createReview", branch: branch.name, ...review }, idle)
          }
        />
      ) : null}
      {mode === "land" ? (
        <LandConfirm
          name={branch.name}
          pending={action.pending}
          onCancel={() => choose("idle")}
          onLand={() => action.run({ kind: "land", branch: branch.name }, idle)}
        />
      ) : null}
      {mode === "idle" ? (
        <ActionRow
          available={available}
          pending={action.pending}
          onChoose={choose}
          onPush={() =>
            action.run({ kind: "push", branch: branch.name, force: available.push === "force" })
          }
        />
      ) : null}
      {action.error ? (
        <p role="alert" className="text-[11px] leading-normal text-destructive-text">
          {action.error.message}
        </p>
      ) : null}
    </div>
  );
}
