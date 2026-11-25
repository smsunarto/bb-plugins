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
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { describeProblem, readAgo, type ForgeAction, type ForgeResult } from "../../core/change.ts";
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
import { SendControls, useSendControls } from "../send.tsx";
import { DETAIL_TONE, ShipPath } from "../status.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button, CompactButton } from "../components/ui/button.tsx";
import { Separator } from "../components/ui/separator.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { Hint, OpenOnGitHub, Pending } from "../ui.tsx";
import { ChangesList } from "./changes-nav.tsx";
import { CommitsView } from "./commits-view.tsx";
import { ConversationView, PullRequestDescription } from "./conversation-view.tsx";
import { PrImagesContext } from "../pr-markdown.tsx";
import { FilesView, WrapContext } from "./files-view.tsx";
import { GuidedView, ViewedProgress } from "./guided-view.tsx";
import { ReviewBar, ReviewScroller } from "./review-bar.tsx";
import { PANEL_PATH, PHONE, WIDE, useGo, useIsPage, useNow, useWidth, type Go } from "./hooks.ts";
import { AskHost, BotIcon, useAskAgent } from "./ask-panel.tsx";
import { ArrowRight, Chevron, StackIcon, StateIcon } from "./icons.tsx";
import { revisionId } from "./patches.ts";
import { RailSections } from "./rail.tsx";
import { FocusContext, ReviewFocus } from "./review-focus.ts";
import { ReviewSection } from "./review-section.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";

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

/**
 * Mark ready, Convert to draft, or Close, only while the pull request is
 * still at the head the reader sees. Close is offered on the reader's own
 * pull requests, as Convert to draft is.
 */
function useStateActions(detail: Ready) {
  const mutation = useRpcMutation({ contract: sourceControlContract, method: "changeForgeAction" });
  const [outcome, setOutcome] = useState<Outcome>(null);
  const mutate = useRef(mutation.mutate);
  useLayoutEffect(() => {
    mutate.current = mutation.mutate;
  });
  const { row, head } = detail;
  const pending = mutation.pendingInputs.some((input) => input.key === row.key);
  const live = row.number !== null && head !== null;
  const canToggle =
    live && ((row.state === "draft" && detail.canMarkReady) || (row.state === "open" && row.mine));
  const canClose = live && row.mine && (row.state === "draft" || row.state === "open");
  return useMemo(() => {
    const run = (action: ForgeAction) => () => {
      setOutcome(null);
      mutate.current({ key: row.key, action, expected: { number: row.number!, head: head! } }).then(
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
    };
    return {
      toggle: canToggle ? run({ kind: "setDraft", draft: row.state !== "draft" }) : null,
      close: canClose ? run({ kind: "close" }) : null,
      pending,
      message: outcomeText(outcome, head),
    };
  }, [canToggle, canClose, row.key, row.state, row.number, head, pending, outcome]);
}

/** The status chip's pill, its glyphs at 12px rather than the shared Button's 16px. */
const CHIP = "h-6 gap-1 rounded-full px-2 [&_svg]:size-3";

function StatusMenu({
  detail,
  draft,
}: {
  detail: Ready;
  draft: ReturnType<typeof useStateActions>;
}) {
  const { state } = detail.row;
  const icon = <StateIcon state={state} size={11} />;
  if (!draft.toggle && !draft.close)
    return (
      <Badge variant="secondary" className={CHIP} data-testid="sc-review-state">
        {icon}
        {detail.status.label}
      </Badge>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" data-testid="sc-review-state" className={CHIP}>
          {icon}
          {detail.status.label}
          <Chevron />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {draft.toggle ? (
          <DropdownMenuItem disabled={draft.pending} onSelect={() => draft.toggle?.()}>
            {state === "draft" ? "Mark ready for review" : "Convert to draft"}
          </DropdownMenuItem>
        ) : null}
        {draft.close ? (
          <DropdownMenuItem
            variant="destructive"
            data-testid="sc-close-pr"
            disabled={draft.pending}
            onSelect={() => draft.close?.()}
          >
            Close pull request
          </DropdownMenuItem>
        ) : null}
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
    <Hint label={compact ? "Ask agent" : null}>
      <CompactButton
        size={compact ? "sm" : "default"}
        variant="outline"
        data-testid="sc-ask-agent"
        aria-label={compact ? "Ask agent" : undefined}
        onClick={(event) => ask({ trigger: event.currentTarget })}
        className={cx(
          "bg-surface-raised hover:bg-surface-recessed",
          compact ? "w-7 px-0" : "gap-2",
        )}
      >
        <BotIcon />
        {compact ? null : "Ask agent"}
      </CompactButton>
    </Hint>
  );
}

/** Merge for an open pull request, at the head and base the header shows. */
function PageMerge({ detail, compact }: { detail: Ready; compact?: boolean }) {
  const submit = useChangeMerge();
  const target = mergeTarget(detail);
  if (!target) return null;
  return (
    <MergeButton submit={submit} target={target} size={compact ? "sm" : "default"} label="Merge" />
  );
}

function Header({ detail, now }: { detail: Ready; now: number }) {
  const { row } = detail;
  const draft = useStateActions(detail);
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
          <OpenOnGitHub
            href={row.url}
            label={row.number !== null ? `Open #${row.number} in GitHub` : "Open in GitHub"}
          />
        ) : null}
        <AskButton />
        <PageMerge detail={detail} />
        {row.state === "draft" && draft.toggle ? (
          <Button
            size="sm"
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
    { id: "overview", label: "Overview", count: null },
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
        "flex shrink-0 flex-row flex-wrap-reverse items-end gap-x-6 border-b border-solid border-border-hairline",
        PAD,
      )}
    >
      <TabsList
        aria-label="Review"
        // The list overlaps the row's border by a pixel so the active underline sits on it. Under
        // 24rem, where the four tabs no longer fit, it scrolls sideways rather than clipping one,
        // and its end fades: over a tab while more lies beyond, over its own padding at the end.
        className="-mb-px h-auto max-w-full justify-start gap-6 rounded-none bg-transparent p-0 [scrollbar-width:none] @max-sm:overflow-x-auto @max-sm:pe-6 @max-sm:[mask-image:linear-gradient(to_right,currentColor_calc(100%-1.5rem),transparent)] @max-xs:gap-4"
      >
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.id}
            value={tab.id}
            data-testid={`sc-tab-${tab.id}`}
            className="cursor-pointer gap-2 rounded-none border-b-2 border-solid border-b-transparent px-0 py-2 text-[13px] leading-5 font-normal hover:text-foreground data-[state=active]:border-b-foreground data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:shadow-none"
          >
            {tab.label}
            {tab.count !== null ? <Badge variant="count">{tab.count}</Badge> : null}
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
        <Skeleton className="h-4 w-[36rem] max-w-full" />
      </div>
      <div
        className={cx(
          "flex h-10 items-center gap-6 border-b border-solid border-border-hairline",
          PAD,
        )}
      >
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

