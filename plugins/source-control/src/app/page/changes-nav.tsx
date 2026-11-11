/**
 * The Changes nav (board A, left) and the phone list (board D): every
 * Change from every source, by repository and stack, closest to shipping
 * first. Rows have fixed heights per kind, so the list windows past 50 rows
 * without measuring anything.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { describeProblem, readAgo } from "../../core/change.ts";
import type { ChangeKey } from "../../core/ids.ts";
import {
  lineTone,
  parseReviewPath,
  type Filter,
  type NavRow,
  type RepoShelf,
} from "../../core/review.ts";
import { useEscapeLayer } from "../escape.ts";
import { cx, shortAge } from "../format.ts";
import { Chips } from "../status.tsx";
import { Bar } from "../ui.tsx";
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
    <span
      className={cx(
        "flex h-5 shrink-0 items-center gap-1 rounded-full px-2",
        phone ? "bg-surface-raised" : "border border-solid border-border",
      )}
    >
      <HostIcon />
      <span
        className={cx(
          "max-w-32 truncate leading-4 text-muted-foreground",
          phone ? "text-[12px]" : "text-[11px] font-medium",
        )}
      >
        {name}
      </span>
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
        <span
          aria-hidden
          className={cx(
            "size-3.5 shrink-0 rounded-full",
            dots.get(row.author.toLowerCase()) ?? "bg-(--tertiary-foreground)",
          )}
        />
      )}
      <span className="shrink-0 text-[12px] leading-4 text-(--tertiary-foreground)">
        {row.author}
      </span>
    </>
  ) : null;
  return (
    <button
      type="button"
      data-testid="sc-nav-row"
      data-key={row.key}
      aria-current={selected ? "page" : undefined}
      onClick={() => onSelect(row.key)}
      className={cx(
        "flex h-14 w-full min-w-0 cursor-pointer flex-col gap-1 rounded-[8px] border-0 bg-transparent p-2 text-start transition-colors duration-150 hover:bg-border-hairline focus-visible:-outline-offset-2 motion-reduce:transition-none",
        selected && "bg-border-hairline",
      )}
    >
      <span className="flex w-full min-w-0 items-start gap-2">
        <span className="flex h-5 w-4 shrink-0 items-center justify-center">
          <StateIcon state={row.state} phone={phone} />
        </span>
        {row.number !== null ? (
          <span className="shrink-0 text-[12px] leading-5 text-(--tertiary-foreground)">
            #{row.number}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[13px] leading-5 font-semibold text-foreground">
          {row.title}
        </span>
        {age ? (
          <span className="shrink-0 text-[12px] leading-5 text-(--tertiary-foreground)">{age}</span>
        ) : null}
      </span>
      <span className="flex h-5 w-full min-w-0 items-center gap-2 overflow-hidden ps-6">
        {phone ? (
          <>
            <span className={cx("min-w-0 shrink truncate text-[12px] leading-4", LINE_TONE[tone])}>
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
        <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
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
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLSpanElement>(null);
  // Escape closes the menu and returns focus to its button; the page stays.
  useEscapeLayer(
    menu,
    () => {
      setOpen(false);
      trigger.current?.focus();
    },
    { open },
  );
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) first.current?.focus();
  }, [open]);
  const accounts = sources?.accounts ?? [];
  if (accounts.length === 0) return null;
  const chosen = accounts.find((account) => account.login === choice);
  const label = chosen ? chosen.login : accounts.length === 1 ? accounts[0]!.login : "All accounts";
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const pick = (login: string | null) => {
    chooseAccount(login);
    close();
  };
  const phone = variant === "phone";
  const dots = (chosen ? [chosen] : accounts).slice(0, 3);
  return (
    <span className="relative flex shrink-0 flex-col">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={accounts.length < 2}
        data-testid="sc-account-picker"
        onClick={() => setOpen((value) => !value)}
        className={cx(
          "flex cursor-pointer items-center gap-2 rounded-[6px] bg-transparent text-muted-foreground disabled:cursor-default",
          phone
            ? "h-8 border-0 px-1 text-[14px] leading-5"
            : "h-6 border border-solid border-border px-2 text-[12px] leading-4 enabled:hover:bg-surface-raised",
        )}
      >
        {phone ? null : (
          <span className="flex" aria-hidden>
            {dots.map((account) => (
              <span
                key={account.login}
                className={cx(
                  "-ms-1 size-3.5 shrink-0 rounded-full border-[1.5px] border-solid border-popover first:ms-0",
                  ACCOUNT_DOTS[accounts.indexOf(account) % ACCOUNT_DOTS.length],
                )}
              />
            ))}
          </span>
        )}
        <span className="max-w-36 truncate">{label}</span>
        {accounts.length > 1 ? <Chevron /> : null}
      </button>
      {open ? (
        <span
          ref={menu}
          role="menu"
          tabIndex={-1}
          data-bb-plugin="source-control"
          className="absolute top-full right-0 z-10 mt-1 flex min-w-44 flex-col rounded-[8px] border border-solid border-border bg-popover p-1 shadow-md"
        >
          {[null, ...accounts.map((account) => account.login)].map((login, index) => (
            <button
              key={login ?? "all"}
              ref={index === 0 ? first : undefined}
              type="button"
              role="menuitemradio"
              aria-checked={(chosen?.login ?? null) === login}
              onClick={() => pick(login)}
              className="flex h-7 cursor-pointer items-center rounded-[6px] border-0 bg-transparent px-2 text-left text-[12px] leading-4 text-foreground enabled:hover:bg-surface-raised aria-checked:font-semibold"
            >
              {login ?? "All accounts"}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mine", label: "Mine" },
  { id: "asked", label: "Asked" },
  { id: "pinned", label: "Pinned" },
];

function Filters({ counts, variant }: { counts: Record<Filter, number>; variant: Variant }) {
  const filter = useFilter();
  const phone = variant === "phone";
  return (
    <fieldset
      className={cx(
        "m-0 flex min-w-0 border-0 bg-surface-raised p-1",
        phone ? "rounded-[8px]" : "rounded-[6px]",
      )}
    >
      <legend className="sr-only">Show</legend>
      {FILTERS.map((option) => {
        const active = option.id === filter;
        // Pinned shows only for a reader who pins, or while it is the chosen filter.
        if (option.id === "pinned" && counts.pinned === 0 && !active) return null;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            data-testid={`sc-filter-${option.id}`}
            onClick={() => chooseFilter(option.id)}
            className={cx(
              "min-w-0 flex-1 cursor-pointer border-0 text-center transition-colors duration-150 motion-reduce:transition-none",
              phone
                ? "rounded-[6px] py-2 text-[14px] leading-5"
                : "rounded-[4px] py-1 text-[12px] leading-4",
              active
                ? "bg-border font-semibold text-foreground"
                : "bg-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label} {counts[option.id]}
          </button>
        );
      })}
    </fieldset>
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
      <li
        className="flex items-center gap-2"
        data-testid="sc-source-pending"
        data-source={state.id}
      >
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
        <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-(--tertiary-foreground)">
          Still reading {where}
        </span>
        {state.kind === "host" ? (
          <button
            type="button"
            onClick={() => stopHost(state.id)}
            className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[12px] leading-4 text-muted-foreground hover:text-foreground"
          >
            Stop
          </button>
        ) : null}
      </li>
    );
  const problem = state.problem ? describeProblem(state.problem) : "";
  const retry = () =>
    state.kind === "host" ? sources.refetchHost(state.id) : sources.refetchAccount(state.id);
  return (
    <li className="flex items-start gap-2" data-testid="sc-source-problem" data-source={state.id}>
      <span
        aria-hidden
        className={cx(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          state.status === "failed" ? "bg-destructive" : "bg-warning",
        )}
      />
      <span className="min-w-0 flex-1 text-[12px] leading-4 text-(--tertiary-foreground)">
        {state.status === "stale" && state.at !== null
          ? `${problem} Showing ${where}'s last read. ${readAgo(state.at, now)}.`
          : `Couldn't read ${where}. ${problem}`}
      </span>
      <button
        type="button"
        onClick={retry}
        className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[12px] leading-4 text-muted-foreground hover:text-foreground"
      >
        Retry
      </button>
    </li>
  );
}

function SourcesFooter({
  sources,
  now,
  phone,
}: {
  sources: ChangeSources;
  now: number;
  phone: boolean;
}) {
  const shown = sources.states.filter((state) => state.status !== "ready");
  if (shown.length === 0 && sources.stopped.length === 0) return null;
  return (
    // Pinned to the bottom of whatever scrolls the list, on that surface's ground.
    <ul
      className={cx(
        "sticky bottom-0 m-0 flex shrink-0 list-none flex-col gap-2 border-t border-solid border-border-hairline px-4 py-3",
        phone ? "bg-background" : "bg-sidebar",
      )}
    >
      {shown.map((state) => (
        <SourceLine key={`${state.kind}:${state.id}`} state={state} now={now} sources={sources} />
      ))}
      {sources.stopped.map((host) => (
        <li key={host.hostId} className="flex items-center gap-2">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-(--tertiary-foreground)" />
          <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-(--tertiary-foreground)">
            Not reading {host.name}
          </span>
          <button
            type="button"
            onClick={() => resumeHost(host.hostId)}
            className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[12px] leading-4 text-muted-foreground hover:text-foreground"
          >
            Read again
          </button>
        </li>
      ))}
    </ul>
  );
}

// ── The list ───────────────────────────────────────────────────────────

function LoadingRows() {
  return (
    <div aria-busy="true" aria-label="Reading changes" className="flex flex-col gap-1 px-2 pt-2">
      <Bar className="mx-2 my-2 h-2.5 w-32" />
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex h-14 flex-col gap-2 p-2">
          <div className="flex items-center gap-2">
            <Bar className="size-3.5" />
            <Bar className={cx("h-3 max-w-full", ["w-48", "w-36", "w-52", "w-40"][index]!)} />
          </div>
          <Bar className="ms-6 h-2.5 w-28" />
        </div>
      ))}
    </div>
  );
}

function EmptyText({ children }: { children: string }) {
  return (
    <p
      className="m-0 px-4 py-6 text-[12px] leading-5 text-muted-foreground"
      data-testid="sc-nav-empty"
    >
      {children}
    </p>
  );
}

const FILTER_EMPTY: Record<Filter, string> = {
  all: "No changes. Open pull requests and checkout branches appear here.",
  mine: "None of these changes are yours.",
  asked: "No one has asked you to review a change.",
  pinned: "No pinned pull requests. Pin one from its review page.",
};

/** What the list says instead of rows, or null when it has rows to show. */
function notListing(sources: ChangeSources, count: number, filter: Filter) {
  const page = sources.sources;
  if (!page) {
    if (!sources.sourcesError) return <LoadingRows />;
    return (
      <p className="m-0 px-4 py-6 text-[12px] leading-5 text-muted-foreground">
        Couldn't ask the bb server what to list. {sources.sourcesError}
      </p>
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

export function ChangesList({ subPath, variant }: { subPath: string; variant: Variant }) {
  const selectedKey = useMemo(() => parseReviewPath(subPath).key, [subPath]);
  const sources = useChangeSources();
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
  const sizeOf = useCallback((index: number) => itemSize(items[index]!), [items]);
  const keyOf = useCallback((index: number) => items[index]!.key, [items]);
  const win = useListWindow({ count: items.length, sizeOf, keyOf, list });
  const phone = variant === "phone";

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
      {/* bb's sidebar scrolls this list; on the page the panel's column does. */}
      <div ref={setList} data-testid="sc-nav-scroll" className="min-h-0 flex-1 pb-2">
        {body}
      </div>
      <SourcesFooter sources={sources} now={now} phone={phone} />
    </nav>
  );
}
