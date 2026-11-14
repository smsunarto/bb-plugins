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
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { useOpenGuide } from "../guide-data.ts";
import { MergeButton, mergeTarget, useChangeMerge } from "../merge.tsx";
import { useChangeReview } from "../review-data.ts";
import { SendControls } from "../send.tsx";
import { ShipPath } from "../status.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { Pending } from "../ui.tsx";
import { ChangesList } from "./changes-nav.tsx";
import { CommitsView } from "./commits-view.tsx";
import { ConversationView } from "./conversation-view.tsx";
import { FilesView } from "./files-view.tsx";
import { GuidedView, ViewedProgress } from "./guided-view.tsx";
import { PANEL_PATH, PHONE, WIDE, useGo, useNow, useWidth, type Go } from "./hooks.ts";
import { AskHost, BotIcon, useAskAgent } from "./ask-panel.tsx";
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
  const { state } = detail.row;
  const icon = <StateIcon state={state} size={11} />;
  if (!draft.toggle)
    return (
      <span className={CHIP} data-testid="sc-review-state">
        {icon}
        {detail.status.label}
      </span>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-testid="sc-review-state" className={cx(CHIP, "cursor-pointer")}>
          {icon}
          {detail.status.label}
          <Chevron />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem disabled={draft.pending} onSelect={() => draft.toggle?.()}>
          {state === "draft" ? "Mark ready for review" : "Convert to draft"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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

/** "Ask agent" (board A): opens the floating conversation about this Change. */
function AskButton({ compact }: { compact?: boolean }) {
  const ask = useAskAgent();
  if (!ask) return null;
  return (
    <Button
      variant="outline"
      data-testid="sc-ask-agent"
      aria-label={compact ? "Ask agent" : undefined}
      title={compact ? "Ask agent" : undefined}
      onClick={(event) => ask({ trigger: event.currentTarget })}
      className={cx(
        "border-border bg-surface-raised hover:bg-surface-recessed",
        compact ? "size-7 px-0" : "h-8 gap-2 px-3 text-[13px] leading-5",
      )}
    >
      <BotIcon />
      {compact ? null : "Ask agent"}
    </Button>
  );
}

/** The pull request in `owner/name`, from a row of a GitHub Change; null for a branch without one. */
function prRefOf(row: Ready["row"]) {
  const slash = row.repo.indexOf("/");
  if (row.number === null || slash <= 0) return null;
  return { owner: row.repo.slice(0, slash), repo: row.repo.slice(slash + 1), number: row.number };
}

/** Pins the pull request to the Changes list, or unpins it: the list's Pinned filter. */
function PinButton({ row, compact }: { row: Ready["row"]; compact?: boolean }) {
  const ref = useMemo(() => prRefOf(row), [row]);
  const pins = useRpcQuery({ contract: sourceControlContract, method: "pins", input: {} });
  const setPinned = useRpcMutation({ contract: sourceControlContract, method: "setPinned" });
  const [chosen, setChosen] = useState<boolean | null>(null);
  if (!ref) return null;
  const listed =
    pins.data?.pins.some(
      (pin) =>
        pin.number === ref.number &&
        `${pin.owner}/${pin.repo}`.toLowerCase() === `${ref.owner}/${ref.repo}`.toLowerCase(),
    ) ?? false;
  const pinned = chosen ?? listed;
  const label = pinned ? "Unpin from the Changes list" : "Pin to the Changes list";
  return (
    <Button
      variant="outline"
      data-testid="sc-pin"
      aria-pressed={pinned}
      aria-label={label}
      title={label}
      disabled={pins.data === undefined || setPinned.isPending}
      onClick={() => {
        const next = !pinned;
        setChosen(next);
        setPinned.mutate({ ref, pinned: next }).catch(() => setChosen(null));
      }}
      className={cx(
        "border-border px-0 hover:bg-surface-raised",
        compact ? "size-7" : "size-8",
        pinned ? "bg-surface-raised text-foreground" : "bg-transparent text-muted-foreground",
      )}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill={pinned ? "currentColor" : "none"}
        aria-hidden
      >
        <path
          d="M9.5 1.5 14.5 6.5 12 7.5 9.5 10 9 13.5 2.5 7 6 6.5 8.5 4z M5.5 10.5 2 14"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    </Button>
  );
}

/** Merge for an open pull request, at the head and base the header shows. */
function PageMerge({ detail }: { detail: Ready }) {
  const submit = useChangeMerge();
  const target = mergeTarget(detail);
  if (!target) return null;
  return (
    <MergeButton
      submit={submit}
      target={target}
      className="h-8 px-3 text-[13px] font-semibold"
      label="Merge"
    />
  );
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
        <PinButton row={row} />
        <AskButton />
        <PageMerge detail={detail} />
        {row.state === "draft" && draft.toggle ? (
          <Button
            variant="outline"
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

function ReviewTabs({
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
    { id: "guided", label: "Guided", count: null },
    { id: "files", label: "Files", count: files },
    { id: "commits", label: "Commits", count: null },
    { id: "conversation", label: "Conversation", count: null },
  ];
  return (
    <Tabs
      value={location.tab}
      // Arrow keys move focus along the tabs; Enter or a click opens one.
      activationMode="manual"
      onValueChange={(tab) => go({ key: location.key, tab: tab as ReviewTab })}
      className={cx(
        // Wrapping in reverse keeps the tabs on the bottom line, against their border.
        "shrink-0 flex-row flex-wrap-reverse items-end gap-x-6 border-b border-solid border-border-hairline",
        PAD,
      )}
    >
      <TabsList aria-label="Review" className="gap-6">
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.id}
            value={tab.id}
            data-testid={`sc-tab-${tab.id}`}
            className="-mb-px gap-2 border-b-2 border-solid border-b-transparent px-0 py-2 text-[13px] leading-5 hover:text-foreground data-[state=active]:border-b-foreground data-[state=active]:font-semibold"
          >
            {tab.label}
            {tab.count !== null ? (
              <span className="font-normal text-(--tertiary-foreground)">{tab.count}</span>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
      {children}
    </Tabs>
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
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-6 w-96 max-w-full" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-3 w-72 max-w-full" />
        </div>
      </div>
      <div className={cx("pb-4", PAD)}>
        <Skeleton className="h-3.5 w-[36rem] max-w-full" />
      </div>
      <div className={cx("flex gap-6 border-b border-solid border-border-hairline py-2.5", PAD)}>
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-16" />
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

// ── Phone header (board E) ─────────────────────────────────────────────

/** Board E's compact head: back to the list, the title and number, then state, findings and checks. */
function PhoneHeader({ detail }: { detail: Ready }) {
  const { row } = detail;
  const navigate = useBbNavigate();
  const draft = useDraftToggle(detail);
  const { stable } = useChangeReview(row.key);
  const open = stable.items.filter(
    (item) => item.state === "open" && item.priority !== null,
  ).length;
  const checks = detail.ship.find((step) => step.id === "checks");
  const checksText = checks?.detail.map((part) => part.text).join(" · ");
  return (
    <header className="flex shrink-0 flex-col" data-testid="sc-phone-header">
      <div className="flex min-w-0 items-center gap-3 px-4 pt-2 pb-3">
        <button
          type="button"
          aria-label="Back to changes"
          onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "" })}
          // The pseudo-element widens the tap target to 36px without moving the title.
          className="relative flex size-5 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-foreground after:absolute after:-inset-2"
        >
          <Chevron className="rotate-90" />
        </button>
        <h1
          className="m-0 min-w-0 flex-1 truncate text-[15px] leading-5 font-semibold text-foreground"
          data-testid="sc-review-title"
        >
          {row.title}
        </h1>
        {row.number !== null ? (
          <span className="shrink-0 text-[13px] leading-5 text-(--tertiary-foreground)">
            #{row.number}
          </span>
        ) : null}
        <PinButton row={detail.row} compact />
        <AskButton compact />
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-5 pt-1 pb-3">
        <span className="flex min-w-0 items-center gap-2 text-[13px] leading-5 text-foreground">
          <StatusMenu detail={detail} draft={draft} />
          {open > 0 ? <span>{plural(open, "finding")} to settle</span> : null}
        </span>
        {checks && checksText ? (
          <span
            className={cx(
              "text-[13px] leading-5",
              checks.state === "failed"
                ? "text-destructive-text"
                : checks.state === "running"
                  ? "text-warning"
                  : "text-muted-foreground",
            )}
          >
            Checks {checksText}
          </span>
        ) : null}
      </div>
      {draft.message ? (
        <output className="px-5 pb-2 text-[12px] leading-4 text-warning">{draft.message}</output>
      ) : null}
    </header>
  );
}

// ── The selected Change ────────────────────────────────────────────────

type Here = ReviewLocation & { key: ChangeKey };

/** The tab's body: no files before a revision is known, else the tab's own view. */
function TabBody({
  location,
  detail,
  lead,
  wide,
  phone,
  now,
  send,
  onPath,
  onCommit,
}: {
  location: Here;
  detail: Ready;
  lead: ReactNode;
  wide: boolean;
  phone: boolean;
  now: number;
  send: ReactNode;
  onPath: (path: string) => void;
  onCommit: (commit: string) => void;
}) {
  const { key, tab } = location;
  const { revision } = detail;
  if (tab === "conversation")
    return (
      <ConversationView changeKey={key} hasPullRequest={detail.row.number !== null} lead={lead} />
    );
  if (!revision)
    return (
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
  if (tab === "guided")
    return (
      <GuidedView
        changeKey={key}
        revision={revision}
        path={location.path}
        line={location.line}
        onPath={onPath}
        // Board E opens on the guide: the rail's sections stay on the other tabs.
        lead={phone ? null : lead}
        wide={wide}
        phone={phone}
        bar={phone ? send : null}
      />
    );
  if (tab === "commits")
    return (
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
  return (
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
}

/** The tab row's end: viewed progress on the file tabs, then the send controls unless the phone's bar has them. */
function TabControls({
  location,
  detail,
  send,
  phoneGuided,
}: {
  location: Here;
  detail: Ready;
  send: ReactNode;
  phoneGuided: boolean;
}) {
  const { revision } = detail;
  const progress =
    revision && (location.tab === "guided" || location.tab === "files") ? (
      <ViewedProgress changeKey={location.key} revision={revision} />
    ) : null;
  if (!progress && phoneGuided) return null;
  return (
    <div className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-3">
      {progress}
      {phoneGuided ? null : (
        <>
          {progress ? <span aria-hidden className="h-4 w-px shrink-0 bg-border" /> : null}
          {send}
        </>
      )}
    </div>
  );
}

function ReviewReady({
  location,
  detail,
  width,
  focus,
}: {
  location: Here;
  detail: Ready;
  width: number;
  focus: ReviewFocus;
}) {
  const { key } = location;
  const go = useGo();
  const now = useNow();
  const wide = width >= WIDE;
  const phone = width < PHONE;
  const onPath = useCallback(
    (path: string) =>
      go({ key, tab: location.tab, commit: location.commit, path }, { replace: true }),
    [go, key, location.tab, location.commit],
  );
  const onCommit = useCallback((commit: string) => go({ key, tab: "commits", commit }), [go, key]);
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
  const send = (
    <SendControls
      changeKey={key}
      number={detail.row.number}
      isDraft={detail.row.state === "draft"}
      head={detail.head}
    />
  );
  // On a phone the guided screen carries the send controls in its bottom bar (board E).
  const phoneGuided = phone && location.tab === "guided";
  return (
    <FocusContext.Provider value={focus}>
      {phoneGuided ? (
        <PhoneHeader detail={detail} />
      ) : (
        <>
          <Header detail={detail} now={now} />
          <div className={cx("shrink-0 pb-4", PAD)}>
            <ShipPath steps={detail.ship} />
          </div>
        </>
      )}
      <ReviewTabs location={location} files={detail.files} go={go}>
        <TabControls location={location} detail={detail} send={send} phoneGuided={phoneGuided} />
      </ReviewTabs>
      <div className="flex min-h-0 min-w-0 flex-1">
        <TabBody
          location={location}
          detail={detail}
          lead={lead}
          wide={wide}
          phone={phone}
          now={now}
          send={send}
          onPath={onPath}
          onCommit={onCommit}
        />
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

function Review({ location, width }: { location: Here; width: number }) {
  const { key } = location;
  const query = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "changeDetail",
    keys: [key],
  });
  const detail = query.data?.[key];
  const go = useGo();
  // One per Change (this component is keyed by it): the rail's pick, and the diff that shows it.
  const [focus] = useState(() => new ReviewFocus());
  // The one place a guide run starts: this page opening the Change, once per mount.
  useOpenGuide(key, detail?.state === "change");
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
            <Button variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </div>
        </div>
      );
    return <HeaderSkeleton />;
  }
  if (detail.state === "missing") return <Missing problem={detail.problem} />;
  return <ReviewReady location={location} detail={detail} width={width} focus={focus} />;
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
      className="@container relative flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground"
    >
      <AskHost changeKey={key} phone={width < PHONE}>
        {key ? (
          <Review key={key} location={{ ...location, key }} width={width} />
        ) : width < PHONE ? (
          <ChangesList subPath={subPath} variant="phone" />
        ) : (
          <NoSelection />
        )}
      </AskHost>
    </div>
  );
}
