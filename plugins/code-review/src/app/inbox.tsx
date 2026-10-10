import { useEffect, useId, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent, ReactNode } from "react";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { INBOX_SECTIONS, parsePrReference, prKey, prSubPath, sameRef } from "../shared/schema.ts";
import type { Inbox as InboxData, InboxPr, InboxSection, PrRef } from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS } from "./components/ui/coarse-pointer-sizing.ts";
import { Input } from "./components/ui/input.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { PANEL_PATH, absoluteTime, plural, relativeTime } from "./format.ts";
import { useStoredChoice } from "./hooks/useStoredChoice.ts";
import { cn, keepInView } from "./lib/utils.ts";
import { Loading, Notice, RetryButton, Tip, errorText } from "./notice.tsx";
import { rpc } from "./rpc.ts";
import {
  Avatar,
  ChecksStateIcon,
  PrStateBadge,
  ReviewDecisionBadge,
  ReviewStateBadge,
  checksLabel,
} from "./status.tsx";

/** How often the inbox asks GitHub again while anything showing it is mounted. */
const INBOX_REFRESH_MS = 120_000;
/** Every reader of the inbox passes these, so the page, the sidebar count, and the pin share one poll. */
export const INBOX_QUERY = { staleTime: 30_000, refetchInterval: INBOX_REFRESH_MS } as const;

export function useInbox() {
  return rpc.inbox.useQuery(INBOX_QUERY);
}

const SECTIONS: readonly {
  id: InboxSection;
  label: string;
  empty: { title: string; detail: string };
}[] = [
  {
    id: "assigned",
    label: "Assigned to me",
    empty: {
      title: "Nothing waiting on you",
      detail: "Pull requests that request your review or are assigned to you show up here.",
    },
  },
  {
    id: "team",
    label: "My team",
    empty: {
      title: "No team review requests",
      detail: "Pull requests that request a review from one of your teams show up here.",
    },
  },
  {
    id: "authored",
    label: "Authored by me",
    empty: {
      title: "No open pull requests",
      detail: "Pull requests you open show up here until they merge or close.",
    },
  },
];

/**
 * Pull requests waiting on the viewer: requested of them or one of their
 * teams, or assigned to them, and not reviewed yet. A pull request in both
 * lists counts once.
 */
export function needsReviewCount(inbox: InboxData): number {
  const waiting = new Set<string>();
  for (const pr of [...inbox.assigned, ...inbox.team]) {
    if (pr.viewerReview === null) waiting.add(prKey(pr.ref));
  }
  return waiting.size;
}

/** The sidebar row's trailing count. Nothing when no review is waiting, or GitHub is unreachable. */
export function NeedsReviewCount() {
  const inbox = useInbox();
  const count = inbox.data ? needsReviewCount(inbox.data) : 0;
  if (count === 0) return null;
  return (
    <span
      className="text-muted-foreground tabular-nums"
      title={`${plural(count, "pull request")} waiting for your review`}
    >
      {count}
    </span>
  );
}

function useOpenPr(): (ref: PrRef) => void {
  const navigate = useBbNavigate();
  return (ref) => navigate.toPluginPanel(PANEL_PATH, { subPath: prSubPath(ref) });
}

