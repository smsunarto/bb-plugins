import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Query, QueryKey } from "@tanstack/react-query";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { branchNameSchema } from "../shared/schema.ts";
import type {
  ActionRisk,
  Branch,
  ButAction,
  ButActionResult,
  PatchSource,
  PushMode,
  ReviewRequest,
} from "../shared/schema.ts";
import {
  butWriteKey,
  useAnnounce,
  useLastWriteFailure,
  useBoardLive,
  useBoardWorkspace,
  useFocusAfterWrite,
  useWriteBusy,
  sameScope,
  writeScope,
} from "./board-context.tsx";
import type { WorkspaceIdentity, WriteFailure, WriteScope } from "./board-context.tsx";
import { Button } from "./components/ui/button.tsx";
import { upstreamLoss } from "../shared/upstream-loss.ts";
import { squashMessage } from "./format.ts";
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

/**
 * Where a write goes. `workspace` is the board's, which a caller inside the
 * board leaves out and a caller above it, such as the header's Pull, passes.
 */
export type WriteTarget = WorkspaceTarget & { workspace?: WorkspaceIdentity | null };

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

/** Whether a cached read is `method`'s answer for this thread. */
function readOf(method: { queryKey: () => QueryKey }, threadId: string) {
  const [name] = method.queryKey();
  return (query: Query) =>
    query.queryKey[0] === name &&
    (query.queryKey[1] as { threadId?: unknown } | undefined)?.threadId === threadId;
}

/**
 * Fetch again what a write or an agent's turn can change: the board, the
 * worktree's diff, the subthreads working on it, its reviews, its parked
 * branches, and the operation log. Diffs and history are keyed by commit id,
 * which a write cannot change, so open commits are not fetched again. The
 * promise is the board's, so a request's spinner ends when the board shows
 * its result and not a moment before.
 */
export function refreshWorkspace(threadId: string): Promise<void> {
  const uncommitted = readOf(rpc.patches, threadId);
  void pluginQueryClient.invalidateQueries({
    predicate: (query) =>
      uncommitted(query) &&
      (query.queryKey[1] as { source?: PatchSource }).source?.kind === "uncommitted",
  });
  for (const method of [
    rpc.reviewRequests,
    rpc.conflictResolution,
    rpc.reviews,
    rpc.parkedBranches,
    rpc.oplog,
  ]) {
    void pluginQueryClient.invalidateQueries({ predicate: readOf(method, threadId) });
  }
  return pluginQueryClient.invalidateQueries({ predicate: readOf(rpc.workspace, threadId) });
}

/** What the status line says once a card's write is through. The header's Pull says its own. */
function outcomeLine(action: ButAction, result: ButActionResult): string | null {
  if (action.kind === "updateWorkspace" || result.status === "confirm") return null;
  if (result.status === "upToDate") return "Already up to date.";
  switch (action.kind) {
    case "push":
      return `Pushed ${action.branch}`;
    case "land":
      return action.message === null
        ? `Landed ${action.branch}`
        : `Squashed and landed ${action.branch}`;
    case "rename":
      return `Renamed to ${action.name}`;
    case "delete":
      return `Deleted ${action.branch}`;
    case "pull":
      return `Pulled ${action.branch}`;
  }
}

/**
 * Why no write can start on a board now, or null. A board from storage that
 * has not been read again may be hours old, and writes to one workspace run
 * one at a time.
 */
export function writeBlocked(live: boolean, otherWrite: boolean): string | null {
  if (!live) return "Checking the workspace…";
  return otherWrite ? "Another GitButler action is running" : null;
}

/**
 * Runs `but` writes for the card or the header. Writes to one workspace
 * rewrite the same branches, so they share one mutation key and run one at
 * a time: `blocked` says why a caller can't start one now.
 *
 * `onSettled` hears every request this caller started, once the board shows
 * its result. `run`'s callback does not when the reader switched repository
 * while it ran: that changes the mutation key, and TanStack drops it.
 */
