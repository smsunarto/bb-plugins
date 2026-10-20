import {
  Markdown,
  experimental_ProviderModelPicker as ProviderModelPicker,
} from "@get-bb/plugin-sdk/app";
import type { AgentSelection, GenerationJob } from "../shared/generation.ts";
import {
  manualCandidates,
  nodeJudgeSettings,
  nodeJudgements,
  type JudgeSettings,
} from "../shared/judge.ts";
import type { Asset, CanvasNode } from "../shared/schema.ts";
import { nodeTakes } from "../shared/takes.ts";
import type { NodePatch } from "./generation.tsx";
import { pinnedAgent } from "./review.tsx";

const running = (job: GenerationJob) => job.status === "queued" || job.status === "running";
export const isJudge = (job: GenerationJob) => job.request.kind === "text" && !!job.request.judgeOf;

/** The node's newest judgement, and whether another one is under way. */
export function judgementState(node: CanvasNode, jobs: GenerationJob[]) {
  return { judging: jobs.some(running), record: nodeJudgements(node).at(-1) };
}

/**
 * An image node's judge: whether each run's outputs compete for the pick, by which agent and
 * criteria, and the newest judgement.
 */
export function JudgeSection({
  node,
  assets,
  hostId,
  defaultAgent,
  jobs,
  disabled,
  onChange,
  onJudge,
}: {
  node: CanvasNode;
  assets: Asset[];
  hostId: string;
  defaultAgent: AgentSelection;
  /** The node's judge jobs, newest first. */
  jobs: GenerationJob[];
  disabled?: boolean;
  onChange: (patch: NodePatch) => void;
  onJudge: () => void;
}) {
  const settings = nodeJudgeSettings(node) ?? { enabled: false };
  const agent = settings.agent ?? defaultAgent;
  const save = (next: JudgeSettings) =>
    onChange({
      judge: {
        enabled: next.enabled,
        agent: pinnedAgent(next.agent ?? agent),
        ...(next.criteria?.trim() ? { criteria: next.criteria } : {}),
      },
    });
  const { judging, record } = judgementState(node, jobs);
  const candidates = manualCandidates(node);
  const chosen = record?.choice && assets.find((asset) => asset.id === record.choice);
  // Jobs come newest first; a failure only matters when nothing newer replaced it.
  const failed = jobs.find((job) => !running(job));
  const failedLast =
    failed && failed.status !== "succeeded" && failed.id !== record?.jobId ? failed : undefined;
  return (
    <section className="gs-inspector-section gs-review gs-judge">
      <h3>Judge</h3>
      <label className="gs-review-toggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => save({ ...settings, enabled: event.target.checked })}
        />
        <span>
          Pick the best output of each run
          <small>
            Compares a run's outputs with the current pick and makes the winner the pick.
          </small>
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
        aria-label="Judge criteria"
        placeholder="What makes one image better, such as the clearest silhouette at icon size"
        value={settings.criteria ?? ""}
        onChange={(event) => save({ ...settings, criteria: event.target.value })}
      />
      <div className="gs-review-result">
        <header>
          {judging ? (
            <span className="gs-review-verdict" data-verdict="reviewing">
              Judging…
            </span>
          ) : chosen ? (
            <span className="gs-judge-choice">Picked {chosen.name}</span>
          ) : (
            <small>{record ? "The last judgement named no candidate." : "No judgement yet."}</small>
          )}
          <button
            type="button"
            disabled={disabled || judging || candidates.length < 2}
            onClick={onJudge}
          >
            {record ? "Judge again" : "Judge now"}
          </button>
        </header>
        <small>
          {candidates.length < 2
            ? "Judge now needs two or more takes."
            : `Judge now compares ${candidates.length} ${
                nodeTakes(node).filter((take) => take.star).length >= 2
                  ? "shortlisted takes"
                  : "takes"
              }.`}
        </small>
        {record?.choice && record.applied === false && (
          <small>The pick changed while the judge ran, so it was left as set.</small>
        )}
        {failedLast && !judging && (
          <small className="gs-review-failed">
            The last judgement {failedLast.status === "uncertain" ? "is unconfirmed" : "failed"}
            {failedLast.detail ? `: ${failedLast.detail}` : "."}
          </small>
        )}
        {record && (
          <div className="gs-review-text">
            <Markdown content={record.text} />
          </div>
        )}
      </div>
    </section>
  );
}
