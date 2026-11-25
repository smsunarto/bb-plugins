/**
 * The Changes nav (board A, left) and the phone list (board D): every
 * Change from every source, by repository and stack, closest to shipping
 * first. Rows have fixed heights per kind, so the list windows past 50 rows
 * without measuring anything.
 */
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { describeProblem, readAgo } from "../../core/change.ts";
import type { ChangeKey } from "../../core/ids.ts";
import {
  lineTone,
  parseReviewPath,
  type Filter,
  type NavRow,
  type RepoShelf,
} from "../../core/review.ts";
import { cx, shortAge } from "../format.ts";
import { Chips } from "../status.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { GitHubAvatar } from "../review-ui.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Item } from "../components/ui/item.tsx";
import { Separator } from "../components/ui/separator.tsx";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.tsx";
import { TEXT_LINK } from "../ui.tsx";
import { useGo, useNow } from "./hooks.ts";
import { Chevron, HostIcon, StackIcon, StateIcon } from "./icons.tsx";
import {
  chooseAccount,
  chooseFilter,
  resumeHost,
  stopHost,
  useAccountChoice,
  useChangeSources,
  useFilter,
  useMergedChanges,
  type ChangeSources,
  type SourceState,
} from "./sources.ts";
import { useListWindow } from "./use-window.ts";

export type Variant = "nav" | "phone";

// ── Flat items ─────────────────────────────────────────────────────────

export type Item =
  | { kind: "shelf"; key: string; repo: string; first: boolean }
  | { kind: "stack"; key: string; size: number }
  | { kind: "row"; key: ChangeKey; row: NavRow; place: "single" | "stacked" | "stackEnd" };

/** Each kind's height in px, gaps included, so a window never measures. */
export function itemSize(item: Item): number {
  if (item.kind === "shelf") return item.first ? 28 : 36;
  if (item.kind === "stack") return 33;
  if (item.place === "stacked") return 56;
  if (item.place === "stackEnd") return 65;
  return 60;
}

export function flatten(shelves: readonly RepoShelf[]): Item[] {
  const items: Item[] = [];
  shelves.forEach((shelf, index) => {
    items.push({ kind: "shelf", key: `shelf:${shelf.repo}`, repo: shelf.repo, first: index === 0 });
    for (const group of shelf.groups) {
      if ("rows" in group) {
        items.push({ kind: "stack", key: `stack:${group.id}`, size: group.rows.length });
        group.rows.forEach((row, at) =>
          items.push({
            kind: "row",
            key: row.key,
            row,
            place: at === group.rows.length - 1 ? "stackEnd" : "stacked",
          }),
        );
      } else items.push({ kind: "row", key: group.key, row: group, place: "single" });
    }
  });
  return items;
}

// ── Account colours ────────────────────────────────────────────────────

const ACCOUNT_DOTS = ["bg-primary", "bg-warning", "bg-success", "bg-(--pr-merged)"] as const;

function useAccountDots(sources: ChangeSources["sources"]): ReadonlyMap<string, string> {
  const accounts = sources?.accounts;
  return useMemo(
    () =>
      new Map(
        (accounts ?? []).map((account, index) => [
          account.login.toLowerCase(),
          ACCOUNT_DOTS[index % ACCOUNT_DOTS.length]!,
        ]),
      ),
    [accounts],
  );
}

// ── Rows ───────────────────────────────────────────────────────────────

const LINE_TONE = {
  neutral: "text-muted-foreground",
  warning: "text-warning",
  error: "text-destructive-text",
  success: "text-success-foreground",
  merged: "text-(--pr-merged)",
} as const;

function HostChip({ name, phone }: { name: string; phone: boolean }) {
  return (
    <Badge variant={phone ? "secondary" : "outline"} className="h-5 gap-1 rounded-full px-2 py-0">
      <HostIcon />
      <span
        className={cx(
          "max-w-32 truncate leading-4 text-muted-foreground",
          phone ? "text-[12px]" : "text-[11px] font-medium",
        )}
      >
        {name}
      </span>
    </Badge>
  );
}

