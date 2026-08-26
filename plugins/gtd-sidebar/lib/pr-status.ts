/**
 * Colour for a sidebar PR number, matching bb's own pull-request tokens.
 *
 * Draft and merge-queue used to fall through to the same muted grey as an
 * ordinary open PR that is not ready, so those two GitHub states were
 * invisible on the card. Attention is the rolled-up signal and wins; state
 * covers the cases attention does not distinguish.
 */
export interface PrNumberAppearance {
  state: string;
  attention: string;
}

const MERGED = "text-[color:var(--pr-merged)]";
/** Quiet open PRs stay on the meta line's own grey so they cannot vanish into a theme token. */
const OPEN = "text-muted-foreground";
/** Draft is the same grey, washed out, so it stays visible and distinct. */
const DRAFT = "text-muted-foreground/50";
const QUEUE = "text-[color:var(--attention)]";
const DANGER = "text-destructive-text";
const PENDING = "text-[color:var(--warning-text)]";
const READY = "text-success-foreground";

export function prNumberClassName(pr: PrNumberAppearance): string {
  switch (pr.attention) {
    case "merged":
      return MERGED;
    case "closed":
    case "checks_failed":
    case "conflicts":
    case "changes_requested":
    case "blocked":
    case "review_requested":
      return DANGER;
    case "queued":
      return QUEUE;
    case "draft":
      return DRAFT;
    case "checks_pending":
      return PENDING;
    case "ready_to_merge":
      return READY;
    default:
      break;
  }

  switch (pr.state) {
    case "merged":
      return MERGED;
    case "closed":
      return DANGER;
    case "draft":
      return DRAFT;
    default:
      return OPEN;
  }
}

export function prNumberLabel(pr: PrNumberAppearance): string {
  switch (pr.attention) {
    case "merged":
      return "Merged pull request";
    case "closed":
      return "Closed pull request";
    case "queued":
      return "Pull request in merge queue";
    case "draft":
      return "Draft pull request";
    case "checks_failed":
      return "Pull request checks failed";
    case "conflicts":
      return "Pull request has conflicts";
    case "changes_requested":
      return "Pull request has changes requested";
    case "blocked":
      return "Pull request is blocked";
    case "review_requested":
      return "Pull request review requested";
    case "checks_pending":
      return "Pull request checks pending";
    case "ready_to_merge":
      return "Pull request ready to merge";
    default:
      break;
  }

  switch (pr.state) {
    case "merged":
      return "Merged pull request";
    case "closed":
      return "Closed pull request";
    case "draft":
      return "Draft pull request";
    default:
      return "Open pull request";
  }
}
