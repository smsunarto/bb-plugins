// What `Pipeline` shows, from the three shapes it takes: `gh run view --json
// name,displayTitle,status,conclusion,event,headBranch,headSha,url,createdAt,updatedAt,jobs`
// (or any subset that has `jobs`), `gh pr checks --json
// name,state,bucket,link,startedAt,completedAt,workflow`, and a hand-written
// list of stages `{name, status, duration?, url?, jobs?: [{name, status,
// duration?, url?, steps?}]}`. Pure: no React, no DOM.
import type { Value } from "./types";

export type PipelineStatus = "failure" | "in_progress" | "queued" | "cancelled" | "success" | "neutral" | "skipped";

export interface PipelineStep {
  readonly name: string;
  readonly number: number | null;
  readonly status: PipelineStatus;
  /** The tool's own word where it says more than the status: "timed out", "waiting". */
  readonly detail: string | null;
  readonly ms: number | null;
  /** What a hand-written list says went wrong. */
  readonly message: string | null;
}

export interface PipelineJob {
  readonly name: string;
  readonly status: PipelineStatus;
  readonly detail: string | null;
  readonly url: string | null;
  /** Epoch ms; null when the job has not started or the data has no times. */
  readonly startedAt: number | null;
  /** How long it ran (so far, for a running job, up to the newest time in the data); null when unknown. */
  readonly ms: number | null;
  /** Where its bar starts, in ms from the run's first start; null when the data has no timeline. */
  readonly offset: number | null;
  readonly steps: readonly PipelineStep[];
  /** Index in `steps` of the first failed step; -1 when none failed. */
  readonly failedStep: number;
  readonly message: string | null;
}

export interface PipelineStage {
  /** The stage's or workflow's name; null for stages inferred from times. */
  readonly name: string | null;
  readonly status: PipelineStatus;
  readonly url: string | null;
  readonly ms: number | null;
  readonly jobs: readonly PipelineJob[];
}

export type PipelineSource = "run" | "checks" | "list";

export interface PipelineRun {
  readonly source: PipelineSource;
  /** The workflow's name. */
  readonly name: string | null;
  /** What the run is about: the commit or pull request title. */
  readonly title: string | null;
  readonly status: PipelineStatus;
  readonly detail: string | null;
  readonly branch: string | null;
  readonly sha: string | null;
  readonly event: string | null;
  readonly url: string | null;
  /** Epoch ms the run was created or its first job started. */
  readonly startedAt: number | null;
  /** The newest time in the data: what a running run's "so far" is measured to; null when the data has no times. */
  readonly asOf: number | null;
  /** The whole run; null while it runs or when nothing is timed. */
  readonly ms: number | null;
  /** The length every job's `offset` and `ms` is drawn against; null when no job is timed. */
  readonly span: number | null;
  /**
   * `stages`: stages that run one after another (a list's stages, or a gh
   * run's jobs grouped by when they started: gh's JSON has no `needs`);
   * `groups`: independent groups (a pull request's checks by workflow).
   */
  readonly layout: "stages" | "groups";
  readonly stages: readonly PipelineStage[];
  readonly counts: Readonly<Record<PipelineStatus, number>>;
  readonly jobCount: number;
}

export type PipelineResult = { readonly ok: true; readonly run: PipelineRun } | { readonly ok: false; readonly error: string };

const SHAPE_HINT =
  "Pipeline needs gh run view --json …,jobs, gh pr checks --json name,state,bucket,…, or a list of stages [{name, status, jobs?}]";

/** Inferred stages past this many read as noise: the jobs show as one list. */
const MAX_INFERRED_STAGES = 8;

/** A plain data object's fields; absent keys read as undefined. */
type Fields = Readonly<Record<string, Value | undefined>>;

function fieldsOf(value: Value | undefined): Fields | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if ("kind" in value && (value.kind === "node" || value.kind === "action" || value.kind === "binding")) return null;
  return value as Fields;
}

