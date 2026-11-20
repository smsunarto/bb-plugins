/**
 * The thread side panel's Review tab: one Change's review beside the thread,
 * opened by `useOpenReview`. Moving inside it keeps its place per thread
 * rather than in a route, so the thread stays where it is; a link to another
 * Change, such as a Stack row, opens that Change's own tab.
 */
import {
  experimental_useAppPanel as useAppPanel,
  type ExperimentalThreadActionTabProps,
} from "@get-bb/plugin-sdk/app";
import { useMemo } from "react";
import type { ChangeKey } from "../core/ids.ts";
import { Button } from "./components/ui/button.tsx";
import { reviewTabParams, setPlace, useOpenReview, useTabPlace } from "./open-review.ts";
import { RevealRequestContext, ReviewHostContext, type ReviewHost } from "./page/hooks.ts";
import { PanelReview } from "./page/review-page.tsx";
import { SOURCE_CONTROL_TAB } from "./thread-info.tsx";
import { pullRequestTabParams } from "./open-pull-request.tsx";
import { PullRequestTab } from "./pull-request-tab.tsx";

export function ReviewTab({ threadId, params }: ExperimentalThreadActionTabProps) {
  const pullRequest = pullRequestTabParams(params);
  if (pullRequest) return <PullRequestTab threadId={threadId} pr={pullRequest.ref} />;
  const parsed = reviewTabParams(params);
  if (!parsed) return <NoChange />;
  return <ChangeReview threadId={threadId} changeKey={parsed.key} />;
}

function ChangeReview({ threadId, changeKey }: { threadId: string; changeKey: ChangeKey }) {
  const { location, request } = useTabPlace(threadId, changeKey);
  const openReview = useOpenReview(threadId);
  const host = useMemo<ReviewHost>(
    () => ({
      go: (target) => (target.key === changeKey ? setPlace(threadId, target) : openReview(target)),
    }),
    [threadId, changeKey, openReview],
  );
  return (
    <ReviewHostContext.Provider value={host}>
      <RevealRequestContext.Provider value={request}>
        <PanelReview location={location} />
      </RevealRequestContext.Provider>
    </ReviewHostContext.Provider>
  );
}

/** Opened from the panel's launcher, with no Change named: point at where reviews start. */
function NoChange() {
  const panel = useAppPanel();
  return (
    <div
      data-bb-plugin="source-control"
      data-testid="sc-review-tab-empty"
      className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <p className="m-0 max-w-sm text-[13px] leading-5 text-muted-foreground">
        Open a change's review from its card in the chat or from the Source Control tab.
      </p>
      <Button
        size="sm"
        variant="outline"
        className="pointer-coarse:h-11"
        onClick={() => panel.openTab({ tab: SOURCE_CONTROL_TAB })}
      >
        Open Source Control
      </Button>
    </div>
  );
}
