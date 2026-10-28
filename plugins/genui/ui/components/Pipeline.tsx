// A CI run as the CI's own page shows it: the run's state, duration, branch
// and commit up top; its jobs as a pipeline (stage columns on a wide reply,
// one list on a narrow one), each with its state, duration and a bar on the
// run's time axis; a failed job open to its steps with the failing one
// marked. Links go out to the CI; re-running or investigating is a message
// the user sends, never an API call from here.
import { useContext, useId, useMemo, useState, type ReactNode } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  COUNT_WORD,
  formatElapsed,
  investigateMessage,
  matrixPrefix,
  readPipeline,
  rerunMessage,
  STATUS_LABEL,
  STATUS_ORDER,
  type PipelineJob,
  type PipelineRun,
  type PipelineStage,
  type PipelineStatus,
  type PipelineStep,
} from "../../core/pipeline";
import type { Action } from "../../core/types";
import { CardDepthContext, NodeKeyContext } from "../runtime";
import { formatNumber, TONE_DOT, TONE_TEXT, type Props, type Tone } from "../values";
import { ErrorLine } from "./display";
import { Button, ButtonGroup, FOCUS_RING } from "./inputs";
import { CHART_DRAW_MS, FADE, RISE, SMOOTH_HEIGHT_CLASS, useEntrance, useSmoothHeight, type Entrance } from "./motion";
import { EXACT_TIME, ICON_BUTTON } from "./projectKit";

/** Jobs a stage or group lists before "N more". */
const JOB_PAGE = 12;
/** Failed and running jobs open on arrival; past this many they wait for a click. */
const OPEN_ON_ARRIVAL = 3;
/** Steps a job lists before "N more". */
const STEP_PAGE = 60;

const GROW_X: Entrance = { keyframes: [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], duration: CHART_DRAW_MS };

const TONE: Record<PipelineStatus, Tone> = {
  failure: "bad",
  in_progress: "warn",
  queued: "neutral",
  cancelled: "neutral",
  success: "good",
  neutral: "neutral",
  skipped: "neutral",
};

/** The bar of a job on the run's time axis. */
const BAR_FILL: Record<PipelineStatus, string> = {
  failure: "bg-destructive",
  in_progress: "bg-warning animate-pulse motion-reduce:animate-none",
  queued: "bg-muted-foreground/30",
  cancelled: "bg-muted-foreground/45",
  success: "bg-success/75",
  neutral: "bg-muted-foreground/45",
  skipped: "bg-muted-foreground/25",
};

const TEXT_BUTTON = cn(
  "w-fit shrink-0 cursor-pointer rounded-sm text-xs leading-5 text-muted-foreground transition-colors duration-150 hover:text-foreground",
  FOCUS_RING,
);

// ---------------------------------------------------------------------------
// Marks

/** The state as GitHub draws it: a check, a cross, a turning arc, rings for the rest. */
function StatusMark({ status, className }: { status: PipelineStatus; className?: string }) {
  const base = cn("size-3.5 shrink-0", className);
  if (status === "success") return <Icon name="CircleCheck" aria-hidden className={cn(base, "text-success")} />;
  if (status === "failure") return <Icon name="CircleX" aria-hidden className={cn(base, "text-destructive")} />;
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn(base, status === "in_progress" ? "text-warning" : "text-muted-foreground")}>
      {status === "in_progress" ? (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.75" />
          <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="origin-center animate-spin motion-reduce:animate-none" />
        </>
      ) : status === "queued" ? (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="8" cy="8" r="1.75" fill="currentColor" />
        </>
      ) : status === "cancelled" ? (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4 12 12 4" stroke="currentColor" strokeWidth="1.5" />
        </>
      ) : status === "neutral" ? (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : (
        // Skipped: a dashed ring, neither a pass nor a failure (as Tests draws it).
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.6 2.1" />
      )}
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <Icon
      name="ChevronRight"
      aria-hidden
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground motion-reduce:transition-none",
        open && "rotate-90",
      )}
    />
  );
}

function DetailChip({ detail }: { detail: string | null }) {
  if (detail === null) return null;
  return <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10.5px] font-medium leading-4 text-muted-foreground">{detail}</span>;
}

/** An icon that opens `url` in a new tab: a job's or a run's page on the CI. */
function OutLink({ url, label }: { url: string; label: string }) {
  return (
    <UrlLink href={url} title={label} aria-label={label} className={cn(ICON_BUTTON, "no-underline")}>
      <Icon name="ExternalLink" aria-hidden className="size-3.5" />
    </UrlLink>
  );
}