/** The pull request's number, if it has one. */
function RowNumber({ number, className }: { number: number | null; className: string }) {
  if (number === null) return null;
  return (
    <span className={cx("shrink-0 text-[12px] text-(--tertiary-foreground)", className)}>
      #{number}
    </span>
  );
}

/** One Change. Memoized on its row object, which keeps its identity while it is unchanged. */
const ChangeRowView = memo(function ChangeRowView({
  row,
  selected,
  variant,
  now,
  hostNames,
  dots,
  onSelect,
}: {
  row: NavRow;
  selected: boolean;
  variant: Variant;
  now: number;
  hostNames: ReadonlyMap<string, string>;
  dots: ReadonlyMap<string, string>;
  onSelect: (key: ChangeKey) => void;
}) {
  const phone = variant === "phone";
  const age = row.updatedAt ? shortAge(row.updatedAt, now) : "";
  const hosts = row.hosts.map((id) => hostNames.get(id) ?? id);
  const tone = lineTone(row);
  const author = row.author ? (
    <>
      {phone ? null : (
        <GitHubAvatar
          login={row.author}
          className="size-3.5"
          fallbackClassName={dots.get(row.author.toLowerCase()) ?? "bg-(--tertiary-foreground)"}
        />
      )}
      <span className="shrink-0 text-[12px] leading-4 text-(--tertiary-foreground)">
        {row.author}
      </span>
    </>
  ) : null;
  return (
    // The window sizes this row at 56px under any pointer: h-14 holds above the row's 44px coarse minimum.
    <Item asChild size="row" className="h-14 min-w-0 cursor-pointer flex-col justify-center gap-1">
      <button
        type="button"
        data-testid="sc-nav-row"
        data-key={row.key}
        aria-current={selected ? "page" : undefined}
        onClick={() => onSelect(row.key)}
      >
        <span className="flex w-full min-w-0 shrink-0 items-start gap-2">
          <span className="flex h-5 w-4 shrink-0 items-center justify-center">
            <StateIcon state={row.state} phone={phone} />
          </span>
          {/* A phone gives the title the whole width; its number moves to the line below. */}
          {phone ? null : <RowNumber number={row.number} className="leading-5" />}
          <span
            title={row.title}
            className="min-w-0 flex-1 truncate text-[13px] leading-5 font-semibold text-foreground"
          >
            {row.title}
          </span>
          {age ? (
            <span className="shrink-0 text-[12px] leading-5 text-(--tertiary-foreground)">
              {age}
            </span>
          ) : null}
        </span>
        {/* Two 20px lines and the gap sit centred in the 56px row, 4px short of filling it: a squeezed line would clip its chips' borders. */}
        <span className="flex h-5 w-full min-w-0 shrink-0 items-center gap-2 overflow-hidden ps-6">
          {phone ? (
            <>
              <RowNumber number={row.number} className="leading-4" />
              <span
                className={cx("min-w-0 shrink truncate text-[12px] leading-4", LINE_TONE[tone])}
              >
                {row.line}
              </span>
              {author}
              {hosts.map((name) => (
                <HostChip key={name} name={name} phone />
              ))}
            </>
          ) : (
            <>
              {author}
              <span className="flex h-5 min-w-0 shrink overflow-hidden">
                <Chips chips={row.chips} />
              </span>
              {hosts.length > 0 ? (
                // Status chips keep their room; a host chip that no longer fits wraps out of sight whole.
                <span className="flex h-5 min-w-0 shrink-[100] flex-wrap gap-2 overflow-hidden">
                  {hosts.map((name) => (
                    <HostChip key={name} name={name} phone={false} />
                  ))}
                </span>
              ) : null}
            </>
          )}
        </span>
      </button>
    </Item>
  );
});

