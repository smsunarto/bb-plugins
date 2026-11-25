/**
 * The Review tab a pull request link opens before its Change is known. It
 * opens inside the click, so the reader sees it at once, looks up the pull
 * request's Change, and then opens the Change's own Review tab and closes
 * itself. When Source Control cannot show that pull request (no access, no
 * answer within `RESOLVE_MS`, or the branch's review now shows another pull
 * request), it says so and offers the pull request on GitHub, a click away.
 */
import {
  experimental_useAppPanel as useAppPanel,
  experimental_useRpcQuery as useRpcQuery,
  UrlLink,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { describeProblem } from "../core/change.ts";
import type { ChangeKey } from "../core/ids.ts";
import type { ChangeDetail } from "../core/review.ts";
import { prKey, prLookup, prUrl, type PrRef } from "../core/watch.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { Button } from "./components/ui/button.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "./components/ui/empty.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import {
  knownPullRequest,
  RESOLVE_MS,
  rememberChange,
  rememberMiss,
  resolvePullRequest,
} from "./open-pull-request.tsx";
import { prTabParams, REVIEW_TAB, useOpenReview } from "./open-review.ts";
import { Alert, AlertDescription } from "./components/ui/alert.tsx";

type Phase =
  | { at: "looking"; key: ChangeKey | null }
  | { at: "opened" }
  | { at: "failed"; problem: string }
  | { at: "elsewhere"; number: number };

export function PullRequestTab({ threadId, pr }: { threadId: string; pr: PrRef }) {
  const lookup = prLookup(pr);
  const rpc = useRpc<typeof sourceControlContract>();
  const [state, setPhase] = useState<Phase>(() => start(lookup, threadId));
  const key = state.at === "looking" ? state.key : null;
  const needsLookup = state.at === "looking" && key === null;

  const keys = useMemo(() => (key ? [key] : []), [key]);
  const { data, error, isFetching, refetch } = useRpcQuery({
    contract: sourceControlContract,
    method: "changeDetail",
    input: { keys, prNumber: pr.number, threadId },
    enabled: key !== null,
  });
  const [validatedKey, setValidatedKey] = useState<ChangeKey | null>(null);
  // Validate by PR number, and wait for the request before using any cached verdict.
  const ready = key !== null && validatedKey === key && !isFetching;
  const detail = ready ? data?.[key] : undefined;
  const reviewProblem = ready ? error?.message : undefined;
  const verdict = useMemo(() => {
    if (reviewProblem) return { at: "failed" as const, problem: reviewProblem };
    return detail && detail.state !== "pending" ? judge(detail, pr.number) : null;
  }, [reviewProblem, detail, pr.number]);
  const phase = state.at === "opened" || verdict?.at === "opened" ? state : (verdict ?? state);

  // On enable the SDK normally fetches. Force a read only if it kept a cached answer idle.
  const needsRefetch = useEffectEvent(() => data !== undefined && !isFetching);
  useEffect(() => {
    if (!key) return;
    let live = true;
    void (async () => {
      await (needsRefetch() ? refetch() : undefined);
      if (live) setValidatedKey(key);
    })();
    return () => {
      live = false;
    };
  }, [key, refetch]);

  // Give the GitHub lookup and the first Change read their own deadlines.
  const looking = phase.at === "looking";
  useEffect(() => {
    if (!looking) return;
    const timer = setTimeout(
      () =>
        setPhase({
          at: "failed",
          problem: key ? "The Review didn't load in time." : "GitHub didn't answer in time.",
        }),
      RESOLVE_MS,
    );
    return () => clearTimeout(timer);
  }, [looking, key]);

  // Find the Change. A result for a closed tab, a later attempt, or after the deadline is dropped.
  useEffect(() => {
    if (!needsLookup) return;
    let live = true;
    void (async () => {
      const resolution = await resolvePullRequest(rpc, lookup, threadId);
      if (!live) return;
      if ("problem" in resolution) rememberMiss(lookup, threadId, resolution.problem);
      setPhase((now) => {
        if (now.at !== "looking") return now;
        return "key" in resolution
          ? { at: "looking", key: resolution.key }
          : { at: "failed", problem: resolution.problem };
      });
    })();
    return () => {
      live = false;
    };
  }, [needsLookup, rpc, lookup, threadId]);

  const openReview = useOpenReview(threadId);
  const panel = useAppPanel();
  const ownPr = prTabParams(pr).pr;
  const acted = useRef(false);

  useEffect(() => {
    if (!key || !verdict || acted.current) return;
    if (verdict.at === "failed") return rememberMiss(lookup, threadId, verdict.problem);
    if (verdict.at === "elsewhere")
      return rememberMiss(lookup, threadId, `This branch's review shows #${verdict.number} now.`);
    acted.current = true;

    // For a Change key, a declined side-panel open falls back to the Review page.
    openReview({ key }, { continuation: true });
    // oxlint-disable-next-line react/set-state-in-effect -- Reflect the panel navigation in this tab.
    setPhase({ at: "opened" });
    rememberChange(lookup, key, threadId);
    const self = panel
      .getTabs()
      .tabs.find(
        (tab) =>
          tab.detail.kind === "plugin" &&
          tab.detail.pluginId === "source-control" &&
          tab.detail.tab.id === REVIEW_TAB.id &&
          isPrParams(tab.detail.params, ownPr),
      );
    if (self) panel.closeTab(self.key);
  }, [key, verdict, lookup, threadId, ownPr, openReview, panel]);

  return (
    <PullRequestTabView
      pr={pr}
      phase={phase}
      onRetry={() => {
        acted.current = false;
        setValidatedKey(null);
        setPhase({ at: "looking", key: null });
      }}
    />
  );
}