/**
 * Board E's compact head, on every tab of a phone: back to the list, the
 * title and the page's actions, then one line of state, number, findings,
 * checks and viewed progress, and a line for a conflict or a stale read.
 * The full header and ship path would take half the screen before any file.
 */
function PhoneHeader({ detail, now }: { detail: Ready; now: number }) {
  const { row } = detail;
  const conflict = conflictText(row);
  const navigate = useBbNavigate();
  const page = useIsPage();
  const draft = useStateActions(detail);
  const { stable } = useChangeReview(row.key);
  const open = stable.items.filter(
    (item) => item.state === "open" && item.priority !== null,
  ).length;
  const checks = detail.ship.find((step) => step.id === "checks");
  return (
    <header className="flex shrink-0 flex-col gap-3 pt-2 pb-3" data-testid="sc-phone-header">
      <div className="flex min-w-0 items-center gap-3 px-4">
        {/* The side panel's Review tab has no Changes list to go back to. */}
        {page ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to changes"
            onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "" })}
            // The pseudo-element widens the tap target to 36px without moving the title.
            className="relative size-5 after:absolute after:-inset-2 [&_svg]:size-3"
          >
            <Chevron className="rotate-90" />
          </Button>
        ) : null}
        <h1
          className="m-0 line-clamp-2 min-w-0 flex-1 text-[15px] leading-5 font-semibold break-words text-foreground"
          data-testid="sc-review-title"
        >
          {row.title}
        </h1>
        <span className="flex shrink-0 items-center gap-2">
          <PageMerge detail={detail} compact />
          {row.url ? (
            <OpenOnGitHub
              href={row.url}
              label={row.number !== null ? `Open #${row.number} in GitHub` : "Open in GitHub"}
              compact
            />
          ) : null}
          <AskButton compact />
        </span>
      </div>
      {/* The checks give way first, so state, number and progress show; a narrow panel wraps progress. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 text-[13px] leading-5">
        <StatusMenu detail={detail} draft={draft} />
        {row.number !== null ? (
          <span className="shrink-0 font-mono text-(--tertiary-foreground)">#{row.number}</span>
        ) : null}
        {open > 0 ? (
          <span className="shrink-0 text-foreground">{plural(open, "finding")}</span>
        ) : null}
        {checks && checks.detail.length > 0 ? (
          <span className="min-w-0 flex-1 truncate" data-testid="sc-phone-checks">
            <span className="text-muted-foreground @max-sm:sr-only">Checks</span>
            {checks.detail.map((part) => (
              <span key={part.text} className={DETAIL_TONE[part.tone]}>
                {" "}
                {part.text}
              </span>
            ))}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {detail.revision ? (
          <ViewedProgress changeKey={row.key} revision={detail.revision} compact />
        ) : null}
      </div>
      {conflict ? (
        <span
          data-testid="sc-review-conflicts"
          className="px-4 text-[12px] leading-4 font-medium text-destructive-text"
        >
          {conflict}
        </span>
      ) : null}
      {draft.message ? (
        <output className="px-4 text-[12px] leading-4 text-warning">{draft.message}</output>
      ) : null}
      {detail.problem ? (
        <span
          className="px-4 text-[12px] leading-4 text-muted-foreground"
          data-testid="sc-review-stale"
        >
          {describeProblem(detail.problem)} This is what bb last read. {readAgo(detail.at, now)}.
        </span>
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
  bar,
  onPath,
  onCommit,
}: {
  location: Here;
  detail: Ready;
  lead: ReactNode;
  wide: boolean;
  phone: boolean;
  now: number;
  /** The phone's bottom-bar send controls, or null. */
  bar: ReactNode;
  onPath: (path: string) => void;
  onCommit: (commit: string) => void;
}) {
  const { key, tab } = location;
  const { revision } = detail;
  const floatingBar =
    bar && tab !== "overview" ? (
      <PhoneBar changeKey={key} revision={revision}>
        {bar}
      </PhoneBar>
    ) : null;
  const description =
    tab === "overview" && detail.row.number !== null ? (
      <PullRequestDescription changeKey={key} />
    ) : null;
  if (tab === "conversation")
    return (
      <ConversationView
        changeKey={key}
        hasPullRequest={detail.row.number !== null}
        lead={lead}
        bar={floatingBar}
      />
    );
  if (!revision)
    return (
      <ReviewScroller
        bar={floatingBar}
        className="min-h-0 flex-1 overflow-y-auto"
        contentClassName="flex flex-col gap-4 px-4 pt-4 @3xl:px-6"
      >
        {lead}
        {description}
        <p className="m-0 text-[13px] leading-5 text-muted-foreground" data-testid="sc-no-revision">
          {detail.problem
            ? `${describeProblem(detail.problem)} Files appear once bb can read them.`
            : "Files appear once bb has read this change's head and base."}
        </p>
      </ReviewScroller>
    );
  if (tab === "overview")
    return (
      <GuidedView
        changeKey={key}
        revision={revision}
        path={location.path}
        line={location.line}
        onPath={onPath}
        // Board E opens on the guide: the rail's sections stay on the other tabs.
        lead={phone ? null : lead}
        description={description}
        wide={wide}
        phone={phone}
        bar={bar}
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
        bar={floatingBar}
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
      bar={floatingBar}
      showTree={wide}
      annotate
    />
  );
}

