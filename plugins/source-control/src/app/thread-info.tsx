/**
 * The thread header's "View in Source Control", and the Info tab's Pull
 * request row and GitButler branches section. Ported from gitbutler
 * (`src/app/app.tsx` `useHeaderActionData`, `BranchesInfo`;
 * `src/app/pull-request/pull-request.tsx` `PullRequestInfoRow`). Each draws
 * nothing for a thread it has nothing to say about, and all read the same
 * keyed `changeForThread` the tab and strip read.
 */
import {
  experimental_DetailRow as DetailRow,
  experimental_Icon as Icon,
  experimental_InfoList as InfoList,
  experimental_InfoListRow as InfoListRow,
  experimental_InfoSection as InfoSection,
  experimental_useAppPanel as useAppPanel,
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  UrlLink,
  type ExperimentalThreadInfoProps,
  type PluginThreadActionDataInput,
  type PluginThreadActionItemInput,
} from "@get-bb/plugin-sdk/app";
import { useMemo } from "react";
import type { ThreadChange } from "../core/change.ts";
import { attentionChips, summarize } from "../core/status.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { GitHubMark, StateIcon } from "./page/icons.tsx";

/** The thread's Source Control tab, as `openTab` names it. */
export const SOURCE_CONTROL_TAB = {
  id: "changes",
  context: { kind: "thread" },
  availability: "fixed",
} as const;

export const HEADER_LABEL = "View in Source Control";

/** Each header's thread: whether it has a checkout to show. Loads only ids not loaded yet. */
export function useHeaderActionData({
  threadIds,
}: PluginThreadActionDataInput): Readonly<Record<string, boolean>> {
  const query = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "changeForThread",
    keys: threadIds,
    enabled: threadIds.length > 0,
  });
  const data = query.data;
  return useMemo(
    () =>
      Object.fromEntries(
        threadIds.map((threadId) => [threadId, data?.[threadId]?.state === "checkout"]),
      ),
    [threadIds, data],
  );
}

export function headerActionItem({
  thread,
  data,
  experimental_panel,
}: PluginThreadActionItemInput<Readonly<Record<string, boolean>>>) {
  if (!data?.[thread.id]) return null;
  return {
    label: HEADER_LABEL,
    icon: "GitBranch",
    run: () => {
      experimental_panel.openTab({ tab: SOURCE_CONTROL_TAB });
    },
  };
}

function useThreadRow(threadId: string, enabled: boolean): ThreadChange | undefined {
  const keys = useMemo(() => [threadId], [threadId]);
  const query = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "changeForThread",
    keys,
    enabled,
  });
  return query.data?.[threadId];
}

const PR_LABEL = { draft: "Draft", open: "Open", merged: "Merged", closed: "Closed" } as const;

/**
 * The Info tab's Pull request row, for a GitButler thread's own branch. bb's
 * bundled GitHub PR Status shows a checked-out branch's; it reads
 * `gitbutler/workspace` here, which has none, so the two never both show.
 */
export function PullRequestInfoRow({ threadId, environment }: ExperimentalThreadInfoProps) {
  const row = useThreadRow(threadId, environment !== null);
  const summary = summarize(row);
  const pr = summary?.pullRequest;
  const gitbutler = row?.state === "checkout" && row.local.read?.value.provider === "gitbutler";
  if (!summary || !pr || !gitbutler) return null;
  const state = pr.state === "open" && pr.isDraft ? "draft" : pr.state;
  const next = pr.state === "open" ? attentionChips(summary)[0]?.label : undefined;
  return (
    <DetailRow icon="GitPullRequestArrow" label="Pull request">
      <span className="flex h-5 max-w-full min-w-0 items-center gap-2">
        <UrlLink
          href={pr.url}
          aria-label={`Pull request ${pr.number}: ${PR_LABEL[state]}${next ? `, ${next}` : ""}`}
          title={pr.title}
          className="flex min-w-0 items-center gap-2 text-xs text-foreground no-underline transition-opacity hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
        >
          <GitHubMark />
          <span className="shrink-0 text-muted-foreground">#{pr.number}</span>
          <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-1.5 text-muted-foreground">
            <StateIcon state={state} size={12} />
            <span>{PR_LABEL[state]}</span>
          </span>
          {next ? <span className="min-w-0 truncate text-muted-foreground">{next}</span> : null}
        </UrlLink>
      </span>
    </DetailRow>
  );
}

/**
 * The Info tab's GitButler branches: every branch applied in the thread's
 * workspace, each stack's top branch first, with its review. bb's own Branch
 * row reads `gitbutler/workspace` there, which names none of them. Selecting
 * one opens the Source Control tab. Nothing for a plain git checkout, whose
 * branch bb's row already names, or before the workspace is read.
 */
export function BranchesInfoSection({ threadId, environment }: ExperimentalThreadInfoProps) {
  const panel = useAppPanel();
  const row = useThreadRow(threadId, environment !== null);
  const workspace = row?.state === "checkout" ? row.local.read?.value : undefined;
  const branches = useMemo(
    () =>
      workspace?.provider === "gitbutler"
        ? workspace.stacks.flatMap((stack) =>
            stack.branches.map((branch, index) => ({
              branch,
              base: stack.branches[index + 1]?.name ?? null,
            })),
          )
        : [],
    [workspace],
  );
  if (branches.length === 0 || row?.state !== "checkout") return null;
  const problem = row.local.problem;
  const open = () => panel.openTab({ tab: SOURCE_CONTROL_TAB });
  return (
    <InfoSection
      label="GitButler branches"
      count={branches.length}
      {...(problem === null
        ? {}
        : {
            accessory: (
              <span className="inline-flex" title="Couldn't refresh">
                <Icon name="AlertTriangle" className="size-3 text-attention" aria-hidden />
                <span className="sr-only">Couldn't refresh. Showing the last workspace.</span>
              </span>
            ),
          })}
    >
      <InfoList
        items={branches}
        getKey={({ branch }) => branch.name}
        renderItem={({ branch, base }) => (
          <InfoListRow
            leading={<Icon name="GitBranch" className="size-3" aria-hidden />}
            name={branch.name}
            title={branch.name}
            {...(base ? { context: `on ${base}` } : {})}
            {...(branch.reviewId
              ? { trailing: <span className="text-muted-foreground">{branch.reviewId}</span> }
              : {})}
            onSelect={open}
          />
        )}
      />
    </InfoSection>
  );
}
