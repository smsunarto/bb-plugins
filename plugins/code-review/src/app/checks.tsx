import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { UrlLink, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Check, Checks, PrRef, PullRequest } from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";
import { CONTROL_HOVER_TRANSITION } from "./components/ui/motion.ts";
import { FixDialog } from "./fix-dialog.tsx";
import { shortSha } from "./format.ts";
import { cn } from "./lib/utils.ts";
import { InlineError, Notice, RetryButton, errorText } from "./notice.tsx";
import { rpc } from "./rpc.ts";
import { ChecksStateIcon } from "./status.tsx";

/** While a check runs, its state is read often; once all settle, now and then, for a new push. */
const CHECKS_RUNNING_MS = 15_000;
const CHECKS_SETTLED_MS = 120_000;

/** `fixChecksPrompt` takes at most this many checks at once. */
export const MAX_FIX_CHECKS = 10;

export type CheckGroupId = "failing" | "running" | "passed" | "other";

export type CheckGroup = { id: CheckGroupId; title: string; checks: Check[] };

const GROUPS: readonly {
  id: CheckGroupId;
  title: string;
  states: readonly Check["state"][];
}[] = [
  { id: "failing", title: "Failing", states: ["failure"] },
  { id: "running", title: "In progress", states: ["pending"] },
  { id: "passed", title: "Passed", states: ["success"] },
  {
    id: "other",
    title: "Skipped, neutral, or cancelled",
    states: ["skipped", "neutral", "cancelled"],
  },
];

/** Checks by outcome, worst first, leaving out empty groups. Order within a group is kept. */
export function groupChecks(checks: readonly Check[]): CheckGroup[] {
  return GROUPS.map(({ id, title, states }) => ({
    id,
    title,
    checks: checks.filter((check) => states.includes(check.state)),
  })).filter((group) => group.checks.length > 0);
}

/** True while GitHub still has a check running, so the tab keeps polling. */
export function checksRunning(data: Checks | undefined): boolean {
  return (
    data?.state === "pending" || (data?.checks.some((check) => check.state === "pending") ?? false)
  );
}

/** `45s`, `2m 05s`, `1h 12m`. Null when either end is missing or out of order. */
export function checkDuration(check: Pick<Check, "startedAt" | "completedAt">): string | null {
  if (!check.startedAt || !check.completedAt) return null;
  const ms = Date.parse(check.completedAt) - Date.parse(check.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The head commit's checks. The header's tab icon, the Summary, and the Checks
 * tab share it. Given the pull request's `headRefOid`, checks read for an
 * earlier head are read again at once, since settled checks are otherwise
 * read only every two minutes and a push would leave the old ones up.
 */
export function useChecks(ref: PrRef, headRefOid?: string) {
  const checks = rpc.checks.useQuery(
    { ref },
    {
      staleTime: 10_000,
      refetchInterval: (query) =>
        checksRunning(query.state.data) ? CHECKS_RUNNING_MS : CHECKS_SETTLED_MS,
    },
  );
  const readFor = checks.data?.headRefOid;
  const { refetch } = checks;
  useEffect(() => {
    // Every part that shows checks notices the push. The first starts the
    // read, and the rest join it instead of restarting it.
    if (headRefOid && readFor && readFor !== headRefOid) void refetch({ cancelRefetch: false });
  }, [headRefOid, readFor, refetch]);
  return checks;
}

/** The pull request's checks, worst first, and the way to hand failures to an agent. */
export function ChecksTab({ pr }: { pr: PullRequest }) {
  const checks = useChecks(pr.ref, pr.headRefOid);
  if (checks.isPending) return <ChecksSkeleton />;
  if (checks.isLoadingError) {
    return (
      <Notice
        tone="error"
        title="Could not load checks"
        action={<RetryButton onRetry={() => void checks.refetch()} />}
      >
        {errorText(checks.error)}
      </Notice>
    );
  }
  // A failed background read keeps the checks it has on screen, with the Fix
  // dialog and the selection, and says so above them.
  return (
    <div className="flex flex-col gap-2.5">
      {checks.isRefetchError ? (
        <InlineError
          what="the latest checks"
          error={checks.error}
          onRetry={() => void checks.refetch()}
        />
      ) : null}
      {checks.data.checks.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 py-10 text-center text-muted-foreground">
          <Icon name="CircleCheck" className="size-4 text-subtle-foreground" aria-hidden />
          <p>No checks reported for this commit</p>
          <p className="font-mono text-[11px] text-subtle-foreground" translate="no">
            {shortSha(checks.data.headRefOid)}
          </p>
        </div>
      ) : (
        <CheckGroups pr={pr} data={checks.data} />
      )}
    </div>
  );
}

function CheckGroups({ pr, data }: { pr: PullRequest; data: Checks }) {
  const groups = groupChecks(data.checks);
  const failing = groups.find((group) => group.id === "failing")?.checks ?? [];
  // Every failure starts selected, including ones that fail after the tab
  // opened, so the reader's choice is what they left out.
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const selected = failing.filter((check) => !excluded.has(check.id));
  const [fix, setFix] = useState<{ open: boolean; checks: Check[] }>({ open: false, checks: [] });

  const toggle = (id: string, include: boolean) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (include) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-2.5">
      {groups.map((group) => (
        <CheckSection
          key={group.id}
          group={group}
          defaultOpen={group.id !== "other"}
          action={
            group.id === "failing" ? (
              <FixButton
                count={selected.length}
                onFix={() => setFix({ open: true, checks: selected })}
              />
            ) : null
          }
        >
          {group.checks.map((check) => (
            <CheckRow
              key={check.id}
              check={check}
              selected={group.id === "failing" ? !excluded.has(check.id) : null}
              onSelect={(include) => toggle(check.id, include)}
            />
          ))}
        </CheckSection>
      ))}
      <FixDialog
        pr={pr}
        checks={fix.checks}
        open={fix.open}
        onOpenChange={(open) => setFix((current) => ({ ...current, open }))}
      />
    </div>
  );
}

