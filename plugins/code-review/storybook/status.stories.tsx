import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  PrStateBadge,
  ReviewStateBadge,
  ReviewDecisionBadge,
  BranchStatusChip,
  ChecksStateIcon,
} from "../src/app/status";
import { Notice, InlineError, Loading, RetryButton } from "../src/app/notice";
import { fn } from "storybook/test";
const meta = {
  play: ready,
  title: "Plugins/Code Review/Statuses",
  component: PrStateBadge,
  tags: ["autodocs"],
  args: { state: "open", isDraft: false },
} satisfies Meta<typeof PrStateBadge>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Open: Story = {};
export const Draft: Story = { args: { isDraft: true } };
export const Merged: Story = { args: { state: "merged" } };
export const Closed: Story = { args: { state: "closed" } };
export const ReviewStates: Story = {
  render: () => (
    <div className="sb-gallery">
      {(
        ["approved", "changes_requested", "commented", "dismissed", "pending", "requested"] as const
      ).map((state) => (
        <ReviewStateBadge key={state} state={state} />
      ))}
    </div>
  ),
};
export const Decisions: Story = {
  render: () => (
    <div className="sb-gallery">
      {(["approved", "changes_requested", "review_required"] as const).map((decision) => (
        <ReviewDecisionBadge key={decision} decision={decision} />
      ))}
    </div>
  ),
};
export const Branches: Story = {
  render: () => (
    <div className="sb-gallery">
      {["unpushed", "pushed", "ahead", "behind", "diverged"].map((status) => (
        <BranchStatusChip key={status} status={status} />
      ))}
    </div>
  ),
};
export const Checks: Story = {
  render: () => (
    <div className="sb-gallery">
      {(["success", "failure", "pending", "neutral", "skipped", "cancelled"] as const).map(
        (state) => (
          <span key={state} className="sb-gallery">
            <ChecksStateIcon state={state} />
            {state}
          </span>
        ),
      )}
    </div>
  ),
};
export const ReadFailure: Story = {
  render: () => (
    <Notice tone="error" title="Review unavailable" action={<RetryButton onRetry={fn()} />}>
      The checkout host disconnected. Retry when it is online.
    </Notice>
  ),
};
export const PartialFailure: Story = {
  render: () => (
    <InlineError
      what="checks"
      error={new globalThis.Error("GitHub is unavailable")}
      onRetry={fn()}
    />
  ),
};
export const Pending: Story = { render: () => <Loading label="Loading review" /> };
