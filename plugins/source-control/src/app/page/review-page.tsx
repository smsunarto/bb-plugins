/**
 * The review page (board A): the selected Change's header, ship path, Files
 * and Commits tabs, and the rail. With no Change selected, a phone shows the
 * Changes list here (board D) and a desktop says to pick one from the nav.
 *
 * Everything below `ReviewPage` is keyed by ChangeKey, so local state (open
 * files, menus, write outcomes) belongs to one Change, and a late answer for
 * another Change can only land in that Change's cache entries.
 */
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
} from "@get-bb/plugin-sdk/app";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { describeProblem, readAgo, type ForgeResult } from "../../core/change.ts";
import type { ChangeKey } from "../../core/ids.ts";
import {
  parseReviewPath,
  type ChangeDetail,
  type ReviewLocation,
  type ReviewTab,
} from "../../core/review.ts";
import { sourceControlContract } from "../../contract/rpc.ts";
import { cx, plural, shortRef } from "../format.ts";
import { SendControls } from "../send.tsx";
import { ShipPath } from "../status.tsx";
import { Bar, Button, Pending } from "../ui.tsx";
import { ChangesList } from "./changes-nav.tsx";
import { CommitsView } from "./commits-view.tsx";
import { ConversationView } from "./conversation-view.tsx";
import { FilesView } from "./files-view.tsx";
import { PHONE, WIDE, useGo, useNow, useWidth, type Go } from "./hooks.ts";
import { ArrowRight, Chevron, GitHubMark, StackIcon, StateIcon } from "./icons.tsx";
import { revisionId } from "./patches.ts";
import { RailSections } from "./rail.tsx";
import { FocusContext, ReviewFocus } from "./review-focus.ts";
import { ReviewSection } from "./review-section.tsx";

type Ready = Extract<ChangeDetail, { state: "change" }>;

const PAD = "px-4 @3xl:px-8";

// ── Status menu ────────────────────────────────────────────────────────

type Outcome = { head: string; result: ForgeResult } | null;

function outcomeText(outcome: Outcome, head: string | null): string | null {
  if (!outcome || outcome.head !== head) return null;
  const { result } = outcome;
  if (result.status === "conflict") return result.detail;
  if (result.status === "failed")
    return "detail" in result.problem ? result.problem.detail : describeProblem(result.problem);
  return null;
}

/** Mark ready or Convert to draft, only while the pull request is still at the head the reader sees. */
function useDraftToggle(detail: Ready) {
  const mutation = useRpcMutation({ contract: sourceControlContract, method: "changeForgeAction" });
  const [outcome, setOutcome] = useState<Outcome>(null);
  const mutate = useRef(mutation.mutate);
  useLayoutEffect(() => {
    mutate.current = mutation.mutate;
  });
  const { row, head } = detail;
  const pending = mutation.pendingInputs.some((input) => input.key === row.key);
  const can =
    row.number !== null &&
    head !== null &&
    ((row.state === "draft" && detail.canMarkReady) || (row.state === "open" && row.mine));
  const toggle = useMemo(
    () =>
      can
        ? () => {
            setOutcome(null);
            mutate
              .current({
                key: row.key,
                action: { kind: "setDraft", draft: row.state !== "draft" },
                expected: { number: row.number!, head: head! },
              })
              .then(
                (result) => setOutcome({ head: head!, result }),
                (error: unknown) =>
                  setOutcome({
                    head: head!,
                    result: {
                      status: "failed",
                      problem: {
                        kind: "failed",
                        site: "GitHub",
                        detail: error instanceof Error ? error.message : "The request failed.",
                      },
                    },
                  }),
              );
          }
        : null,
    [can, row.key, row.state, row.number, head],
  );
  return { toggle, pending, message: outcomeText(outcome, head) };
}

const CHIP =
  "flex h-6 shrink-0 items-center gap-1 rounded-full border-0 bg-border px-2 text-[12px] leading-4 font-semibold text-foreground";

