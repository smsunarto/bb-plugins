import { useEffect, useId, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent, ReactNode } from "react";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import {
  branchSubPath,
  parsePrReference,
  prKey,
  prSubPath,
  sameAccount,
  sameRef,
} from "../shared/schema.ts";
import type {
  Inbox as InboxData,
  InboxPr,
  InboxSection,
  LocalBranch,
  PrRef,
} from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS } from "./components/ui/coarse-pointer-sizing.ts";
import { Input } from "./components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { PANEL_PATH, absoluteTime, plural, relativeTime } from "./format.ts";
import { useStoredChoice } from "./hooks/useStoredChoice.ts";
import { cn, keepInView } from "./lib/utils.ts";
import { Loading, Notice, RetryButton, Tip, errorText } from "./notice.tsx";
import { rpc } from "./rpc.ts";
import { SyncState, useReconcile, usePrPrefetch } from "./sync-state.tsx";
import {
  AccountAvatar,
  Avatar,
  BranchStatusChip,
  ChecksStateIcon,
  PrStateBadge,
  ReviewDecisionBadge,
  ReviewStateBadge,
  checksLabel,
} from "./status.tsx";

/** How often the inbox asks GitHub again while anything showing it is mounted. */
const INBOX_REFRESH_MS = 120_000;
/** Every reader of the inbox passes these, so the page, the navigation badge, and the pin share one poll. */
export const INBOX_QUERY = { staleTime: 30_000, refetchInterval: INBOX_REFRESH_MS } as const;

export function useInbox() {
  return rpc.inbox.useQuery(INBOX_QUERY);
}

/**
 * Unpublished branches take seconds to read, as every machine is asked, so
 * the inbox and a branch's page share one read, polled like the inbox.
 */
const LOCAL_BRANCHES_QUERY = { staleTime: 30_000, refetchInterval: INBOX_REFRESH_MS } as const;

export function useLocalBranches() {
  return rpc.localBranches.useQuery({}, LOCAL_BRANCHES_QUERY);
}

/** The inbox's tabs: the pull request queues, then branches with no pull request yet. */
const INBOX_TABS = ["assigned", "authored", "unpublished"] as const;
type InboxTab = (typeof INBOX_TABS)[number];

