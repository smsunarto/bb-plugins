/**
 * The review page's right rail (board A): the Change's stack, top first, and
 * the checks on its pull request's head, where failing ones can be sent to a
 * new thread to fix.
 */
import {
  experimental_Icon as Icon,
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
} from "@get-bb/plugin-sdk/app";
import { memo, useMemo, useState } from "react";
import {
  describeProblem,
  type CheckRow,
  type ChecksValue,
  type Problem,
} from "../../core/change.ts";
import { checkId, MAX_FIX_CHECKS } from "../../core/fix-checks.ts";
import type { ChangeKey } from "../../core/ids.ts";
import type { ChangeDetail, RowState } from "../../core/review.ts";
import { sourceControlContract } from "../../contract/rpc.ts";
import { FixDialog, type FixTarget } from "../fix-dialog.tsx";
import { cx } from "../format.ts";
import { Checkbox } from "../review-ui.tsx";
import { Bar, Button } from "../ui.tsx";
import type { Go } from "./hooks.ts";
import { CheckIcon, Chevron, StackIcon } from "./icons.tsx";

type Ready = Extract<ChangeDetail, { state: "change" }>;
type StackEntry = NonNullable<Ready["stack"]>[number];

const RAIL_LABEL =
  "m-0 text-[11px] leading-4 font-normal tracking-[0.06em] text-(--tertiary-foreground) uppercase";

export const STATE_CHIP: Record<RowState, { label: string; className: string }> = {
  local: {
    label: "Unpushed",
    className: "border border-solid border-border bg-surface-raised text-foreground",
  },
  draft: { label: "Draft", className: "bg-border text-muted-foreground" },
  open: {
    label: "Open",
    className: "bg-[color-mix(in_oklab,var(--success)_20%,transparent)] text-success-foreground",
  },
  merged: {
    label: "Merged",
    className: "bg-[color-mix(in_oklab,var(--pr-merged)_20%,transparent)] text-(--pr-merged)",
  },
  closed: {
    label: "Closed",
    className: "bg-[color-mix(in_oklab,var(--destructive)_20%,transparent)] text-destructive-text",
  },
};