export function useButAction(
  target: WriteTarget,
  onSettled?: (result: ButActionResult | undefined, error: Error | null, sent: WriteScope) => void,
) {
  const live = useBoardLive();
  const board = useBoardWorkspace();
  const workspace = target.workspace === undefined ? board : target.workspace;
  const scope = { ...target, workspace };
  const busy = useWriteBusy(scope);
  const lastFailure = useLastWriteFailure(scope);
  // The failure this caller already answered, which it no longer shows.
  const [cleared, setCleared] = useState<number | null>(null);
  const announce = useAnnounce();
  const focusAfterWrite = useFocusAfterWrite();
  const mutation = rpc.butAction.useMutation({
    mutationKey: butWriteKey(scope),
    // Reported here, once the board shows the result, and not in `run`'s
    // callback: Delete and Land take the card, and that callback, away first.
    onSettled: async (result, error, sent) => {
      await refreshWorkspace(target.threadId);
      onSettled?.(result, error, sent);
      if (!result) return;
      const { action } = sent;
      if (result.status === "done" && (action.kind === "delete" || action.kind === "land")) {
        focusAfterWrite("removed", action.branch);
      }
      if (result.status === "done" && action.kind === "rename") {
        focusAfterWrite("renamed", action.name);
      }
      const line = outcomeLine(action, result);
      if (line !== null) announce(line);
    },
  });
  // A request about another repository is not this one's to show, even
  // while it is still running after the reader switched.
  const aim = writeScope(target, workspace);
  const sent = mutation.variables;
  const mine = sent !== undefined && sameScope(sent, aim);
  const pending = mine && mutation.isPending;
  return {
    run: (action: ButAction, onResult?: (result: ButActionResult) => void, onError?: () => void) =>
      mutation.mutate(
        { ...aim, action },
        { onSuccess: (result) => onResult?.(result), onError: () => onError?.() },
      ),
    pending,
    /** Which kind of request is in flight, so only its own button spins. */
    running: pending ? (sent?.action.kind ?? null) : null,
    /** Why no write can start here now, other than this caller's own, or null. */
    blocked: writeBlocked(live, busy && !pending),
    error: mine ? mutation.error : null,
    /** The last write's failure, whoever started it, until this caller answers it. */
    lastFailure: lastFailure && lastFailure.id !== cleared ? lastFailure : null,
    reset: () => {
      mutation.reset();
      if (lastFailure) setCleared(lastFailure.id);
    },
  };
}

/**
 * The branch name, which is also its rename control: click it, type, and
 * Enter or leaving the field applies. Escape puts the old name back. While
 * `but` renames, the field holds the new name, read-only. A name `but` would
 * refuse, or did, keeps the field open with that name in it.
 */
export function BranchName({ target, name }: { target: WorkspaceTarget; name: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  // Closed with Enter or Escape, so the name takes the focus back. A click
  // elsewhere leaves the focus where it went.
  const [closedByKey, setClosedByKey] = useState(false);
  const hintId = useId();
  const field = useRef<HTMLInputElement>(null);
  const action = useButAction(target);
  // Enter left the field to apply. A refused name brings the focus back to fix it.
  useFocusAfter(action.pending, () => field.current);

  const next = draft?.trim() ?? "";
  const changed = next !== "" && next !== name;
  const badName = changed ? branchNameSchema.safeParse(next).error?.issues[0]?.message : undefined;
  // A good name still waits while another write runs.
  const problem = changed ? (badName ?? action.blocked ?? undefined) : undefined;
  const acceptable = problem === undefined;
  // One line under the field: what `but` said, or why the name cannot go yet.
  const message = action.error?.message ?? (invalid ? problem : undefined);

  const commit = () => {
    if (action.pending) return;
    if (!acceptable) {
      setInvalid(true);
      return;
    }
    if (!changed) {
      setDraft(null);
      return;
    }
    // While `but` renames, the field reads the name it was asked for. The
    // board gives the new name the focus once drawn, unless the reader moved on.
    setClosedByKey(false);
    setDraft(next);
    action.run({ kind: "rename", branch: name, name: next }, (result) => {
      if (result.status === "done") setDraft(null);
    });
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {draft === null ? (
        <NameButton
          name={name}
          blocked={action.blocked}
          takeFocus={closedByKey}
          onClick={() => {
            action.reset();
            setClosedByKey(false);
            setDraft(name);
          }}
        />
      ) : (
        <span className="relative flex min-w-0">
          <input
            ref={field}
            // The user just asked to edit this field, so focus follows the click.
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            readOnly={action.pending}
            className={cn(
              FIELD,
              "py-0.5 text-sm font-semibold",
              action.pending && "pe-6 text-muted-foreground",
            )}
            aria-label={`New name for ${name}`}
            aria-invalid={action.error !== null || (invalid && badName !== undefined)}
            aria-describedby={message ? hintId : undefined}
            value={draft}
            onChange={(event) => {
              if (action.error) action.reset();
              setInvalid(false);
              setDraft(event.target.value);
            }}
            onFocus={(event) => {
              setClosedByKey(false);
              event.target.select();
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              // Once asked, the rename runs to the end: backing out would only hide it.
              if (action.pending) return;
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
                action.reset();
                setDraft(null);
              }
            }}
          />
          <span className="pointer-events-none absolute inset-y-0 end-2 flex items-center text-muted-foreground">
            <Pending pending={action.pending} />
          </span>
        </span>
      )}
      {message ? (
        <p id={hintId} role="alert" className="mt-0.5 text-[11px] text-destructive-text">
          {message}
        </p>
      ) : null}
    </div>
  );
}

