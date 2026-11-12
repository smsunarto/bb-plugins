/**
 * The tab's writes: Push and Land on a branch card, Pull in the header, and
 * the confirmations they ask first. Ported from
 * `plugins/gitbutler/src/app/branch-actions.tsx`. Every write names the
 * revision the reader saw; the server refuses with `conflict` when the
 * checkout has moved since. Nothing is retried on its own: a confirmation
 * resubmits only on the reader's click.
 */
import {
  experimental_Icon as Icon,
  experimental_useRpcMutation as useRpcMutation,
} from "@get-bb/plugin-sdk/app";
import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  branchNameSchema,
  describeProblem,
  type ActionRisk,
  type Branch,
  type Revision,
  type VcsAction,
  type VcsResult,
} from "../core/change.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { useEscapeLayer } from "./escape.ts";
import { useHostGate } from "./host-gate.ts";
import { cx, plural, squashMessage } from "./format.ts";
import { Button } from "./components/ui/button.tsx";
import { Pending } from "./ui.tsx";
import { Input } from "./components/ui/input.tsx";
import { Textarea } from "./components/ui/textarea.tsx";

/** The rename field takes focus, its name selected, when the reader opens it. */
function focusOnMount(field: HTMLInputElement | null) {
  field?.focus();
  field?.select();
}

/** What a write is about: a branch's name, or the whole workspace for Pull. */
export type Scope = string;
export const WORKSPACE: Scope = "@workspace";

export function scopeOf(action: VcsAction): Scope {
  return action.kind === "pull" ? WORKSPACE : action.branch;
}

/** How a scope's last write ended, when it left something to say or ask. */
export type Outcome =
  | {
      kind: "confirm";
      action: VcsAction;
      risk: ActionRisk | null;
      loss: string[] | null;
      /** The revision the question is about. */
      seen: Revision;
    }
  | { kind: "conflict" }
  | { kind: "failed"; text: string };

/** One stable dispatcher for every card, so no row holds its own closure. */
export type Dispatch = {
  send(action: VcsAction, expected: Revision): void;
  dismiss(scope: Scope): void;
};

export const CONFLICT_TEXT = "The checkout changed since you looked.";

function outcomeOf(result: VcsResult, action: VcsAction, seen: Revision): Outcome | null {
  switch (result.status) {
    case "done":
    case "upToDate":
      // The server invalidates the thread's read, which redraws the cards.
      return null;
    case "confirm":
      return { kind: "confirm", action, risk: result.risk, loss: result.loss, seen };
    case "conflict":
      return { kind: "conflict" };
    case "failed":
      return { kind: "failed", text: describeProblem(result.problem) };
  }
}

function withOutcome(scope: Scope, outcome: Outcome | null) {
  return (current: ReadonlyMap<Scope, Outcome>): ReadonlyMap<Scope, Outcome> => {
    if (outcome === null && !current.has(scope)) return current;
    const next = new Map(current);
    if (outcome) next.set(scope, outcome);
    else next.delete(scope);
    return next;
  };
}

const NO_OUTCOMES: ReadonlyMap<Scope, Outcome> = new Map();

/**
 * The thread's writes. Mounted once per thread, so a late answer for one
 * thread never lands in another's cards. `running` names each scope's write
 * in flight; `busy` holds every write button while any runs, since writes to
 * one checkout rewrite the same branches.
 */