function StatusMenu({
  detail,
  draft,
}: {
  detail: Ready;
  draft: ReturnType<typeof useDraftToggle>;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const item = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) item.current?.focus();
  }, [open]);
  const { state } = detail.row;
  const icon = <StateIcon state={state} size={11} />;
  if (!draft.toggle)
    return (
      <span className={CHIP} data-testid="sc-review-state">
        {icon}
        {detail.status.label}
      </span>
    );
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <span className="relative flex shrink-0 flex-col">
      <button
        ref={trigger}
        type="button"
        data-testid="sc-review-state"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cx(CHIP, "cursor-pointer")}
      >
        {icon}
        {detail.status.label}
        <Chevron />
      </button>
      {open ? (
        <span
          role="menu"
          tabIndex={-1}
          data-bb-plugin="source-control"
          className="absolute top-7 left-0 z-10 flex min-w-48 flex-col rounded-[8px] border border-solid border-border bg-popover p-1 shadow-md"
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <button
            type="button"
            ref={item}
            role="menuitem"
            disabled={draft.pending}
            onClick={() => {
              draft.toggle?.();
              close();
            }}
            className="flex h-7 cursor-pointer items-center rounded-[6px] border-0 bg-transparent px-2 text-left text-[12px] leading-4 text-foreground enabled:hover:bg-surface-raised"
          >
            {state === "draft" ? "Mark ready for review" : "Convert to draft"}
          </button>
        </span>
      ) : null}
    </span>
  );
}

// ── Header ─────────────────────────────────────────────────────────────

/** What the Change conflicts with, from the chips its row already derives. */
function conflictText(row: Ready["row"]): string | null {
  if (row.chips.some((chip) => chip.id === "conflicted")) return "Conflicted in its checkout";
  if (row.chips.some((chip) => chip.id === "conflicts"))
    return row.baseRef ? `Conflicts with ${row.baseRef}` : "Conflicts with its base";
  return null;
}

