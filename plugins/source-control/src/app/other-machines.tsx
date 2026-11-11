/**
 * The thread's repository on other machines: each other host the placement
 * table has a checkout on, with that repository's branches there as it last
 * read them, and this thread's Change marked where it is. Ported from
 * gitbutler (`src/app/other-machines.tsx`), reading through the review
 * page's per-host lists instead of asking every machine for every path.
 *
 * Folded, it reads nothing. Opened, it reads each host on its own: one that is
 * slow or offline stays pending, or shows its last read and why it is old,
 * without holding the others back.
 */
import {
  experimental_Icon as Icon,
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { useMemo, useState } from "react";
import { describeProblem, readAgo } from "../core/change.ts";
import type { ChangeKey } from "../core/ids.ts";
import { reviewPath, type ChangeRow, type SourceRows } from "../core/review.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { cx } from "./format.ts";
import { PANEL_PATH } from "./page/hooks.ts";
import { STATE_CHIP } from "./page/rail.tsx";
import { Bar } from "./ui.tsx";

type Host = { hostId: string; name: string };

/** The repository's rows on one host, this thread's Change first. */
export function repositoryRows(
  source: SourceRows | undefined,
  repo: string,
  changeKey: ChangeKey | null,
): ChangeRow[] {
  const wanted = repo.toLowerCase();
  const rows = (source?.read?.rows ?? []).filter((row) => row.repo.toLowerCase() === wanted);
  return rows.sort((a, b) => Number(b.key === changeKey) - Number(a.key === changeKey));
}

function BranchRow({ row, mine }: { row: ChangeRow; mine: boolean }) {
  const navigate = useBbNavigate();
  const chip = STATE_CHIP[row.state];
  return (
    <li className="flex min-w-0 border-t border-border-hairline first:border-t-0">
      <button
        type="button"
        className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-start hover:bg-surface-raised"
        title={row.title}
        onClick={() =>
          navigate.toPluginPanel(PANEL_PATH, { subPath: reviewPath({ key: row.key }) })
        }
      >
        <span
          className={cx(
            "flex h-4 shrink-0 items-center rounded-full px-2 text-[11px] leading-3 font-semibold",
            chip.className,
          )}
        >
          {chip.label}
        </span>
        <span className="min-w-0 truncate text-[12px] leading-4 text-foreground" translate="no">
          {row.number !== null ? `#${row.number} · ${row.branch}` : row.branch}
        </span>
        {mine ? (
          <span className="shrink-0 text-[11px] leading-4 text-muted-foreground">This change</span>
        ) : null}
      </button>
    </li>
  );
}

function HostSection({
  host,
  source,
  repo,
  changeKey,
  now,
}: {
  host: Host;
  source: SourceRows | undefined;
  repo: string;
  changeKey: ChangeKey | null;
  now: number;
}) {
  const rows = useMemo(() => repositoryRows(source, repo, changeKey), [source, repo, changeKey]);
  let note: string | null = null;
  if (source?.problem)
    note = source.read
      ? `${describeProblem(source.problem)} ${readAgo(source.read.at, now)}.`
      : describeProblem(source.problem);
  else if (source?.read) note = readAgo(source.read.at, now);
  return (
    <section
      className="flex min-w-0 flex-col border-t border-border-hairline first:border-t-0"
      aria-label={`On ${host.name}`}
      data-testid="sc-other-host"
    >
      <header className="flex min-h-8 min-w-0 items-center gap-2 px-3 py-1.5">
        <Icon name="Monitor" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate text-[12px] leading-4 font-medium text-foreground">
          {host.name}
        </span>
        {note ? (
          <span
            className={cx(
              "ms-auto min-w-0 truncate text-[11px] leading-4",
              source?.problem ? "text-warning" : "text-muted-foreground",
            )}
            title={note}
          >
            {note}
          </span>
        ) : null}
      </header>
      {source?.read ? (
        rows.length > 0 ? (
          <ul className="m-0 list-none p-0">
            {rows.map((row) => (
              <BranchRow key={row.key} row={row} mine={row.key === changeKey} />
            ))}
          </ul>
        ) : (
          <p className="m-0 px-3 pb-2 text-[11px] leading-4 text-muted-foreground">
            No checkout of {repo} here.
          </p>
        )
      ) : source?.problem ? null : (
        <div className="px-3 pb-2" aria-busy="true" aria-label={`Reading ${host.name}`}>
          <Bar className="h-4 w-48 max-w-full" />
        </div>
      )}
    </section>
  );
}

function Hosts({
  hostId,
  repo,
  changeKey,
  now,
}: {
  hostId: string;
  repo: string;
  changeKey: ChangeKey | null;
  now: number;
}) {
  const list = useRpcQuery({ contract: sourceControlContract, method: "checkoutHosts", input: {} });
  const hosts = useMemo(
    () => (list.data?.hosts ?? []).filter((host) => host.hostId !== hostId),
    [list.data, hostId],
  );
  const keys = useMemo(() => hosts.map((host) => host.hostId), [hosts]);
  // Keyed by host: each one's answer arrives, and is shown, on its own.
  const reads = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "hostChanges",
    keys,
    enabled: keys.length > 0,
  });
  if (!list.data)
    return list.error ? (
      <p className="m-0 px-3 py-2 text-[12px] leading-4 text-muted-foreground">
        Couldn't list the other machines. {list.error.message}
      </p>
    ) : (
      <div className="px-3 py-2" aria-busy="true">
        <Bar className="h-4 w-40 max-w-full" />
      </div>
    );
  if (hosts.length === 0)
    return (
      <p className="m-0 px-3 py-2 text-[12px] leading-4 text-muted-foreground">
        bb knows no checkout on another machine.
      </p>
    );
  return (
    <div className="flex min-w-0 flex-col">
      {hosts.map((host) => (
        <HostSection
          key={host.hostId}
          host={host}
          source={reads.data?.[host.hostId]}
          repo={repo}
          changeKey={changeKey}
          now={now}
        />
      ))}
    </div>
  );
}

/** A folded card at the tab's foot, for a checkout whose repository is on GitHub. */
export function OtherMachinesCard({
  hostId,
  repo,
  changeKey,
  now,
  className,
}: {
  hostId: string;
  /** `owner/name` on GitHub: what recognizes the repository on another machine. */
  repo: string;
  changeKey: ChangeKey | null;
  now: number;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className={className} aria-label="Other machines" data-testid="sc-other-machines">
      <header className="flex min-h-10 min-w-0 items-center px-3 py-2">
        <button
          type="button"
          className="flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[4px] border-0 bg-transparent p-0 text-start"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon
            name="ChevronDown"
            className={cx(
              "size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              !open && "-rotate-90",
            )}
            aria-hidden
          />
          <span className="truncate text-[13px] leading-5 font-semibold text-foreground">
            Other machines
          </span>
        </button>
      </header>
      {open ? (
        <div className="border-t border-border-hairline">
          <Hosts hostId={hostId} repo={repo} changeKey={changeKey} now={now} />
        </div>
      ) : null}
    </section>
  );
}