/** The name as a button, with a pencil that shows on hover or focus. */
function NameButton({
  name,
  blocked,
  takeFocus,
  onClick,
}: {
  name: string;
  blocked: string | null;
  takeFocus: boolean;
  onClick: () => void;
}) {
  return (
    <h3 className="m-0 flex min-w-0 text-sm font-semibold">
      <button
        type="button"
        data-branch-name={name}
        className="group -mx-1 flex min-w-0 cursor-pointer items-center gap-1 rounded-sm px-1 text-start enabled:hover:bg-state-hover disabled:cursor-default"
        title={blocked ?? `${name} (click to rename)`}
        aria-label={`Rename branch ${name}`}
        disabled={blocked !== null}
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={takeFocus}
        onClick={onClick}
      >
        <span className="truncate">{name}</span>
        {/* Holds its room while hidden, so a hover never moves the name. */}
        <Icon
          name="Edit"
          className="size-3 shrink-0 text-subtle-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-disabled:invisible"
          aria-hidden
        />
      </button>
    </h3>
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
  const board = useBoardWorkspace();
  const requests = rpc.reviewRequests.useQuery(target, {
    // Poll only while a subthread works, so the card sees it finish.
    refetchInterval: (query) =>
      query.state.data?.requests.some((request) => request.running) ? REVIEW_POLL_MS : false,
  });
  const mutation = rpc.requestReview.useMutation({
    onSettled: () => refreshWorkspace(target.threadId),
  });
  return {
    request: () => mutation.mutate({ ...writeScope(target, board), branch }),
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
 * host found a risk. Land and Delete always ask, and ask again with `risk`
 * when the host found one.
 */
type Mode =
  | { kind: "idle" }
  /**
   * `message` is the squashed commit's, for a branch of several commits.
   * `risk` is what the pull that brings a branch behind the target up to it
   * would also do.
   */
  | { kind: "land"; message: string; risk: ActionRisk | null }
  | { kind: "push" }
  | { kind: "delete"; risk: ActionRisk | null }
  | { kind: "pull"; risk: ActionRisk };
type ModeKind = Mode["kind"];

const IDLE: Mode = { kind: "idle" };

/** The question a write's host answered with, about what it found. */
function askAbout(action: ButAction, risk: ActionRisk): Mode {
  if (action.kind === "land") return { kind: "land", message: action.message ?? "", risk };
  return action.kind === "delete" ? { kind: "delete", risk } : { kind: "pull", risk };
}

/** Land's question, with the message of the one commit a branch of several is squashed into. */
function landing(branch: Branch): Mode {
  const message = squashMessage(branch.commits.map((commit) => commit.message));
  return { kind: "land", message, risk: null };
}

/** The squashed commit's message, for Land on a branch of several commits. */
function SquashMessage({
  mode,
  branch,
  pending,
  onChange,
}: {
  mode: Mode;
  branch: Branch;
  pending: boolean;
  onChange: (message: string) => void;
}) {
  if (mode.kind !== "land" || branch.commits.length < 2) return null;
  return (
    <textarea
      aria-label="Squashed commit message"
      className={cn(FIELD, "basis-full resize-y leading-normal")}
      rows={Math.min(8, mode.message.split("\n").length + 1)}
      value={mode.message}
      readOnly={pending}
      onChange={(event) => onChange(event.target.value)}
    />
  );
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
 * How hard a confirmation's answer is to take back: `destructive` loses work
 * or deletes commits from the remote, and `attention` changes the remote in a
 * way that can't easily be undone.
 */
export type ConfirmTone = "default" | "attention" | "destructive";

/** Each tone's tint, and its warning icon's colour, so it never rests on the tint alone. */
const CONFIRM_LOOK: Record<ConfirmTone, { box: string; icon: string } | null> = {
  default: null,
  attention: { box: "border-transparent bg-surface-attention", icon: "text-attention" },
  destructive: {
    box: "border-surface-destructive-border bg-surface-destructive",
    icon: "text-destructive-text",
  },
};

/**
 * Asked once more before a change that is hard to take back. Focus starts on
 * Cancel, and Escape cancels. Both answers are described by the prompt, so
 * the focused Cancel reads out what is at stake. Once confirmed, the request
 * runs to the end: backing out then would only hide it.
 */
export function Confirm({
  prompt,
  label,
  pending,
  blocked = null,
  tone = "default",
  onConfirm,
  onCancel,
  children,
}: {
  prompt: ReactNode;
  label: string;
  pending: boolean;
  /** Why the answer can't run yet, shown on hover. Cancel still works. */
  blocked?: string | null;
  tone?: ConfirmTone;
  onConfirm: () => void;
  onCancel: () => void;
  /** What the answer runs with, such as a message, on its own line under the prompt. */
  children?: ReactNode;
}) {
  const promptId = useId();
  const look = CONFIRM_LOOK[tone];
  return (
    // Escape from either button inside cancels.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5",
        look && cn("rounded-md border px-2 py-1.5", look.box),
      )}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) onCancel();
      }}
    >
      <p id={promptId} className="me-auto min-w-0 text-muted-foreground">
        {look ? (
          <Icon
            name="AlertTriangle"
            className={cn("me-1 inline-block size-3 align-[-2px]", look.icon)}
            aria-hidden
          />
        ) : null}
        {prompt}
      </p>
      {children}
      {/* One unit, so a long prompt never wraps Cancel apart from its answer. */}
      <div className="ms-auto flex shrink-0 gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className={ACTION}
          disabled={pending}
          aria-describedby={promptId}
          // The safe answer takes focus, so a stray Enter cancels.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onClick={onCancel}
        >
          Cancel
        </Button>
        {/* A disabled button takes no hover, so what holds it says why. */}
        <span className="flex" title={blocked ?? undefined}>
          <Button
            size="sm"
            variant={tone === "destructive" ? "destructive" : "default"}
            className={ACTION}
            disabled={pending || blocked !== null}
            aria-describedby={promptId}
            onClick={onConfirm}
          >
            <Pending pending={pending} />
            {label}
          </Button>
        </span>
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

type Confirmation = {
  prompt: ReactNode;
  label: string;
  action: ButAction;
  tone: ConfirmTone;
  /** Why the answer can't run yet, beyond what holds every write back. */
  blocked?: string;
};

/**
 * Land's question. A branch of several commits is squashed into one first,
 * and a branch behind the target is pulled up to it first, so the question
 * says so: the pull rebases every applied branch, not only this one.
 */
function landConfirmation(
  mode: Extract<Mode, { kind: "land" }>,
  branch: Branch,
  behind: number,
): Confirmation {
  const name = <span className="font-semibold text-foreground">{branch.name}</span>;
  const count = branch.commits.length;
  const squash = count > 1;
  const pull = mode.risk ? (
    <> Landing pulls the workspace first. {pullRiskPrompt(mode.risk)}</>
  ) : behind > 0 ? (
    <>
      {" "}
      The target has {behind === 1 ? "a new commit" : `${behind} new commits`}, so this pulls the
      workspace first, which rebases every applied branch.
    </>
  ) : null;
  const message = mode.message.trim();
  return {
    prompt: (
      <>
        {squash ? (
          <>
            Squash {name}'s {count} commits into one and land it
          </>
        ) : (
          <>Land {name}</>
        )}{" "}
        on the target branch? This pushes it to the remote without a PR and can't easily be undone.
        {pull}
        {/* The forge closes a review only once its own commits land, which a squash or a pull rewrites. */}
        {(squash || pull !== null) && branch.reviewId !== null ? (
          <> Its PR {branch.reviewId} stays open.</>
        ) : null}
      </>
    ),
    label: `${squash ? "Squash and land" : "Land"}${mode.risk ? " anyway" : ""}`,
    action: {
      kind: "land",
      branch: branch.name,
      message: squash ? message : null,
      accepted: mode.risk,
    },
    tone: "attention",
    ...(squash && message === "" ? { blocked: "Write the commit message first" } : {}),
  };
}

/** What each confirmation asks, and what its second click runs. */
function confirmationFor(
  mode: Exclude<Mode, { kind: "idle" }>,
  branch: Branch,
  /** New upstream commits the push deletes, and the ids it agrees to on confirming. */
  lost: { count: number; commits: string[] },
  force: boolean,
  branchesAbove: number,
  /** Commits the target has that the workspace lacks, as GitButler last fetched it. */
  behind: number,
): Confirmation {
  const name = <span className="font-semibold text-foreground">{branch.name}</span>;
  switch (mode.kind) {
    case "land":
      return landConfirmation(mode, branch, behind);
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
        tone: "destructive",
      };
    case "pull":
      return {
        prompt: pullRiskPrompt(mode.risk, branch.name),
        label: "Pull anyway",
        action: { kind: "pull", branch: branch.name, accepted: mode.risk },
        tone: "default",
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
        // It only asks when it deletes upstream commits, whichever label it wears.
        tone: "destructive",
      };
    }
  }
}

