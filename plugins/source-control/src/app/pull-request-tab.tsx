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
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  UrlLink,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeKey } from "../core/ids.ts";
import type { ChangeDetail } from "../core/review.ts";
import { prKey, prLookup, prUrl, type PrRef } from "../core/watch.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { Button } from "./components/ui/button.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import {
  knownPullRequest,
  RESOLVE_MS,
  rememberChange,
  rememberMiss,
  resolvePullRequest,
} from "./open-pull-request.tsx";
import { REVIEW_TAB, useOpenReview } from "./open-review.ts";

type Phase =
  | { at: "looking"; key: ChangeKey | null }
  | { at: "opened" }
  | { at: "failed"; problem: string }
  | { at: "elsewhere"; number: number };

export function PullRequestTab({ threadId, pr }: { threadId: string; pr: PrRef }) {
  const lookup = prLookup(pr);
  const rpc = useRpc<typeof sourceControlContract>();
  const [state, setPhase] = useState<Phase>(() => start(lookup));
  const key = state.at === "looking" ? state.key : null;
  const needsLookup = state.at === "looking" && key === null;

  const keys = useMemo(() => (key ? [key] : []), [key]);
  const detail = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "changeDetail",
    keys,
    enabled: key !== null,
  }).data?.[key ?? ""];
  // Once the Change's review has loaded, it decides where the tab goes.
  const verdict = key && detail && detail.state !== "pending" ? judge(detail, pr.number) : null;
  const phase = verdict ?? state;
  const looking = phase.at === "looking";

  // One deadline per attempt, for the lookup and the Change's first read together.
  useEffect(() => {
    if (!looking) return;
    const timer = setTimeout(
      () =>
        setPhase((now) =>
          now.at === "looking" ? { at: "failed", problem: "GitHub didn't answer in time." } : now,
        ),
      RESOLVE_MS,
    );
    return () => clearTimeout(timer);
  }, [looking]);

  // Find the Change. A result for a closed tab, a later attempt, or after the deadline is dropped.
  useEffect(() => {
    if (!needsLookup) return;
    let live = true;
    void (async () => {
      const resolution = await resolvePullRequest(rpc, lookup, threadId);
      if (!live) return;
      if ("problem" in resolution) rememberMiss(lookup, resolution.problem);
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
  const acted = useRef<string | null>(null);

  // Act on the verdict once per Change: open its own tab and close this one, or remember the miss.
  useEffect(() => {
    if (!key || !verdict) {
      acted.current = null;
      return;
    }
    if (acted.current === key) return;
    acted.current = key;
    if (verdict.at === "failed") return rememberMiss(lookup, verdict.problem);
    if (verdict.at === "elsewhere")
      return rememberMiss(lookup, `This branch's review shows #${verdict.number} now.`);
    rememberChange(lookup, key);
    openReview({ key });
    const self = panel
      .getTabs()
      .tabs.find(
        (tab) =>
          tab.detail.kind === "plugin" &&
          tab.detail.tab.id === REVIEW_TAB.id &&
          isPrParams(tab.detail.params, prKey(pr).toLowerCase()),
      );
    if (self) panel.closeTab(self.key);
  }, [key, verdict, lookup, pr, openReview, panel]);

  return (
    <PullRequestTabView
      pr={pr}
      phase={phase}
      onRetry={() => setPhase({ at: "looking", key: null })}
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
    <div
      data-bb-plugin="source-control"
      data-testid="sc-pull-request-tab"
      className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <p className="m-0 text-[13px] leading-5 font-medium text-foreground" translate="no">
        {prKey(pr)}
      </p>
      {phase.at === "opened" ? (
        <p className="m-0 text-[13px] leading-5 text-muted-foreground">Opened in its review tab.</p>
      ) : phase.at === "looking" ? (
        <output className="m-0 flex items-center gap-2 text-[13px] leading-5 text-muted-foreground">
          <Spinner />
          Opening its review…
        </output>
      ) : (
        <>
          <p role="alert" className="m-0 max-w-sm text-[13px] leading-5 text-muted-foreground">
            {phase.at === "elsewhere"
              ? `This branch's review shows #${phase.number} now, so #${pr.number} is on GitHub.`
              : `Source Control can't show this pull request. ${phase.problem}`}
          </p>
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
        </>
      )}
    </div>
  );
}

/** Where a tab starts: at the Change when this window knows it, else looking. Retry ignores a recent miss. */
function start(lookup: string): Phase {
  const known = knownPullRequest(lookup);
  if (known && "problem" in known) return { at: "failed", problem: known.problem };
  return { at: "looking", key: known?.key ?? null };
}

/** Where a known Change's review sends this pull request's link. */
function judge(detail: Exclude<ChangeDetail, { state: "pending" }>, number: number): Phase {
  if (detail.state === "missing")
    return { at: "failed", problem: "Source Control doesn't know this pull request's branch." };
  const shown = detail.row.number;
  return shown !== null && shown !== number ? { at: "elsewhere", number: shown } : { at: "opened" };
}

function isPrParams(params: unknown, pr: string): boolean {
  return typeof params === "object" && params !== null && "pr" in params && params.pr === pr;
}
