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
/** bb paints open PRs with `text-success`, not the meta line's grey. */
const OPEN = "text-success";
/** Draft is muted, matching bb's draft token. */
const DRAFT = "text-muted-foreground";
const QUEUE = "text-[color:var(--attention)]";
const DANGER = "text-destructive-text";
/**
 * Conflicts are the one red the user has to act on locally — a rebase, not a
 * re-run or a re-review. Striking the number through separates it from the
 * other danger states at a glance.
 *
 * The card's own `hover:underline` sets the same property and Tailwind emits
 * it after this rule, so hovering would otherwise trade the strikethrough —
 * the one thing carrying the conflict — for an underline. `!` is what settles
 * that: the two utilities are siblings on one element, so neither source order
 * nor tailwind-merge (different groups, it keeps both) decides it for us.
 */
const CONFLICTS =
  "text-destructive-text line-through hover:[text-decoration-line:underline_line-through]!";
const PENDING = "text-[color:var(--warning-text)]";
const READY = "text-success";

export function prNumberClassName(pr: PrNumberAppearance): string {
  switch (pr.attention) {
    case "merged":
      return MERGED;
    case "conflicts":
      return CONFLICTS;
    case "closed":
    case "checks_failed":
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
