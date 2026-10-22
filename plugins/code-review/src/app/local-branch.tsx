import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { BranchTab, LocalBranch } from "../shared/schema.ts";
import { FindingsCard, LinkedThreads, ReviewWithBbButton } from "./bb-review.tsx";
import { BranchReview } from "./changes.tsx";
import { Button } from "./components/ui/button.tsx";
import { COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS } from "./components/ui/coarse-pointer-sizing.ts";
import { PANEL_PATH, plural } from "./format.ts";
import { useLocalBranch } from "./local-branch-query.ts";
import { cn } from "./lib/utils.ts";
import { Loading, Notice, RetryButton, Section, Tip, errorText } from "./notice.tsx";
import { BranchStatusChip } from "./status.tsx";
import { CommitLine } from "./summary.tsx";

function useBackToInbox(): () => void {
  const navigate = useBbNavigate();
  return () => navigate.toPluginPanel(PANEL_PATH, { subPath: "" });
}

/**
 * An unpublished branch's commits, findings, and diffs, found by its inbox id.
 */
export function LocalBranchView({ id, tab }: { id: string; tab: BranchTab }) {
  const branches = useLocalBranch(id);
  const back = useBackToInbox();
  const data = branches.data;
  if (data && !branches.isError) return <Loaded branch={data} tab={tab} />;

  const backButton = (
    <Button variant="outline" size="sm" className="h-6 px-2.5 text-xs font-normal" onClick={back}>
      Back to inbox
    </Button>
  );
  const body = branches.isError ? (
    <Notice
      tone="error"
      title="Could not load the branch"
      action={
        <>
          <RetryButton onRetry={() => void branches.refetch()} />
          {backButton}
        </>
      }
    >
      {errorText(branches.error)}
    </Notice>
  ) : (
    <Loading label="Loading the branch…" rows={5} />
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <span className="truncate text-muted-foreground">Unpublished branch</span>
      </div>
      <div className="p-4">{body}</div>
    </div>
  );
}

function Loaded({ branch, tab }: { branch: LocalBranch; tab: BranchTab }) {
  const back = useBackToInbox();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border bg-background px-3 py-2.5">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 basis-64 items-start gap-1">
            <Tip label="Back to inbox">
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
                  "-ms-1.5 -mt-1 shrink-0 text-muted-foreground",
                )}
                aria-label="Back to inbox"
                onClick={back}
              >
                <Icon name="ArrowLeft" aria-hidden />
              </Button>
            </Tip>
            <h1
              className="min-w-0 font-mono text-sm leading-snug font-semibold [overflow-wrap:anywhere]"
              translate="no"
            >
              {branch.branch}
            </h1>
          </div>
          <div
            role="toolbar"
            aria-label="Branch actions"
            className="flex shrink-0 items-center gap-1"
          >
            <ReviewWithBbButton branch={branch} />
          </div>
        </div>
        <Meta branch={branch} />
      </header>
      <BranchReview branch={branch} section={tab} overview={<BranchSummary branch={branch} />} />
    </div>
  );
}

function Meta({ branch }: { branch: LocalBranch }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
      <BranchStatusChip status={branch.status} />
      <span>{branch.repoName}</span>
      <span className="flex min-w-0 items-center gap-1" title={branch.path}>
        <Icon name="Laptop" className="size-3 shrink-0" aria-hidden />
        <span className="sr-only">On </span>
        <span className="truncate">{branch.machine}</span>
      </span>
      <span className="tabular-nums">{plural(branch.commits.length, "commit")}</span>
      {branch.parent ? (
        <span className="flex min-w-0 items-center gap-1">
          on
          <span
            className="truncate rounded bg-secondary px-1 font-mono text-foreground"
            title={`Stacked on ${branch.parent}`}
            translate="no"
          >
            {branch.parent}
          </span>
        </span>
      ) : null}
    </div>
  );
}

/** What the branch is (its commits), then bb's review of it, and its agent threads beside. */
function BranchSummary({ branch }: { branch: LocalBranch }) {
  return (
    <div className="@container/summary">
      <div className="flex flex-col gap-5 @3xl/summary:flex-row @3xl/summary:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          <Section title="Commits">
            <ol className="flex flex-col gap-1.5">
              {branch.commits.map((commit) => (
                <li key={commit.commitId} className="min-w-0">
                  <CommitLine
                    oid={commit.commitId}
                    message={commit.message}
                    author={commit.authorName}
                    createdAt={commit.createdAt}
                  />
                </li>
              ))}
            </ol>
          </Section>
          <div className="min-w-0 empty:hidden">
            <FindingsCard branch={branch} />
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-5 empty:hidden @3xl/summary:w-64 @3xl/summary:shrink-0">
          <LinkedThreads branch={branch} />
        </div>
      </div>
    </div>
  );
}