/**
 * A failed write of this footer's on `branch`, from whichever card started
 * it. Renames say theirs under the name.
 */
function footerFailure(failure: WriteFailure | null, branch: string): Error | null {
  if (!failure || failure.action.kind === "rename" || failure.action.kind === "updateWorkspace") {
    return null;
  }
  return failure.action.branch === branch ? failure.error : null;
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
  blocked,
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
  /** Why no request can start here now, or null. */
  blocked: string | null;
  /** The confirmation just cancelled, whose button takes the focus back. */
  refocus: ModeKind;
  onPull: () => void;
  onPush: () => void;
  onReview: () => void;
  onLand: () => void;
  onDelete: () => void;
}) {
  const busy = running !== null || requesting || blocked !== null;
  return (
    // A disabled button takes no hover, so the row says why its buttons are off.
    <div className="flex flex-wrap items-center gap-1.5" title={blocked ?? undefined}>
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
  behind,
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
  /** Commits the target has that the workspace lacks, as GitButler last fetched it. */
  behind: number;
}) {
  const [mode, setMode] = useState<Mode>(IDLE);
  const [refocus, setRefocus] = useState<ModeKind>("idle");
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
    // Back from a confirmation, focus returns to the button that opened it.
    setRefocus(next.kind === "idle" ? mode.kind : "idle");
    setMode(next);
  };
  const run = (next: ButAction) => {
    review.reset();
    // How it went, "Already up to date." too, goes to the board's status line.
    action.run(
      next,
      (result) => setMode(result.status === "confirm" ? askAbout(next, result.risk) : IDLE),
      // The pull a land asked about may have run before it failed, so the
      // question is asked again from the board the failure leaves.
      () => setMode((current) => (current.kind === "land" ? { ...current, risk: null } : current)),
    );
  };
  const error = action.error ?? footerFailure(action.lastFailure, branch.name) ?? review.error;
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
    mode.kind === "idle"
      ? null
      : confirmationFor(mode, branch, atRisk, force, branchesAbove, behind);

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
          blocked={action.blocked ?? confirmation.blocked}
          tone={confirmation.tone}
          onCancel={() => choose(IDLE)}
          onConfirm={() => run(confirmation.action)}
        >
          <SquashMessage
            mode={mode}
            branch={branch}
            pending={action.pending}
            onChange={(message) =>
              setMode((current) => (current.kind === "land" ? { ...current, message } : current))
            }
          />
        </Confirm>
      ) : (
        <ActionRow
          branch={branch.name}
          // While a subthread writes this PR, a second click would start another.
          available={{ ...available, review: available.review && !review.current?.running }}
          running={action.running}
          requesting={review.pending}
          blocked={action.blocked}
          refocus={refocus}
          onPull={() => run({ kind: "pull", branch: branch.name, accepted: null })}
          onLand={() => choose(landing(branch))}
          onDelete={() => choose({ kind: "delete", risk: null })}
          onReview={() => {
            action.reset();
            review.request();
          }}
          onPush={() =>
            asksFirst
              ? choose({ kind: "push" })
              : run({ kind: "push", branch: branch.name, force, acceptedLoss: [] })
          }
        />
      )}
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