function str(value: Value | undefined): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function webUrl(value: Value | undefined): string | null {
  const text = str(value);
  return text !== null && /^https?:\/\/\S+$/i.test(text) ? text : null;
}

/** An ISO time as epoch ms; GitHub's `0001-01-01T00:00:00Z` (not yet) and anything unparsable are null. */
export function timestamp(value: Value | undefined): number | null {
  const text = str(value);
  if (text === null) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// ---------------------------------------------------------------------------
// Status words

const STATUS_WORDS: Readonly<Record<string, readonly [PipelineStatus, string | null]>> = {
  success: ["success", null],
  succeeded: ["success", null],
  successful: ["success", null],
  pass: ["success", null],
  passed: ["success", null],
  passing: ["success", null],
  ok: ["success", null],
  done: ["success", null],
  completed: ["success", null],
  complete: ["success", null],
  green: ["success", null],
  failure: ["failure", null],
  failed: ["failure", null],
  fail: ["failure", null],
  failing: ["failure", null],
  error: ["failure", "error"],
  errored: ["failure", "error"],
  broken: ["failure", null],
  red: ["failure", null],
  timedout: ["failure", "timed out"],
  timeout: ["failure", "timed out"],
  startupfailure: ["failure", "startup failure"],
  actionrequired: ["failure", "action required"],
  inprogress: ["in_progress", null],
  running: ["in_progress", null],
  active: ["in_progress", null],
  started: ["in_progress", null],
  building: ["in_progress", null],
  deploying: ["in_progress", null],
  queued: ["queued", null],
  pending: ["queued", null],
  waiting: ["queued", "waiting"],
  requested: ["queued", null],
  scheduled: ["queued", null],
  expected: ["queued", "expected"],
  blocked: ["queued", "blocked"],
  cancelled: ["cancelled", null],
  canceled: ["cancelled", null],
  cancel: ["cancelled", null],
  aborted: ["cancelled", null],
  stopped: ["cancelled", null],
  skipped: ["skipped", null],
  skipping: ["skipped", null],
  skip: ["skipped", null],
  neutral: ["neutral", null],
  stale: ["neutral", "stale"],
};

/** A status word (any case, `_`/`-`/space ignored) as a status and its detail; null when it is no status. */
export function pipelineStatus(value: Value | undefined): { readonly status: PipelineStatus; readonly detail: string | null } | null {
  if (typeof value === "boolean") return { status: value ? "success" : "failure", detail: null };
  if (typeof value !== "string") return null;
  const word = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!Object.hasOwn(STATUS_WORDS, word)) return null;
  const [status, detail] = STATUS_WORDS[word];
  return { status, detail };
}

/** A gh run, job or step: `status` until it completes, then its `conclusion`. */
function ghStatus(fields: Fields): { status: PipelineStatus; detail: string | null } {
  const state = str(fields.status)?.toLowerCase() ?? null;
  if (state === "completed" || state === null) {
    const conclusion = pipelineStatus(fields.conclusion ?? undefined);
    if (conclusion !== null) return conclusion;
    return state === "completed" ? { status: "neutral", detail: null } : { status: "queued", detail: null };
  }
  return pipelineStatus(state) ?? { status: "queued", detail: state };
}

/** The state a set of jobs adds up to. */
export function overallStatus(statuses: readonly PipelineStatus[]): PipelineStatus {
  if (statuses.length === 0) return "neutral";
  const has = (status: PipelineStatus) => statuses.includes(status);
  if (has("failure")) return "failure";
  if (has("in_progress")) return "in_progress";
  if (has("queued")) return statuses.every((status) => status === "queued") || !has("success") ? "queued" : "in_progress";
  if (has("cancelled")) return "cancelled";
  if (has("success")) return "success";
  if (statuses.every((status) => status === "skipped")) return "skipped";
  return "neutral";
}