/** A job's bar on the run's axis; with no timeline, its length against the longest job. */
function DurationBar({ job, span }: { job: PipelineJob; span: number | null }) {
  const grow = useEntrance<HTMLDivElement>(GROW_X);
  if (span === null || job.ms === null || job.offset === null) return <div aria-hidden className="h-1 w-full rounded-full bg-muted/60" />;
  const left = Math.min(100, (job.offset / span) * 100);
  const width = Math.max(0, Math.min(100 - left, (job.ms / span) * 100));
  return (
    <div aria-hidden className="relative h-1 w-full overflow-hidden rounded-full bg-muted/60">
      <div
        ref={grow}
        className={cn("absolute inset-y-0 min-w-[2px] origin-left rounded-full", BAR_FILL[job.status])}
        style={{ left: `${left}%`, width: `${width}%` }}
      />
    </div>
  );
}

function jobTime(job: PipelineJob): string | null {
  if (job.status === "queued") return job.detail === null ? "queued" : null;
  if (job.ms === null) return null;
  return job.status === "in_progress" ? `${formatElapsed(job.ms)}…` : formatElapsed(job.ms);
}

// ---------------------------------------------------------------------------
// Steps

function StepRow({ step, failing }: { step: PipelineStep; failing: boolean }) {
  const quiet = step.status === "skipped" || (step.status === "queued" && !failing);
  return (
    <li className={cn("flex min-w-0 flex-col rounded-md px-1.5 py-0.5", failing && "bg-destructive/8")}>
      <div className="flex min-w-0 items-center gap-2 text-xs leading-5">
        <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground/70">{step.number ?? ""}</span>
        <StatusMark status={step.status} className="size-3" />
        <span
          title={step.name}
          className={cn(
            "min-w-0 flex-1 truncate",
            failing ? "font-medium text-destructive" : quiet ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {step.name}
        </span>
        <span className="sr-only">, {STATUS_LABEL[step.status]}</span>
        <DetailChip detail={step.detail} />
        {failing ? <span className="shrink-0 text-[11px] font-medium text-destructive">failed here</span> : null}
        {step.status === "in_progress" ? (
          <span className="shrink-0 font-medium text-warning-text">running</span>
        ) : step.ms === null ? null : (
          <span className="shrink-0 tabular-nums text-muted-foreground">{formatElapsed(step.ms)}</span>
        )}
      </div>
      {step.message === null ? null : (
        <pre className="m-0 ml-[38px] whitespace-pre-wrap font-mono text-[11px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">{step.message}</pre>
      )}
    </li>
  );
}

/** A job's steps, its failing step marked, and the link to its log. */
function JobDetail({ job }: { job: PipelineJob }) {
  const fade = useEntrance<HTMLDivElement>(FADE);
  const [shown, setShown] = useState(STEP_PAGE);
  const rest = job.steps.length - shown;
  return (
    <div ref={fade} className="flex min-w-0 flex-col gap-1.5 pb-1 pt-1">
      {job.message === null ? null : (
        <pre className="m-0 whitespace-pre-wrap rounded-md bg-destructive/8 px-2 py-1 font-mono text-[11px] leading-4 text-destructive [overflow-wrap:anywhere]">
          {job.message}
        </pre>
      )}
      {job.steps.length === 0 ? null : (
        <ol aria-label={`Steps of ${job.name}`} className="m-0 flex min-w-0 list-none flex-col p-0">
          {job.steps.slice(0, shown).map((step, index) => (
            <StepRow key={index} step={step} failing={index === job.failedStep} />
          ))}
        </ol>
      )}
      {rest > 0 ? (
        <button type="button" onClick={() => setShown((count) => count + STEP_PAGE)} className={cn(TEXT_BUTTON, "pl-[34px]")}>
          Show {formatNumber(rest)} more {rest === 1 ? "step" : "steps"}
        </button>
      ) : null}
      {job.url === null ? null : (
        <UrlLink
          href={job.url}
          className={cn("ml-[34px] flex w-fit items-center gap-1 rounded-sm text-xs leading-5 text-muted-foreground no-underline hover:text-foreground", FOCUS_RING)}
        >
          {job.status === "failure" ? "Open the log" : "Open the job"}
          <Icon name="ExternalLink" aria-hidden className="size-3" />
        </UrlLink>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Jobs

/** Which jobs show their steps, by `jobId`. */
interface Opened {
  readonly isOpen: (id: string) => boolean;
  readonly toggle: (id: string) => void;
}

/** One job: its state, name, time and bar; a button that opens its steps where it has any. */
function JobRow({ job, label, openId, span, opened, inline }: { job: PipelineJob; label: string; openId: string; span: number | null; opened: Opened; inline: boolean }) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const id = useId();
  const expandable = job.steps.length > 0 || job.message !== null;
  const open = expandable && opened.isOpen(openId);
  const { outer, inner } = useSmoothHeight<HTMLLIElement, HTMLDivElement>();
  const time = jobTime(job);
  const body = (
    <>
      <span className="flex min-w-0 items-start gap-1.5">
        <span className="flex h-5 shrink-0 items-center gap-1.5">
          {expandable ? <Chevron open={open} /> : <span aria-hidden className="w-3.5 shrink-0" />}
          <StatusMark status={job.status} />
        </span>
        <span
          title={job.name}
          className={cn("line-clamp-2 min-w-0 flex-1 text-[13px] leading-5 text-foreground [overflow-wrap:anywhere]", job.status === "failure" && "font-medium")}
        >
          {label === job.name ? job.name : <><span className="sr-only">{job.name.slice(0, job.name.length - label.length)}</span>{label}</>}
        </span>
        <span className="sr-only">, {STATUS_LABEL[job.status]}</span>
        <DetailChip detail={job.detail} />
        {time === null || !inline ? null : <span className="shrink-0 text-xs leading-5 tabular-nums text-muted-foreground">{time}</span>}
      </span>
      {/* In a column the name takes the whole width; the time sits by the bar. */}
      <span className="flex min-w-0 items-center gap-2 pl-[42px]">
        <span className="min-w-0 flex-1">
          <DurationBar job={job} span={span} />
        </span>
        {time === null || inline ? null : <span className="shrink-0 text-[11px] leading-4 tabular-nums text-muted-foreground">{time}</span>}
      </span>
    </>
  );
  return (
    <li
      ref={(element) => {
        rise.current = element;
        outer.current = element;
      }}
      className={cn("min-w-0", SMOOTH_HEIGHT_CLASS)}
    >
      <div ref={inner} className="flex min-w-0 flex-col">
        <div className={cn("flex min-w-0 gap-1", inline ? "items-start" : "items-end")}>
          {expandable ? (
            <button
              type="button"
              id={`${id}-job`}
              aria-expanded={open}
              aria-controls={inline ? `${id}-steps` : undefined}
              aria-label={`${job.name}, ${STATUS_LABEL[job.status].toLowerCase()}${time === null ? "" : `, ${time}`}`}
              onClick={() => opened.toggle(openId)}
              className={cn("group flex min-w-0 flex-1 cursor-pointer flex-col gap-1 rounded-md py-1 text-left", FOCUS_RING)}
            >
              {body}
            </button>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col gap-1 py-1">{body}</div>
          )}
          {job.url === null ? null : (
            <span className={inline ? "pt-0.5" : "pb-0.5"}>
              <OutLink url={job.url} label={`Open ${job.name}`} />
            </span>
          )}
        </div>
        {inline && open ? (
          <div id={`${id}-steps`} role="region" aria-labelledby={`${id}-job`} className="min-w-0 pl-2">
            <JobDetail job={job} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function JobList({ jobs, stage, cut, span, opened, inline }: { jobs: readonly PipelineJob[]; stage: number; cut: number; span: number | null; opened: Opened; inline: boolean }) {
  const [shown, setShown] = useState(JOB_PAGE);
  const rest = jobs.length - shown;
  return (
    <>
      <ul className="m-0 flex min-w-0 list-none flex-col gap-0.5 p-0">
        {jobs.slice(0, shown).map((job, index) => (
          <JobRow key={index} job={job} label={job.name.slice(cut)} openId={jobId(stage, index)} span={span} opened={opened} inline={inline} />
        ))}
      </ul>
      {rest > 0 ? (
        <button type="button" onClick={() => setShown((count) => count + JOB_PAGE * 4)} className={cn(TEXT_BUTTON, "pl-5")}>
          Show {formatNumber(rest)} more {rest === 1 ? "job" : "jobs"}
        </button>
      ) : null}
    </>
  );
}

/** What a stage is called and how much of its jobs' names that covers; null for a stage that is one job of its own name. */
function stageHeading(stage: PipelineStage, index: number, total: number): { label: string; cut: number } | null {
  if (stage.jobs.length === 1 && stage.jobs[0].name === stage.name) return null;
  if (stage.name !== null) return { label: stage.name, cut: 0 };
  // A matrix says its shared name once: "Build&Test" over "node-24, macos-latest".
  const matrix = matrixPrefix(stage.jobs.map((job) => job.name));
  if (matrix !== null) return { label: matrix.label, cut: matrix.length };
  return { label: total > 1 ? `Stage ${index + 1}` : "Jobs", cut: 0 };
}

/** A stage's header: its name (or its place, for stages read from times), its state, jobs and time. */
function StageHeader({ stage, label }: { stage: PipelineStage; label: string }) {
  const count = `${formatNumber(stage.jobs.length)} ${stage.jobs.length === 1 ? "job" : "jobs"}`;
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs leading-5 text-muted-foreground">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[TONE[stage.status]])} />
      <span className="min-w-0 truncate font-medium text-foreground">{label}</span>
      <span className="sr-only">, {STATUS_LABEL[stage.status]}</span>
      <span className="shrink-0 tabular-nums">{stage.ms === null || stage.ms === 0 ? count : `${count} · ${formatElapsed(stage.ms)}`}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layouts

/**
 * Stages one after another: columns joined by chevrons on a wide reply, one
 * list with stage captions on a narrow one. An open job's steps sit under
 * it in the list, and under the columns on a wide reply.
 */
function Stages({ run, opened }: { run: PipelineRun; opened: Opened }) {
  const open = run.stages.flatMap((stage, s) =>
    stage.jobs.flatMap((job, j) => ((job.steps.length > 0 || job.message !== null) && opened.isOpen(jobId(s, j)) ? [{ job, id: jobId(s, j) }] : [])),
  );
  const headings = run.stages.map((stage, index) => stageHeading(stage, index, run.stages.length));
  const many = run.stages.length > 1;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* Narrow: one list. */}
      <div className="flex min-w-0 flex-col gap-3 @2xl:hidden">
        {run.stages.map((stage, index) => (
          <section key={index} aria-label={headings[index]?.label ?? stage.jobs[0]?.name} className="flex min-w-0 flex-col gap-1">
            {headings[index] !== null && (many || stage.name !== null) ? <StageHeader stage={stage} label={headings[index].label} /> : null}
            <JobList jobs={stage.jobs} stage={index} cut={headings[index]?.cut ?? 0} span={run.span} opened={opened} inline />
          </section>
        ))}
      </div>
      {/* Wide: columns, scrolling sideways past what fits. */}
      <div className="hidden min-w-0 snap-x overflow-x-auto pb-1 @2xl:flex">
        {run.stages.map((stage, index) => (
          <div key={index} className="flex min-w-0 shrink-0 snap-start items-start" style={{ flexBasis: `${Math.max(100 / run.stages.length, 30)}%` }}>
            {index === 0 ? null : (
              <Icon name="ChevronRight" aria-hidden className="mx-1 mt-1 size-3.5 shrink-0 text-muted-foreground/60" />
            )}
            <section aria-label={headings[index]?.label ?? stage.jobs[0]?.name} className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg bg-surface-recessed/60 px-2 py-1.5">
              {headings[index] === null ? null : <StageHeader stage={stage} label={headings[index].label} />}
              <JobList jobs={stage.jobs} stage={index} cut={headings[index]?.cut ?? 0} span={run.span} opened={opened} inline={false} />
            </section>
          </div>
        ))}
      </div>
      {open.length === 0 ? null : (
        <div className="hidden min-w-0 flex-col gap-3 @2xl:flex">
          {open.map(({ job, id }) => (
            <section key={id} aria-label={`${job.name}, steps`} className="flex min-w-0 flex-col gap-0.5 border-t border-border/60 pt-2">
              <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium leading-5 text-foreground">
                <StatusMark status={job.status} />
                <span className="min-w-0 flex-1 truncate">{job.name}</span>
                {job.ms === null ? null : <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">{jobTime(job)}</span>}
                <button type="button" aria-label={`Close ${job.name}`} title="Close" onClick={() => opened.toggle(id)} className={ICON_BUTTON}>
                  <Icon name="X" aria-hidden className="size-3.5" />
                </button>
              </div>
              <JobDetail job={job} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** Independent groups (a pull request's checks by workflow): groups with trouble open, all-clear ones folded. */
function Groups({ run, opened }: { run: PipelineRun; opened: Opened }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {run.stages.map((stage, index) => (
        <Group key={index} stage={stage} index={index} span={run.span} opened={opened} />
      ))}
    </div>
  );
}

function Group({ stage, index, span, opened }: { stage: PipelineStage; index: number; span: number | null; opened: Opened }) {
  const id = useId();
  const quiet = stage.status === "success" || stage.status === "skipped" || stage.status === "neutral";
  const [open, setOpen] = useState(!quiet);
  const { outer, inner } = useSmoothHeight<HTMLElement, HTMLDivElement>();
  return (
    <section ref={outer} aria-label={stage.name ?? "Checks"} className={cn("min-w-0", SMOOTH_HEIGHT_CLASS)}>
      <div ref={inner} className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            id={`${id}-group`}
            aria-expanded={open}
            aria-controls={`${id}-checks`}
            aria-label={`${stage.name}, ${STATUS_LABEL[stage.status].toLowerCase()}, ${groupCounts(stage)}`}
            onClick={() => setOpen((value) => !value)}
            className={cn("group flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md py-0.5 text-left text-xs leading-5", FOCUS_RING)}
          >
            <Chevron open={open} />
            <StatusMark status={stage.status} />
            <span className="min-w-0 max-w-[70%] shrink-0 truncate text-[13px] font-medium text-foreground">{stage.name}</span>
            <span className="sr-only">, {STATUS_LABEL[stage.status]}</span>
            <span className="min-w-0 truncate tabular-nums text-muted-foreground">{groupCounts(stage)}</span>
          </button>
          {stage.url === null ? null : <OutLink url={stage.url} label={`Open the ${stage.name} run`} />}
        </div>
        {open ? (
          <div id={`${id}-checks`} role="region" aria-labelledby={`${id}-group`} className="min-w-0 pl-4">
            <JobList jobs={stage.jobs} stage={index} cut={0} span={span} opened={opened} inline />
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** "1 failed · 7 passed" for a group's header, attention first. */
function groupCounts(stage: PipelineStage): string {
  return STATUS_ORDER.map((status) => [stage.jobs.filter((job) => job.status === status).length, COUNT_WORD[status]] as const)
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${formatNumber(count)} ${word}`)
    .join(" · ");
}

// ---------------------------------------------------------------------------
// Header

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function Header({ run }: { run: PipelineRun }) {
  const fade = useEntrance<HTMLDivElement>(FADE);
  const title = run.title ?? run.name ?? (run.source === "checks" ? "Checks" : "Pipeline");
  const tone = TONE[run.status];
  const running = run.status === "in_progress" || run.status === "queued";
  const facts: ReactNode[] = [];
  if (run.title !== null && run.name !== null) facts.push(<span key="name" className="min-w-0 truncate font-medium text-foreground">{run.name}</span>);
  facts.push(
    <span key="state" className={cn("shrink-0 font-medium", TONE_TEXT[tone])}>
      {STATUS_LABEL[run.status]}
      {run.detail === null ? "" : ` (${run.detail})`}
    </span>,
  );
  if (run.ms !== null) {
    facts.push(
      <span key="time" className="flex shrink-0 items-center gap-1 tabular-nums" title="Total duration">
        <Icon name="Clock" aria-hidden className="size-3" />
        {formatElapsed(run.ms)}
      </span>,
    );
  } else if (running && run.startedAt !== null && run.asOf !== null) {
    facts.push(
      <span key="time" className="flex shrink-0 items-center gap-1 tabular-nums" title={`As of ${EXACT_TIME.format(run.asOf)}`}>
        <Icon name="Clock" aria-hidden className="size-3" />
        {formatElapsed(run.asOf - run.startedAt)} so far, as of {CLOCK.format(run.asOf)}
      </span>,
    );
  }
  if (run.branch !== null) {
    facts.push(
      <span key="branch" className="flex min-w-0 items-center gap-1" title={run.branch}>
        <Icon name="GitBranch" aria-hidden className="size-3 shrink-0" />
        <span className="sr-only">Branch </span>
        <span className="min-w-0 truncate rounded-sm bg-surface-recessed px-1.5 font-mono text-[11px]">{run.branch}</span>
      </span>,
    );
  }
  if (run.sha !== null) {
    facts.push(
      <span key="sha" className="shrink-0 font-mono text-[11px]" title={run.sha}>
        <span className="sr-only">Commit </span>
        {run.sha.slice(0, 7)}
      </span>,
    );
  }
  if (run.event !== null) facts.push(<span key="event" className="shrink-0">{run.event.replace(/_/g, " ")}</span>);
  return (
    <div ref={fade} className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-start gap-2">
        <StatusMark status={run.status} className="mt-[3px] size-4" />
        <h3 className="m-0 min-w-0 flex-1 text-balance text-[15px] font-semibold leading-6 tracking-[-0.01em] text-foreground [overflow-wrap:anywhere]">
          {title}
        </h3>
        {run.url === null ? null : <OutLink url={run.url} label="Open the run" />}
      </div>
      <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 pl-6 text-xs leading-5 text-muted-foreground">{facts}</p>
      <Counts run={run} />
    </div>
  );
}

function Counts({ run }: { run: PipelineRun }) {
  const noun = run.source === "checks" ? "checks" : "jobs";
  return (
    <p className="m-0 flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 pl-6 text-xs leading-5 text-muted-foreground">
      <span className="tabular-nums">
        {formatNumber(run.jobCount)} {run.jobCount === 1 ? noun.slice(0, -1) : noun}:
      </span>
      {STATUS_ORDER.map((status) =>
        run.counts[status] > 0 ? (
          <span key={status} className="flex items-center gap-1.5 tabular-nums">
            <span aria-hidden className={cn("size-2 rounded-full", TONE_DOT[TONE[status]])} />
            <span className={cn("font-medium", TONE_TEXT[TONE[status]] || "text-foreground")}>{formatNumber(run.counts[status])}</span>
            {COUNT_WORD[status]}
          </span>
        ) : null,
      )}
    </p>
  );
}

// ---------------------------------------------------------------------------

function sendButton(label: string, text: string, primary: boolean) {
  const action: Action = { kind: "action", type: "send", text };
  const props = { label, action: [action], ...(primary ? { variant: "primary" } : {}) };
  return { key: label, props, element: <Button props={props} /> };
}

/** A job's place in the run, stable while the same report re-evaluates. */
function jobId(stage: number, job: number): string {
  return `${stage}:${job}`;
}

/** Failed jobs, then running ones, open on arrival (the first few: they show where it broke or where it is); the rest on a click. */
function useOpened(run: PipelineRun | null): Opened {
  const initial = useMemo(() => {
    const jobsIn = (status: PipelineStatus) =>
      (run?.stages ?? []).flatMap((stage, s) =>
        stage.jobs.flatMap((job, j) => (job.status === status && (job.steps.length > 0 || job.message !== null) ? [jobId(s, j)] : [])),
      );
    return new Set([...jobsIn("failure"), ...jobsIn("in_progress")].slice(0, OPEN_ON_ARRIVAL));
  }, [run]);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  return {
    isOpen: (id) => initial.has(id) !== toggled.has(id),
    toggle: (id) =>
      setToggled((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
  };
}

export function Pipeline({ props }: { props: Props }) {
  const depth = useContext(CardDepthContext);
  const question = `${useContext(NodeKeyContext)}/actions`;
  const result = useMemo(() => readPipeline(props.run), [props.run]);
  const opened = useOpened(result.ok ? result.run : null);
  if (!result.ok) return <ErrorLine message={result.error} />;
  const run = result.run;
  const investigate = investigateMessage(run);
  const rerun = rerunMessage(run);
  const buttons = [
    ...(investigate === null ? [] : [sendButton(run.counts.failure === 1 ? "Investigate the failure" : "Investigate the failures", investigate, true)]),
    ...(rerun === null ? [] : [sendButton(run.counts.failure > 0 ? (run.source === "checks" ? "Re-run failed checks" : "Re-run failed jobs") : "Re-run", rerun, false)]),
  ];
  const body = (
    <div className="@container flex min-w-0 flex-col gap-4">
      <Header run={run} />
      {run.jobCount === 0 ? (
        <p className="m-0 pl-6 text-xs leading-5 text-muted-foreground">
          {run.source === "list" ? "No stages." : run.source === "checks" ? "No checks reported." : "No jobs in this run yet."}
        </p>
      ) : run.layout === "groups" ? (
        <Groups run={run} opened={opened} />
      ) : (
        <Stages run={run} opened={opened} />
      )}
      {buttons.length === 0 ? null : <ButtonGroup buttons={buttons} question={question} />}
    </div>
  );
  if (depth > 0) return <div className="min-w-0 text-sm text-foreground">{body}</div>;
  return (
    <CardDepthContext value={1}>
      <section aria-label={`CI run: ${run.title ?? run.name ?? "pipeline"}, ${STATUS_LABEL[run.status]}`} className="min-w-0 rounded-xl border border-border bg-background p-4 text-sm text-foreground sm:px-5">
        {body}
      </section>
    </CardDepthContext>
  );
}