/** The Inbox tab: a box to open any pull request by link, then the viewer's queues. */
export function Inbox({ selected }: { selected: PrRef | null }) {
  const inbox = useInbox();
  // The tab the reader last chose, kept across visits.
  const [section, setSection] = useStoredChoice("inbox-section", INBOX_SECTIONS, "assigned");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 px-2.5 pt-2">
        <h2 className="min-w-0 flex-1 truncate font-semibold text-foreground">Pull requests</h2>
        <Tip label="Refresh">
          <Button
            variant="ghost"
            size="icon"
            className={cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS, "text-muted-foreground")}
            aria-label="Refresh pull requests"
            onClick={() => void inbox.refetch()}
          >
            <Icon
              name="RotateCcw"
              className={cn(inbox.isFetching && "motion-safe:animate-spin")}
              aria-hidden
            />
          </Button>
        </Tip>
      </header>
      <PasteLink />
      <Tabs
        value={section}
        onValueChange={(value) => setSection(value as InboxSection)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList
          aria-label="Inbox"
          className="mx-2.5 mt-2 flex h-auto shrink-0 justify-stretch gap-0.5 rounded-md p-0.5"
        >
          {SECTIONS.map(({ id, label }) => (
            <TabsTrigger
              key={id}
              value={id}
              title={label}
              className="h-6 min-w-0 flex-auto gap-1 px-1.5 text-[11px] font-medium"
            >
              <span className="truncate">{label}</span>
              {inbox.data ? (
                <span className="shrink-0 text-subtle-foreground tabular-nums">
                  {inbox.data[id].length}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <div data-inbox-scroll className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-1 pb-6">
          {inbox.data ? (
            SECTIONS.map(({ id, label, empty }) => (
              <TabsContent key={id} value={id} className="mt-0 focus-visible:ring-0">
                <PinnedGroup inbox={inbox.data} selected={selected} />
                <SectionRows
                  label={label}
                  section={id}
                  inbox={inbox.data}
                  selected={selected}
                  empty={empty}
                />
              </TabsContent>
            ))
          ) : inbox.isError ? (
            <Notice
              tone="error"
              title="Could not load your pull requests"
              className="mx-1 mt-2"
              action={<RetryButton onRetry={() => void inbox.refetch()} />}
            >
              {errorText(inbox.error)}
            </Notice>
          ) : (
            <Loading label="Loading pull requests…" rows={6} className="px-1 pt-3" />
          )}
        </div>
      </Tabs>
    </div>
  );
}

/**
 * Opens what the reader pastes or types: a github.com pull request link or
 * `owner/repo#123`. A paste that names one opens it at once; anything else
 * waits for Enter, then says what it expected.
 */
function PasteLink() {
  const open = useOpenPr();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inputId = useId();
  const errorId = useId();

  const tryOpen = (text: string): boolean => {
    const ref = parsePrReference(text);
    if (!ref) return false;
    open(ref);
    setValue("");
    setInvalid(false);
    return true;
  };

  return (
    <form
      className="shrink-0 px-2.5 pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim() && !tryOpen(value)) setInvalid(true);
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Pull request link
      </label>
      <div className="relative">
        <Icon
          name="Search"
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-subtle-foreground"
          aria-hidden
        />
        <Input
          id={inputId}
          value={value}
          placeholder="Paste a pull request link"
          spellCheck={false}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          className={cn(
            "h-7 pl-7 text-xs",
            invalid && "border-surface-destructive-border focus-visible:ring-destructive-text",
          )}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
          }}
          onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
            if (tryOpen(event.clipboardData.getData("text"))) event.preventDefault();
          }}
        />
      </div>
      {invalid ? (
        <p id={errorId} role="alert" className="mt-1 text-[11px] text-destructive-text">
          Not a pull request. Paste a github.com pull request link or owner/repo#123.
        </p>
      ) : null}
    </form>
  );
}

function PinnedGroup({ inbox, selected }: { inbox: InboxData; selected: PrRef | null }) {
  if (inbox.pinned.length === 0) return null;
  return (
    <Group label="Pinned" icon="Pin">
      <Rows prs={inbox.pinned} viewer={inbox.viewer} selected={selected} pinned={inbox.pinned} />
    </Group>
  );
}

function SectionRows({
  label,
  section,
  inbox,
  selected,
  empty,
}: {
  label: string;
  section: InboxSection;
  inbox: InboxData;
  selected: PrRef | null;
  empty: { title: string; detail: string };
}) {
  const prs = inbox[section];
  if (prs.length === 0) {
    return (
      <div className="flex flex-col items-center px-4 py-10 text-center text-muted-foreground">
        <Icon name="GitPullRequest" className="mb-2 size-5 text-subtle-foreground" aria-hidden />
        <p className="font-medium text-foreground">{empty.title}</p>
        <p className="mt-1 max-w-56 leading-normal">{empty.detail}</p>
      </div>
    );
  }
  // The tab names the group already, so its heading is only for the pinned
  // group's sake: without one the two lists would run together.
  return (
    <Group label={label} hidden={inbox.pinned.length === 0}>
      <Rows prs={prs} viewer={inbox.viewer} selected={selected} pinned={inbox.pinned} />
    </Group>
  );
}

function Group({
  label,
  icon,
  hidden = false,
  children,
}: {
  label: string;
  icon?: string;
  hidden?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-1.5">
      <h3
        id={id}
        className={cn(
          "flex items-center gap-1 px-1.5 pt-1.5 pb-1 text-[11px] font-medium text-subtle-foreground",
          hidden && "sr-only",
        )}
      >
        {icon ? <Icon name={icon} className="size-3" aria-hidden /> : null}
        {label}
      </h3>
      {children}
    </section>
  );
}

