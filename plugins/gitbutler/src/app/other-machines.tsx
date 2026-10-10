import { useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Branch, Checkout } from "../shared/schema.ts";
import type { WorkspaceTarget } from "./branch-actions.tsx";
import { Count } from "./file-list.tsx";
import { subject } from "./format.ts";
import { cn } from "./lib/utils.ts";
import { rpc } from "./rpc.ts";
import { storedAnswer } from "./stored-queries.ts";
import { When } from "./when.tsx";
import { BRANCH_LOOK, Chip, TONE } from "./workspace-lane.tsx";

/**
 * How often the other machines are read again. Each read reaches every
 * connected machine, and what changes there is seldom urgent here.
 */
const OTHER_MACHINES_POLL_MS = 30_000;

const STATUS_CHIP =
  "bg-transparent font-medium text-muted-foreground ring-1 ring-border ring-inset";

function BranchRow({ branch }: { branch: Branch }) {
  const look = BRANCH_LOOK[branch.status];
  const newest = branch.commits[0];
  const commits = branch.commits.length;
  return (
    <li
      className="flex min-w-0 items-start gap-2 px-2.5 py-1.5"
      aria-label={`Branch ${branch.name}`}
    >
      <span
        className={cn(
          "mt-px flex size-4 shrink-0 items-center justify-center rounded",
          TONE[look.tone],
          "bg-current",
        )}
        aria-hidden
      >
        <Icon name={look.icon} className="size-3 text-background" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium" title={branch.name} translate="no">
            {branch.name}
          </span>
          {look.label ? (
            <Chip
              title={branch.rawStatus}
              className={
                branch.status === "conflicted"
                  ? "bg-destructive text-destructive-foreground"
                  : STATUS_CHIP
              }
            >
              {look.label}
            </Chip>
          ) : null}
          {branch.reviewId ? <Chip className={STATUS_CHIP}>{branch.reviewId}</Chip> : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="shrink-0 tabular-nums">
            {commits === 1 ? "1 commit" : `${commits} commits`}
          </span>
          {newest ? (
            <span className="truncate" title={subject(newest.message)}>
              · {subject(newest.message)}
            </span>
          ) : null}
        </span>
      </span>
      {newest ? (
        <When
          value={newest.createdAt}
          className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
        />
      ) : null}
    </li>
  );
}

function MachineBody({ checkout }: { checkout: Checkout }) {
  if (checkout.state !== "ready" || checkout.stacks.length === 0) {
    return (
      <p className="border-t border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
        {checkout.state === "ready" ? "No applied branches." : checkout.reason}
      </p>
    );
  }
  return (
    // One group per stack, its branches top first as on this machine's board.
    <ul className="list-none divide-y divide-border border-t border-border">
      {checkout.stacks.map((stack) => (
        <li key={stack.key}>
          <ul className="list-none">
            {stack.branches.map((branch) => (
              <BranchRow key={branch.name} branch={branch} />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function MachineCard({ checkout }: { checkout: Checkout }) {
  const [open, setOpen] = useState(true);
  const branches = checkout.stacks.reduce((count, stack) => count + stack.branches.length, 0);
  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-card"
      aria-label={`On ${checkout.machine}`}
    >
      <button
        type="button"
        className="flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 text-start focus-visible:-outline-offset-2"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        title={checkout.path}
      >
        <Icon
          name="ChevronDown"
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            !open && "-rotate-90",
          )}
          aria-hidden
        />
        <Icon name="Laptop" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate text-sm font-semibold">{checkout.machine}</span>
        {branches > 0 ? <Count>{branches}</Count> : null}
      </button>
      {open ? <MachineBody checkout={checkout} /> : null}
    </section>
  );
}

/**
 * The same repository's applied branches on every other connected machine,
 * one card each, read only. Writes belong to a thread on that machine. Like
 * the parked list, nothing shows while loading or after a failure: the board
 * above is what the panel is for.
 */
export function OtherMachines({
  target,
  environmentId,
}: {
  target: WorkspaceTarget;
  /** The board's environment. An answer read for another one is not shown. */
  environmentId: string | null;
}) {
  const query = rpc.otherMachines.useQuery(target, {
    ...storedAnswer("otherMachines", target),
    staleTime: OTHER_MACHINES_POLL_MS,
    refetchInterval: OTHER_MACHINES_POLL_MS,
  });
  const data =
    query.data?.reason === null && query.data.environmentId === environmentId ? query.data : null;
  if (!data) return null;
  return data.checkouts.map((checkout) => (
    <MachineCard key={`${checkout.hostId}:${checkout.path}`} checkout={checkout} />
  ));
}