function FixButton({ count, onFix }: { count: number; onFix: () => void }) {
  const tooMany = count > MAX_FIX_CHECKS;
  const reason =
    count === 0
      ? "Select at least one failing check"
      : tooMany
        ? `Fix takes up to ${MAX_FIX_CHECKS} checks at a time`
        : `Start a thread that fixes ${count === 1 ? "this check" : `these ${count} checks`}`;
  const button = (
    <Button
      size="sm"
      className="h-6 gap-1.5 px-2.5 text-xs [&_[data-icon-root]]:size-3"
      disabled={count === 0 || tooMany}
      onClick={onFix}
    >
      <Icon name="Toolbox" aria-hidden />
      {count > 1 ? `Fix ${count} checks` : "Fix"}
    </Button>
  );
  // A disabled button shows no tooltip of its own, so the reason sits on a wrapper.
  return (
    <span className="ms-auto shrink-0" title={reason}>
      {button}
    </span>
  );
}

function CheckSection({
  group,
  defaultOpen,
  action,
  children,
}: {
  group: CheckGroup;
  defaultOpen: boolean;
  action: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();
  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-card"
      aria-label={group.title}
    >
      <div className="flex min-h-9 items-center gap-2 pe-2.5">
        <button
          type="button"
          className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 ps-2.5 text-start focus-visible:-outline-offset-2"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((current) => !current)}
        >
          <Icon
            name="ChevronDown"
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              !open && "-rotate-90",
            )}
            aria-hidden
          />
          <span className="truncate font-semibold">{group.title}</span>
          <span className="inline-flex h-4.5 shrink-0 items-center rounded-full bg-secondary px-1.5 text-[11px] font-semibold tabular-nums text-secondary-foreground">
            {group.checks.length}
          </span>
        </button>
        {action}
      </div>
      {open ? (
        <ul id={listId} className="list-none divide-y divide-border border-t border-border">
          {children}
        </ul>
      ) : null}
    </section>
  );
}

function CheckRow({
  check,
  selected,
  onSelect,
}: {
  check: Check;
  /** Null for a check that cannot be fixed from here. */
  selected: boolean | null;
  onSelect: (include: boolean) => void;
}) {
  const duration = checkDuration(check);
  const checkboxId = useId();
  const detail = [check.workflow, check.description].filter(Boolean).join(" · ");
  return (
    <li className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
      {selected === null ? null : (
        <input
          id={checkboxId}
          type="checkbox"
          className="size-3.5 shrink-0 cursor-pointer accent-primary"
          checked={selected}
          aria-label={`Include ${check.name} in the fix`}
          onChange={(event) => onSelect(event.target.checked)}
        />
      )}
      <span className="flex size-4 shrink-0 items-center justify-center">
        <ChecksStateIcon state={check.state} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        {selected === null ? (
          <span className="truncate font-medium" title={check.name}>
            {check.name}
          </span>
        ) : (
          <label
            htmlFor={checkboxId}
            className="cursor-pointer truncate font-medium"
            title={check.name}
          >
            {check.name}
          </label>
        )}
        {detail ? (
          <span className="truncate text-[11px] text-muted-foreground" title={detail}>
            {detail}
          </span>
        ) : null}
      </span>
      {duration ? (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" title="Duration">
          {duration}
        </span>
      ) : null}
      {check.detailsUrl ? (
        <UrlLink
          href={check.detailsUrl}
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-state-hover hover:text-foreground",
            CONTROL_HOVER_TRANSITION,
          )}
          aria-label={`Details for ${check.name}`}
        >
          Details
          <Icon name="ArrowUpRight" className="size-3" aria-hidden />
        </UrlLink>
      ) : null}
    </li>
  );
}

/** Two group cards of rows on their way, so the tab does not jump when they land. */
function ChecksSkeleton() {
  return (
    <output className="flex flex-col gap-2.5" aria-busy>
      <span className="sr-only">Loading checks</span>
      {[3, 4].map((rows) => (
        <div key={rows} className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex h-9 items-center gap-2 px-2.5">
            <Skeleton className="h-3 w-20" />
          </div>
          {Array.from({ length: rows }, (_, row) => (
            <div key={row} className="flex h-10 items-center gap-2 border-t border-border px-2.5">
              <Skeleton className="size-3.5 rounded-full" />
              <Skeleton className={cn("h-3", row % 2 ? "w-1/3" : "w-1/2")} />
              <Skeleton className="ms-auto h-3 w-10" />
            </div>
          ))}
        </div>
      ))}
    </output>
  );
}
