import {
  Markdown,
  experimental_ProviderModelPicker as ProviderModelPicker,
} from "@get-bb/plugin-sdk/app";
import type { AgentSelection, GenerationJob } from "../shared/generation.ts";
import {
  nodeReviewSettings,
  outputReview,
  retryLimit,
  retryLineage,
  reviewVerdict,
  type ReviewSettings,
  type Verdict,
} from "../shared/review.ts";
import type { CanvasNode } from "../shared/schema.ts";
import { nodeTakes } from "../shared/takes.ts";
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
  const save = (next: ReviewSettings) => {
    // Saving the agent pins it, so automatic reviews run on the agent shown here.
    const { providerId, model, reasoningLevel, serviceTier } = next.agent ?? agent;
    onChange({
      review: {
        enabled: next.enabled,
        agent: { providerId, model, reasoningLevel, ...(serviceTier ? { serviceTier } : {}) },
        ...(next.criteria?.trim() ? { criteria: next.criteria } : {}),
        ...(next.retries ? { retries: next.retries } : {}),
        ...(next.retryOn === "fixes" ? { retryOn: next.retryOn } : {}),
      },
    });
  };
  const { reviewing, record, verdict } = outputReviewState(node, assetId, jobs);
  const runId = nodeTakes(node).find((take) => take.assetId === assetId)?.jobId;
  const attempt = runId ? retryLineage(runId).attempt : 0;
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
      <fieldset className="gs-review-retry" disabled={!settings.enabled}>
        <legend>Retry automatically</legend>
        <label>
          <span>Up to</span>
          <select
            aria-label="Automatic retries"
            value={settings.retries ?? 0}
            onChange={(event) => save({ ...settings, retries: Number(event.target.value) })}
          >
            {Array.from({ length: retryLimit + 1 }, (_, count) => (
              <option key={count} value={count}>
                {count ? `${count} ${count === 1 ? "time" : "times"}` : "Off"}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>When</span>
          <select
            aria-label="Verdicts that retry"
            value={settings.retryOn ?? "fail"}
            disabled={!settings.retries}
            onChange={(event) =>
              save({ ...settings, retryOn: event.target.value as "fail" | "fixes" })
            }
          >
            <option value="fail">Fail</option>
            <option value="fixes">Fail or Pass with fixes</option>
          </select>
        </label>
        <small>Each retry runs the same brief and inputs again, then reviews the new output.</small>
      </fieldset>
      {assetId && (
        <div className="gs-review-result">
          <header>
            <VerdictBadge verdict={verdict} reviewing={reviewing} className="gs-review-verdict" />
            {attempt > 0 && <span className="gs-review-attempt">Retry {attempt}</span>}
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
