import {
  definePluginApp,
  experimental_Icon as Icon,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { terminal, type ArenaRun, type Job } from "../shared/arena.ts";
import type { rpcContract } from "../shared/rpc.ts";
import "./arena.css";

const changed = z.object({ runId: z.uuid() });
const phaseNames: Record<ArenaRun["phase"], string> = {
  snapshot: "Preparing",
  framing: "Framing",
  candidates: "Candidates running",
  judging: "Judging",
  synthesizing: "Synthesizing",
  integrating: "Verifying and integrating",
  stopping: "Stopping",
  failing: "Stopping failed run",
  completed: "Integrated",
  failed: "Needs attention",
  stopped: "Stopped",
};

function WorkerLink({ job }: { job: Job }) {
  const navigate = useBbNavigate();
  const threadId = job.threadId;
  if (!threadId) return <span className="arena-muted">Waiting to launch</span>;
  return (
    <button type="button" className="arena-worker-link" onClick={() => navigate.toThread(threadId)}>
      Open {job.role === "candidate" ? `Candidate ${(job.candidate ?? 0) + 1}` : job.role} thread
    </button>
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
  const report = synthesis?.report?.kind === "synthesis" ? synthesis.report : null;
  const judge = jobs.find((job) => job.role === "judge");
  const frame = jobs.find((job) => job.role === "frame")?.report;
  const completed = run.phase === "completed";
  return (
    <article className="arena-summary" aria-label="Arena run summary">
      <header className="arena-header">
        <div className="arena-heading">
          <Icon name="GitCompareArrows" aria-hidden />
          <strong>Arena</strong>
          <span className="arena-muted">Round {run.round} of 3</span>
        </div>
        <div className="arena-actions">
          <span className={completed ? "arena-success" : "arena-state"}>
            {phaseNames[run.phase]}
          </span>
          {!terminal.has(run.phase) && (
            <button type="button" onClick={onStop} disabled={stopping}>
              {stopping
                ? "Stopping…"
                : run.phase === "stopping"
                  ? "Retry Stop Arena"
                  : "Stop Arena"}
            </button>
          )}
        </div>
      </header>
      <p className="arena-task">{run.task}</p>
      {candidates.length > 0 && (
        <section aria-label="Candidates" className="arena-candidates">
          {candidates.map((job) => (
            <div key={job.key} className="arena-candidate">
              <div className="arena-candidate-label">
                <strong>Candidate {(job.candidate ?? 0) + 1}</strong>
                <span className="arena-muted">
                  {job.model.providerId === "codex" ? "Codex" : "Claude"}
                </span>
              </div>
              <div>
                <p>
                  {job.report?.summary ?? job.error ?? "Working independently on the same task…"}
                </p>
                {job.report?.kind === "candidate" && (
                  <p className="arena-muted">{job.report.tradeoff}</p>
                )}
                <WorkerLink job={job} />
              </div>
            </div>
          ))}
        </section>
      )}
      {report && (
        <section className="arena-synthesis" aria-label="Synthesis">
          <h3>Synthesis</h3>
          <p>{report.summary}</p>
          <p className="arena-muted">
            Base: Candidate {report.baseCandidate + 1}. {report.rationale}
          </p>
          {report.grafts.length > 0 && (
            <ul>
              {report.grafts.map((graft) => (
                <li key={`${graft.candidate}:${graft.change}`}>
                  From Candidate {graft.candidate + 1}: {graft.change}
                </li>
              ))}
            </ul>
          )}
          {synthesis && <WorkerLink job={synthesis} />}
        </section>
      )}
      {run.integration && (
        <section aria-label="Verification" className="arena-verification">
          <h3>Verification</h3>
          <p>{run.integration.summary}</p>
          {run.integration.checks.map((check) => (
            <details key={check.command}>
              <summary>
                <span className={check.exitCode === 0 ? "arena-success" : "arena-error"}>
                  {check.exitCode === 0 ? "Passed" : "Failed"}
                </span>{" "}
                <code>{check.command}</code>
              </summary>
              <pre>{check.output || "Command completed without output."}</pre>
            </details>
          ))}
        </section>
      )}
      {run.error && <output className="arena-error">{run.error}</output>}
      <details className="arena-details">
        <summary>Judgment and round history</summary>
        {frame?.kind === "frame" && (
          <ol>
            {frame.rubric.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ol>
        )}
        {judge && (
          <div>
            <p>{judge.report?.summary ?? judge.error ?? "Judgment pending."}</p>
            <WorkerLink job={judge} />
          </div>
        )}
        {report && report.rejected.length > 0 && (
          <div>
            <h3>Not incorporated</h3>
            <ul>
              {report.rejected.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {Array.from({ length: run.round }, (_, index) => index + 1).map((round) => (
          <div key={round} className="arena-round">
            <strong>Round {round}</strong>
            {run.jobs
              .filter((job) => job.round === round)
              .map((job) => (
                <p key={job.key}>
                  {job.role}
                  {job.candidate === null ? "" : ` ${job.candidate + 1}`} · {job.outcome}
                  {job.error ? ` · ${job.error}` : ""}
                </p>
              ))}
          </div>
        ))}
      </details>
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
        setError(cause instanceof Error ? cause.message : "Could not load Arena.");
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
      setError(cause instanceof Error ? cause.message : "Could not stop Arena. Retry Stop Arena.");
    } finally {
      setStopping(false);
    }
  }
  return (
    <div>
      {error && (
        <div role="alert" className="arena-load-error">
          {error}{" "}
          <button type="button" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}
      {run ? (
        <ArenaSummary run={run} onStop={() => void stop()} stopping={stopping} />
      ) : (
        !error && <output>Loading Arena…</output>
      )}
    </div>
  );
}

function ArenaDirective({ attributes, message, source }: PluginMessageDirectiveProps) {
  const id = z.uuid().safeParse(attributes.run);
  if (!id.success)
    return (
      <p role="alert">
        Invalid Arena run reference. <code>{source}</code>
      </p>
    );
  return (
    <RunCard key={`${message.threadId}:${id.data}`} runId={id.data} threadId={message.threadId} />
  );
}

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: "arena", component: ArenaDirective });
});
