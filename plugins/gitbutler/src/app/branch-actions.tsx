import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { branchNameSchema } from "../shared/schema.ts";
import type {
  ActionRisk,
  Branch,
  ButAction,
  ButActionResult,
  PushMode,
  ReviewRequest,
} from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { upstreamLoss } from "../shared/upstream-loss.ts";
import { cn } from "./lib/utils.ts";
import { rpc } from "./rpc.ts";

/**
 * The branch card's write side: rename on the name, and Pull, Push, Create PR,
 * Land, and Delete in a footer, as GitButler desktop puts them. Each runs `but`
 * on the host; afterwards the whole cache is dropped, because any of them can
 * change every branch, the base, and the history below it. Create PR hands
 * the branch to a subthread instead.
 */

export type WorkspaceTarget = { threadId: string; repositoryKey: string | undefined };

const ACTION = "h-6 gap-1 px-2 text-xs font-normal";
const FIELD =
  "w-full min-w-0 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * A request disables the button that started it, and a browser then drops the
 * focus to the page. When the request ends with nothing focused, the focus
 * comes back to `target()`, so a keyboard reader keeps their place.
 */
export function useFocusAfter(busy: boolean, target: () => HTMLElement | null | undefined) {
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    if (document.activeElement === null || document.activeElement === document.body) {
      target()?.focus();
    }
  });
}

/**
 * A card footer that takes the focus back after a request: to the first
 * button left, since a Pull that worked takes its own away, or to Cancel when
 * a confirmation stays open.
 */
function useFooterFocus(...busy: boolean[]) {
  const footer = useRef<HTMLDivElement>(null);
  useFocusAfter(busy.some(Boolean), () =>
    footer.current?.querySelector<HTMLButtonElement>("button:not(:disabled)"),
  );
  return footer;
}

/** Runs `but` writes for the card or the header. One request at a time per caller. */
export function useButAction(target: WorkspaceTarget) {
  const mutation = rpc.butAction.useMutation({
    onSettled: () => pluginQueryClient.invalidateQueries(),
  });
  // A request about another repository is not this one's to show, even
  // while it is still running after the reader switched.
  const sent = mutation.variables;
  const mine = sent?.threadId === target.threadId && sent.repositoryKey === target.repositoryKey;
  return {
    run: (action: ButAction, onResult?: (result: ButActionResult) => void) =>
      mutation.mutate({ ...target, action }, { onSuccess: (result) => onResult?.(result) }),
    pending: mine && mutation.isPending,
    /** Which kind of request is in flight, so only its own button spins. */
    running: mine && mutation.isPending ? (sent?.action.kind ?? null) : null,
    error: mine ? mutation.error : null,
    reset: mutation.reset,
  };
}

/**
 * The branch name, which is also its rename control: click it, type, and
 * Enter or leaving the field applies. Escape puts the old name back. A name
 * `but` would refuse keeps the field open with the typed text in it.
 */
