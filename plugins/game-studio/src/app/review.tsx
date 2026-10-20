import {
  Markdown,
  experimental_ProviderModelPicker as ProviderModelPicker,
} from "@get-bb/plugin-sdk/app";
import type { AgentSelection, GenerationJob } from "../shared/generation.ts";
import {
  nodeReviewSettings,
  outputReview,
  reviewVerdict,
  type ReviewSettings,
  type Verdict,
} from "../shared/review.ts";
import type { CanvasNode } from "../shared/schema.ts";
import type { NodePatch } from "./generation.tsx";

export const verdictLabels: Record<Verdict, string> = {
  pass: "Pass",
  fixes: "Pass with fixes",
  fail: "Fail",
};
const running = (job: GenerationJob) => job.status === "queued" || job.status === "running";
/** The node's review of one output: its verdict, or that one is under way. */
export function outputReviewState(
  node: CanvasNode,
  assetId: string | undefined,
  jobs: GenerationJob[],
) {
  const reviewing = jobs.some(
    (job) =>
      running(job) &&
      job.request.kind === "text" &&
      !!assetId &&
      !!job.request.reviewOf?.includes(assetId),
  );
  const record = outputReview(node, assetId);
  return { reviewing, record, verdict: record && reviewVerdict(record.text) };
}

/** A small verdict chip for a node card or a take. */
export function VerdictBadge({
  verdict,
  reviewing,
  className,
}: {
  verdict?: Verdict;
  reviewing?: boolean;
  className: string;
}) {
  if (!reviewing && !verdict) return null;
  return (
    <span className={className} data-verdict={reviewing ? "reviewing" : verdict}>
      {reviewing ? "Reviewing…" : verdictLabels[verdict!]}
    </span>
  );
}

/**
 * An image or 3D node's review: whether each new output is reviewed, by which agent and with
 * which extra criteria, and the current output's review.
 */
export function ReviewSection({
  node,
  assetId,
  hostId,
  defaultAgent,
  jobs,
  disabled,
  onChange,
  onReview,
}: {
  node: CanvasNode;
  /** The output on show, which "Review now" judges. */
  assetId?: string;
  hostId: string;
  defaultAgent: AgentSelection;
  /** The node's review jobs, newest first. */
  jobs: GenerationJob[];
  disabled?: boolean;
  onChange: (patch: NodePatch) => void;
  onReview: (assetId: string) => void;
}) {
  const settings = nodeReviewSettings(node) ?? { enabled: false };
  const agent = settings.agent ?? defaultAgent;
  const save = (next: ReviewSettings) =>
    onChange({
      review: {
        enabled: next.enabled,
        // Saving the agent pins it, so automatic reviews run on the agent shown here.
        agent: {
          providerId: (next.agent ?? agent).providerId,
          model: (next.agent ?? agent).model,
          reasoningLevel: (next.agent ?? agent).reasoningLevel,
          ...((next.agent ?? agent).serviceTier
            ? { serviceTier: (next.agent ?? agent).serviceTier! }
            : {}),
        },
        ...(next.criteria?.trim() ? { criteria: next.criteria } : {}),
      },
    });
  const { reviewing, record, verdict } = outputReviewState(node, assetId, jobs);
  const failed = jobs.find(
    (job) =>
      !running(job) &&
      job.status !== "succeeded" &&
      job.request.kind === "text" &&
      !!assetId &&
      !!job.request.reviewOf?.includes(assetId),
  );
  return (
    <section className="gs-inspector-section gs-review">
      <h3>Review</h3>
      <label className="gs-review-toggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => save({ ...settings, enabled: event.target.checked })}
        />
        <span>
          Review each new output
          <small>Checks it against this node's brief and input images.</small>
        </span>
      </label>
      <div className="gs-review-agent">
        <span>Agent</span>
        <ProviderModelPicker
          value={agent}
          onChange={(value) => save({ ...settings, agent: value })}
          routing={{ kind: "host", hostId }}
        />
      </div>
      <textarea
        aria-label="Extra review criteria"
        placeholder="Extra criteria, such as a triangle budget or a style rule"
        value={settings.criteria ?? ""}
        onChange={(event) => save({ ...settings, criteria: event.target.value })}
      />
      {assetId && (
        <div className="gs-review-result">
          <header>
            <VerdictBadge verdict={verdict} reviewing={reviewing} className="gs-review-verdict" />
            {!reviewing && !record && <small>This output has not been reviewed.</small>}
            <button
              type="button"
              disabled={disabled || reviewing}
              onClick={() => onReview(assetId)}
            >
              {record ? "Review again" : "Review now"}
            </button>
          </header>
          {failed && !reviewing && (
            <small className="gs-review-failed">
              The last review {failed.status === "uncertain" ? "is unconfirmed" : "failed"}
              {failed.detail ? `: ${failed.detail}` : "."}
            </small>
          )}
          {record && (
            <div className="gs-review-text">
              <Markdown content={record.text} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