/** The tab row's end: viewed progress on the file tabs, then the send controls. A phone has both elsewhere. */
function TabControls({
  location,
  detail,
  send,
}: {
  location: Here;
  detail: Ready;
  send: ReactNode;
}) {
  const { revision } = detail;
  const progress =
    revision && (location.tab === "overview" || location.tab === "files") ? (
      <ViewedProgress changeKey={location.key} revision={revision} />
    ) : null;
  return (
    <div className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-3">
      {progress}
      {progress ? <Separator orientation="vertical" className="h-4 self-center" /> : null}
      {send}
    </div>
  );
}

const NO_ORDER: ReadonlyMap<string, number> = new Map();

/** The phone's review bar off the guide: items step in the Files tab's order once a revision is known. */
function PhoneBar({
  changeKey,
  revision,
  children,
}: {
  changeKey: ChangeKey;
  revision: Ready["revision"];
  children: ReactNode;
}) {
  if (!revision)
    return (
      <ReviewBar changeKey={changeKey} order={NO_ORDER}>
        {children}
      </ReviewBar>
    );
  return (
    <OrderedBar changeKey={changeKey} revision={revision}>
      {children}
    </OrderedBar>
  );
}

function OrderedBar({
  changeKey,
  revision,
  children,
}: {
  changeKey: ChangeKey;
  revision: NonNullable<Ready["revision"]>;
  children: ReactNode;
}) {
  const query = useRpcQuery({
    contract: sourceControlContract,
    method: "changeFiles",
    input: { key: changeKey, revision },
  });
  const files = query.data?.ok ? query.data.files : null;
  const order = useMemo(
    () => (files ? new Map(files.map((file, index) => [file.path, index])) : NO_ORDER),
    [files],
  );
  return (
    <ReviewBar changeKey={changeKey} order={order}>
      {children}
    </ReviewBar>
  );
}