type ItemProps = {
  item: Item;
  selected: boolean;
  variant: Variant;
  now: number;
  hostNames: ReadonlyMap<string, string>;
  dots: ReadonlyMap<string, string>;
  onSelect: (key: ChangeKey) => void;
};

const ItemView = memo(function ItemView({ item, ...props }: ItemProps) {
  if (item.kind === "shelf")
    return (
      <div
        className={cx("flex h-full items-center gap-2 px-2 pb-1", item.first ? "pt-2" : "pt-4")}
        role="presentation"
      >
        <h3 className="m-0 shrink-0 truncate text-[11px] leading-4 font-medium text-(--tertiary-foreground)">
          {item.repo}
        </h3>
        <Separator className="min-w-4 flex-1" />
      </div>
    );
  if (item.kind === "stack")
    return (
      <div className="h-full rounded-t-[10px] border border-b-0 border-solid border-border-hairline px-1 pt-1">
        <div className="flex items-center gap-2 px-2 pt-2 pb-1">
          <StackIcon />
          <span className="truncate text-[11px] leading-4 text-(--tertiary-foreground)">
            Stack of {item.size} · merges bottom first
          </span>
        </div>
      </div>
    );
  const row = <ChangeRowView row={item.row} {...props} />;
  if (item.place === "single") return <div className="h-full pb-1">{row}</div>;
  if (item.place === "stacked")
    return (
      <div className="h-full border-x border-y-0 border-solid border-border-hairline px-1">
        {row}
      </div>
    );
  return (
    <div className="h-full pb-1">
      <div className="rounded-b-[10px] border border-t-0 border-solid border-border-hairline px-1 pb-1">
        {row}
      </div>
    </div>
  );
});

// ── Header: account picker and filters ─────────────────────────────────