const ROW_SELECTOR = "[data-inbox-row]";

/** Up and down walk the rows of the whole pane, pinned group included; Home and End jump. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const pane = event.currentTarget.closest("[role=tabpanel]");
  const rows = Array.from(pane?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? []);
  const index = rows.indexOf(event.currentTarget);
  if (index === -1) return;
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : Math.min(Math.max(index + (event.key === "ArrowDown" ? 1 : -1), 0), rows.length - 1);
  event.preventDefault();
  rows[next]?.focus();
}

function Rows({
  prs,
  viewer,
  selected,
  pinned,
}: {
  prs: readonly InboxPr[];
  viewer: string;
  selected: PrRef | null;
  pinned: readonly InboxPr[];
}) {
  return (
    <ul className="flex flex-col gap-px">
      {prs.map((pr) => (
        <li key={prKey(pr.ref)}>
          <Row
            pr={pr}
            viewer={viewer}
            selected={selected !== null && sameRef(selected, pr.ref)}
            pinned={pinned.some((item) => sameRef(item.ref, pr.ref))}
          />
        </li>
      ))}
    </ul>
  );
}

/** What the row says about review: the verdict on the viewer's own work, or the viewer's part in someone else's. */
function RowReview({ pr, viewer }: { pr: InboxPr; viewer: string }) {
  if (pr.author?.login === viewer) {
    return pr.reviewDecision ? <ReviewDecisionBadge decision={pr.reviewDecision} /> : null;
  }
  if (pr.viewerReview) return <ReviewStateBadge state={pr.viewerReview} />;
  return pr.reviewRequestedFromViewer ? <ReviewStateBadge state="requested" /> : null;
}

function Row({
  pr,
  viewer,
  selected,
  pinned,
}: {
  pr: InboxPr;
  viewer: string;
  selected: boolean;
  pinned: boolean;
}) {
  const open = useOpenPr();
  const ref = useRef<HTMLButtonElement>(null);
  // A deep link opens with its row possibly far down the list.
  useEffect(() => {
    const row = ref.current;
    const area = row?.closest<HTMLElement>("[data-inbox-scroll]");
    if (selected && row && area) keepInView(area, row);
  }, [selected]);
  return (
    <button
      ref={ref}
      type="button"
      data-inbox-row
      aria-current={selected ? "page" : undefined}
      onClick={() => open(pr.ref)}
      onKeyDown={moveFocus}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-1 rounded-md px-2 py-2 text-left outline-none",
        "hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",
        selected && "bg-surface-selected hover:bg-surface-selected",
      )}
    >
      <span className="flex w-full items-center gap-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">
          {pr.ref.owner}/{pr.ref.repo}
        </span>
        <span className="shrink-0 tabular-nums">#{pr.ref.number}</span>
        {pinned ? (
          <span className="inline-flex shrink-0">
            <Icon name="Pin" className="size-3 text-subtle-foreground" aria-hidden />
            <span className="sr-only">Pinned</span>
          </span>
        ) : null}
        <time
          dateTime={pr.updatedAt}
          title={`Updated ${absoluteTime(pr.updatedAt)}`}
          className="ms-auto shrink-0 ps-2 text-subtle-foreground"
        >
          {relativeTime(pr.updatedAt)}
        </time>
      </span>
      <span className="line-clamp-2 leading-snug font-medium text-foreground [overflow-wrap:anywhere]">
        {pr.title}
      </span>
      <span className="flex w-full items-center gap-1.5 text-[11px] text-muted-foreground">
        {pr.author ? (
          <span className="flex min-w-0 items-center gap-1">
            <Avatar login={pr.author.login} url={pr.author.avatarUrl} className="size-3.5" />
            <span className="truncate">{pr.author.login}</span>
          </span>
        ) : null}
        <span className="ms-auto flex shrink-0 items-center gap-1.5">
          {pr.isDraft || pr.state !== "open" ? (
            <PrStateBadge state={pr.state} isDraft={pr.isDraft} />
          ) : null}
          <ChecksStateIcon
            state={pr.checks}
            label={pr.checks ? `Checks: ${checksLabel(pr.checks)}` : undefined}
          />
          <RowReview pr={pr} viewer={viewer} />
        </span>
      </span>
    </button>
  );
}
