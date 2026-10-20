import { useState, type ReactNode } from "react";
import type { GenerationJob } from "../shared/generation.ts";
import type { Asset, CanvasNode } from "../shared/schema.ts";
import { nodeTakes, takeRun, type Take } from "../shared/takes.ts";
import type { NodePatch } from "./generation.tsx";
import { Icon } from "./icons.tsx";
import { VerdictBadge, outputReviewState } from "./review.tsx";

const noJobs: GenerationJob[] = [];
const media = (job: GenerationJob) => job.request.kind !== "text";
const generating = (job: GenerationJob) =>
  (job.status === "queued" || job.status === "running") && media(job);
const failed = (job: GenerationJob) =>
  !["queued", "running", "succeeded"].includes(job.status) && media(job);
const outputCount = (job: GenerationJob) =>
  job.request.kind === "image" ? (job.request.outputCount ?? 1) : 1;
const ago = (time: number) => {
  const minutes = Math.round((Date.now() - time) / 60_000);
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes} min ago`
      : `${Math.round(minutes / 60)} h ago`;
};

type Run = {
  key: string;
  label: string;
  takes: Take[];
  jobs: GenerationJob[];
  /** Images still generating; their placeholders sit beside the run's finished takes. */
  pending: number;
  /** The newest run's failed requests, shown in place of the old status box. */
  failures: GenerationJob[];
};

/**
 * Groups takes and jobs into runs, oldest first. A batch is one run; takes recorded before runs
 * existed share "Earlier".
 */
export function nodeRuns(takes: Take[], jobs: GenerationJob[]): Run[] {
  const latest = jobs.find(media);
  const keys = [...new Set(takes.map((take) => takeRun(take.jobId)))];
  for (const job of jobs.filter(media).reverse())
    if ((generating(job) || job === latest) && !keys.includes(takeRun(job.id)))
      keys.push(takeRun(job.id));
  const numbered = keys.filter(Boolean);
  return keys.map((key) => {
    const runJobs = jobs.filter((job) => media(job) && takeRun(job.id) === key);
    return {
      key,
      label: key ? `Run ${numbered.indexOf(key) + 1}` : "Earlier",
      takes: takes.filter((take) => takeRun(take.jobId) === key),
      jobs: runJobs,
      pending: runJobs.filter(generating).reduce((sum, job) => sum + outputCount(job), 0),
      failures: latest && takeRun(latest.id) === key ? runJobs.filter(failed) : [],
    };
  });
}

type GenerationProps = {
  node: CanvasNode;
  assets: Asset[];
  baseUrl?: string;
  jobs: GenerationJob[];
  /** The node's review jobs, so each take shows its verdict. */
  reviewJobs?: GenerationJob[];
  batch: number;
  canRun: boolean;
  /** The model and output settings. */
  settings: ReactNode;
  onChange: (patch: NodePatch) => void;
  onRun: () => void;
  onControl: (jobId: string, action: "cancel" | "resume") => void;
};

/**
 * The media node's Generation section: settings, then every run's takes. Star takes to shortlist
 * them and choose one with Use.
 */
export function GenerationSection({
  node,
  assets,
  baseUrl,
  jobs,
  reviewJobs = noJobs,
  batch,
  canRun,
  settings,
  onChange,
  onRun,
  onControl,
}: GenerationProps) {
  const [shortlist, setShortlist] = useState(false);
  const takes = nodeTakes(node);
  const pick = node.data.assetId;
  const stars = takes.filter((take) => take.star).length;
  const setTakes = (next: Take[]) => onChange({ takes: next });
  const url = (asset: Asset) =>
    baseUrl &&
    `${baseUrl.replace(/\/$/, "")}/${asset.path.split("/").map(encodeURIComponent).join("/")}`;
  const runs = nodeRuns(takes, jobs)
    .reverse()
    .map((run) =>
      shortlist
        ? Object.assign(run, {
            takes: run.takes.filter((take) => take.star),
            pending: 0,
            failures: [],
          })
        : run,
    )
    .filter((run) => run.takes.length || run.pending || run.failures.length);
  const removable = takes.filter((take) => !take.star && take.assetId !== pick).length;
  return (
    <section className="gs-inspector-section gs-takes">
      <h3>Generation</h3>
      {settings}
      <header>
        <span className="tabular-nums">
          {takes.length ? `${takes.length} takes · ${stars} ★` : "No takes yet"}
        </span>
        <button
          type="button"
          className="gs-takes-reroll"
          title={takes.length ? "Run the brief again" : "Run the brief"}
          disabled={!canRun}
          onClick={onRun}
        >
          <Icon name={takes.length ? "RefreshCw" : "ArrowUp"} />
          {takes.length ? "Reroll" : "Generate"}
          {batch > 1 ? ` ×${batch}` : ""}
        </button>
      </header>
      {takes.length > 0 && (
        <fieldset className="gs-takes-filter" aria-label="Show takes">
          <button type="button" aria-pressed={!shortlist} onClick={() => setShortlist(false)}>
            All
          </button>
          <button type="button" aria-pressed={shortlist} onClick={() => setShortlist(true)}>
            ★ Shortlist
          </button>
        </fieldset>
      )}
      <div className="gs-takes-body">
        {runs.map((run) => {
          const started = Math.min(...run.jobs.map((job) => job.createdAt));
          const resumable = run.failures.filter((job) => job.taskId);
          return (
            <div className="gs-takes-run" key={run.key || "earlier"}>
              <h4>
                {run.label}
                {run.pending > 0 ? (
                  <span> · Generating {run.pending}…</span>
                ) : (
                  run.jobs.length > 0 && <span> · {ago(started)}</span>
                )}
                {run.pending > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      run.jobs.filter(generating).forEach((job) => onControl(job.id, "cancel"))
                    }
                  >
                    Cancel
                  </button>
                )}
              </h4>
              {run.failures.length > 0 && (
                <output className="gs-takes-failure">
                  <span>
                    {run.failures.length > 1 ? `${run.failures.length} images ` : ""}
                    {run.failures[0]!.status === "auth-required"
                      ? "Sign in required"
                      : run.failures[0]!.status === "uncertain"
                        ? "Status unknown"
                        : "Failed"}
                    {run.failures[0]!.detail ? ` · ${run.failures[0]!.detail}` : ""}
                  </span>
                  {resumable.length > 0 && (
                    <button
                      type="button"
                      onClick={() => resumable.forEach((job) => onControl(job.id, "resume"))}
                    >
                      Resume
                    </button>
                  )}
                </output>
              )}
              {(run.takes.length > 0 || run.pending > 0) && (
                <div className="gs-takes-grid">
                  {run.takes.map((take) => {
                    const asset = assets.find((item) => item.id === take.assetId);
                    const src = asset && url(asset);
                    const picked = take.assetId === pick;
                    return (
                      <div key={take.assetId} className="gs-take" data-picked={picked || undefined}>
                        <VerdictBadge
                          {...outputReviewState(node, take.assetId, reviewJobs)}
                          className="gs-take-verdict"
                        />
                        {src && asset.type === "video" ? (
                          <video src={src} muted preload="metadata" />
                        ) : src ? (
                          <img src={src} alt={asset.name} loading="lazy" />
                        ) : (
                          <span className="gs-take-missing">{asset?.name ?? "Missing output"}</span>
                        )}
                        <button
                          type="button"
                          className="gs-take-star"
                          aria-pressed={!!take.star}
                          aria-label={take.star ? "Remove from shortlist" : "Add to shortlist"}
                          onClick={() =>
                            setTakes(
                              takes.map((item) =>
                                item.assetId === take.assetId
                                  ? item.star
                                    ? { assetId: item.assetId, jobId: item.jobId }
                                    : { ...item, star: true }
                                  : item,
                              ),
                            )
                          }
                        >
                          ★
                        </button>
                        <button
                          type="button"
                          className="gs-take-use"
                          aria-pressed={picked}
                          disabled={picked}
                          onClick={() => onChange({ assetId: take.assetId })}
                        >
                          {picked ? "✓ Using" : "Use"}
                        </button>
                      </div>
                    );
                  })}
                  {Array.from({ length: run.pending }, (_, index) => (
                    <div key={`pending-${index}`} className="gs-take" data-pending />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {shortlist && !stars && (
          <p className="gs-takes-empty">Star takes to shortlist them here.</p>
        )}
      </div>
      {removable > 0 && (
        <footer>
          <button
            type="button"
            onClick={() => setTakes(takes.filter((take) => take.star || take.assetId === pick))}
          >
            Clear {removable} unstarred
          </button>
        </footer>
      )}
    </section>
  );
}