const SECTIONS: readonly {
  id: Exclude<InboxSection, "team">;
  label: string;
  empty: { title: string; detail: string };
}[] = [
  {
    id: "assigned",
    label: "Assigned to me",
    empty: {
      title: "Nothing waiting on you",
      detail:
        "Pull requests assigned to you or requesting your or your team’s review show up here.",
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

/**
 * The Review destination's navigation badge: how many pull requests wait for
 * the viewer's review. None when nothing waits, or GitHub is unreachable.
 */
export function useNeedsReviewBadge(): ExperimentalBadge | null {
  const inbox = useInbox();
  const count = inbox.data ? needsReviewCount(inbox.data) : 0;
  if (count === 0) return null;
  return { count, label: `${plural(count, "pull request")} waiting for your review` };
}

/** Opens a pull request as `account`, or as whichever account the page picks when none is given. */
function useOpenPr(): (ref: PrRef, account?: string) => void {
  const navigate = useBbNavigate();
  return (ref, account) =>
    navigate.toPluginPanel(PANEL_PATH, { subPath: prSubPath(ref, "summary", account) });
}

const ALL_ACCOUNTS = "all";

/**
 * The inbox as one account sees it, or every account's when `account` is
 * {@link ALL_ACCOUNTS}: then a pull request waiting on several accounts is
 * listed once, as the first of them in gh's order, and one assigned to any
 * account is not repeated under My team.
 */
export function inboxFor(inbox: InboxData, account: string): InboxData {
  if (account === ALL_ACCOUNTS) {
    const rank = (pr: InboxPr) => inbox.accounts.findIndex((a) => sameAccount(a, pr.account));
    const key = (pr: InboxPr) => prKey(pr.ref).toLowerCase();
    const once = (prs: InboxPr[], skip = new Set<string>()) => {
      const first = new Map<string, InboxPr>();
      for (const pr of prs) {
        const held = first.get(key(pr));
        if (!held || rank(pr) < rank(held)) first.set(key(pr), pr);
      }
      return prs.filter((pr) => first.get(key(pr)) === pr && !skip.has(key(pr)));
    };
    const assigned = once(inbox.assigned);
    return {
      ...inbox,
      assigned,
      team: once(inbox.team, new Set(assigned.map(key))),
      authored: once(inbox.authored),
    };
  }
  const mine = (prs: InboxPr[]) => prs.filter((pr) => sameAccount(pr.account, account));
  return {
    ...inbox,
    assigned: mine(inbox.assigned),
    team: mine(inbox.team),
    authored: mine(inbox.authored),
    pinned: mine(inbox.pinned),
  };
}

/**
 * The Inbox tab: a box to open any pull request by link, then the viewer's
 * queues, and the unpublished branches once GitButler can list them.
 */
export function Inbox({
  selected,
  selectedBranch,
}: {
  selected: PrRef | null;
  /** The unpublished branch the page shows, by id. */
  selectedBranch: string | null;
}) {
  const inbox = useInbox();
  useReconcile();
  const branches = useLocalBranches();
  const { section, setTab } = useInboxTab();
  const accounts = inbox.data?.accounts ?? [];
  // The account the reader last chose, kept across visits.
  const [chosenAccount, setAccount] = useStoredChoice(
    "inbox-account",
    [ALL_ACCOUNTS, ...accounts],
    ALL_ACCOUNTS,
  );
  // A choice of an account gh has since signed out of reads as every account,
  // and comes back if it signs in again.
  const account = accounts.length > 1 ? chosenAccount : ALL_ACCOUNTS;
  const shown = inbox.data ? inboxFor(inbox.data, account) : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 px-2.5 pt-2">
        <h2 className="min-w-0 flex-1 truncate font-semibold text-foreground">Pull requests</h2>
        {inbox.data && accounts.length > 1 ? (
          <AccountFilter inbox={inbox.data} value={account} onChange={setAccount} />
        ) : null}
        <Tip label="Refresh">
          <Button
            variant="ghost"
            size="icon"
            className={cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS, "text-muted-foreground")}
            aria-label="Refresh pull requests"
            onClick={() => {
              void inbox.refetch();
              void branches.refetch();
            }}
          >
            <Icon
              name="RotateCcw"
              className={cn(
                (inbox.isFetching || branches.isFetching) && "motion-safe:animate-spin",
              )}
              aria-hidden
            />
          </Button>
        </Tip>
      </header>
      <SyncState query={inbox} className="px-3 pt-1" />
      <PasteLink />
      {inbox.data && inbox.data.unavailable.length > 0 ? (
        <Notice tone="error" className="mx-2.5 mt-2" title="Some accounts could not load">
          {inbox.data.unavailable.map(({ account: login, message }) => (
            <p key={login}>
              <span className="font-medium text-foreground">{login}</span>: {message}
            </p>
          ))}
        </Notice>
      ) : null}
      <Tabs
        value={section}
        onValueChange={(value) => setTab(value as InboxTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList
          aria-label="Inbox"
          className="mx-2.5 mt-2 flex h-auto shrink-0 justify-stretch gap-0.5 rounded-md p-0.5"
        >
          {SECTIONS.map(({ id, label }) => (
            <InboxTabTrigger
              key={id}
              value={id}
              label={label}
              title={label}
              count={
                shown
                  ? id === "assigned"
                    ? new Set(
                        [...shown.assigned, ...shown.team].map((pr) => prKey(pr.ref).toLowerCase()),
                      ).size
                    : shown[id].length
                  : undefined
              }
            />
          ))}
          {
            <InboxTabTrigger
              value="unpublished"
              label="Unpublished"
              title="Unpublished branches"
              count={branches.data?.available ? branches.data.branches.length : undefined}
            />
          }
        </TabsList>
        <div data-inbox-scroll className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-1 pb-6">
          {/* The Unpublished tab says its own state, so the pull requests' waits for theirs. */}
          {section === "unpublished" && !shown ? null : (
            <SectionPanes inbox={inbox} shown={shown} selected={selected} />
          )}
          {
            <TabsContent value="unpublished" className="mt-0 focus-visible:ring-0">
              <Unpublished query={branches} selected={selectedBranch} />
            </TabsContent>
          }
        </div>
      </Tabs>
    </div>
  );
}

/**
 * Every queue remains selectable during discovery, including Unpublished.
 */
function useInboxTab() {
  const [section, setTab] = useStoredChoice("inbox-section", INBOX_TABS, "assigned");
  return { section, setTab };
}

function InboxTabTrigger({
  value,
  label,
  title,
  count,
}: {
  value: InboxTab;
  label: string;
  title: string;
  /** Left out until the list is read. */
  count: number | undefined;
}) {
  return (
    <TabsTrigger
      value={value}
      title={title}
      className="h-6 min-w-0 flex-auto gap-1 px-1.5 text-[11px] font-medium"
    >
      <span className="truncate">{label}</span>
      {count === undefined ? null : (
        <span className="shrink-0 text-subtle-foreground tabular-nums">{count}</span>
      )}
    </TabsTrigger>
  );
}

/** Each pull request tab's list, once the inbox is read, or why it is not yet. */
function SectionPanes({
  inbox,
  shown,
  selected,
}: {
  inbox: ReturnType<typeof useInbox>;
  /** The inbox as the chosen account sees it. */
  shown: InboxData | undefined;
  selected: PrRef | null;
}) {
  if (shown) {
    return SECTIONS.map(({ id, label, empty }) => (
      <TabsContent key={id} value={id} className="mt-0 focus-visible:ring-0">
        <PinnedGroup inbox={shown} selected={selected} />
        <SectionRows label={label} section={id} inbox={shown} selected={selected} empty={empty} />
      </TabsContent>
    ));
  }
  return inbox.isError ? (
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
  );
}

/**
 * Narrows the inbox to one signed-in account, or shows every account's.
 * Only there when gh is signed in to more than one.
 */
function AccountFilter({
  inbox,
  value,
  onChange,
}: {
  inbox: InboxData;
  value: string;
  onChange: (account: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = useId();
  // Arrow keys walk a radio group, choosing as they go, so only a click or Space closes it.
  const walking = useRef(false);
  const { accounts } = inbox;
  const filtered = value !== ALL_ACCOUNTS;
  const choices = [ALL_ACCOUNTS, ...accounts].map((choice) => ({
    choice,
    waiting: needsReviewCount(inboxFor(inbox, choice)),
    // What sets the account apart: gh's active one opens pasted links; a failed one shows nothing.
    detail: inbox.unavailable.some((each) => sameAccount(each.account, choice))
      ? "Could not load"
      : choice === accounts[0]
        ? "Active gh account"
        : null,
  }));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Accounts: ${filtered ? value : "all"}`}
          className={cn(
            "flex h-6 min-w-0 shrink items-center gap-1 rounded-md px-1.5 text-[11px] hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
            // A narrowed inbox reads as a set filter, so it is never mistaken for everything.
            filtered ? "bg-secondary text-foreground" : "text-muted-foreground",
          )}
        >
          {filtered ? (
            <AccountAvatar login={value} className="size-3.5" />
          ) : (
            <span className="flex shrink-0 -space-x-1">
              {accounts.slice(0, 3).map((login) => (
                <AccountAvatar
                  key={login}
                  login={login}
                  className="size-3.5 ring-1 ring-background"
                />
              ))}
            </span>
          )}
          <span className="truncate">{filtered ? value : "All accounts"}</span>
          <Icon name="ChevronDown" className="size-3 shrink-0" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" mobileTitle="Accounts" className="w-60 p-1 text-xs">
        <fieldset>
          <legend className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">
            Show pull requests for
          </legend>
          {choices.map(({ choice, waiting, detail }, i) => (
            <label
              key={choice}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-secondary has-[:focus-visible]:bg-secondary",
                // A rule sets the whole apart from the single accounts.
                choice === ALL_ACCOUNTS && "mb-1 rounded-b-none border-b border-border",
              )}
            >
              <input
                type="radio"
                name={name}
                value={choice}
                checked={choice === value}
                className="sr-only"
                // The name stays the account; its note and count describe it.
                aria-label={choice === ALL_ACCOUNTS ? "All accounts" : choice}
                aria-describedby={`${name}-${i}-detail ${name}-${i}-count`}
                onKeyDown={(event) => {
                  walking.current = event.key.startsWith("Arrow");
                }}
                onChange={() => onChange(choice)}
                onClick={() => {
                  if (!walking.current) setOpen(false);
                  walking.current = false;
                }}
              />
              {choice === ALL_ACCOUNTS ? (
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <Icon name="Users" className="size-4 text-muted-foreground" aria-hidden />
                </span>
              ) : (
                <AccountAvatar login={choice} className="size-5" />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-foreground">
                  {choice === ALL_ACCOUNTS ? "All accounts" : choice}
                </span>
                {detail ? (
                  <span
                    id={`${name}-${i}-detail`}
                    className={cn(
                      "truncate text-[11px]",
                      detail === "Could not load" ? "text-warning-text" : "text-muted-foreground",
                    )}
                  >
                    {detail}
                  </span>
                ) : null}
              </span>
              {waiting > 0 ? (
                <span
                  id={`${name}-${i}-count`}
                  className="shrink-0 text-muted-foreground tabular-nums"
                  title={`${plural(waiting, "pull request")} waiting for review`}
                >
                  {waiting}
                  <span className="sr-only"> waiting for review</span>
                </span>
              ) : null}
              <Icon
                name="Check"
                className={cn("size-3.5 shrink-0", choice !== value && "invisible")}
                aria-hidden
              />
            </label>
          ))}
        </fieldset>
      </PopoverContent>
    </Popover>
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
      <Rows inbox={inbox} prs={inbox.pinned} selected={selected} />
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
  const prs =
    section === "assigned"
      ? [
          ...new Map(
            [...inbox.assigned, ...inbox.team].map((pr) => [prKey(pr.ref).toLowerCase(), pr]),
          ).values(),
        ]
      : inbox[section];
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
      <Rows inbox={inbox} prs={prs} selected={selected} />
    </Group>
  );
}

function Group({
  label,
  icon,
  hidden = false,
  repo = false,
  children,
}: {
  label: string;
  icon?: string;
  hidden?: boolean;
  repo?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const Heading = repo ? "h4" : "h3";
  return (
    <section aria-labelledby={id} className="mt-1.5">
      <Heading
        id={id}
        className={cn(
          "flex items-center gap-1 px-1.5 pt-1.5 pb-1 text-[11px] font-medium text-subtle-foreground",
          hidden && "sr-only",
        )}
      >
        {icon ? <Icon name={icon} className="size-3" aria-hidden /> : null}
        {label}
      </Heading>
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
  inbox,
  prs,
  selected,
}: {
  inbox: InboxData;
  prs: readonly InboxPr[];
  selected: PrRef | null;
}) {
  const repos = new Map<string, InboxPr[]>();
  for (const pr of prs) {
    const key = `${pr.ref.owner}/${pr.ref.repo}`;
    const group = repos.get(key) ?? [];
    group.push(pr);
    repos.set(key, group);
  }
  return [...repos].map(([repo, items]) => (
    <Group key={repo} label={repo} repo>
      <ul className="flex flex-col gap-px">
        {items.map((pr) => (
          <li key={prKey(pr.ref)}>
            <Row
              pr={pr}
              selected={selected !== null && sameRef(selected, pr.ref)}
              pinned={inbox.pinned.some((item) => sameRef(item.ref, pr.ref))}
              showAccount={inbox.accounts.length > 1}
            />
          </li>
        ))}
      </ul>
    </Group>
  ));
}

/** What the row says about review: the verdict on the account's own work, or its part in someone else's. */
function RowReview({ pr }: { pr: InboxPr }) {
  if (pr.author && sameAccount(pr.author.login, pr.account)) {
    return pr.reviewDecision ? <ReviewDecisionBadge decision={pr.reviewDecision} /> : null;
  }
  if (pr.viewerReview) return <ReviewStateBadge state={pr.viewerReview} />;
  return pr.reviewRequestedFromViewer ? <ReviewStateBadge state="requested" /> : null;
}

/** One inbox row: opens what it lists, walks with the arrow keys, and stays in view while the page shows it. */
function RowButton({
  selected,
  onOpen,
  onInterest,
  children,
}: {
  selected: boolean;
  onOpen: () => void;
  onInterest?: () => void;
  children: ReactNode;
}) {
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
      onClick={onOpen}
      onMouseEnter={onInterest}
      onFocus={onInterest}
      onKeyDown={moveFocus}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-1 rounded-md px-2 py-2 text-left outline-none",
        "hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",
        selected && "bg-surface-selected hover:bg-surface-selected",
      )}
    >
      {children}
    </button>
  );
}

function Row({
  pr,
  selected,
  pinned,
  showAccount,
}: {
  pr: InboxPr;
  selected: boolean;
  pinned: boolean;
  /** gh has several accounts, so the row says which one it waits on. */
  showAccount: boolean;
}) {
  const open = useOpenPr();
  const prefetch = usePrPrefetch();
  return (
    <RowButton
      selected={selected}
      onOpen={() => open(pr.ref, pr.account)}
      onInterest={() => prefetch(pr)}
    >
      {/* Title first, as the thing to recognise; when it changed sits beside it. */}
      <span className="flex w-full items-start gap-2">
        <span className="line-clamp-2 min-w-0 flex-1 leading-snug font-medium text-foreground [overflow-wrap:anywhere]">
          {pr.title}
        </span>
        <time
          dateTime={pr.updatedAt}
          title={`Updated ${absoluteTime(pr.updatedAt)}`}
          className="shrink-0 pt-px text-[11px] text-subtle-foreground"
        >
          {relativeTime(pr.updatedAt)}
        </time>
      </span>
      <span className="flex w-full items-center gap-1 text-[11px] text-muted-foreground">
        {showAccount ? (
          <span className="inline-flex shrink-0" title={`As ${pr.account}`}>
            <span>As {pr.account}, </span>
          </span>
        ) : null}
        <span className="shrink-0 tabular-nums">#{pr.ref.number}</span>
        {pinned ? (
          <span className="inline-flex shrink-0">
            <Icon name="Pin" className="size-3 text-subtle-foreground" aria-hidden />
            <span className="sr-only">Pinned</span>
          </span>
        ) : null}
        {pr.author ? (
          // The repo tells same-titled pull requests apart, so the author gives way first.
          <span className="flex min-w-0 shrink-[3] items-center gap-1">
            <span className="text-subtle-foreground" aria-hidden>
              ·
            </span>
            <Avatar login={pr.author.login} url={pr.author.avatarUrl} className="size-3.5" />
            <span className="truncate">{pr.author.login}</span>
          </span>
        ) : null}
        <span className="ms-auto flex shrink-0 items-center gap-1.5 ps-2">
          {pr.isDraft || pr.state !== "open" ? (
            <PrStateBadge state={pr.state} isDraft={pr.isDraft} />
          ) : null}
          <ChecksStateIcon
            state={pr.checks}
            label={pr.checks ? `Checks: ${checksLabel(pr.checks)}` : undefined}
          />
          <RowReview pr={pr} />
        </span>
      </span>
    </RowButton>
  );
}

// ── Unpublished branches ─────────────────────────────────────────────────

/**
 * The Unpublished tab: GitButler branches with commits and no pull request,
 * from every machine, newest commit first. Not narrowed by account: a local
 * branch belongs to no GitHub account.
 */
function Unpublished({
  query,
  selected,
}: {
  query: ReturnType<typeof useLocalBranches>;
  selected: string | null;
}) {
  const branches = query.data;
  if (branches?.available) {
    if (branches.branches.length === 0) {
      return (
        <div className="flex flex-col items-center px-4 py-10 text-center text-muted-foreground">
          <Icon name="GitBranch" className="mb-2 size-5 text-subtle-foreground" aria-hidden />
          <p className="font-medium text-foreground">No unpublished branches</p>
          <p className="mt-1 max-w-56 leading-normal">
            GitButler branches with commits and no pull request show up here, from every machine.
          </p>
        </div>
      );
    }
    return (
      <ul className="mt-1.5 flex flex-col gap-px">
        {branches.branches.map((branch) => (
          <li key={branch.id}>
            <BranchRow branch={branch} selected={branch.id === selected} />
          </li>
        ))}
      </ul>
    );
  }
  if (branches && !branches.available) {
    return (
      <Notice
        tone="info"
        title="Unpublished branches unavailable"
        action={<RetryButton onRetry={() => void query.refetch()} />}
      >
        {branches.reason}
      </Notice>
    );
  }
  if (query.isError) {
    return (
      <Notice
        tone="error"
        title="Could not load unpublished branches"
        className="mx-1 mt-2"
        action={<RetryButton onRetry={() => void query.refetch()} />}
      >
        {errorText(query.error)}
      </Notice>
    );
  }
  return <Loading label="Loading unpublished branches…" rows={4} className="px-1 pt-3" />;
}

/**
 * The unpublished branches alone, for when gh cannot list pull requests:
 * reading and reviewing a local branch needs no GitHub account. Nothing
 * without the GitButler plugin.
 */
export function UnpublishedOnly({ selected }: { selected: string | null }) {
  const query = useLocalBranches();
  return (
    <section aria-label="Unpublished branches" className="flex min-h-0 flex-col px-1.5">
      <h2 className="px-1 pt-1 font-semibold text-foreground">Unpublished branches</h2>
      <Unpublished query={query} selected={selected} />
    </section>
  );
}

function BranchRow({ branch, selected }: { branch: LocalBranch; selected: boolean }) {
  const navigate = useBbNavigate();
  const newest = branch.commits[0]?.createdAt ?? "";
  return (
    <RowButton
      selected={selected}
      onOpen={() => navigate.toPluginPanel(PANEL_PATH, { subPath: branchSubPath(branch.id) })}
    >
      {/* Laid out like a pull request row: what it is first, when beside it. */}
      <span className="flex w-full items-start gap-2">
        <span
          className="min-w-0 flex-1 truncate font-mono leading-snug font-medium text-foreground"
          translate="no"
          title={branch.branch}
        >
          {branch.branch}
        </span>
        <time
          dateTime={newest}
          title={`Last commit ${absoluteTime(newest)}`}
          className="shrink-0 pt-px text-[11px] text-subtle-foreground"
        >
          {relativeTime(newest)}
        </time>
      </span>
      <span className="flex w-full items-center gap-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{branch.repoName}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 shrink-[2] truncate" title={`${branch.machine}:${branch.path}`}>
          {branch.machine}
        </span>
      </span>
      <span className="flex w-full items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="shrink-0 tabular-nums">{plural(branch.commits.length, "commit")}</span>
        {branch.parent ? (
          <span className="min-w-0 truncate" title={`Stacked on ${branch.parent}`}>
            on{" "}
            <span className="font-mono" translate="no">
              {branch.parent}
            </span>
          </span>
        ) : null}
        <BranchStatusChip status={branch.status} className="ms-auto" />
      </span>
    </RowButton>
  );
}