function AccountPicker({
  sources,
  variant,
}: {
  sources: ChangeSources["sources"];
  variant: Variant;
}) {
  const choice = useAccountChoice();
  const accounts = sources?.accounts ?? [];
  if (accounts.length === 0) return null;
  const chosen = accounts.find((account) => account.login === choice);
  const label = chosen ? chosen.login : accounts.length === 1 ? accounts[0]!.login : "All accounts";
  const phone = variant === "phone";
  const dots = (chosen ? [chosen] : accounts).slice(0, 3);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={phone ? "ghost" : "outline"}
          size="sm"
          disabled={accounts.length < 2}
          data-testid="sc-account-picker"
          className={cx(
            "shrink-0 gap-2 font-normal text-muted-foreground",
            phone
              ? "h-8 px-1 text-[14px] leading-5"
              : "h-6 px-2 text-[12px] leading-4 max-md:pointer-coarse:h-9",
          )}
        >
          {phone ? null : (
            <span className="flex" aria-hidden>
              {dots.map((account) => (
                <GitHubAvatar
                  key={account.login}
                  login={account.login}
                  className="-ms-1 size-3.5 border-[1.5px] border-solid border-popover first:ms-0"
                  fallbackClassName={ACCOUNT_DOTS[accounts.indexOf(account) % ACCOUNT_DOTS.length]}
                />
              ))}
            </span>
          )}
          <span className="max-w-36 truncate">{label}</span>
          {accounts.length > 1 ? <Chevron /> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuRadioGroup
          value={chosen?.login ?? ALL_ACCOUNTS}
          onValueChange={(value) => chooseAccount(value === ALL_ACCOUNTS ? null : value)}
        >
          <DropdownMenuRadioItem value={ALL_ACCOUNTS}>All accounts</DropdownMenuRadioItem>
          {accounts.map((account) => (
            <DropdownMenuRadioItem key={account.login} value={account.login}>
              {account.login}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The radio value for "All accounts": no GitHub login starts with a space. */
const ALL_ACCOUNTS = " all";

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mine", label: "Mine" },
  { id: "asked", label: "Asked" },
];

function Filters({ counts, variant }: { counts: Record<Filter, number>; variant: Variant }) {
  const filter = useFilter();
  const phone = variant === "phone";
  return (
    <ToggleGroup
      type="single"
      aria-label="Show"
      value={filter}
      // A single group reports "" when its pressed item is pressed again: one filter stays chosen.
      onValueChange={(next) => {
        if (next) chooseFilter(next);
      }}
      className={cx(
        "flex min-w-0 gap-0 bg-surface-raised p-1",
        phone ? "rounded-lg" : "rounded-md",
      )}
    >
      {FILTERS.map((option) => {
        return (
          <ToggleGroupItem
            key={option.id}
            value={option.id}
            data-testid={`sc-filter-${option.id}`}
            className={cx(
              "h-auto min-w-0 flex-1",
              phone
                ? "rounded-md py-2 text-[14px] leading-5"
                : "rounded-sm py-1 text-[12px] leading-4",
              // The nav variant also fills the phone's sidebar sheet, where a finger needs more room.
              !phone && "max-md:pointer-coarse:py-2",
              "data-[state=on]:font-semibold",
            )}
          >
            {option.label} {counts[option.id]}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

// ── Footer: sources still reading or in trouble ────────────────────────

function SourceLine({
  state,
  now,
  sources,
}: {
  state: SourceState;
  now: number;
  sources: ChangeSources;
}) {
  const where = state.kind === "host" ? state.name : `GitHub (${state.name})`;
  if (state.status === "pending")
    return (
      <Item
        asChild
        size="row"
        className="min-w-0"
        data-testid="sc-source-pending"
        data-source={state.id}
      >
        <li>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
          <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-(--tertiary-foreground)">
            Still reading {where}
          </span>
          {state.kind === "host" ? (
            <Button
              variant="link"
              size="sm"
              onClick={() => stopHost(state.id)}
              className={TEXT_LINK}
            >
              Stop
            </Button>
          ) : null}
        </li>
      </Item>
    );
  const problem = state.problem ? describeProblem(state.problem) : "";
  // One line per source: the full problem waits in the tooltip, so two
  // sleeping hosts don't push three-line paragraphs over the list.
  const offline = state.problem?.kind === "host-offline";
  const stale = state.status === "stale" && state.at !== null;
  const label = stale
    ? `${where} ${offline ? "offline" : "not refreshed"} · ${readAgo(state.at!, now).toLowerCase()}`
    : offline
      ? `${where} offline`
      : `Couldn't read ${where}`;
  const retry = () =>
    state.kind === "host" ? sources.refetchHost(state.id) : sources.refetchAccount(state.id);
  return (
    <Item
      asChild
      size="row"
      className="min-w-0"
      data-testid="sc-source-problem"
      data-source={state.id}
    >
      <li>
        <span
          aria-hidden
          className={cx(
            "size-1.5 shrink-0 rounded-full",
            state.status === "failed" ? "bg-destructive" : "bg-warning",
          )}
        />
        <span
          title={problem || undefined}
          className="min-w-0 flex-1 truncate text-[12px] leading-4 text-(--tertiary-foreground)"
        >
          {label}
          {problem ? <span className="sr-only">. {problem}</span> : null}
        </span>
        <Button variant="link" size="sm" onClick={retry} className={TEXT_LINK}>
          Retry
        </Button>
      </li>
    </Item>
  );
}

/** Whether the list ends in a footer naming sources that are not ready or not read. */
function hasSourcesFooter(sources: ChangeSources): boolean {
  return sources.stopped.length > 0 || sources.states.some((state) => state.status !== "ready");
}

function SourcesFooter({
  sources,
  now,
  phone,
  drawer,
}: {
  sources: ChangeSources;
  now: number;
  phone: boolean;
  drawer: boolean;
}) {
  const shown = sources.states.filter((state) => state.status !== "ready");
  if (!hasSourcesFooter(sources)) return null;
  return (
    // Below the list, on that surface's ground: pinned to the bottom of bb's scrolling sidebar,
    // or the nav's last row where the nav scrolls its own list. On a phone under bb Monokai that
    // bottom is the home indicator's strip: the footer runs through it to the screen's edge and
    // pads its lines clear of the indicator.
    <ul
      className={cx(
        "m-0 flex shrink-0 list-none flex-col border-t border-solid border-border-hairline px-2 pt-2",
        phone
          ? "bg-background pb-[calc(0.5rem+var(--plugin-page-bottom-inset,0px))]"
          : drawer
            ? "bg-sidebar pb-[calc(0.5rem+var(--sidebar-list-bottom-inset,0px))]"
            : "sticky bottom-0 bg-sidebar pb-2",
      )}
    >
      {shown.map((state) => (
        <SourceLine key={`${state.kind}:${state.id}`} state={state} now={now} sources={sources} />
      ))}
      {sources.stopped.map((host) => (
        <Item asChild size="row" className="min-w-0" key={host.hostId}>
          <li>
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full bg-(--tertiary-foreground)"
            />
            <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-(--tertiary-foreground)">
              Not reading {host.name}
            </span>
            <Button
              variant="link"
              size="sm"
              onClick={() => resumeHost(host.hostId)}
              className={TEXT_LINK}
            >
              Read again
            </Button>
          </li>
        </Item>
      ))}
    </ul>
  );
}

// ── The list ───────────────────────────────────────────────────────────

function LoadingRows() {
  return (
    <div aria-busy="true" aria-label="Reading changes" className="flex flex-col gap-1 px-2 pt-2">
      <Skeleton className="mx-2 my-2 h-3 w-32" />
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex h-14 flex-col gap-2 p-2">
          <div className="flex items-center gap-2">
            <Skeleton className="size-3.5" />
            <Skeleton className={cx("h-3 max-w-full", ["w-48", "w-36", "w-52", "w-40"][index]!)} />
          </div>
          <Skeleton className="ms-6 h-3 w-28" />
        </div>
      ))}
    </div>
  );
}

function EmptyText({ children }: { children: string }) {
  return (
    // EmptyState takes no testid: the wrapper carries it.
    <div data-testid="sc-nav-empty">
      <EmptyState className="mx-4 my-6" messageClassName="m-0" message={children} />
    </div>
  );
}

const FILTER_EMPTY: Record<Filter, string> = {
  all: "No changes. Open pull requests and checkout branches appear here.",
  mine: "None of these changes are yours.",
  asked: "No one has asked you to review a change.",
};

/** What the list says instead of rows, or null when it has rows to show. */
function notListing(sources: ChangeSources, count: number, filter: Filter) {
  const page = sources.sources;
  if (!page) {
    if (!sources.sourcesError) return <LoadingRows />;
    return (
      <EmptyState
        className="mx-4 my-6"
        messageClassName="m-0"
        message={`Couldn't ask the bb server what to list. ${sources.sourcesError}`}
      />
    );
  }
  if (page.hosts.length === 0 && page.accounts.length === 0)
    return (
      <EmptyText>
        Nothing to list yet. Changes appear here once a thread has a checkout, or once the bb server
        or a connected host has a signed-in GitHub CLI.
      </EmptyText>
    );
  if (count > 0) return null;
  if (sources.states.some((state) => state.status === "pending")) return <LoadingRows />;
  return <EmptyText>{FILTER_EMPTY[filter]}</EmptyText>;
}

/** Every item in flow, or past 50 only the window's, placed by offset. */
function ListItems({
  items,
  win,
  render,
}: {
  items: readonly Item[];
  win: ReturnType<typeof useListWindow>;
  render: (item: Item) => ReactNode;
}) {
  if (!win.items)
    return (
      <div className="px-2">
        {items.map((item) => (
          <div key={item.key} style={{ height: itemSize(item) }}>
            {render(item)}
          </div>
        ))}
      </div>
    );
  return (
    <div className="relative px-2" style={{ height: win.total }}>
      {win.items.map((virtual) => {
        const item = items[virtual.index]!;
        return (
          <div
            key={item.key}
            data-index={virtual.index}
            className="absolute top-0 right-2 left-2"
            style={{
              height: virtual.size,
              transform: `translateY(${virtual.start - win.margin}px)`,
            }}
          >
            {render(item)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * `drawer`: the nav fills a phone drawer's sidebar column (useSidebarColumnFill) and scrolls its
 * own list, so the footer ends the column at the screen's edge instead of floating above the
 * home indicator's strip that bb Monokai pads the column's end with.
 */
export function ChangesList({
  subPath,
  variant,
  drawer = false,
}: {
  subPath: string;
  variant: Variant;
  drawer?: boolean;
}) {
  const selectedKey = useMemo(() => parseReviewPath(subPath).key, [subPath]);
  const sources = useChangeSources();
  const footer = hasSourcesFooter(sources);
  const filter = useFilter();
  const merged = useMergedChanges(sources.rowSets, filter);
  const items = useMemo(() => flatten(merged.shelves), [merged.shelves]);
  const hosts = sources.sources?.hosts;
  const hostNames = useMemo(
    () => new Map((hosts ?? []).map((host) => [host.hostId, host.name])),
    [hosts],
  );
  const dots = useAccountDots(sources.sources);
  const now = useNow();
  const go = useGo();
  const onSelect = useCallback((key: ChangeKey) => go({ key }), [go]);
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const phone = variant === "phone";
  const sizeOf = useCallback((index: number) => itemSize(items[index]!), [items]);
  const keyOf = useCallback((index: number) => items[index]!.key, [items]);
  const win = useListWindow({ count: items.length, sizeOf, keyOf, list });

  const render = (item: Item) => (
    <ItemView
      item={item}
      selected={item.kind === "row" && item.key === selectedKey}
      variant={variant}
      now={now}
      hostNames={hostNames}
      dots={dots}
      onSelect={onSelect}
    />
  );

  const body = notListing(sources, items.length, filter) ?? (
    <ListItems items={items} win={win} render={render} />
  );

  return (
    <nav
      data-bb-plugin="source-control"
      data-testid="sc-changes-nav"
      aria-label="Changes"
      className="@container flex h-full min-h-0 min-w-0 flex-col text-foreground"
    >
      <div
        className={cx(
          "flex shrink-0 flex-col gap-3",
          // bb scrolls the sidebar; the head stays above the list as board A draws it.
          phone ? "px-5 pt-2 pb-3" : "sticky top-0 z-10 bg-sidebar px-4 pt-4 pb-3",
        )}
      >
        <div
          className={cx("flex justify-between gap-2", phone ? "items-baseline" : "items-center")}
        >
          <h2
            className={cx(
              "m-0 text-foreground",
              phone
                ? "text-[28px] leading-8.5 font-bold tracking-[-0.02em]"
                : "text-[13px] leading-5 font-semibold",
            )}
          >
            Changes
          </h2>
          <AccountPicker sources={sources.sources} variant={variant} />
        </div>
        <Filters counts={merged.counts} variant={variant} />
      </div>
      {/* bb's sidebar scrolls this list; on a phone page, and in a phone drawer that the nav
          fills, nothing above it does, so it scrolls itself. The window follows `list`'s nearest
          scrolling ancestor, so the ref sits inside. */}
      <div
        data-testid="sc-nav-scroll"
        className={cx(
          "min-h-0 flex-1",
          (phone || drawer) && "overflow-y-auto overscroll-contain",
          phone && !footer && "pb-[var(--plugin-page-bottom-inset,0px)]",
          drawer && !footer && "pb-[var(--sidebar-list-bottom-inset,0px)]",
        )}
      >
        <div ref={setList} className="pb-2">
          {body}
        </div>
      </div>
      <SourcesFooter sources={sources} now={now} phone={phone} drawer={drawer} />
    </nav>
  );
}