/** Failures first, then running, queued…; the given order otherwise. */
function byAttention<T extends { readonly status: PipelineStatus }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => STATUS_ORDER.indexOf(a.item.status) - STATUS_ORDER.indexOf(b.item.status) || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * The label two or more job names share before a separator, as a matrix
 * names its jobs ("Build&Test: node-24, macos-latest", "test (ubuntu, 20)",
 * "e2e / chromium"), so a stage can say it once: the label and how much of
 * each name it covers. Null when they share none.
 */
export function matrixPrefix(names: readonly string[]): { readonly label: string; readonly length: number } | null {
  if (names.length < 2) return null;
  const head = (name: string) => /^(.+?)(?::\s+|\s+(?=\()|\s+[-/›]\s+)(?=\S)/.exec(name);
  const first = head(names[0]);
  if (first === null) return null;
  return names.every((name) => head(name)?.[0] === first[0]) ? { label: first[1], length: first[0].length } : null;
}

// ---------------------------------------------------------------------------
// Durations

/** `850ms`, `45s`, `1.5 s`, `1m 20s`, `2h 5m`, `01:23`, `1:02:03`; numbers are seconds. Null when unreadable. */
export function parseDuration(value: Value | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value * 1000 : null;
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text === "") return null;
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d+))?$/.exec(text);
  if (clock !== null) {
    const [, h, m, s] = clock;
    return ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * 1000;
  }
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  const unit = /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/g;
  let total = 0;
  let matched = "";
  for (const match of text.matchAll(unit)) {
    const amount = Number(match[1]);
    const word = match[2];
    total += word.startsWith("ms") || word.startsWith("milli") ? amount : word.startsWith("s") ? amount * 1000 : word.startsWith("m") ? amount * 60_000 : amount * 3_600_000;
    matched += match[0];
  }
  // Everything but spaces and commas must have been read.
  return matched !== "" && matched.replace(/\s/g, "").length === text.replace(/[\s,]/g, "").length ? total : null;
}