/** What the tab shows while it looks, once it has handed off, or when GitHub is the way. */
function PullRequestTabView({
  pr,
  phase,
  onRetry,
}: {
  pr: PrRef;
  phase: Phase;
  onRetry: () => void;
}) {
  return (
    <Empty
      size="sm"
      data-bb-plugin="source-control"
      data-testid="sc-pull-request-tab"
      // Safe centring: a short panel scrolls the content instead of clipping its top.
      className="h-full justify-center-safe overflow-auto"
    >
      <EmptyHeader className="w-full">
        <EmptyTitle className="w-full [overflow-wrap:anywhere]" translate="no">
          {prKey(pr)}
        </EmptyTitle>
        {phase.at === "opened" ? (
          <EmptyDescription>Opened in its review tab.</EmptyDescription>
        ) : phase.at === "looking" ? (
          <EmptyDescription>
            <output className="flex items-center gap-2">
              <Spinner />
              Opening its review…
            </output>
          </EmptyDescription>
        ) : null}
      </EmptyHeader>
      {phase.at === "opened" || phase.at === "looking" ? null : (
        <EmptyContent>
          <Alert variant={phase.at === "failed" ? "destructive" : "default"} className="max-w-sm">
            <AlertDescription className="[overflow-wrap:anywhere]">
              {phase.at === "elsewhere"
                ? `This branch's review shows #${phase.number} now, so #${pr.number} is on GitHub.`
                : phase.problem}
            </AlertDescription>
          </Alert>
          <div className="flex flex-wrap justify-center gap-2">
            <Button size="sm" variant="outline" className="pointer-coarse:h-11" asChild>
              <UrlLink href={prUrl(pr)}>Open #{pr.number} on GitHub</UrlLink>
            </Button>
            {phase.at === "failed" ? (
              <Button size="sm" variant="ghost" className="pointer-coarse:h-11" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
          </div>
        </EmptyContent>
      )}
    </Empty>
  );
}

/** Where a tab starts: at the Change when this window knows it, else looking. Retry ignores a recent miss. */
function start(lookup: string, threadId: string): Phase {
  const known = knownPullRequest(lookup, threadId);
  if (known && "problem" in known) return { at: "failed", problem: known.problem };
  return { at: "looking", key: known?.key ?? null };
}

/** Where a known Change's review sends this pull request's link. */
function judge(detail: Exclude<ChangeDetail, { state: "pending" }>, number: number): Phase {
  if (detail.state === "missing")
    return {
      at: "failed",
      problem: detail.problem
        ? describeProblem(detail.problem)
        : "Source Control doesn't know this pull request's branch.",
    };
  const shown = detail.row.number;
  if (shown === null)
    return { at: "failed", problem: "This branch has no pull request in Review." };
  return shown !== number ? { at: "elsewhere", number: shown } : { at: "opened" };
}

function isPrParams(params: unknown, pr: string): boolean {
  return typeof params === "object" && params !== null && "pr" in params && params.pr === pr;
}