export function useVcsActions(threadId: string, gate: string | null) {
  const mutation = useRpcMutation({ contract: sourceControlContract, method: "vcsAction" });
  const [outcomes, setOutcomes] = useState(NO_OUTCOMES);
  const mutate = useRef(mutation.mutate);
  const closed = useRef(gate);
  useLayoutEffect(() => {
    mutate.current = mutation.mutate;
    closed.current = gate;
  });
  const dispatch = useMemo<Dispatch>(
    () => ({
      send(action, expected) {
        const scope = scopeOf(action);
        // The host gate: every write goes through here, so none can skip it.
        if (closed.current !== null) {
          setOutcomes(withOutcome(scope, { kind: "failed", text: closed.current }));
          return;
        }
        setOutcomes(withOutcome(scope, null));
        mutate.current({ threadId, action, expected }).then(
          (result) => setOutcomes(withOutcome(scope, outcomeOf(result, action, expected))),
          (error: unknown) =>
            setOutcomes(
              withOutcome(scope, {
                kind: "failed",
                text: error instanceof Error ? error.message : "The request failed.",
              }),
            ),
        );
      },
      dismiss(scope) {
        setOutcomes(withOutcome(scope, null));
      },
    }),
    [threadId],
  );
  const { pendingInputs } = mutation;
  const running = useMemo(() => {
    const map = new Map<Scope, VcsAction["kind"]>();
    for (const input of pendingInputs) {
      if (input.threadId === threadId) map.set(scopeOf(input.action), input.action.kind);
    }
    return map as ReadonlyMap<Scope, VcsAction["kind"]>;
  }, [pendingInputs, threadId]);
  return { dispatch, outcomes, running, busy: running.size > 0 };
}

/**
 * How hard a confirmation's answer is to take back: `destructive` deletes
 * commits from the remote, and `attention` changes the remote in a way that
 * can't easily be undone.
 */
type ConfirmTone = "default" | "attention" | "destructive";

const CONFIRM_LOOK: Record<ConfirmTone, { box: string; icon: string } | null> = {
  default: null,
  attention: {
    box: "border-transparent bg-[color-mix(in_oklab,var(--warning)_10%,transparent)]",
    icon: "text-warning",
  },
  destructive: {
    box: "border-[color-mix(in_oklab,var(--destructive)_35%,transparent)] bg-[color-mix(in_oklab,var(--destructive)_10%,transparent)]",
    icon: "text-destructive",
  },
};

/**
 * Asked once more before a change that is hard to take back. Focus starts on
 * Cancel, and Escape cancels. Once confirmed, the request runs to the end.
 */