export function BranchName({ target, name }: { target: WorkspaceTarget; name: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  // Closed with Enter or Escape, so the name takes the focus back. A click
  // elsewhere leaves the focus where it went.
  const [closedByKey, setClosedByKey] = useState(false);
  const hintId = useId();
  const action = useButAction(target);

  const next = draft?.trim() ?? "";
  const changed = next !== "" && next !== name;
  const problem = changed ? branchNameSchema.safeParse(next).error?.issues[0]?.message : undefined;
  const acceptable = problem === undefined;

  const commit = () => {
    if (!acceptable) {
      setInvalid(true);
      return;
    }
    setDraft(null);
    if (changed) action.run({ kind: "rename", branch: name, name: next });
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {draft === null ? (
        <h3 className="m-0 flex min-w-0 text-sm font-semibold">
          <button
            type="button"
            className="-mx-1 min-w-0 cursor-pointer truncate rounded-sm px-1 text-start hover:bg-state-hover disabled:opacity-60"
            title={`${name} (click to rename)`}
            aria-label={`Rename branch ${name}`}
            disabled={action.pending}
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus={closedByKey}
            onClick={() => {
              action.reset();
              setClosedByKey(false);
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
          className={cn(FIELD, "py-0.5 text-sm font-semibold")}
          aria-label={`New name for ${name}`}
          aria-invalid={invalid}
          aria-describedby={invalid ? hintId : undefined}
          value={draft}
          onChange={(event) => {
            setInvalid(false);
            setDraft(event.target.value);
          }}
          onFocus={(event) => event.target.select()}
          onBlur={commit}
          onKeyDown={(event) => {
            // Enter applies by leaving the field, so a refused name keeps focus.
            if (event.key === "Enter") {
              if (acceptable) {
                setClosedByKey(true);
                event.currentTarget.blur();
              } else setInvalid(true);
            }
            if (event.key === "Escape") {
              setClosedByKey(true);
              setInvalid(false);
              setDraft(null);
            }
          }}
        />
      )}
      {draft !== null && invalid ? (
        <p id={hintId} role="alert" className="mt-0.5 text-[11px] text-destructive-text">
          {problem}
        </p>
      ) : null}
      {action.error ? (
        <p role="alert" className="mt-0.5 text-[11px] text-destructive-text">
          {action.error.message}
        </p>
      ) : null}
    </div>
  );
}

const REVIEW_POLL_MS = 5_000;

/**
 * Create PR is the agent's job, not a form's: a subthread reads the branch,
 * writes the description, and runs `but pr new`. Which subthread belongs to
 * which branch lives on the server, so the card finds it again after the
 * panel remounts or the repository changes.
 */
function useReviewRequest(target: WorkspaceTarget, branch: string) {
  const requests = rpc.reviewRequests.useQuery(target, {
    // Poll only while a subthread works, so the card sees it finish.
    refetchInterval: (query) =>
      query.state.data?.requests.some((request) => request.running) ? REVIEW_POLL_MS : false,
  });
  const mutation = rpc.requestReview.useMutation({
    onSettled: () => pluginQueryClient.invalidateQueries(),
  });
  return {
    request: () => mutation.mutate({ ...target, branch }),
    pending: mutation.isPending,
    current: requests.data?.requests.find((request) => request.branch === branch) ?? null,
    error: mutation.error,
    reset: mutation.reset,
  };
}

function ReviewStatus({ request }: { request: ReviewRequest }) {
  const navigate = useBbNavigate();
  return (
    // `output` is the native polite live region, so the hand-off is announced.
    <output className="flex items-center gap-1.5 text-muted-foreground">
      <Icon name="GitPullRequest" className="size-3 shrink-0" aria-hidden />
      <span className="me-auto">
        {request.running
          ? "A subthread is writing and opening the PR."
          : "The PR subthread stopped without opening a PR."}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className={ACTION}
        onClick={() => navigate.toThread(request.threadId)}
      >
        Open subthread
      </Button>
    </output>
  );
}

/**
 * The footer's state: its buttons, or a confirmation. Pull asks only when the
 * host found a risk. Delete always asks, and asks again with `risk` when the
 * host found one.
 */
type Mode =
  | { kind: "idle" }
  | { kind: "land" }
  | { kind: "push" }
  | { kind: "delete"; risk: ActionRisk | null }
  | { kind: "pull"; risk: ActionRisk };
type ModeKind = Mode["kind"];

const IDLE: Mode = { kind: "idle" };

/** The question a write's host answered with, about what it found. */
function askAbout(action: ButAction, risk: ActionRisk): Mode {
  return action.kind === "delete" ? { kind: "delete", risk } : { kind: "pull", risk };
}

/** Tells one question from the next, even of the same kind. */
function questionKey(mode: Mode): string {
  return "risk" in mode ? `${mode.kind}:${JSON.stringify(mode.risk)}` : mode.kind;
}

function Pending({ pending, icon }: { pending: boolean; icon?: string }) {
  if (pending) return <Icon name="Spinner" className="size-3 animate-spin" aria-hidden />;
  return icon ? <Icon name={icon} className="size-3" aria-hidden /> : null;
}

function ActionButton({
  icon,
  busy = false,
  disabled,
  takeFocus = false,
  className,
  onClick,
  children,
}: {
  icon: string;
  /** This button's own request is in flight, so its icon spins. */
  busy?: boolean;
  disabled: boolean;
  /** Set only on the way back from a confirmation this button opened. */
  takeFocus?: boolean;
  className?: string;
  onClick: () => void;
  children: string;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(ACTION, className)}
      disabled={disabled}
      // oxlint-disable-next-line jsx-a11y/no-autofocus
      autoFocus={takeFocus}
      onClick={onClick}
    >
      <Pending pending={busy} icon={icon} />
      {children}
    </Button>
  );
}

/**
 * Asked once more before a change that is hard to take back. Focus starts on
 * Cancel, and Escape cancels. Once confirmed, the request runs to the end:
 * backing out then would only hide it.
 */
export function Confirm({
  prompt,
  label,
  pending,
  destructive = false,
  onConfirm,
  onCancel,
}: {
  prompt: ReactNode;
  label: string;
  pending: boolean;
  /** The answer deletes work, so it wears the destructive colour. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    // Escape from either button inside cancels.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="flex flex-wrap items-center gap-1.5"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) onCancel();
      }}
    >
      <p className="me-auto min-w-0 text-muted-foreground">{prompt}</p>
      {/* One unit, so a long prompt never wraps Cancel apart from its answer. */}
      <div className="flex shrink-0 gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className={ACTION}
          disabled={pending}
          // The safe answer takes focus, so a stray Enter cancels.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          variant={destructive ? "destructive" : "default"}
          className={ACTION}
          disabled={pending}
          onClick={onConfirm}
        >
          <Pending pending={pending} />
          {label}
        </Button>
      </div>
    </div>
  );
}

/**
 * What a pull would also do, said before it runs. `branch` is the pulled
 * branch, or none for the whole workspace.
 */
export function pullRiskPrompt(
  { conflicted, overlapsUncommitted }: ActionRisk,
  branch?: string,
): ReactNode {
  const name = branch ? <span className="font-semibold text-foreground">{branch}</span> : null;
  // Conflicted commits block a push. Markers in uncommitted files only need
  // resolving, which the panel's notice says once they are there.
  return (
    <>
      {conflicted.length > 0 ? (
        <>
          Pulling{name ? <> {name}</> : null} leaves conflicted commits in {listNames(conflicted)}.
          Resolve them before pushing.
        </>
      ) : null}
      {conflicted.length > 0 && overlapsUncommitted ? " " : null}
      {overlapsUncommitted ? (
        <>
          Your uncommitted changes touch files the incoming commits change, so conflict markers can
          get written into them.
        </>
      ) : null}
    </>
  );
}

/** "a", "a and b", "a, b, and c": branch names inside a sentence. */
export function listNames(names: readonly string[]): ReactNode {
  const shown = names.map((name) => (
    <span key={name} className="font-semibold text-foreground">
      {name}
    </span>
  ));
  if (shown.length <= 2) return shown.flatMap((name, index) => (index ? [" and ", name] : [name]));
  return shown.flatMap((name, index) =>
    index === 0 ? [name] : index === shown.length - 1 ? [", and ", name] : [", ", name],
  );
}

/** Statuses whose commits the remote already has, so a delete loses nothing it lacks. */
const ON_REMOTE: ReadonlySet<Branch["status"]> = new Set(["pushed", "behind", "integrated"]);

/** What deleting a branch loses, from how much of it the remote already has. */
function deleteLoss(branch: Branch): string {
  const count = branch.commits.length;
  if (count === 0) return "It has no commits.";
  const one = count === 1;
  const its = one ? "Its commit" : `Its ${count} commits`;
  if (branch.status === "unpushed") {
    return `${its} ${one ? "was" : "were"} never pushed, so only GitButler's undo history keeps ${one ? "it" : "them"} afterwards.`;
  }
  const leave = `${its} ${one ? "leaves" : "leave"} the workspace`;
  return ON_REMOTE.has(branch.status)
    ? `${leave}.`
    : `${leave}, and any not yet pushed stay only in GitButler's undo history.`;
}

/**
 * What deleting a branch costs. `but branch delete` drops the local branch
 * and its commits, rebases the branches above it, and never touches the
 * remote or a PR.
 */
function deletePrompt(branch: Branch, branchesAbove: number): ReactNode {
  const remote = branch.status === "unpushed" ? "" : " The remote branch and any PR stay.";
  const above =
    branchesAbove === 0
      ? ""
      : branchesAbove === 1
        ? " The branch above it moves down onto the base."
        : ` The ${branchesAbove} branches above it move down onto the base.`;
  return (
    <>
      Delete <span className="font-semibold text-foreground">{branch.name}</span>?{" "}
      {deleteLoss(branch)}
      {remote}
      {above}
    </>
  );
}

/** What each confirmation asks, and what its second click runs. */
function confirmationFor(
  mode: Exclude<Mode, { kind: "idle" }>,
  branch: Branch,
  /** New upstream commits the push deletes, and the ids it agrees to on confirming. */
  lost: { count: number; commits: string[] },
  force: boolean,
  branchesAbove: number,
): { prompt: ReactNode; label: string; action: ButAction; destructive: boolean } {
  const name = <span className="font-semibold text-foreground">{branch.name}</span>;
  switch (mode.kind) {
    case "land":
      return {
        prompt: (
          <>
            Land {name} on the target branch? This pushes it to the remote without a PR and can't
            easily be undone.
          </>
        ),
        label: "Land",
        action: { kind: "land", branch: branch.name },
        destructive: false,
      };
    case "delete":
      return {
        prompt: mode.risk ? (
          <>
            Your uncommitted changes touch files {name} changed, so deleting it can write conflict
            markers into them.
          </>
        ) : (
          deletePrompt(branch, branchesAbove)
        ),
        label: mode.risk ? "Delete anyway" : "Delete",
        action: { kind: "delete", branch: branch.name, accepted: mode.risk },
        destructive: true,
      };
    case "pull":
      return {
        prompt: pullRiskPrompt(mode.risk, branch.name),
        label: "Pull anyway",
        action: { kind: "pull", branch: branch.name, accepted: mode.risk },
        destructive: false,
      };
    case "push": {
      const label = force ? "Force push" : "Push";
      return {
        prompt: (
          <>
            {label} {name}? This deletes{" "}
            {lost.count === 1 ? "the upstream commit" : `the ${lost.count} upstream commits`} shown
            in this stack from the remote.
          </>
        ),
        label,
        action: { kind: "push", branch: branch.name, force, acceptedLoss: lost.commits },
        destructive: false,
      };
    }
  }
}

/** The new upstream commits a push deletes: how many, and which by id. */
function pushRisk(pushedWith: readonly Branch[]): { count: number; commits: string[] } {
  return {
    count: pushedWith.reduce((total, entry) => total + entry.newUpstream, 0),
    commits: upstreamLoss(pushedWith),
  };
}

type Available = { pull: boolean; push: PushMode; review: boolean; land: boolean };

/**
 * Which sending buttons a branch gets. Integrated or empty branches have
 * nothing to send. `but` refuses to push a conflicted commit, here or in a
 * branch below that the push takes along, and Create PR and Land both push.
 * The commit rows already mark the conflict.
 */
function availableFor(branch: Branch, landable: boolean, pushedWith: readonly Branch[]): Available {
  const open = branch.commits.length > 0 && branch.status !== "integrated";
  const conflicted = pushedWith.some((entry) => entry.commits.some((commit) => commit.conflicted));
  return {
    pull: branch.newUpstream > 0,
    push: conflicted ? "none" : branch.push,
    review: open && branch.reviewId === null && !conflicted,
    land: open && landable && !conflicted,
  };
}

function ActionRow({
  branch,
  available,
  running,
  requesting,
  refocus,
  onPull,
  onPush,
  onReview,
  onLand,
  onDelete,
}: {
  branch: string;
  available: Available;
  running: ButAction["kind"] | null;
  requesting: boolean;
  /** The confirmation just cancelled, whose button takes the focus back. */
  refocus: ModeKind;
  onPull: () => void;
  onPush: () => void;
  onReview: () => void;
  onLand: () => void;
  onDelete: () => void;
}) {
  const busy = running !== null || requesting;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* First: on a branch behind its remote, pulling is the safe way forward. */}
      {available.pull ? (
        <ActionButton
          icon="ArrowDown"
          busy={running === "pull"}
          disabled={busy}
          takeFocus={refocus === "pull"}
          onClick={onPull}
        >
          Pull
        </ActionButton>
      ) : null}
      {available.push === "none" ? null : (
        <ActionButton
          icon="ArrowUp"
          busy={running === "push"}
          disabled={busy}
          takeFocus={refocus === "push"}
          onClick={onPush}
        >
          {/* Rewritten commits replace the remote branch, so the label says so. */}
          {available.push === "force" ? "Force push" : "Push"}
        </ActionButton>
      )}
      {available.review ? (
        <ActionButton icon="GitPullRequest" busy={requesting} disabled={busy} onClick={onReview}>
          Create PR
        </ActionButton>
      ) : null}
      {available.land ? (
        <ActionButton
          icon="GitMerge"
          busy={running === "land"}
          disabled={busy}
          takeFocus={refocus === "land"}
          onClick={onLand}
        >
          Land
        </ActionButton>
      ) : null}
      {/* Apart from the rest and quiet, so it is never the button a hand drifts to. */}
      <Button
        variant="ghost"
        size="sm"
        className={cn(ACTION, "ms-auto text-muted-foreground hover:text-destructive-text")}
        disabled={busy}
        aria-label={`Delete ${branch}`}
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={refocus === "delete"}
        onClick={onDelete}
      >
        <Pending pending={running === "delete"} icon="Trash2" />
        Delete
      </Button>
    </div>
  );
}