/** CI style: `0s`, `<1s`, `45s`, `1m 34s`, `1h 05m`. */
export function formatElapsed(ms: number): string {
  if (!(ms > 0)) return "0s";
  if (ms < 1000) return ms < 950 ? "<1s" : "1s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

// ---------------------------------------------------------------------------
// Readers

interface TimedJob {
  readonly job: Omit<PipelineJob, "offset">;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
}

/** A gh step: `{name, status, conclusion, number, startedAt, completedAt}`. */
function ghStep(value: Value): PipelineStep | null {
  const fields = fieldsOf(value);
  const name = fields === null ? null : str(fields.name);
  if (fields === null || name === null) return null;
  const { status, detail } = ghStatus(fields);
  const start = timestamp(fields.startedAt);
  const end = timestamp(fields.completedAt);
  const number = typeof fields.number === "number" && Number.isSafeInteger(fields.number) ? fields.number : null;
  return { name, number, status, detail, ms: start !== null && end !== null ? Math.max(0, end - start) : null, message: null };
}

/** A gh job; a running job is timed up to `asOf`, the newest time in the data. */
function ghJob(value: Value, asOf: number | null): TimedJob | null {
  const fields = fieldsOf(value);
  const name = fields === null ? null : str(fields.name);
  if (fields === null || name === null) return null;
  const { status, detail } = ghStatus(fields);
  const steps = Array.isArray(fields.steps) ? fields.steps.flatMap((step) => ghStep(step) ?? []) : [];
  const startedAt = timestamp(fields.startedAt);
  // A skipped job can report its completion a second before its start.
  const completedAt = startedAt === null ? null : (() => {
    const end = timestamp(fields.completedAt);
    return end === null ? null : Math.max(end, startedAt);
  })();
  const end = completedAt ?? (status === "in_progress" ? asOf : null);
  const ms = startedAt !== null && end !== null ? Math.max(0, end - startedAt) : null;
  return {
    job: { name, status, detail, url: webUrl(fields.url), startedAt, ms, steps, failedStep: steps.findIndex((step) => step.status === "failure"), message: null },
    startedAt,
    completedAt,
  };
}

/**
 * Jobs grouped into stages by when they ran: a job starts a later stage than
 * every job that had finished by the time it started. gh's JSON has no
 * `needs`, so this is the order things ran in, which for a workflow of
 * dependent jobs is its graph's columns. Jobs that have not started go last.
 */
export function inferStages(jobs: readonly TimedJob[]): TimedJob[][] {
  const started = jobs
    .map((job, index) => ({ job, index }))
    .filter(({ job }) => job.startedAt !== null)
    .sort((a, b) => a.job.startedAt! - b.job.startedAt! || a.index - b.index);
  const level = new Map<TimedJob, number>();
  let deepest = 0;
  for (const { job } of started) {
    let stage = 0;
    for (const [other, otherStage] of level) {
      // A skipped job did nothing another could have waited for.
      if (other.job.status === "skipped" || other.completedAt === null || other.completedAt > job.startedAt!) continue;
      stage = Math.max(stage, otherStage + 1);
    }
    level.set(job, stage);
    deepest = Math.max(deepest, stage);
  }
  const waiting = jobs.filter((job) => job.startedAt === null);
  const count = deepest + 1 + (waiting.length > 0 && started.length > 0 ? 1 : 0);
  if (count > MAX_INFERRED_STAGES) return [[...jobs]];
  const stages: TimedJob[][] = Array.from({ length: deepest + 1 }, () => []);
  // Keep the data's order within a stage.
  for (const job of jobs) if (job.startedAt !== null) stages[level.get(job)!].push(job);
  if (waiting.length > 0) stages.push(waiting);
  return stages.filter((stage) => stage.length > 0);
}

function counted(jobs: readonly { readonly status: PipelineStatus }[]): Record<PipelineStatus, number> {
  const counts: Record<PipelineStatus, number> = { failure: 0, in_progress: 0, queued: 0, cancelled: 0, success: 0, neutral: 0, skipped: 0 };
  for (const job of jobs) counts[job.status]++;
  return counts;
}

/** Timed jobs placed on a shared axis from the first start. */
function placed(jobs: readonly TimedJob[]): { jobs: Map<TimedJob, PipelineJob>; start: number | null; span: number | null } {
  const starts = jobs.flatMap((job) => (job.startedAt === null ? [] : [job.startedAt]));
  const start = starts.length === 0 ? null : Math.min(...starts);
  let end = start;
  const out = new Map<TimedJob, PipelineJob>();
  for (const timed of jobs) {
    const offset = start !== null && timed.startedAt !== null ? timed.startedAt - start : null;
    if (offset !== null && timed.job.ms !== null) end = Math.max(end!, start! + offset + timed.job.ms);
    out.set(timed, { ...timed.job, offset });
  }
  return { jobs: out, start, span: start === null || end === null || end <= start ? null : end - start };
}

function stageOf(name: string | null, jobs: readonly PipelineJob[], url: string | null = null, ms: number | null = null): PipelineStage {
  const timed = jobs.filter((job) => job.offset !== null && job.ms !== null);
  const wall = timed.length === 0 ? null : Math.max(...timed.map((job) => job.offset! + job.ms!)) - Math.min(...timed.map((job) => job.offset!));
  return { name, status: overallStatus(jobs.map((job) => job.status)), url, ms: ms ?? wall, jobs: byAttention(jobs) };
}

function newestTime(values: readonly (number | null)[]): number | null {
  const times = values.filter((value): value is number => value !== null);
  return times.length === 0 ? null : Math.max(...times);
}

/** Every timestamp a gh run's JSON holds, run, jobs and steps. */
function ghTimes(run: Fields, jobs: readonly Value[]): (number | null)[] {
  const times = [timestamp(run.createdAt), timestamp(run.updatedAt)];
  for (const value of jobs) {
    const job = fieldsOf(value);
    if (job === null) continue;
    times.push(timestamp(job.startedAt), timestamp(job.completedAt));
    if (Array.isArray(job.steps)) {
      for (const step of job.steps) {
        const fields = fieldsOf(step);
        if (fields !== null) times.push(timestamp(fields.startedAt), timestamp(fields.completedAt));
      }
    }
  }
  return times;
}

function fromGhRun(run: Fields): PipelineRun {
  const values = Array.isArray(run.jobs) ? run.jobs : [];
  const asOf = newestTime(ghTimes(run, values));
  const timed = values.flatMap((value) => ghJob(value, asOf) ?? []);
  const { jobs, start, span } = placed(timed);
  const stages = inferStages(timed).map((stage) => stageOf(null, stage.map((job) => jobs.get(job)!)));
  const all = [...jobs.values()];
  const own = str(run.status) === null && str(run.conclusion) === null ? null : ghStatus(run);
  const { status, detail } = own ?? { status: overallStatus(all.map((job) => job.status)), detail: null };
  const created = timestamp(run.createdAt);
  const updated = timestamp(run.updatedAt);
  const finished = status !== "in_progress" && status !== "queued";
  const ms = finished && created !== null && updated !== null && updated >= created ? updated - created : finished && span !== null ? span : null;
  return {
    source: "run",
    name: str(run.name) ?? str(run.workflowName),
    title: str(run.displayTitle),
    status,
    detail,
    branch: str(run.headBranch),
    sha: str(run.headSha),
    event: str(run.event),
    url: webUrl(run.url),
    startedAt: created ?? start,
    asOf,
    ms,
    span,
    layout: "stages",
    stages,
    counts: counted(all),
    jobCount: all.length,
  };
}

/** The run id in a check's Actions link, so two runs of one workflow keep apart. */
function runIdOf(link: string | null): string | null {
  return link === null ? null : (/\/actions\/runs\/(\d+)/.exec(link)?.[1] ?? null);
}

function isCheck(value: Value): boolean {
  const fields = fieldsOf(value);
  return fields !== null && (fields.bucket !== undefined || (fields.state !== undefined && (fields.link !== undefined || fields.workflow !== undefined)));
}

function fromChecks(values: readonly Value[]): PipelineRun {
  const timed: { group: string; workflow: string | null; timed: TimedJob }[] = [];
  for (const value of values) {
    const fields = fieldsOf(value);
    const name = fields === null ? null : str(fields.name);
    if (fields === null || name === null) continue;
    const read = pipelineStatus(fields.state ?? undefined) ?? pipelineStatus(fields.bucket ?? undefined) ?? { status: "neutral" as const, detail: null };
    const startedAt = timestamp(fields.startedAt);
    const end = timestamp(fields.completedAt);
    const completedAt = startedAt !== null && end !== null ? Math.max(end, startedAt) : null;
    const ms = startedAt !== null && completedAt !== null && read.status !== "in_progress" && read.status !== "queued" ? completedAt - startedAt : null;
    const link = webUrl(fields.link);
    const workflow = str(fields.workflow);
    timed.push({
      group: `${workflow ?? ""}\u0000${workflow === null ? "" : (runIdOf(link) ?? "")}`,
      workflow,
      timed: {
        job: { name, status: read.status, detail: read.detail, url: link, startedAt, ms, steps: [], failedStep: -1, message: null },
        startedAt,
        completedAt,
      },
    });
  }
  const { jobs, start, span } = placed(timed.map(({ timed }) => timed));
  const groups = new Map<string, { workflow: string | null; jobs: PipelineJob[] }>();
  for (const { group, workflow, timed: job } of timed) {
    const entry = groups.get(group) ?? { workflow, jobs: [] };
    entry.jobs.push(jobs.get(job)!);
    groups.set(group, entry);
  }
  // One workflow that ran more than once on this commit numbers its runs by when they started.
  const entries = [...groups.values()];
  const firstStart = (jobs: readonly PipelineJob[]) => Math.min(...jobs.map((job) => job.startedAt ?? Number.POSITIVE_INFINITY));
  const stages = entries.map(({ workflow, jobs: groupJobs }) => {
    const runs = entries.filter((entry) => entry.workflow === workflow);
    const nth = 1 + runs.filter((entry) => firstStart(entry.jobs) < firstStart(groupJobs)).length;
    const name = workflow === null ? "Other checks" : runs.length > 1 ? `${workflow} · run ${nth} of ${runs.length}` : workflow;
    const runUrl = groupJobs.map((job) => job.url).find((url) => url !== null && runIdOf(url) !== null);
    return stageOf(name, groupJobs, workflow === null || runUrl === undefined ? null : runUrl!.replace(/\/job\/\d+.*$/, ""));
  });
  const all = [...jobs.values()];
  const status = overallStatus(all.map((job) => job.status));
  const finished = status !== "in_progress" && status !== "queued";
  return {
    source: "checks",
    name: null,
    title: null,
    status,
    detail: null,
    branch: null,
    sha: null,
    event: null,
    url: null,
    startedAt: start,
    asOf: newestTime(timed.flatMap(({ timed: job }) => [job.startedAt, job.completedAt])),
    ms: finished ? span : null,
    span,
    layout: "groups",
    stages: byAttention(stages),
    counts: counted(all),
    jobCount: all.length,
  };
}

/** A hand-written step: a name, or `{name, status?, duration?, message?}`. */
function listStep(value: Value, jobStatus: PipelineStatus, index: number): PipelineStep | null {
  if (typeof value === "string") {
    const name = value.trim();
    return name === "" ? null : { name, number: index + 1, status: jobStatus === "success" ? "success" : "neutral", detail: null, ms: null, message: null };
  }
  const fields = fieldsOf(value);
  const name = fields === null ? null : (str(fields.name) ?? str(fields.title));
  if (fields === null || name === null) return null;
  const read = pipelineStatus(fields.status ?? fields.conclusion ?? fields.state ?? undefined);
  return {
    name,
    number: index + 1,
    status: read?.status ?? (jobStatus === "success" ? "success" : "neutral"),
    detail: read?.detail ?? null,
    ms: listDuration(fields),
    message: str(fields.message) ?? str(fields.error),
  };
}

function listDuration(fields: Fields): number | null {
  const given = parseDuration(fields.duration ?? fields.time ?? fields.elapsed ?? undefined);
  if (given !== null) return given;
  const start = timestamp(fields.startedAt ?? fields.start ?? undefined);
  const end = timestamp(fields.completedAt ?? fields.end ?? undefined);
  return start !== null && end !== null && end >= start ? end - start : null;
}

/** A hand-written job: `{name, status, duration?, url?, steps?, message?}`. */
function listJob(value: Value): Omit<PipelineJob, "offset"> | null {
  const fields = fieldsOf(value);
  const name = typeof value === "string" ? value.trim() || null : fields === null ? null : (str(fields.name) ?? str(fields.title));
  if (name === null) return null;
  if (fields === null) return { name, status: "neutral", detail: null, url: null, startedAt: null, ms: null, steps: [], failedStep: -1, message: null };
  const read = pipelineStatus(fields.status ?? fields.conclusion ?? fields.state ?? undefined);
  const status = read?.status ?? "neutral";
  const steps = Array.isArray(fields.steps) ? fields.steps.flatMap((step, index) => listStep(step, status, index) ?? []) : [];
  return {
    name,
    status,
    detail: read?.detail ?? null,
    url: webUrl(fields.url ?? fields.link ?? undefined),
    startedAt: timestamp(fields.startedAt ?? fields.start ?? undefined),
    ms: listDuration(fields),
    steps,
    failedStep: steps.findIndex((step) => step.status === "failure"),
    message: str(fields.message) ?? str(fields.error),
  };
}

function fromList(values: readonly Value[], header: Fields | null): PipelineRun {
  // Each item is a stage; one without jobs is a stage of one job, itself.
  const raw = values.flatMap((value) => {
    const fields = fieldsOf(value);
    const self = listJob(value);
    if (self === null) return [];
    const nested = fields !== null && Array.isArray(fields.jobs) ? fields.jobs.flatMap((job) => listJob(job) ?? []) : [];
    // A stage's own status, when the list gives one, wins over its jobs'.
    const own = nested.length > 0 && fields !== null && pipelineStatus(fields.status ?? fields.conclusion ?? fields.state ?? undefined) !== null;
    return [{ self, jobs: nested.length > 0 ? nested : [self], own }];
  });
  // Stages run one after another: with every stage timed, jobs sit on one axis.
  const stageMs = raw.map(({ self, jobs }) => self.ms ?? (jobs.every((job) => job.ms !== null) ? Math.max(...jobs.map((job) => job.ms!)) : null));
  const sequential = raw.length > 0 && stageMs.every((ms) => ms !== null);
  const longest = Math.max(0, ...raw.flatMap(({ jobs }) => jobs.map((job) => job.ms ?? 0)));
  let cursor = 0;
  const stages = raw.map(({ self, jobs, own }, index) => {
    const at = cursor;
    if (sequential) cursor += stageMs[index]!;
    const stage = stageOf(
      self.name,
      jobs.map((job) => ({ ...job, offset: job.ms === null ? null : sequential ? at : 0 })),
      self.url,
      stageMs[index],
    );
    return own ? { ...stage, status: self.status } : stage;
  });
  const all = stages.flatMap((stage) => stage.jobs);
  const span = sequential ? cursor : longest;
  const headerStatus = header === null ? null : pipelineStatus(header.status ?? header.conclusion ?? undefined);
  return {
    source: "list",
    name: header === null ? null : (str(header.name) ?? str(header.workflow)),
    title: header === null ? null : (str(header.title) ?? str(header.displayTitle)),
    status: headerStatus?.status ?? overallStatus(stages.map((stage) => stage.status)),
    detail: headerStatus?.detail ?? null,
    branch: header === null ? null : (str(header.branch) ?? str(header.headBranch)),
    sha: header === null ? null : (str(header.sha) ?? str(header.commit) ?? str(header.headSha)),
    event: header === null ? null : str(header.event),
    url: header === null ? null : webUrl(header.url),
    startedAt: header === null ? null : timestamp(header.startedAt ?? header.createdAt ?? undefined),
    asOf: null,
    ms: (header === null ? null : parseDuration(header.duration ?? undefined)) ?? (sequential && cursor > 0 ? cursor : null),
    span: span > 0 ? span : null,
    layout: "stages",
    stages,
    counts: counted(all),
    jobCount: all.length,
  };
}

/** The run `value` describes, or why it can't be read. */
export function readPipeline(value: Value | undefined): PipelineResult {
  const fields = fieldsOf(value);
  if (Array.isArray(value) && value.some(isCheck)) return { ok: true, run: fromChecks(value) };
  if (fields !== null && Array.isArray(fields.jobs) && (fields.headSha !== undefined || fields.databaseId !== undefined || fields.conclusion !== undefined || isGhJobList(fields.jobs))) {
    return { ok: true, run: fromGhRun(fields) };
  }
  const stages = Array.isArray(value) ? value : fields === null ? null : Array.isArray(fields.stages) ? fields.stages : Array.isArray(fields.jobs) ? fields.jobs : null;
  if (stages !== null) {
    const run = fromList(stages, Array.isArray(value) ? null : fields);
    return stages.length > 0 && run.jobCount === 0 ? { ok: false, error: "Pipeline stages need a name and a status" } : { ok: true, run };
  }
  if (fields !== null && (fields.headSha !== undefined || fields.displayTitle !== undefined)) return { ok: true, run: fromGhRun(fields) };
  return { ok: false, error: SHAPE_HINT };
}

/** gh's job objects carry `startedAt`/`conclusion`/`databaseId`; a hand list rarely does. */
function isGhJobList(jobs: readonly Value[]): boolean {
  return jobs.some((job) => {
    const fields = fieldsOf(job);
    return fields !== null && (fields.databaseId !== undefined || (fields.conclusion !== undefined && fields.startedAt !== undefined));
  });
}

// ---------------------------------------------------------------------------
// Words the renderer and the markdown share

export const STATUS_LABEL: Record<PipelineStatus, string> = {
  failure: "Failed",
  in_progress: "In progress",
  queued: "Queued",
  cancelled: "Cancelled",
  success: "Succeeded",
  neutral: "Neutral",
  skipped: "Skipped",
};

/** States in attention order: failures, then what still runs, then the rest. */
export const STATUS_ORDER: readonly PipelineStatus[] = ["failure", "in_progress", "queued", "cancelled", "success", "neutral", "skipped"];

/** How a count of jobs in a state reads: "3 failed", "2 running". */
export const COUNT_WORD: Record<PipelineStatus, string> = {
  failure: "failed",
  in_progress: "running",
  queued: "queued",
  cancelled: "cancelled",
  success: "passed",
  neutral: "neutral",
  skipped: "skipped",
};

/** "1 failed, 7 passed, 1 skipped": attention order, zero counts left out. */
export function jobCountsText(counts: Readonly<Record<PipelineStatus, number>>, separator = ", "): string {
  const parts = STATUS_ORDER.filter((status) => counts[status] > 0).map((status) => `${counts[status]} ${COUNT_WORD[status]}`);
  return parts.length === 0 ? "no jobs" : parts.join(separator);
}

/** The jobs that failed, each with its first failed step. */
export function failedJobs(run: PipelineRun): { readonly job: PipelineJob; readonly step: PipelineStep | null }[] {
  return run.stages.flatMap((stage) =>
    stage.jobs.filter((job) => job.status === "failure").map((job) => ({ job, step: job.failedStep < 0 ? null : job.steps[job.failedStep] })),
  );
}

/** What "Investigate" sends: which jobs failed where, and the run's link. */
export function investigateMessage(run: PipelineRun): string | null {
  const failed = failedJobs(run);
  if (failed.length === 0) return null;
  const subject = run.source === "checks" ? "these checks" : `the ${run.name ?? "CI"} run${run.branch === null ? "" : ` on ${run.branch}`}`;
  const shown = failed.slice(0, 8).map(({ job, step }) => `${job.name}${step === null ? "" : ` (step "${step.name}")`}${job.url === null ? "" : ` ${job.url}`}`);
  const more = failed.length > shown.length ? `; and ${failed.length - shown.length} more` : "";
  return `Find out why ${subject} failed and fix it. Failed: ${shown.join("; ")}${more}${run.url === null ? "" : `. Run: ${run.url}`}`;
}

/** What "Re-run failed jobs" sends; null when nothing failed or was cancelled. */
export function rerunMessage(run: PipelineRun): string | null {
  const failed = run.counts.failure > 0;
  if (!failed && run.status !== "cancelled") return null;
  const what = failed ? (run.source === "checks" ? "the failed checks" : "the failed jobs") : "the cancelled run";
  const of = run.source === "checks" ? "" : ` of ${run.name ?? "the run"}${run.branch === null ? "" : ` on ${run.branch}`}`;
  return `Re-run ${what}${of}${run.url === null ? "" : ` (${run.url})`}.`;
}