function Header({ detail, now }: { detail: Ready; now: number }) {
  const { row } = detail;
  const draft = useDraftToggle(detail);
  const slash = row.repo.indexOf("/");
  const owner = slash > 0 ? row.repo.slice(0, slash) : null;
  const name = slash > 0 ? row.repo.slice(slash + 1) : row.repo;
  const conflict = conflictText(row);
  return (
    <header
      data-testid="sc-review-header"
      className={cx(
        "flex shrink-0 flex-wrap items-start justify-between gap-x-8 gap-y-3 pt-5 pb-4",
        PAD,
      )}
    >
      <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[12px] leading-4">
          {owner ? (
            <>
              <span className="text-(--tertiary-foreground)">{owner}</span>
              <span className="text-(--tertiary-foreground)">/</span>
            </>
          ) : null}
          <span className="text-muted-foreground">{name}</span>
          {row.stack && row.stack.size > 1 ? (
            <>
              <span className="w-1 shrink-0" />
              <StackIcon />
              <span className="text-(--tertiary-foreground)">
                {row.stack.position} of {row.stack.size}
              </span>
            </>
          ) : null}
        </div>
        <h1
          className="m-0 text-[20px] leading-7 font-semibold tracking-[-0.01em] break-words text-foreground"
          data-testid="sc-review-title"
        >
          {row.title}
        </h1>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-4">
          <StatusMenu detail={detail} draft={draft} />
          {row.number !== null ? (
            <span className="font-mono text-(--tertiary-foreground)">#{row.number}</span>
          ) : null}
          <span className="min-w-0 truncate font-mono text-foreground">{row.branch}</span>
          {row.baseRef ? (
            <>
              <ArrowRight />
              <span className="min-w-0 truncate font-mono text-muted-foreground">
                {shortRef(row.baseRef)}
              </span>
            </>
          ) : null}
          {detail.files !== null ? (
            <>
              <span className="text-(--tertiary-foreground)">·</span>
              <span className="text-muted-foreground">{plural(detail.files, "file")}</span>
            </>
          ) : null}
          {detail.additions !== null ? (
            <span className="font-mono text-success-foreground">+{detail.additions}</span>
          ) : null}
          {detail.deletions !== null ? (
            <span className="font-mono text-destructive-text">−{detail.deletions}</span>
          ) : null}
          {conflict ? (
            <>
              <span className="text-(--tertiary-foreground)">·</span>
              <span data-testid="sc-review-conflicts" className="font-medium text-destructive-text">
                {conflict}
              </span>
            </>
          ) : null}
        </div>
        {draft.message ? (
          <output className="text-[12px] leading-4 text-warning">{draft.message}</output>
        ) : null}
        {detail.problem ? (
          <span
            className="text-[12px] leading-4 text-muted-foreground"
            data-testid="sc-review-stale"
          >
            {describeProblem(detail.problem)} This is what bb last read. {readAgo(detail.at, now)}.
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 @3xl:pt-5">
        {row.url ? (
          <a
            href={row.url}
            target="_blank"
            rel="noreferrer"
            aria-label={row.number !== null ? `Open #${row.number} in GitHub` : "Open in GitHub"}
            title="Open in GitHub"
            className="flex size-8 shrink-0 items-center justify-center rounded-[6px] border border-solid border-border text-foreground transition-colors hover:bg-surface-raised motion-reduce:transition-none"
          >
            <GitHubMark />
          </a>
        ) : null}
        {row.state === "draft" && draft.toggle ? (
          <Button
            data-testid="sc-mark-ready"
            className="h-8 px-3 text-[13px] font-semibold"
            disabled={draft.pending}
            onClick={draft.toggle}
          >
            <Pending pending={draft.pending} />
            Mark ready for review
          </Button>
        ) : null}
      </div>
    </header>
  );
}

function Tabs({
  location,
  files,
  go,
  children,
}: {
  location: ReviewLocation & { key: ChangeKey };
  files: number | null;
  go: Go;
  /** The review controls at the row's end (board A). */
  children?: ReactNode;
}) {
  const tabs: { id: ReviewTab; label: string; count: number | null }[] = [
    { id: "files", label: "Files", count: files },
    { id: "commits", label: "Commits", count: null },
    { id: "conversation", label: "Conversation", count: null },
  ];
  return (
    <div
      className={cx(
        // Wrapping in reverse keeps the tabs on the bottom line, against their border.
        "flex shrink-0 flex-wrap-reverse items-end gap-x-6 border-b border-solid border-border-hairline",
        PAD,
      )}
    >
      <div role="tablist" aria-label="Review" className="flex shrink-0 items-center gap-6">
        {tabs.map((tab) => {
          const active = tab.id === location.tab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`sc-tab-${tab.id}`}
              onClick={() => go({ key: location.key, tab: tab.id })}
              className={cx(
                "-mb-px flex cursor-pointer gap-2 border-0 border-b-2 border-solid bg-transparent px-0 py-2 text-[13px] leading-5",
                active
                  ? "border-b-foreground font-semibold text-foreground"
                  : "border-b-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.count !== null ? (
                <span className="font-normal text-(--tertiary-foreground)">{tab.count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {children}
    </div>
  );
}

// ── States ─────────────────────────────────────────────────────────────

function HeaderSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Reading this change"
      data-testid="sc-review-loading"
      className="flex flex-col"
    >
      <div className={cx("flex flex-col gap-3 pt-5 pb-4", PAD)}>
        <Bar className="h-3 w-40" />
        <Bar className="h-6 w-96 max-w-full" />
        <div className="flex items-center gap-2">
          <Bar className="h-6 w-16 rounded-full" />
          <Bar className="h-3 w-72 max-w-full" />
        </div>
      </div>
      <div className={cx("pb-4", PAD)}>
        <Bar className="h-3.5 w-[36rem] max-w-full" />
      </div>
      <div className={cx("flex gap-6 border-b border-solid border-border-hairline py-2.5", PAD)}>
        <Bar className="h-4 w-12" />
        <Bar className="h-4 w-16" />
      </div>
    </div>
  );
}

function Missing({ problem }: { problem: Extract<ChangeDetail, { state: "missing" }>["problem"] }) {
  return (
    <div
      className={cx("flex flex-col gap-2 py-10", PAD)}
      data-testid="sc-review-missing"
      role="alert"
    >
      <h1 className="m-0 text-[16px] leading-6 font-semibold text-foreground">
        bb doesn't know this change
      </h1>
      <p className="m-0 max-w-xl text-[13px] leading-5 text-muted-foreground">
        {problem
          ? describeProblem(problem)
          : "No checkout or pull request bb can read has this branch. It may have been deleted, or the link may be from another bb."}
      </p>
    </div>
  );
}

// ── The selected Change ────────────────────────────────────────────────

function Review({
  location,
  width,
}: {
  location: ReviewLocation & { key: ChangeKey };
  width: number;
}) {
  const { key } = location;
  const query = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "changeDetail",
    keys: [key],
  });
  const detail = query.data?.[key];
  const go = useGo();
  const now = useNow();
  const wide = width >= WIDE;
  const onPath = useCallback(
    (path: string) =>
      go({ key, tab: location.tab, commit: location.commit, path }, { replace: true }),
    [go, key, location.tab, location.commit],
  );
  const onCommit = useCallback((commit: string) => go({ key, tab: "commits", commit }), [go, key]);
  // One per Change (this component is keyed by it): the rail's pick, and the diff that shows it.
  const [focus] = useState(() => new ReviewFocus());
  useLayoutEffect(
    () => focus.onDetached((item) => go({ key, tab: "files", path: item.anchor.path })),
    [focus, go, key],
  );
  if (!detail || detail.state === "pending") {
    if (query.error && !detail)
      return (
        <div className={cx("flex flex-col gap-2 py-10", PAD)} role="alert">
          <p className="m-0 text-[13px] leading-5 text-muted-foreground">
            Couldn't read this change. {query.error.message}
          </p>
          <div>
            <Button onClick={() => void query.refetch()}>Try again</Button>
          </div>
        </div>
      );
    return <HeaderSkeleton />;
  }
  if (detail.state === "missing") return <Missing problem={detail.problem} />;
  const rail = (
    <>
      <RailSections detail={detail} go={go} now={now} />
      <ReviewSection changeKey={key} repo={detail.row.repo} number={detail.row.number} />
    </>
  );
  const lead = wide ? null : (
    <div className="flex flex-col gap-4 border-b border-solid border-border-hairline pb-4">
      {rail}
    </div>
  );
  const { revision } = detail;
  let body;
  if (location.tab === "conversation")
    body = (
      <ConversationView changeKey={key} hasPullRequest={detail.row.number !== null} lead={lead} />
    );
  else if (!revision)
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 px-4 py-4 @3xl:px-6">
          {lead}
          <p
            className="m-0 text-[13px] leading-5 text-muted-foreground"
            data-testid="sc-no-revision"
          >
            {detail.problem
              ? `${describeProblem(detail.problem)} Files appear once bb can read them.`
              : "Files appear once bb has read this change's head and base."}
          </p>
        </div>
      </div>
    );
  else if (location.tab === "commits")
    body = (
      <CommitsView
        changeKey={key}
        revision={revision}
        commit={location.commit}
        path={location.path}
        line={location.line}
        url={detail.row.url}
        now={now}
        lead={lead}
        wide={wide}
        onCommit={onCommit}
        onPath={onPath}
      />
    );
  else
    body = (
      <FilesView
        key={revisionId(key, revision)}
        changeKey={key}
        revision={revision}
        path={location.path}
        line={location.line}
        onPath={onPath}
        lead={lead}
        showTree={wide}
        annotate
      />
    );
  return (
    <FocusContext.Provider value={focus}>
      <Header detail={detail} now={now} />
      <div className={cx("shrink-0 pb-4", PAD)}>
        <ShipPath steps={detail.ship} />
      </div>
      <Tabs location={location} files={detail.files} go={go}>
        <SendControls
          changeKey={key}
          number={detail.row.number}
          isDraft={detail.row.state === "draft"}
          head={detail.head}
        />
      </Tabs>
      <div className="flex min-h-0 min-w-0 flex-1">
        {body}
        {wide ? (
          <aside
            aria-label="Stack, checks and review"
            className="flex w-84 shrink-0 flex-col gap-4 overflow-y-auto overscroll-contain border-s border-solid border-border-hairline py-4 ps-5 pe-8"
          >
            {rail}
          </aside>
        ) : null}
      </div>
    </FocusContext.Provider>
  );
}

function NoSelection() {
  return (
    <div className="flex flex-1 items-center justify-center p-8" data-testid="sc-review-empty">
      <p className="m-0 max-w-sm text-center text-[13px] leading-5 text-muted-foreground">
        Pick a change from the list to review its files and commits.
      </p>
    </div>
  );
}

export function ReviewPage({ subPath }: { subPath: string }) {
  const location = useMemo(() => parseReviewPath(subPath), [subPath]);
  const root = useRef<HTMLDivElement>(null);
  const width = useWidth(root);
  const { key } = location;
  return (
    <div
      ref={root}
      data-bb-plugin="source-control"
      data-testid="sc-review-page"
      className="@container flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground"
    >
      {key ? (
        <Review key={key} location={{ ...location, key }} width={width} />
      ) : width < PHONE ? (
        <ChangesList subPath={subPath} variant="phone" />
      ) : (
        <NoSelection />
      )}
    </div>
  );
}
