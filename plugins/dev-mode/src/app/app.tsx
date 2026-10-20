import { registerReview } from "./review.tsx";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
  type PluginMessageDirectiveProps,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  MAX_ROUNDS,
  roleLabel,
  terminal,
  type ArenaRun,
  type Digest,
  type Job,
  type Readable,
} from "../shared/arena.ts";
import type { rpcContract } from "../shared/rpc.ts";
import "./arena.css";

const changed = z.object({ runId: z.uuid() });
const phaseNames: Record<ArenaRun["phase"], string> = {
  snapshot: "Getting ready",
  framing: "Setting criteria",
  candidates: "Building solutions",
  judging: "Reviewing solutions",
  synthesizing: "Combining changes",
  integrating: "Checking the result",
  stopping: "Stopping",
  failing: "Cleaning up",
  completed: "Applied",
  failed: "Needs attention",
  stopped: "Stopped",
};
const STAGES = [
  { role: "frame", label: "Plan" },
  { role: "candidate", label: "Build" },
  { role: "judge", label: "Review" },
  { role: "synthesis", label: "Combine" },
  { role: "verify", label: "Check" },
] as const;
type Step = "pending" | "active" | "done" | "failed" | "halted";
const STEP_ICONS: Record<Exclude<Step, "pending">, string> = {
  active: "Spinner",
  done: "Check",
  failed: "X",
  halted: "Square",
};

/** Each stage's state in the current round, read from its jobs. */
function stepState(run: ArenaRun, role: (typeof STAGES)[number]["role"]): Step {
  if (role === "verify") {
    if (run.integration) return run.integration.status === "integrated" ? "done" : "failed";
    return run.phase === "integrating" ? "active" : "pending";
  }
  const jobs = run.jobs.filter((job) => job.round === run.round && job.role === role);
  if (jobs.length === 0) return "pending";
  if (jobs.some((job) => job.outcome === "running"))
    return terminal.has(run.phase) ? "halted" : "active";
  return jobs.some((job) => job.outcome === "completed") ? "done" : "failed";
}

function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Ticks while the run is live so a quiet stage still reads as alive. */
function Duration({ run }: { run: ArenaRun }) {
  const live = !terminal.has(run.phase);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return (
    <span className="arena-duration">
      {formatDuration((live ? now : (run.endedAt ?? run.updatedAt)) - run.startedAt)}
    </span>
  );
}

function roleName(job: Job) {
  return roleLabel(job.role, job.candidate);
}

function Provider({ job }: { job: Job }) {
  const { providers } = experimental_useProviders();
  const id = job.model.providerId;
  const provider = providers.find((candidate) => candidate.id === id);
  return (
    <span className="arena-provider" title={job.model.model}>
      <ProviderIcon
        providerKind="agent"
        provider={provider ?? { id }}
        className="arena-provider-icon"
        aria-hidden
      />
      {provider?.displayName ?? (id === "codex" ? "Codex" : "Claude")}
    </span>
  );
}

function WorkerLink({ job }: { job: Job }) {
  const navigate = useBbNavigate();
  const threadId = job.threadId;
  if (!threadId) return <span className="arena-muted">Starting…</span>;
  return (
    <button
      type="button"
      className="arena-link"
      aria-label={`Open ${roleName(job)} thread`}
      onClick={() => navigate.toThread(threadId)}
    >
      Open thread
      <Icon name="ChevronRight" aria-hidden />
    </button>
  );
}

