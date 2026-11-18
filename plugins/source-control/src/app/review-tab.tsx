/**
 * The thread side panel's Review tab: one Change's review beside the thread,
 * opened by `useOpenReview`. Moving inside it keeps its place in memory
 * rather than in a route, so the thread stays where it is.
 */
import type { ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import { experimental_useAppPanel as useAppPanel } from "@get-bb/plugin-sdk/app";
import type { ChangeKey } from "../core/ids.ts";
import { Button } from "./components/ui/button.tsx";
import { movePlace, reviewTabParams, useTabPlace } from "./open-review.ts";
import { PHONE, ReviewHostContext, type ReviewHost } from "./page/hooks.ts";
import { ReviewView } from "./page/review-page.tsx";
import { SOURCE_CONTROL_TAB } from "./thread-info.tsx";

/** A side panel's width before the first measure: under `PHONE`, as panels usually are. */
const PANEL_GUESS = PHONE - 1;

const HOST: ReviewHost = { go: (target) => movePlace(target) };

export function ReviewTab({ params }: ExperimentalThreadActionTabProps) {
  const parsed = reviewTabParams(params);
  if (!parsed) return <NoChange />;
  return <ChangeReview changeKey={parsed.key} />;
}

function ChangeReview({ changeKey }: { changeKey: ChangeKey }) {
  const { location, visit } = useTabPlace(changeKey);
  return (
    <ReviewHostContext.Provider value={HOST}>
      <ReviewView location={location} subPath="" visit={visit} guess={PANEL_GUESS} />
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
        onClick={() => panel.openTab({ tab: SOURCE_CONTROL_TAB })}
      >
        Open Source Control
      </Button>
    </div>
  );
}
