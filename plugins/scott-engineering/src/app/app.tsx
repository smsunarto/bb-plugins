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
import { MAX_ROUNDS, roleLabel, terminal, type ArenaRun, type Job } from "../shared/arena.ts";
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
      {formatDuration((live ? now : run.updatedAt) - run.startedAt)}
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

function Task({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 240 || text.split("\n").length > 3;
  return (
    <div className="arena-task">
      <p data-open={open || !long}>{text}</p>
      {long && (
        <button type="button" className="arena-link" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show full task"}
        </button>
      )}
    </div>
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

function CandidateBody({ job, active }: { job: Job; active: boolean }) {
  if (job.report)
    return (
      <>
        <p>{job.report.summary}</p>
        {job.report.kind === "candidate" && <p className="arena-muted">{job.report.tradeoff}</p>}
      </>
    );
  if (job.error) return <p className="arena-error">{job.error}</p>;
  return active ? (
    <p className="arena-muted arena-shimmer">Working on the task…</p>
  ) : (
    <p className="arena-muted">Stopped before sharing a result.</p>
  );
}

function Candidate({ job, run }: { job: Job; run: ArenaRun }) {
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
      <CandidateBody job={job} active={state === "active"} />
      <footer>
        <WorkerLink job={job} />
      </footer>
    </section>
  );
}

function Synthesis({ job }: { job: Job }) {
  const report = job.report?.kind === "synthesis" ? job.report : null;
  if (!report) return null;
  return (
    <section className="arena-section" aria-label="Combined result">
      <header>
        <Icon name="GitMerge" aria-hidden />
        <h3>Combined result</h3>
        <Provider job={job} />
        <WorkerLink job={job} />
      </header>
      <p>{report.summary}</p>
      <p className="arena-muted">
        Built on Candidate {report.baseCandidate + 1}. {report.rationale}
      </p>
      {report.grafts.length > 0 && (
        <ul className="arena-grafts">
          {report.grafts.map((graft) => (
            <li key={`${graft.candidate}:${graft.change}`}>
              <span className="arena-badge">From Candidate {graft.candidate + 1}</span>
              <span>{graft.change}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Verification({ integration }: { integration: NonNullable<ArenaRun["integration"]> }) {
  const passed = integration.status === "integrated";
  return (
    <section className="arena-section" data-passed={passed} aria-label="Checks">
      <header>
        <Icon name={passed ? "CircleCheck" : "CircleX"} aria-hidden />
        <h3>Checks</h3>
      </header>
      <p className={passed ? undefined : "arena-error"}>{integration.summary}</p>
      {integration.checks.length > 0 && (
        <ul className="arena-checks">
          {integration.checks.map((check) => (
            <li key={check.command}>
              <details>
                <summary data-passed={check.exitCode === 0}>
                  <Icon name={check.exitCode === 0 ? "Check" : "X"} aria-hidden />
                  <span className="arena-check-status">
                    {check.exitCode === 0 ? "Passed" : "Failed"}
                  </span>
                  <code>{check.command}</code>
                </summary>
                <pre>{check.output || "The command finished without output."}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Details({ run }: { run: ArenaRun }) {
  const jobs = run.jobs.filter((job) => job.round === run.round);
  const frame = jobs.find((job) => job.role === "frame")?.report;
  const judge = jobs.find((job) => job.role === "judge");
  const synthesis = jobs.find((job) => job.role === "synthesis")?.report;
  const scores = judge?.report?.kind === "judge" ? judge.report.scores : [];
  return (
    <details className="arena-details">
      <summary>
        <Icon name="ChevronRight" aria-hidden />
        Scores, review, and history
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
              {frame.rubric.map((criterion, index) => (
                <tr key={criterion}>
                  <td>{criterion}</td>
                  {scores.map((item) => (
                    <td key={item.candidate} title={item.criteria[index]?.rationale}>
                      {item.criteria[index]?.score ?? "–"}
                    </td>
                  ))}
                </tr>
              ))}
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
        {synthesis?.kind === "synthesis" && synthesis.rejected.length > 0 && (
          <div>
            <h3>Not included</h3>
            <ul>
              {synthesis.rejected.map((item) => (
                <li key={item}>{item}</li>
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

export function ArenaSummary({
  run,
  onStop,
  stopping,
}: {
  run: ArenaRun;
  onStop: () => void;
  stopping: boolean;
}) {
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
          <span className="arena-round">
            Round {run.round} of {MAX_ROUNDS}
          </span>
        </div>
        <div className="arena-actions">
          <span className="arena-phase">
            {live && <span className="arena-pulse" aria-hidden />}
            {phaseNames[run.phase]}
          </span>
          <Duration run={run} />
          {live && (
            <button type="button" className="arena-stop" onClick={onStop} disabled={stopping}>
              <Icon name="Square" aria-hidden />
              {stopping ? "Stopping…" : run.phase === "stopping" ? "Retry stop" : "Stop Arena"}
            </button>
          )}
        </div>
      </header>
      <Steps run={run} />
      <Task text={run.task} />
      {run.feedback && run.round > 1 && (
        <p className="arena-callout">
          <strong>Trying again after round {run.round - 1}.</strong> {run.feedback.summary}
        </p>
      )}
      {candidates.length > 0 && (
        <div className="arena-candidates">
          {candidates.map((job) => (
            <Candidate key={job.key} job={job} run={run} />
          ))}
        </div>
      )}
      {synthesis && <Synthesis job={synthesis} />}
      {run.integration && <Verification integration={run.integration} />}
      {error && (
        <output className="arena-alert" role="alert">
          {error}
        </output>
      )}
      <Details run={run} />
    </article>
  );
}

function RunCard({ runId, threadId }: { runId: string; threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [run, setRun] = useState<ArenaRun | null>(null);
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
        <ArenaSummary run={run} onStop={() => void stop()} stopping={stopping} />
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
});
