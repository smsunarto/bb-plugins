import { useState } from "react";
import type { GenerationJob } from "../shared/generation.ts";
import type { Asset, CanvasNode } from "../shared/schema.ts";
import { nodeTakes, takeRun, type Take } from "../shared/takes.ts";
import type { NodePatch } from "./generation.tsx";
import { Icon } from "./icons.tsx";

const generating = (job: GenerationJob) =>
  (job.status === "queued" || job.status === "running") && job.request.kind !== "text";
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

type TakesProps = {
  node: CanvasNode;
  assets: Asset[];
  baseUrl?: string;
  jobs: GenerationJob[];
  batch: number;
  canReroll: boolean;
  onChange: (patch: NodePatch) => void;
  onReroll: () => void;
};

/** Whether a media node has takes to review or runs that will produce them. */
export const hasTakes = (node: CanvasNode, jobs: GenerationJob[]) =>
  nodeTakes(node).length > 0 || jobs.some(generating);

/** The selected media node's takes, as a section of the node inspector. */
export function Takes({
  node,
  assets,
  baseUrl,
  jobs,
  batch,
  canReroll,
  onChange,
  onReroll,
}: TakesProps) {
  const [shortlist, setShortlist] = useState(false);
  const takes = nodeTakes(node);
  const pick = node.data.assetId;
  const stars = takes.filter((take) => take.star).length;
  // A batch is one request per image, so all running jobs share one placeholder group.
  const pending = jobs.filter(generating).reduce((sum, job) => sum + outputCount(job), 0);
  const setTakes = (next: Take[]) => onChange({ takes: next });
  const url = (asset: Asset) =>
    baseUrl &&
    `${baseUrl.replace(/\/$/, "")}/${asset.path.split("/").map(encodeURIComponent).join("/")}`;
  // Newest run first; takes from before runs were recorded share one group.
  const runs = [...new Set(takes.map((take) => takeRun(take.jobId)))]
    .reverse()
    .map((run, index, all) => ({
      run,
      label: run ? `Run ${all.length - index - (all.includes("") ? 1 : 0)}` : "Earlier",
      job: jobs.find((job) => takeRun(job.id) === run),
      takes: takes.filter((take) => takeRun(take.jobId) === run && (!shortlist || take.star)),
    }));
  const removable = takes.filter((take) => !take.star && take.assetId !== pick).length;
  return (
    <section className="gs-inspector-section gs-takes" aria-labelledby="gs-takes-title">
      <header>
        <h3 id="gs-takes-title">Takes</h3>
        <span className="tabular-nums">
          {takes.length} · {stars} ★
        </span>
        <fieldset className="gs-takes-filter" aria-label="Show takes">
          <button type="button" aria-pressed={!shortlist} onClick={() => setShortlist(false)}>
            All
          </button>
          <button type="button" aria-pressed={shortlist} onClick={() => setShortlist(true)}>
            ★ Shortlist
          </button>
        </fieldset>
        <button
          type="button"
          className="gs-takes-reroll"
          title="Run the brief again"
          disabled={!canReroll}
          onClick={onReroll}
        >
          <Icon name="RefreshCw" />
          Reroll{batch > 1 ? ` ×${batch}` : ""}
        </button>
      </header>
      <div className="gs-takes-body">
        {pending > 0 && (
          <div className="gs-takes-run">
            <h4>Generating ×{pending}…</h4>
            <div className="gs-takes-grid">
              {Array.from({ length: pending }, (_, index) => (
                <div key={index} className="gs-take" data-pending />
              ))}
            </div>
          </div>
        )}
        {runs
          .filter((run) => run.takes.length)
          .map((run) => (
            <div className="gs-takes-run" key={run.run || "earlier"}>
              <h4>
                {run.label}
                {run.job && <span> · {ago(run.job.createdAt)}</span>}
              </h4>
              <div className="gs-takes-grid">
                {run.takes.map((take) => {
                  const asset = assets.find((item) => item.id === take.assetId);
                  const src = asset && url(asset);
                  const picked = take.assetId === pick;
                  return (
                    <div key={take.assetId} className="gs-take" data-picked={picked || undefined}>
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
              </div>
            </div>
          ))}
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
