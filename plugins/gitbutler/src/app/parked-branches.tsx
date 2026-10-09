import { useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { ParkedBranch } from "../shared/schema.ts";
import { AskAgentButton } from "./ask-agent.tsx";
import type { WorkspaceTarget } from "./branch-actions.tsx";
import { Count } from "./file-list.tsx";
import { cn } from "./lib/utils.ts";
import { rpc } from "./rpc.ts";
import { When } from "./when.tsx";

/** How often the parked list is read again. A branch is parked or applied rarely. */
const PARKED_POLL_MS = 60_000;

function ParkedRow({ branch }: { branch: ParkedBranch }) {
  return (
    <li className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium" title={branch.name} translate="no">
          {branch.name}
        </span>
        {branch.subject ? (
          <span className="truncate text-[11px] text-muted-foreground" title={branch.subject}>
            {branch.subject}
          </span>
        ) : null}
      </span>
      {branch.updatedAt ? (
        <When
          value={branch.updatedAt}
          className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
        />
      ) : null}
      <AskAgentButton
        text={`Apply branch ${branch.name} to the workspace with but.`}
        label={`Ask agent to apply ${branch.name}`}
      />
    </li>
  );
}

/**
 * Local branches GitButler has but this workspace does not apply. Closed by
 * default, since the applied stacks are what the panel is for. Applying one
 * rewrites the workspace, so a row asks the agent to instead.
 */
export function ParkedBranches({ target }: { target: WorkspaceTarget }) {
  const parked = rpc.parkedBranches.useQuery(target, {
    staleTime: PARKED_POLL_MS,
    refetchInterval: PARKED_POLL_MS,
  });
  const [open, setOpen] = useState(false);
  // Nothing while loading or after a failure too: the list is context the
  // reader did not ask for, so it never takes room to say it is missing.
  const data = parked.data?.reason === null ? parked.data : null;
  if (!data || data.branches.length === 0) return null;
  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-card"
      aria-label="Not applied"
    >
      <button
        type="button"
        className="flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 text-start focus-visible:-outline-offset-2"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <Icon
          name="ChevronDown"
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            !open && "-rotate-90",
          )}
          aria-hidden
        />
        <span className="truncate text-sm font-semibold">Not applied</span>
        <Count>{data.branches.length}</Count>
      </button>
      {open ? (
        <ul className="list-none divide-y divide-border border-t border-border">
          {data.branches.map((branch) => (
            <ParkedRow key={branch.name} branch={branch} />
          ))}
        </ul>
      ) : null}
      {open && data.hasMore ? (
        <p className="border-t border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
          Showing the most recently updated branches only.
        </p>
      ) : null}
    </section>
  );
}