export function Confirm({
  prompt,
  label,
  pending,
  blocked = null,
  tone = "default",
  onConfirm,
  onCancel,
  fieldFocus = false,
  children,
}: {
  prompt: ReactNode;
  label: string;
  pending: boolean;
  /** A field among `children` takes focus instead of Cancel, as Rename's name does. */
  fieldFocus?: boolean;
  /** Why the answer can't run yet, shown on hover. Cancel still works. */
  blocked?: string | null;
  tone?: ConfirmTone;
  onConfirm: () => void;
  onCancel: () => void;
  /** What the answer runs with, such as a message, under the prompt. */
  children?: ReactNode;
}) {
  const promptId = useId();
  const look = CONFIRM_LOOK[tone];
  const root = useRef<HTMLDivElement>(null);
  // Escape from anywhere inside cancels, unless the answer is already running.
  useEscapeLayer(root, () => {
    if (!pending) onCancel();
  });
  return (
    <div
      ref={root}
      className={cx(
        "flex flex-wrap items-center gap-2 text-[12px]",
        look && `rounded-[6px] border px-2.5 py-2 ${look.box}`,
      )}
    >
      <p
        id={promptId}
        className="m-0 me-auto min-w-0 basis-full leading-normal text-muted-foreground"
      >
        {look ? (
          <Icon
            name="AlertTriangle"
            className={cx("me-1 inline-block size-3 align-[-2px]", look.icon)}
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
          disabled={pending}
          aria-describedby={promptId}
          // The safe answer takes focus, so a stray Enter cancels.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={!fieldFocus}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <span className="flex" title={blocked ?? undefined}>
          <Button
            variant={tone === "destructive" ? "destructive" : "default"}
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

function Name({ children }: { children: string }) {
  return <span className="font-semibold text-foreground">{children}</span>;
}

/** "a", "a and b", "a, b, and c": branch names inside a sentence. */
export function listNames(names: readonly string[]): ReactNode {
  const shown = names.map((name) => <Name key={name}>{name}</Name>);
  if (shown.length <= 2) return shown.flatMap((name, index) => (index ? [" and ", name] : [name]));
  return shown.flatMap((name, index) =>
    index === 0 ? [name] : index === shown.length - 1 ? [", and ", name] : [", ", name],
  );
}

/** What a pull would also do, said before it runs. */
export function pullRiskPrompt(
  { conflicted, overlapsUncommitted }: ActionRisk,
  native = false,
): ReactNode {
  return (
    <>
      {conflicted.length > 0 ? (
        <>
          Pulling {native ? "may leave conflicts" : "leaves conflicted commits"} in{" "}
          {listNames(conflicted)}. Resolve them before pushing.
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

type Confirmation = {
  prompt: ReactNode;
  label: string;
  /** What the confirm click sends. */
  action: VcsAction;
  tone: ConfirmTone;
  blocked?: string;
};

/**
 * Land's question: publication, squashing, and how the checkout's provider
 * handles a newer target. `risk` is what the pull that comes first would do.
 */
function landConfirmation(
  branch: Branch,
  message: string,
  risk: ActionRisk | null,
  behind: number,
  native: boolean,
): Confirmation {
  const count = branch.commits.length;
  const squash = count > 1;
  const newerTargetAction = native
    ? "creates the landing commit on top of the newer target."
    : "pulls the workspace first, which rebases every applied branch.";
  const pull =
    risk && !native ? (
      <> Landing pulls the workspace first. {pullRiskPrompt(risk, native)}</>
    ) : behind > 0 ? (
      <>
        {" "}
        The target has {behind === 1 ? "a new commit" : `${behind} new commits`}, so this{" "}
        {newerTargetAction}
      </>
    ) : null;
  const rewritesCommits = squash || pull !== null;
  const trimmed = message.trim();
  return {
    prompt: (
      <>
        {squash ? (
          <>
            Squash <Name>{branch.name}</Name>'s {count} commits into one and land it
          </>
        ) : (
          <>
            Land <Name>{branch.name}</Name>
          </>
        )}{" "}
        on the target branch? This pushes it to the remote without a PR and can't easily be undone.
        {pull}
        {rewritesCommits && branch.reviewId !== null ? (
          <> Its PR {branch.reviewId} stays open.</>
        ) : null}
        {native && rewritesCommits && branch.reviewId === null ? (
          <> An existing PR may remain open after these commits are rewritten.</>
        ) : null}
      </>
    ),
    label: `${squash ? "Squash and land" : "Land"}${risk ? " anyway" : ""}`,
    action: {
      kind: "land",
      branch: branch.name,
      message: squash ? trimmed : null,
      accepted: risk,
    },
    tone: "attention",
    ...(squash && trimmed === "" ? { blocked: "Write the commit message first" } : {}),
  };
}

/** The question a server's `confirm` asks about a branch write. */
function serverConfirmation(
  outcome: Extract<Outcome, { kind: "confirm" }>,
  branch: Branch,
  behind: number,
  native: boolean,
): Confirmation | null {
  const { action } = outcome;
  if (action.kind === "push") {
    const loss = outcome.loss ?? [];
    const label = action.force ? "Force push" : "Push";
    return {
      prompt: (
        <>
          {label} <Name>{branch.name}</Name>? This deletes{" "}
          {loss.length === 1 ? "the upstream commit" : `the ${loss.length} upstream commits`} shown
          in this stack from the remote.
        </>
      ),
      label,
      action: { ...action, acceptedLoss: loss },
      // It only asks when it deletes upstream commits, whichever label it wears.
      tone: "destructive",
    };
  }
  if (action.kind === "land") {
    const asked = landConfirmation(branch, action.message ?? "", outcome.risk, behind, native);
    return { ...asked, action: { ...action, accepted: outcome.risk } };
  }
  if (action.kind === "delete" && outcome.risk) {
    return {
      prompt: (
        <>
          Your uncommitted changes touch files <Name>{branch.name}</Name>'s commits change, so
          deleting it writes conflict markers into them.
        </>
      ),
      label: "Delete anyway",
      action: { ...action, accepted: outcome.risk },
      tone: "destructive",
    };
  }
  return null;
}

/** Statuses whose commits the remote already has, so a delete loses nothing it lacks. */
const ON_REMOTE: ReadonlySet<Branch["status"]> = new Set(["pushed", "behind", "integrated"]);

/** What deleting a branch loses, from how much of it the remote already has. */
function deleteLoss(branch: Branch, native: boolean): string {
  const count = branch.commits.length;
  if (count === 0) return "It has no commits.";
  const one = count === 1;
  const its = one ? "Its commit" : `Its ${count} commits`;
  const history = native ? "git's reflog" : "GitButler's undo history";
  if (branch.status === "unpushed")
    return `${its} ${one ? "was" : "were"} never pushed, so only ${history} keeps ${one ? "it" : "them"} afterwards.`;
  const leave = `${its} ${one ? "leaves" : "leave"} ${native ? "the checkout" : "the workspace"}`;
  return ON_REMOTE.has(branch.status)
    ? `${leave}.`
    : `${leave}, and any not yet pushed stay only in ${history}.`;
}

/**
 * Delete's question. `but branch delete` drops the local branch and its
 * commits and rebases the branches above it; plain git leaves the checkout
 * detached at the branch's head. Neither touches the remote or a pull request.
 */
function deleteConfirmation(branch: Branch, above: number, native: boolean): Confirmation {
  const remote = branch.status === "unpushed" ? "" : " The remote branch and any PR stay.";
  const moves =
    native || above === 0
      ? ""
      : above === 1
        ? " The branch above it moves down onto the base."
        : ` The ${above} branches above it move down onto the base.`;
  const detached = native ? " The checkout is left detached at its last commit." : "";
  return {
    prompt: (
      <>
        Delete <Name>{branch.name}</Name>? {deleteLoss(branch, native)}
        {remote}
        {moves}
        {detached}
      </>
    ),
    label: "Delete",
    action: { kind: "delete", branch: branch.name, accepted: null },
    tone: "destructive",
  };
}

/** The new state of a revision a question was asked about, if it moved. */
function moved(seen: Revision, now: Revision): boolean {
  return seen.head !== now.head || seen.target !== now.target;
}

const CHANGED_PROMPT =
  "This branch changed while the confirmation was open. Review the updated branch before continuing.";

/** A write's refusal or failure, under the row that started it. */
export function OutcomeLine({
  outcome,
  scope,
  dispatch,
}: {
  outcome: Outcome | undefined;
  scope: Scope;
  dispatch: Dispatch;
}) {
  if (!outcome || outcome.kind === "confirm") return null;
  return (
    <div role="alert" className="flex min-w-0 items-start gap-2">
      <p
        className={cx(
          "m-0 min-w-0 flex-1 text-[12px] leading-4",
          outcome.kind === "failed" ? "text-destructive" : "text-warning",
        )}
      >
        {outcome.kind === "conflict" ? CONFLICT_TEXT : outcome.text}
      </p>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Dismiss"
        className="size-4 rounded-[4px] text-muted-foreground"
        onClick={() => dispatch.dismiss(scope)}
      >
        <Icon name="X" className="size-3" aria-hidden />
      </Button>
    </div>
  );
}

/** A branch footer's local state: its buttons, or Land's first question. */
type Mode =
  | { kind: "idle" }
  | { kind: "land"; message: string; seen: Revision }
  | { kind: "delete"; seen: Revision }
  | { kind: "rename"; name: string; seen: Revision };
const IDLE: Mode = { kind: "idle" };

/**
 * Rename's question: the new name, checked as the server will check it. The
 * remote branch and any pull request keep the old name until the next push.
 */
function renameConfirmation(branch: Branch, name: string, native: boolean): Confirmation {
  const next = name.trim();
  let blocked: string | undefined;
  if (next === branch.name) blocked = "Type a new name.";
  else if (!branchNameSchema.safeParse(next).success)
    blocked = "A branch name has no spaces and does not start with - or refs/.";
  const remote =
    branch.status === "unpushed" || native
      ? ""
      : " GitButler keeps its stack, and the remote branch keeps the old name until you push.";
  return {
    prompt: (
      <>
        Rename <Name>{branch.name}</Name>?{remote}
      </>
    ),
    label: "Rename",
    action: { kind: "rename", branch: branch.name, name: next },
    tone: "default",
    ...(blocked ? { blocked } : {}),
  };
}

/**
 * The footer under a branch header: Push, Land and Delete. Push goes straight
 * out; the server asks first when it would delete remote commits. Land and
 * Delete always ask, and ask again when the server finds a risk.
 */
export const BranchActions = memo(function BranchActions({
  branch,
  targetHead,
  landable,
  above,
  pushBlocked,
  behind,
  native,
  outcome,
  running,
  busy,
  dispatch,
  prAction,
}: {
  branch: Branch;
  /** The target head the reader saw, which every write names. */
  targetHead: string | null;
  /** Land refuses a branch with other branches below it in its stack. */
  landable: boolean;
  /** Branches stacked above this one. */
  above: number;
  /** A conflicted commit here or below, which a push would take along. */
  pushBlocked: boolean;
  /** Commits the target has that the workspace lacks. */
  behind: number;
  native: boolean;
  outcome: Outcome | undefined;
  running: VcsAction["kind"] | null;
  busy: boolean;
  dispatch: Dispatch;
  /** The pull request's own action beside Land: Create PR without one, Merge for an open one. */
  prAction?: ReactNode;
}) {
  const [mode, setMode] = useState<Mode>(IDLE);
  const hostBlocked = useHostGate();
  const now: Revision = { head: branch.head, target: targetHead };
  const pending = running !== null;
  const blocked = hostBlocked ?? (busy && !pending ? "Another action is running" : null);
  const off = busy || hostBlocked !== null;
  const available = availableFor(branch, landable, pushBlocked);
  const send = (action: VcsAction) => {
    setMode(IDLE);
    dispatch.send(action, now);
  };
  const asked = question(outcome, mode, branch, behind, native, above);
  return (
    <div className="flex min-w-0 flex-col gap-2 border-t border-border-hairline px-3 py-2">
      {asked ? (
        <Question
          asked={asked.confirmation}
          changed={moved(asked.seen, now)}
          pending={pending}
          blocked={blocked}
          onCancel={() => (asked.fromServer ? dispatch.dismiss(branch.name) : setMode(IDLE))}
          onReview={() =>
            (mode.kind === "land" || mode.kind === "rename") && !asked.fromServer
              ? setMode({ ...mode, seen: now })
              : dispatch.dismiss(branch.name)
          }
          onConfirm={() => send(asked.confirmation.action)}
          fieldFocus={mode.kind === "rename" && !asked.fromServer}
        >
          {asked.fromServer ? null : (
            <ModeField
              mode={mode}
              branch={branch}
              pending={pending}
              onChange={setMode}
              onSubmit={() => {
                const confirmation = asked.confirmation;
                // A branch that moved since asks to be looked at again first.
                if (!confirmation.blocked && !blocked && !moved(asked.seen, now))
                  send(confirmation.action);
              }}
            />
          )}
        </Question>
      ) : (
        <ActionRow
          branch={branch}
          available={available}
          running={running}
          busy={off}
          blocked={blocked}
          prAction={prAction}
          onPush={(force) => send({ kind: "push", branch: branch.name, force, acceptedLoss: [] })}
          onLand={() =>
            setMode({
              kind: "land",
              message: squashMessage(branch.commits.map((commit) => commit.subject)),
              seen: now,
            })
          }
          onDelete={() => setMode({ kind: "delete", seen: now })}
          onRename={() => setMode({ kind: "rename", name: branch.name, seen: now })}
        />
      )}
      {hostBlocked && !asked ? (
        <p className="m-0 text-[12px] leading-4 text-muted-foreground">{hostBlocked}</p>
      ) : null}
      <OutcomeLine outcome={outcome} scope={branch.name} dispatch={dispatch} />
    </div>
  );
});

/** What a question asks for besides its answer: Rename's new name, or Land's squashed message. */
function ModeField({
  mode,
  branch,
  pending,
  onChange,
  onSubmit,
}: {
  mode: Mode;
  branch: Branch;
  pending: boolean;
  onChange: (mode: Mode) => void;
  onSubmit: () => void;
}) {
  if (mode.kind === "rename")
    return (
      <Input
        aria-label={`New name for ${branch.name}`}
        className="h-7 w-full min-w-0 basis-full border-border-hairline bg-background px-2 font-mono text-[12px]"
        value={mode.name}
        readOnly={pending}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        ref={focusOnMount}
        onChange={(event) => onChange({ ...mode, name: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !pending) onSubmit();
        }}
      />
    );
  if (mode.kind !== "land" || branch.commits.length <= 1) return null;
  return (
    <Textarea
      aria-label="Squashed commit message"
      className="min-h-0 w-full min-w-0 basis-full resize-y border-border-hairline bg-background px-2 py-1 text-[12px] leading-normal"
      rows={Math.min(8, mode.message.split("\n").length + 1)}
      value={mode.message}
      readOnly={pending}
      onChange={(event) => onChange({ ...mode, message: event.target.value })}
    />
  );
}

type Available = { push: Branch["push"]; land: boolean };

/**
 * Which sending buttons a branch gets. Integrated or empty branches have
 * nothing to land, and a conflicted commit here or below blocks both.
 */
function availableFor(branch: Branch, landable: boolean, pushBlocked: boolean): Available {
  const open = branch.commits.length > 0 && branch.status !== "integrated";
  return { push: pushBlocked ? "none" : branch.push, land: open && landable && !pushBlocked };
}

/** The open question on a branch: the server's, else Land's own first one. */
function question(
  outcome: Outcome | undefined,
  mode: Mode,
  branch: Branch,
  behind: number,
  native: boolean,
  above: number,
): { confirmation: Confirmation; seen: Revision; fromServer: boolean } | null {
  if (outcome?.kind === "confirm") {
    const confirmation = serverConfirmation(outcome, branch, behind, native);
    return confirmation ? { confirmation, seen: outcome.seen, fromServer: true } : null;
  }
  if (mode.kind === "delete")
    return {
      confirmation: deleteConfirmation(branch, above, native),
      seen: mode.seen,
      fromServer: false,
    };
  if (mode.kind === "rename")
    return {
      confirmation: renameConfirmation(branch, mode.name, native),
      seen: mode.seen,
      fromServer: false,
    };
  if (mode.kind !== "land") return null;
  return {
    confirmation: landConfirmation(branch, mode.message, null, behind, native),
    seen: mode.seen,
    fromServer: false,
  };
}

/** A confirmation, or, once its branch moved, a request to look again first. */
function Question({
  asked,
  changed,
  pending,
  blocked,
  onCancel,
  onReview,
  onConfirm,
  fieldFocus = false,
  children,
}: {
  asked: Confirmation;
  changed: boolean;
  pending: boolean;
  blocked: string | null;
  onCancel: () => void;
  onReview: () => void;
  onConfirm: () => void;
  fieldFocus?: boolean;
  children?: ReactNode;
}) {
  if (changed)
    return (
      <Confirm
        prompt={CHANGED_PROMPT}
        label="Review updated branch"
        pending={pending}
        tone={asked.tone}
        onCancel={onCancel}
        onConfirm={onReview}
      />
    );
  return (
    <Confirm
      prompt={asked.prompt}
      label={asked.label}
      pending={pending}
      blocked={blocked ?? asked.blocked ?? null}
      tone={asked.tone}
      onCancel={onCancel}
      onConfirm={onConfirm}
      fieldFocus={fieldFocus}
    >
      {children}
    </Confirm>
  );
}

function ActionRow({
  branch,
  available,
  running,
  busy,
  blocked,
  prAction,
  onPush,
  onLand,
  onDelete,
  onRename,
}: {
  branch: Branch;
  available: Available;
  running: VcsAction["kind"] | null;
  busy: boolean;
  blocked: string | null;
  prAction: ReactNode;
  onPush: (force: boolean) => void;
  onLand: () => void;
  onDelete: () => void;
  onRename: () => void;
}) {
  const force = available.push === "force";
  // Rewritten commits replace the remote branch, so the label says so.
  const pushLabel = force ? "Force push" : "Push";
  return (
    // A disabled button takes no hover, so the row says why its buttons are off.
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" title={blocked ?? undefined}>
      {available.push === "none" ? null : (
        <Button
          variant="outline"
          disabled={busy}
          data-host-bound="push"
          aria-label={`${pushLabel} ${branch.name}`}
          onClick={() => onPush(force)}
        >
          <Pending pending={running === "push"} icon="ArrowUp" />
          {pushLabel}
        </Button>
      )}
      {available.land ? (
        <Button
          variant="outline"
          disabled={busy}
          data-host-bound="land"
          aria-label={`Land ${branch.name}`}
          onClick={onLand}
        >
          <Pending pending={running === "land"} icon="ArrowDown" />
          Land
        </Button>
      ) : null}
      {prAction}
      <Button
        variant="ghost"
        className="ms-auto shrink-0 text-muted-foreground"
        disabled={busy}
        data-host-bound="rename"
        aria-label={`Rename ${branch.name}`}
        onClick={onRename}
      >
        <Pending pending={running === "rename"} icon="Edit" />
        Rename
      </Button>
      {/* Apart from the rest and quiet, so it is never the button a hand drifts to. */}
      <Button
        variant="ghost"
        className="shrink-0 text-muted-foreground enabled:hover:text-destructive"
        disabled={busy}
        data-host-bound="delete"
        aria-label={`Delete ${branch.name}`}
        onClick={onDelete}
      >
        <Pending pending={running === "delete"} icon="Trash2" />
        Delete
      </Button>
    </div>
  );
}

/** The header's Pull: brings the workspace up to its target. */
export function PullButton({
  behind,
  targetHead,
  running,
  busy,
  dispatch,
}: {
  behind: number;
  targetHead: string | null;
  running: boolean;
  busy: boolean;
  dispatch: Dispatch;
}) {
  const gate = useHostGate();
  let title = "Pull the target into the workspace";
  if (gate) title = gate;
  else if (busy && !running) title = "Another action is running";
  return (
    // A disabled button takes no hover, so the reason sits on a wrapper.
    <span className="flex shrink-0" title={title}>
      <Button
        variant="outline"
        className="size-7 px-0!"
        aria-label={behind > 0 ? `Pull ${plural(behind, "new commit")}` : "Pull"}
        data-host-bound="pull"
        disabled={busy || gate !== null}
        onClick={() =>
          dispatch.send({ kind: "pull", accepted: null }, { head: null, target: targetHead })
        }
      >
        <Pending pending={running} icon="ArrowDown" />
      </Button>
    </span>
  );
}

/** Under the header: Pull's question, refusal, or failure. */
export function PullStatus({
  outcome,
  targetHead,
  native,
  running,
  busy,
  dispatch,
}: {
  outcome: Outcome | undefined;
  targetHead: string | null;
  native: boolean;
  running: boolean;
  busy: boolean;
  dispatch: Dispatch;
}) {
  const gate = useHostGate();
  if (!outcome) return null;
  const now: Revision = { head: null, target: targetHead };
  return (
    <div className="shrink-0 border-b border-border-hairline px-3 @md:px-4 py-2">
      {outcome.kind === "confirm" && outcome.risk ? (
        moved(outcome.seen, now) ? (
          <Confirm
            prompt="The target changed while the confirmation was open. Review it before pulling."
            label="Review"
            pending={running}
            onCancel={() => dispatch.dismiss(WORKSPACE)}
            onConfirm={() => dispatch.dismiss(WORKSPACE)}
          />
        ) : (
          <Confirm
            prompt={pullRiskPrompt(outcome.risk, native)}
            label="Pull anyway"
            pending={running}
            blocked={gate ?? (busy && !running ? "Another action is running" : null)}
            onCancel={() => dispatch.dismiss(WORKSPACE)}
            onConfirm={() => dispatch.send({ kind: "pull", accepted: outcome.risk }, now)}
          />
        )
      ) : (
        <OutcomeLine outcome={outcome} scope={WORKSPACE} dispatch={dispatch} />
      )}
    </div>
  );
}