const StackRow = memo(function StackRow({
  entry,
  onOpen,
}: {
  entry: StackEntry;
  onOpen: (key: ChangeKey) => void;
}) {
  const chip = STATE_CHIP[entry.state];
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-current={entry.current ? "page" : undefined}
        onClick={() => onOpen(entry.key)}
        className={cx(
          "flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-[6px] border-0 bg-transparent p-2 text-start hover:bg-border-hairline",
          entry.current && "bg-border-hairline",
        )}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span
            className={cx(
              "min-w-0 flex-1 truncate font-mono text-[13px] leading-5",
              entry.current ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            {entry.branch}
          </span>
          <span
            className={cx(
              "flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] leading-4 font-semibold",
              chip.className,
            )}
          >
            {chip.label}
          </span>
        </span>
        <span className="text-[12px] leading-4 text-(--tertiary-foreground)">
          {[
            entry.number !== null ? `#${entry.number}` : null,
            `${entry.commits} ${entry.commits === 1 ? "commit" : "commits"}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </button>
    </li>
  );
});

function StackSection({ detail, go }: { detail: Ready; go: Go }) {
  const onOpen = useMemo(() => (key: ChangeKey) => go({ key }), [go]);
  if (!detail.stack || detail.stack.length < 2) return null;
  return (
    <section className="flex flex-col gap-1" aria-label="Stack" data-testid="sc-rail-stack">
      <div className="flex items-center gap-2 pb-2">
        <StackIcon />
        <h2 className={RAIL_LABEL}>Stack</h2>
      </div>
      <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
        {detail.stack.map((entry) => (
          <StackRow key={entry.key} entry={entry} onOpen={onOpen} />
        ))}
      </ol>
    </section>
  );
}

function duration(check: CheckRow, now: number): string {
  if (!check.startedAt) return "";
  const start = Date.parse(check.startedAt);
  const end = check.completedAt ? Date.parse(check.completedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function CheckLine({
  check,
  now,
  selected,
  onSelect,
}: {
  check: CheckRow;
  now: number;
  /** Null for a check that is not failing, which Fix does not take. */
  selected: boolean | null;
  onSelect: (id: string, include: boolean) => void;
}) {
  const name = check.workflow ? `${check.name} (${check.workflow})` : check.name;
  const body = (
    <>
      <CheckIcon outcome={check.outcome} />
      <span
        className={cx(
          "min-w-0 flex-1 truncate text-[13px] leading-5",
          check.outcome === "passed" || check.outcome === "skipped"
            ? "text-muted-foreground"
            : "text-foreground",
        )}
      >
        {name}
      </span>
      <span className="shrink-0 text-[12px] leading-4 text-(--tertiary-foreground)">
        {duration(check, now)}
      </span>
    </>
  );
  return (
    <li className="flex min-w-0 items-center">
      {selected !== null ? (
        <Checkbox
          className="ms-2"
          checked={selected}
          label={`Include ${name} in Fix`}
          onChange={(include) => onSelect(checkId(check), include)}
        />
      ) : null}
      {check.url ? (
        <a
          href={check.url}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-[6px] px-2 py-1 no-underline hover:bg-surface-raised"
        >
          {body}
        </a>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1">{body}</span>
      )}
    </li>
  );
}

const settled = (row: CheckRow) => row.outcome === "passed" || row.outcome === "skipped";

/** "2 running · 9 passed". */
export function checksSummary(rows: readonly CheckRow[]): string {
  const count = (outcome: CheckRow["outcome"]) =>
    rows.filter((row) => row.outcome === outcome).length;
  const passed = rows.filter(settled).length;
  return [
    [count("failed"), "failed"],
    [count("pending"), "running"],
    [passed, "passed"],
  ]
    .filter(([n]) => n !== 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(" · ");
}

/** The passed checks as one line: "Lint, Typecheck and 7 more". */
function passedLine(passed: readonly CheckRow[]): string {
  const [first, second] = passed;
  if (passed.length === 1) return first!.name;
  if (passed.length === 2) return `${first!.name} and ${second!.name}`;
  return `${first!.name}, ${second!.name} and ${passed.length - 2} more`;
}

const RAIL_NOTE = "m-0 px-2 text-[12px] leading-4 text-muted-foreground";

function FixButton({ count, onFix }: { count: number; onFix: () => void }) {
  const tooMany = count > MAX_FIX_CHECKS;
  let reason = `Start a thread that fixes ${count === 1 ? "this check" : `these ${count} checks`}`;
  if (count === 0) reason = "Select at least one failing check";
  else if (tooMany) reason = `Fix takes up to ${MAX_FIX_CHECKS} checks at a time`;
  return (
    // A disabled button shows no tooltip of its own, so the reason sits on a wrapper.
    <span className="flex px-2 pb-1" title={reason}>
      <Button
        className="min-w-0 flex-1"
        data-testid="sc-fix-checks"
        disabled={count === 0 || tooMany}
        onClick={onFix}
      >
        <Icon name="Toolbox" className="size-3.5 shrink-0" aria-hidden />
        {count > 1 ? `Fix ${count} checks` : "Fix"}
      </Button>
    </span>
  );
}

function CheckList({
  changeKey,
  value,
  problem,
  now,
}: {
  changeKey: ChangeKey;
  value: NonNullable<ChecksValue>;
  problem: Problem | null;
  now: number;
}) {
  const [expanded, setExpanded] = useState(false);
  // Every failure starts selected, including ones that fail later, so the reader's choice is what they left out.
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const [fix, setFix] = useState<FixTarget | null>(null);
  if (value.rows.length === 0) return <p className={RAIL_NOTE}>No checks on this head.</p>;
  const attention = value.rows.filter((row) => !settled(row));
  const passed = value.rows.filter(settled);
  const shown = expanded ? [...attention, ...passed] : attention;
  const failing = value.rows.filter((row) => row.outcome === "failed");
  const chosen = failing.filter((row) => !excluded.has(checkId(row)));
  const onSelect = (id: string, include: boolean) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (include) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <>
      {failing.length > 0 ? (
        <FixButton
          count={chosen.length}
          // The dialog keeps the head and checks seen now, whatever arrives meanwhile.
          onFix={() => setFix({ changeKey, head: value.head, checks: chosen })}
        />
      ) : null}
      {fix ? <FixDialog target={fix} onClose={() => setFix(null)} /> : null}
      <ul className="m-0 flex list-none flex-col p-0" data-testid="sc-rail-checks">
        {shown.map((check) => (
          <CheckLine
            key={checkId(check)}
            check={check}
            now={now}
            selected={check.outcome === "failed" ? !excluded.has(checkId(check)) : null}
            onSelect={onSelect}
          />
        ))}
        {!expanded && passed.length > 0 ? (
          <li>
            <button
              type="button"
              aria-expanded={false}
              onClick={() => setExpanded(true)}
              className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-[6px] border-0 bg-transparent px-2 py-1 text-start hover:bg-surface-raised"
            >
              <CheckIcon outcome="passed" />
              <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-muted-foreground">
                {passedLine(passed)}
              </span>
              <Chevron />
            </button>
          </li>
        ) : null}
        {problem ? (
          <li className="px-2 pt-1 text-[12px] leading-4 text-muted-foreground">
            {describeProblem(problem)} These are the last checks bb read.
          </li>
        ) : null}
      </ul>
    </>
  );
}

function ChecksSection({
  changeKey,
  hasPullRequest,
  now,
}: {
  changeKey: ChangeKey;
  hasPullRequest: boolean;
  now: number;
}) {
  const query = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "checksForChange",
    keys: [changeKey],
    enabled: hasPullRequest,
  });
  const facet = query.data?.[changeKey];
  const value = facet?.read?.value ?? null;
  let body;
  if (!hasPullRequest)
    body = <p className={RAIL_NOTE}>Checks run once the branch has a pull request.</p>;
  else if (facet?.read)
    body = value ? (
      <CheckList changeKey={changeKey} value={value} problem={facet.problem} now={now} />
    ) : null;
  else if (facet?.problem) body = <p className={RAIL_NOTE}>{describeProblem(facet.problem)}</p>;
  else
    body = (
      <div aria-busy="true" aria-label="Reading checks" className="flex flex-col gap-2 px-2 py-1">
        <Bar className="h-3 w-40" />
        <Bar className="h-3 w-32" />
      </div>
    );
  const summary = value ? checksSummary(value.rows) : "";
  return (
    <section className="flex flex-col gap-1" aria-label="Checks">
      <div className="flex items-baseline justify-between gap-2 pb-2">
        <h2 className={RAIL_LABEL}>Checks</h2>
        {summary ? (
          <span className="text-[12px] leading-4 text-(--tertiary-foreground)">{summary}</span>
        ) : null}
      </div>
      {body}
    </section>
  );
}

export function RailSections({ detail, go, now }: { detail: Ready; go: Go; now: number }) {
  return (
    <>
      <StackSection detail={detail} go={go} />
      <ChecksSection
        changeKey={detail.row.key}
        hasPullRequest={detail.row.number !== null}
        now={now}
      />
    </>
  );
}
