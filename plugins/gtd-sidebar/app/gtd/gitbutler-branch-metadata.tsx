// The GitButler branch of a plain checkout, as an item on bb's row metadata
// line. A worktree is bb's own branch, so only a plain checkout, where
// GitButler applies its virtual branches, gets one. Opt-in through the
// "Show GitButler branches" setting, since each read runs `but status` on
// the thread's machine.
import { useEffect, useMemo } from "react";
import {
  experimental_useRpcQuery as useRpcQuery,
  useSettings,
  type ExperimentalThreadRowMetadataDataInput,
  type ExperimentalThreadRowMetadataProps,
  type ExperimentalThreadRowMetadataRegistration,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCommittedEvent } from "../../hooks/use-committed-event.ts";
import { gtdSidebarRpcContract } from "../../lib/rpc-contract.ts";

const REFRESH_MS = 30_000;
/** The read's own limit. */
const MAX_ENVIRONMENTS = 100;
const NO_LABELS: ReadonlyMap<string, string> = new Map();

type BranchLabels = ReadonlyMap<string, string>;

function useBranchLabels({ threads }: ExperimentalThreadRowMetadataDataInput): BranchLabels {
  const { values } = useSettings();
  const enabled = values?.gitButlerBranches === true;
  const environmentKey = useMemo(
    () =>
      [
        ...new Set(
          threads.flatMap((thread) => {
            const environment = thread.environment;
            // null: bb does not know the checkout yet.
            return environment?.isWorktree === false && environment.id !== null
              ? [environment.id]
              : [];
          }),
        ),
      ]
        .sort()
        .slice(0, MAX_ENVIRONMENTS)
        .join("\u0000"),
    [threads],
  );
  const input = useMemo(
    () => ({ environmentIds: environmentKey === "" ? [] : environmentKey.split("\u0000") }),
    [environmentKey],
  );
  const active = enabled && input.environmentIds.length > 0;
  const { data, refetch } = useRpcQuery({
    contract: gtdSidebarRpcContract,
    method: "listEnvironmentBranches",
    input,
    enabled: active,
  });
  // GitButler's branches change outside bb, so the read polls while it is on.
  const reread = useCommittedEvent(refetch);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void reread(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, reread]);
  return useMemo(
    () =>
      active && data !== undefined
        ? new Map(data.environments.map(({ environmentId, label }) => [environmentId, label]))
        : NO_LABELS,
    [active, data],
  );
}

function GitButlerBranch({ thread, data }: ExperimentalThreadRowMetadataProps<BranchLabels>) {
  const environmentId = thread.environment?.id ?? null;
  const label = environmentId === null ? undefined : data.get(environmentId);
  if (label === undefined) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-gtd-gitbutler-branch=""
          className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
        >
          <Icon name="GitBranch" className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">GitButler: {label}</TooltipContent>
    </Tooltip>
  );
}

export const gitButlerBranchMetadata: ExperimentalThreadRowMetadataRegistration<BranchLabels> = {
  id: "gitbutler-branch",
  order: 20,
  useData: useBranchLabels,
  component: GitButlerBranch,
};