function Steps({ run }: { run: ArenaRun }) {
  return (
    <ol className="arena-steps" aria-label="Arena progress">
      {STAGES.map((stage) => {
        const state = stepState(run, stage.role);
        return (
          <li
            key={stage.role}
            data-state={state}
            aria-current={state === "active" ? "step" : undefined}
          >
            {state === "pending" ? (
              <span className="arena-step-dot" aria-hidden />
            ) : (
              <Icon name={STEP_ICONS[state]} aria-hidden />
            )}
            <span className="arena-step-label">{stage.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** The judge's mean rubric score (0–5) and the verdict badges for one candidate. */
function standing(run: ArenaRun, candidate: number) {
  const jobs = run.jobs.filter((item) => item.round === run.round);
  const judge = jobs.find((item) => item.role === "judge")?.report;
  const synthesis = jobs.find((item) => item.role === "synthesis")?.report;
  const badges: string[] = [];
  let mean: number | null = null;
  if (judge?.kind === "judge") {
    const criteria = judge.scores.find((item) => item.candidate === candidate)?.criteria ?? [];
    if (criteria.length)
      mean = criteria.reduce((sum, item) => sum + item.score, 0) / criteria.length;
    if (judge.preferredCandidate === candidate) badges.push("Top rated");
  }
  if (synthesis?.kind === "synthesis") {
    if (synthesis.baseCandidate === candidate) badges.push("Starting point");
    else if (synthesis.grafts.some((graft) => graft.candidate === candidate))
      badges.push("Parts used");
  }
  return { mean, badges };
}

/** A rewrite stops reading as "in progress" after this long, even if it never lands. */
const REWRITE_PATIENCE_MS = 120_000;

/** The plain-language rewrite of a job's result, if one has landed. */
function rewrite<K extends Readable["kind"]>(
  digests: readonly Digest[],
  job: Job | undefined,
  kind: K,
): Extract<Readable, { kind: K }> | null {
  const result = digests.find((item) => item.jobKey === job?.key && item.status === "done")?.result;
  return result?.kind === kind ? (result as Extract<Readable, { kind: K }>) : null;
}

/** One switch for every rewritten block, so the card never mixes the two voices by accident. */
function Wording({
  digests,
  original,
  onToggle,
}: {
  digests: readonly Digest[];
  original: boolean;
  onToggle: () => void;
}) {
  if (digests.some((item) => item.status === "done" && item.result))
    return (
      <button type="button" className="arena-link arena-wording" onClick={onToggle}>
        {original ? "Show rewritten wording" : "Show original wording"}
      </button>
    );
  const rewriting = digests.some(
    (item) => item.status === "running" && Date.now() - item.startedAt < REWRITE_PATIENCE_MS,
  );
  return rewriting ? (
    <span className="arena-muted arena-shimmer arena-wording">Rewriting for readability…</span>
  ) : null;
}

function CandidateBody({
  job,
  active,
  readable,
}: {
  job: Job;
  active: boolean;
  readable: Extract<Readable, { kind: "candidate" }> | null;
}) {
  if (job.report?.kind === "candidate") return <p>{readable?.summary ?? job.report.summary}</p>;
  if (job.error) return <p className="arena-error">{job.error}</p>;
  return active ? (
    <p className="arena-muted arena-shimmer">Working on the task…</p>
  ) : (
    <p className="arena-muted">Stopped before sharing a result.</p>
  );
}

function Candidate({ job, run, digests }: { job: Job; run: ArenaRun; digests: readonly Digest[] }) {
  const { mean, badges } = standing(run, job.candidate ?? 0);
  const state =
    job.outcome === "running" ? (terminal.has(run.phase) ? "halted" : "active") : job.outcome;
  return (
    <section className="arena-candidate" data-state={state} aria-label={roleName(job)}>
      <header>
        <strong>{roleName(job)}</strong>
        <Provider job={job} />
        {mean !== null && (
          <span className="arena-score" title="Average review score (0–5)">
            {mean.toFixed(1)}
            <span className="arena-muted">/5</span>
          </span>
        )}
      </header>
      {badges.length > 0 && (
        <div className="arena-badges">
          {badges.map((badge) => (
            <span key={badge} className="arena-badge" data-kind={badge}>
              {badge}
            </span>
          ))}
        </div>
      )}
      <CandidateBody
        job={job}
        active={state === "active"}
        readable={rewrite(digests, job, "candidate")}
      />
      <footer>
        <WorkerLink job={job} />
      </footer>
    </section>
  );
}

/** What landed: the combined change, where its parts came from, and whether checks passed. */
function Result({
  job,
  integration,
  digests,
}: {
  job: Job | undefined;
  integration: ArenaRun["integration"];
  digests: readonly Digest[];
}) {
  const report = job?.report?.kind === "synthesis" ? job.report : null;
  if (!job || !report) return integration ? <Verification integration={integration} /> : null;
  const text = rewrite(digests, job, "synthesis");
  const sources = [...new Set(report.grafts.map((graft) => graft.candidate))];
  return (
    <section className="arena-result" aria-label="Combined result">
      <header>
        <Icon name="GitMerge" aria-hidden />
        <h3>Combined result</h3>
        <span className="arena-muted">Built on Candidate {report.baseCandidate + 1}</span>
        <WorkerLink job={job} />
      </header>
      <p className="arena-lead">{text?.summary ?? report.summary}</p>
      {sources.map((source) => (
        <div key={source} className="arena-grafts">
          <p className="arena-label">From Candidate {source + 1}</p>
          <ul>
            {report.grafts.map((graft, index) =>
              graft.candidate === source ? (
                <li key={graft.change}>
                  <Icon name="Plus" aria-hidden />
                  <span>{text?.grafts[index] ?? graft.change}</span>
                </li>
              ) : null,
            )}
          </ul>
        </div>
      ))}
      {integration && <Verification integration={integration} />}
    </section>
  );
}

function Verification({ integration }: { integration: NonNullable<ArenaRun["integration"]> }) {
  const [open, setOpen] = useState<string | null>(null);
  const passed = integration.status === "integrated";
  const shown = integration.checks.find((check) => check.command === open);
  return (
    <div className="arena-verification" data-passed={passed} aria-label="Checks">
      <p className="arena-status">
        <Icon name={passed ? "CircleCheck" : "CircleX"} aria-hidden />
        <span>{integration.summary}</span>
      </p>
      {integration.checks.length > 0 && (
        <div className="arena-checks">
          {integration.checks.map((check) => (
            <button
              key={check.command}
              type="button"
              className="arena-check"
              data-passed={check.exitCode === 0}
              aria-expanded={open === check.command}
              title="Show output"
              onClick={() => setOpen(open === check.command ? null : check.command)}
            >
              <Icon name={check.exitCode === 0 ? "Check" : "X"} aria-hidden />
              <span className="arena-visually-hidden">
                {check.exitCode === 0 ? "Passed" : "Failed"}
              </span>
              <code>{check.command}</code>
            </button>
          ))}
        </div>
      )}
      {shown && <pre>{shown.output || "The command finished without output."}</pre>}
    </div>
  );
}

function Details({ run, digests }: { run: ArenaRun; digests: readonly Digest[] }) {
  const jobs = run.jobs.filter((job) => job.round === run.round);
  const frame = jobs.find((job) => job.role === "frame")?.report;
  const judge = jobs.find((job) => job.role === "judge");
  const synthesisJob = jobs.find((job) => job.role === "synthesis");
  const synthesis = synthesisJob?.report;
  const combined = rewrite(digests, synthesisJob, "synthesis");
  const candidates = jobs.filter((job) => job.role === "candidate");
  const scores = judge?.report?.kind === "judge" ? judge.report.scores : [];
  return (
    <details className="arena-details">
      <summary>
        <Icon name="ChevronRight" aria-hidden />
        Details
      </summary>
      <div className="arena-details-body">
        {frame?.kind === "frame" && (
          <table className="arena-rubric">
            <thead>
              <tr>
                <th scope="col">Goal</th>
                {scores.map((item) => (
                  <th scope="col" key={item.candidate}>
                    Candidate {item.candidate + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {frame.rubric.map((criterion, index) => {
                const best = Math.max(...scores.map((item) => item.criteria[index]?.score ?? 0));
                return (
                  <tr key={criterion}>
                    <td>{criterion}</td>
                    {scores.map((item) => {
                      const score = item.criteria[index]?.score;
                      return (
                        <td
                          key={item.candidate}
                          title={item.criteria[index]?.rationale}
                          data-best={scores.length > 1 && score === best}
                        >
                          {score ?? "–"}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {judge && (
          <div className="arena-judge">
            <header>
              <h3>Review</h3>
              <Provider job={judge} />
              <WorkerLink job={judge} />
            </header>
            <p>{judge.report?.summary ?? judge.error ?? "Review is still running."}</p>
          </div>
        )}
        {synthesis?.kind === "synthesis" && (
          <div>
            <h3>Why Candidate {synthesis.baseCandidate + 1}</h3>
            <p>{combined?.rationale ?? synthesis.rationale}</p>
          </div>
        )}
        {candidates.some((job) => job.report?.kind === "candidate") && (
          <div>
            <h3>Tradeoffs</h3>
            <ul>
              {candidates.map((job) =>
                job.report?.kind === "candidate" ? (
                  <li key={job.key}>
                    <strong>{roleName(job)}:</strong>{" "}
                    {rewrite(digests, job, "candidate")?.tradeoff ?? job.report.tradeoff}
                  </li>
                ) : null,
              )}
            </ul>
          </div>
        )}
        {synthesis?.kind === "synthesis" && synthesis.rejected.length > 0 && (
          <div>
            <h3>Not included</h3>
            <ul>
              {synthesis.rejected.map((item, index) => (
                <li key={item}>{combined?.rejected[index] ?? item}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="arena-history">
          {Array.from({ length: run.round }, (_, index) => index + 1).map((round) => (
            <p key={round}>
              <strong>Round {round}</strong>
              {run.jobs
                .filter((job) => job.round === round)
                .map((job) => (
                  <span key={job.key} data-outcome={job.outcome} title={job.error ?? undefined}>
                    <Icon name={OUTCOME_ICONS[job.outcome]} aria-hidden />
                    {roleName(job)}
                  </span>
                ))}
            </p>
          ))}
        </div>
      </div>
    </details>
  );
}

const OUTCOME_ICONS: Record<Job["outcome"], string> = {
  running: "Dot",
  completed: "Check",
  failed: "X",
};
const NO_DIGESTS: readonly Digest[] = [];

export function ArenaSummary({
  run,
  digests = NO_DIGESTS,
  onStop,
  stopping,
}: {
  run: ArenaRun;
  digests?: readonly Digest[];
  onStop: () => void;
  stopping: boolean;
}) {
  const [original, setOriginal] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const rewrites = original ? NO_DIGESTS : digests;
  const jobs = run.jobs.filter((job) => job.round === run.round);
  const candidates = jobs.filter((job) => job.role === "candidate");
  const synthesis = jobs.find((job) => job.role === "synthesis");
  const live = !terminal.has(run.phase);
  // A rerun keeps its reason in both fields until the next stage clears the error.
  const error = run.error && run.error !== run.feedback?.summary ? run.error : null;
  return (
    <article className="arena-summary" data-phase={run.phase} aria-label="Arena run summary">
      <header className="arena-header">
        <div className="arena-title">
          <Icon name="Fork" aria-hidden />
          <strong>Arena</strong>
          <button
            type="button"
            className="arena-task"
            aria-expanded={taskOpen}
            title={taskOpen ? "Hide the task" : run.task}
            onClick={() => setTaskOpen(!taskOpen)}
          >
            {run.task}
          </button>
        </div>
        <div className="arena-actions">
          {(live || run.round > 1) && (
            <span className="arena-round">
              Round {run.round} of {MAX_ROUNDS}
            </span>
          )}
          <span className="arena-phase">
            {live && <span className="arena-pulse" aria-hidden />}
            {phaseNames[run.phase]}
          </span>
          <Duration run={run} />
          {live && (
            <button type="button" className="arena-stop" onClick={onStop} disabled={stopping}>
              <Icon name="Square" aria-hidden />
              {stopping
                ? "Stopping…"
                : run.phase === "stopping"
                  ? "Retry stop"
                  : run.phase === "failing"
                    ? "Retry cleanup"
                    : "Stop Arena"}
            </button>
          )}
        </div>
      </header>
      {/* Once applied, every step is a check mark; the result below says the same thing. */}
      {taskOpen && <p className="arena-task-full">{run.task}</p>}
      {run.phase !== "completed" && <Steps run={run} />}
      {run.feedback && run.round > 1 && (
        <p className="arena-callout">
          <strong>Trying again after round {run.round - 1}.</strong> {run.feedback.summary}
        </p>
      )}
      {error && (
        <output className="arena-alert" role="alert">
          {error}
        </output>
      )}
      <Result job={synthesis} integration={run.integration} digests={rewrites} />
      {candidates.length > 0 && (
        <div className="arena-candidates">
          {candidates.map((job) => (
            <Candidate key={job.key} job={job} run={run} digests={rewrites} />
          ))}
        </div>
      )}
      <footer className="arena-footer">
        <Details run={run} digests={rewrites} />
        <Wording digests={digests} original={original} onToggle={() => setOriginal(!original)} />
      </footer>
    </article>
  );
}

function RunCard({ runId, threadId }: { runId: string; threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [run, setRun] = useState<ArenaRun | null>(null);
  const [digests, setDigests] = useState<readonly Digest[]>([]);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const result = await rpc.call("get", { runId, threadId });
      if (request === sequence.current) {
        setRun((current) =>
          !current || result.run.updatedAt >= current.updatedAt ? result.run : current,
        );
        setDigests(result.digests ?? []);
        setError("");
      }
    } catch (cause) {
      if (request === sequence.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load this Arena. Retry to refresh it.",
        );
    }
  }, [rpc, runId, threadId]);
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current += 1;
    };
  }, [refresh, connection]);
  useRealtime("arena.changed", (payload) => {
    const event = changed.safeParse(payload);
    if (event.success && event.data.runId === runId) void refresh();
  });
  async function stop() {
    setStopping(true);
    setError("");
    try {
      const result = await rpc.call("stop", { runId, threadId });
      setRun((current) =>
        !current || result.run.updatedAt >= current.updatedAt ? result.run : current,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not stop Arena. Try again.");
    } finally {
      setStopping(false);
    }
  }
  return (
    <div>
      {error && (
        <div role="alert" className="arena-alert arena-load-error">
          {error}{" "}
          <button type="button" className="arena-link" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}
      {run ? (
        <ArenaSummary run={run} digests={digests} onStop={() => void stop()} stopping={stopping} />
      ) : (
        !error && <output className="arena-loading">Loading Arena…</output>
      )}
    </div>
  );
}

function ArenaDirective({ attributes, message, source }: PluginMessageDirectiveProps) {
  const id = z.uuid().safeParse(attributes.run);
  if (!id.success)
    return (
      <p role="alert">
        Can’t show this Arena: the run ID is invalid. <code>{source}</code>
      </p>
    );
  return (
    <RunCard key={`${message.threadId}:${id.data}`} runId={id.data} threadId={message.threadId} />
  );
}

/** Hidden workers have no sidebar row, so their header links back to the launching chat. */
function BackToMainThread({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [owner, setOwner] = useState<{ threadId: string; owner: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const thread = await sdk.threads.get({ threadId }).catch(() => null);
      if (cancelled || !thread) return;
      const worker = thread.originPluginId === "scott-engineering";
      setOwner({ threadId, owner: worker ? thread.lifecycleOwnerThreadId : null });
    })();
    return () => {
      cancelled = true;
    };
  }, [sdk, threadId]);
  const target = owner?.threadId === threadId ? owner.owner : null;
  if (!target) return null;
  return (
    <button
      type="button"
      className="arena-back"
      onClick={() => navigate.toThread(target)}
      aria-label="Back to main thread"
      title="Back to the thread that started this Arena"
    >
      <Icon name="ChevronLeft" aria-hidden />
      {!isCompactViewport && <span>Back to main thread</span>}
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: "arena", component: ArenaDirective });
  app.slots.experimental_threadHeaderAction({
    id: "arena-back-to-main-thread",
    title: "Back to main thread",
    component: BackToMainThread,
  });
  registerReview(app);
});