/** Said under the buttons when a pull found nothing new on the remote. */
function UpToDate() {
  return <output className="text-[11px] text-muted-foreground">Already up to date.</output>;
}

/**
 * The footer under a branch header. Every branch can at least be deleted,
 * so every card has one.
 */
export function BranchActions({
  target,
  branch,
  landable,
  pushedWith,
  branchesAbove,
}: {
  target: WorkspaceTarget;
  branch: Branch;
  /** `but land` refuses a branch with other branches below it in its stack. */
  landable: boolean;
  /**
   * This branch and every branch below it. `but push` forces them all, so a
   * push deletes the new upstream commits of each.
   */
  pushedWith: readonly Branch[];
  /** Branches stacked on this one, which a delete moves down onto the base. */
  branchesAbove: number;
}) {
  const [mode, setMode] = useState<Mode>(IDLE);
  const [refocus, setRefocus] = useState<ModeKind>("idle");
  const [upToDate, setUpToDate] = useState(false);
  // For one render only: the button takes the focus as it mounts, and a poll
  // that later drops and restores it must not pull the focus there again.
  useEffect(() => {
    if (refocus !== "idle") setRefocus("idle");
  }, [refocus]);
  const action = useButAction(target);
  const review = useReviewRequest(target, branch.name);
  const footer = useFooterFocus(action.pending, review.pending);
  const available = availableFor(branch, landable, pushedWith);

  const choose = (next: Mode) => {
    action.reset();
    review.reset();
    setUpToDate(false);
    // Back from a confirmation, focus returns to the button that opened it.
    setRefocus(next.kind === "idle" ? mode.kind : "idle");
    setMode(next);
  };
  const run = (next: ButAction) => {
    review.reset();
    setUpToDate(false);
    action.run(next, (result) => {
      if (result.status === "confirm") {
        setMode(askAbout(next, result.risk));
        return;
      }
      setUpToDate(result.status === "upToDate");
      setMode(IDLE);
    });
  };
  const error = action.error ?? review.error;
  const force = available.push === "force";
  /*
   * `but push` forces by default, with or without `--with-force`, and takes
   * the branches below along. A push that only replaces the stack's own old
   * commits goes straight out. One that would delete commits nobody has here
   * asks first, whichever button started it. The confirmation agrees to them
   * by id, so a remote rewritten since asks again.
   */
  const atRisk = pushRisk(pushedWith);
  const asksFirst = atRisk.count > 0;
  const confirmation =
    mode.kind === "idle" ? null : confirmationFor(mode, branch, atRisk, force, branchesAbove);

  return (
    <div
      ref={footer}
      className="flex flex-col gap-1.5 border-t border-border bg-secondary/40 px-2.5 py-2"
    >
      {confirmation ? (
        <Confirm
          // A new question mounts afresh, so focus starts on its Cancel, not
          // on the button that was just clicked and now answers something else.
          key={questionKey(mode)}
          prompt={confirmation.prompt}
          label={confirmation.label}
          pending={action.pending}
          destructive={confirmation.destructive}
          onCancel={() => choose(IDLE)}
          onConfirm={() => run(confirmation.action)}
        />
      ) : (
        <ActionRow
          branch={branch.name}
          // While a subthread writes this PR, a second click would start another.
          available={{ ...available, review: available.review && !review.current?.running }}
          running={action.running}
          requesting={review.pending}
          refocus={refocus}
          onPull={() => run({ kind: "pull", branch: branch.name, accepted: null })}
          onLand={() => choose({ kind: "land" })}
          onDelete={() => choose({ kind: "delete", risk: null })}
          onReview={() => {
            action.reset();
            setUpToDate(false);
            review.request();
          }}
          onPush={() =>
            asksFirst
              ? choose({ kind: "push" })
              : run({ kind: "push", branch: branch.name, force, acceptedLoss: [] })
          }
        />
      )}
      {upToDate && !confirmation ? <UpToDate /> : null}
      {/* Once the PR exists the card shows it, so a finished subthread drops out. */}
      {review.current && (review.current.running || branch.reviewId === null) ? (
        <ReviewStatus request={review.current} />
      ) : null}
      {error ? (
        <p role="alert" className="text-[11px] leading-normal text-destructive-text">
          {error.message}
        </p>
      ) : null}
    </div>
  );
}