function ReviewReady({
  location,
  detail,
  width,
  focus,
  sendControls,
}: {
  location: Here;
  detail: Ready;
  width: number;
  focus: ReviewFocus;
  sendControls: ReturnType<typeof useSendControls>;
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
      controls={sendControls}
      isDraft={detail.row.state === "draft"}
      size={phone ? "bar" : "row"}
    />
  );
  return (
    <FocusContext.Provider value={focus}>
      <WrapContext.Provider value={phone}>
        {phone ? (
          <PhoneHeader detail={detail} now={now} />
        ) : (
          <>
            <Header detail={detail} now={now} />
            <div className={cx("shrink-0 pb-4", PAD)}>
              <ShipPath steps={detail.ship} />
            </div>
          </>
        )}
        <ReviewTabs location={location} files={detail.files} go={go}>
          {phone ? null : <TabControls location={location} detail={detail} send={send} />}
        </ReviewTabs>
        <div className="flex min-h-0 min-w-0 flex-1">
          <PrImagesContext value={location.key}>
            <TabBody
              location={location}
              detail={detail}
              lead={lead}
              wide={wide}
              phone={phone}
              now={now}
              bar={phone ? send : null}
              onPath={onPath}
              onCommit={onCommit}
            />
          </PrImagesContext>
          {wide ? (
            <aside
              aria-label="Stack, checks and review"
              className="flex w-84 shrink-0 flex-col gap-4 overflow-y-auto overscroll-contain border-s border-solid border-border-hairline py-4 ps-5 pe-8"
            >
              {rail}
            </aside>
          ) : null}
        </div>
      </WrapContext.Provider>
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
  const ready = detail?.state === "change" ? detail : null;
  const sendControls = useSendControls(key, ready?.row.number ?? null, ready?.head ?? null);
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
            <CompactButton size="sm" variant="outline" onClick={() => void query.refetch()}>
              Try again
            </CompactButton>
          </div>
        </div>
      );
    return <HeaderSkeleton />;
  }
  if (detail.state === "missing") return <Missing problem={detail.problem} />;
  return (
    <ReviewReady
      location={location}
      detail={detail}
      width={width}
      focus={focus}
      sendControls={sendControls}
    />
  );
}

function NoSelection() {
  return (
    <div className="flex flex-1 items-center justify-center p-8" data-testid="sc-review-empty">
      <EmptyState
        className="max-w-sm"
        messageClassName="m-0 text-center"
        message="Pick a change from the list to review its files and commits."
      />
    </div>
  );
}

export function ReviewPage({ subPath }: { subPath: string }) {
  const location = useMemo(() => parseReviewPath(subPath), [subPath]);
  return <ReviewView location={location} subPath={subPath} />;
}

/** The review of `location`, as the page draws it, laid out for the window's width at first. */
export function ReviewView({
  location,
  subPath,
}: {
  location: ReviewLocation;
  /** The page's subPath, for the phone's Changes list when no Change is picked. */
  subPath: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  return <ReviewFrame root={root} width={useWidth(root)} location={location} subPath={subPath} />;
}

/**
 * The review of one Change in a side panel tab. The window says nothing about
 * the panel's width, so it draws once the panel has been measured, never a
 * layout for the wrong width.
 */
export function PanelReview({ location }: { location: Here }) {
  const root = useRef<HTMLDivElement>(null);
  return <ReviewFrame root={root} width={useWidth(root, true)} location={location} subPath="" />;
}

function ReviewFrame({
  root,
  width,
  location,
  subPath,
}: {
  root: RefObject<HTMLDivElement | null>;
  /** Null until measured: nothing is drawn yet. */
  width: number | null;
  location: ReviewLocation;
  subPath: string;
}) {
  const { key } = location;
  return (
    <div
      ref={root}
      data-bb-plugin="source-control"
      data-testid="sc-review-page"
      // Under bb Monokai on a phone the page runs under the home indicator; the phone
      // list and the guided view's action bar pad by --plugin-page-bottom-inset.
      className="@container relative flex h-[calc(100%+var(--plugin-page-bottom-inset,0px))] mb-[calc(-1*var(--plugin-page-bottom-inset,0px))] min-h-0 min-w-0 flex-col bg-background text-foreground"
    >
      {width === null ? null : (
        <AskHost changeKey={key} phone={width < PHONE}>
          {key ? (
            <Review key={key} location={{ ...location, key }} width={width} />
          ) : width < PHONE ? (
            <ChangesList subPath={subPath} variant="phone" />
          ) : (
            <NoSelection />
          )}
        </AskHost>
      )}
    </div>
  );
}
