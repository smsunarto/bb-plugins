// Provenance: which build or revision really reached a phone or a server.
// A chain of stages from source to live (checkout → build → transfer →
// install → launch; commit → build → deploy → live probe), each with the
// facts it reported (branch, sha, build, device, url…). Reads the chain,
// flags a fact that differs from what was requested (`expected`) or that
// changes between stages (the sha built is not the sha installed), finds the
// last stage with a receipt, and says in one line what is true. Unknown is
// its own state: a stage without a reported outcome is "no receipt", never
// a pass. Pure: no React, no DOM.
import { formatElapsed, parseDuration, timestamp } from "./pipeline";
import type { Value } from "./types";

export type StageStatus = "done" | "failed" | "running" | "pending" | "skipped" | "unknown";

export const STAGE_STATUS_LABEL: Readonly<Record<StageStatus, string>> = {
  done: "Done",
  failed: "Failed",
  running: "Running",
  pending: "Not started",
  skipped: "Skipped",
  unknown: "Unknown",
};

/** What a fact's value is checked against, when it is wrong. */
export type FactCheck =
  /** Differs from what the user asked for. */
  | { readonly kind: "expected"; readonly expected: string }
  /** Differs from the stage before that reported the same fact. */
  | { readonly kind: "changed"; readonly stage: number; readonly previous: string };

export interface Fact {
  /** Canonical key: `sha` for commit/revision, `build` for CFBundleVersion… */
  readonly key: string;
  /** The key as shown. */
  readonly label: string;
  /** The value in full, as copied. */
  readonly value: string;
  /** The value as shown: a sha's first 7 characters, a digest's first 12. */
  readonly short: string;
  /** An identity fact (branch, sha, build, version…), compared across stages. */
  readonly identity: boolean;
  readonly check: FactCheck | null;
  /** Equal to what was requested, or to the previous stage that reported it; only ever on a stage with a receipt. */
  readonly confirmed: boolean;
}

export type Evidence =
  | { readonly kind: "url"; readonly url: string; readonly label: string | null }
  | { readonly kind: "image"; readonly src: string; readonly label: string | null }
  | { readonly kind: "file"; readonly path: string; readonly line: number | null; readonly label: string | null }
  | { readonly kind: "text"; readonly text: string; readonly label: string | null };

/**
 * Whether a stage reported its outcome: `receipt` (done, failed or
 * running), `none` (no receipt: unknown, or never reported), `waiting` (after
 * a running stage), `not-reached` (after a failure), `skipped`.
 */
export type Receipt = "receipt" | "none" | "waiting" | "not-reached" | "skipped";

export interface Stage {
  readonly name: string;
  readonly status: StageStatus;
  /** A status word worth keeping beside the status: "timed out". */
  readonly note: string | null;
  readonly facts: readonly Fact[];
  /** Epoch ms, when `time` is a date. */
  readonly at: number | null;
  /** `time` as written, when it is no date ("after 6 min"). */
  readonly timeText: string | null;
  readonly ms: number | null;
  readonly detail: string | null;
  readonly evidence: readonly Evidence[];
  readonly receipt: Receipt;
  /** The last stage with a receipt while the chain stops after it: later stages have no receipt and nothing failed or runs. */
  readonly last: boolean;
  /** The past-tense verb for what this stage did ("installed"), from its name; null when its name says none. */
  readonly verb: string | null;
}

export interface Mismatch {
  readonly stage: number;
  readonly key: string;
  readonly label: string;
  readonly actual: string;
  readonly check: FactCheck;
}

export type VerdictTone = "good" | "bad" | "warn" | "info" | "neutral";

export interface Verdict {
  readonly tone: VerdictTone;
  readonly title: string;
  /** Mismatches first, then what is unconfirmed or missing. */
  readonly lines: readonly { readonly text: string; readonly tone: VerdictTone }[];
}

export interface Provenance {
  readonly stages: readonly Stage[];
  readonly expected: readonly Fact[];
  readonly mismatches: readonly Mismatch[];
  /** The index of the last stage with a receipt; -1 when none has one. */
  readonly lastReceipt: number;
  /** Summed durations, and how many stages had one. */
  readonly totalMs: number | null;
  readonly timed: number;
  readonly verdict: Verdict;
}

export type ProvenanceResult = { readonly ok: true; readonly provenance: Provenance } | { readonly ok: false; readonly error: string };

const SHAPE_HINT = "Provenance needs a list of stages [{name, status, facts?: {branch, sha, build, device…}}], source to live";

/** Stages read at most; a real chain has a handful. */
export const MAX_STAGES = 40;
/** Facts read per stage at most. */
const MAX_FACTS = 24;
/** Evidence items read per stage at most. */
const MAX_EVIDENCE = 12;

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

// ---------------------------------------------------------------------------
// Status

const STATUS_WORDS: Readonly<Record<string, readonly [StageStatus, string | null]>> = {
  done: ["done", null],
  success: ["done", null],
  succeeded: ["done", null],
  successful: ["done", null],
  ok: ["done", null],
  pass: ["done", null],
  passed: ["done", null],
  completed: ["done", null],
  complete: ["done", null],
  finished: ["done", null],
  built: ["done", null],
  installed: ["done", null],
  deployed: ["done", null],
  launched: ["done", null],
  live: ["done", null],
  verified: ["done", null],
  failed: ["failed", null],
  failure: ["failed", null],
  fail: ["failed", null],
  error: ["failed", "error"],
  errored: ["failed", "error"],
  broken: ["failed", null],
  crashed: ["failed", "crashed"],
  rejected: ["failed", "rejected"],
  running: ["running", null],
  inprogress: ["running", null],
  active: ["running", null],
  started: ["running", null],
  building: ["running", null],
  installing: ["running", null],
  deploying: ["running", null],
  uploading: ["running", null],
  transferring: ["running", null],
  pending: ["pending", null],
  queued: ["pending", "queued"],
  waiting: ["pending", null],
  scheduled: ["pending", null],
  notstarted: ["pending", null],
  todo: ["pending", null],
  skipped: ["skipped", null],
  skip: ["skipped", null],
  notneeded: ["skipped", null],
  na: ["skipped", null],
  unknown: ["unknown", null],
  // A request that timed out says nothing about what happened on the other end.
  timeout: ["unknown", "timed out"],
  timedout: ["unknown", "timed out"],
  noreceipt: ["unknown", null],
  uncertain: ["unknown", null],
  unverified: ["unknown", "unverified"],
  claimed: ["unknown", "claimed, not checked"],
  missing: ["unknown", null],
};

/** A status word (any case; spaces, `_`, `-`, `/` ignored); anything else is unknown, keeping the word as its note. */
export function stageStatus(value: Value | undefined): { readonly status: StageStatus; readonly note: string | null } {
  if (typeof value === "boolean") return { status: value ? "done" : "failed", note: null };
  const raw = str(value);
  if (raw === null) return { status: "unknown", note: null };
  const word = raw.toLowerCase().replace(/[\s_/-]+/g, "");
  if (Object.hasOwn(STATUS_WORDS, word)) {
    const [status, note] = STATUS_WORDS[word];
    return { status, note };
  }
  return { status: "unknown", note: raw };
}

// ---------------------------------------------------------------------------
// Facts

/** Spellings of the keys tools and agents use, lowercased without separators, to the canonical key. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  sha: "sha",
  commit: "sha",
  commitsha: "sha",
  revision: "sha",
  rev: "sha",
  gitsha: "sha",
  githash: "sha",
  gitcommit: "sha",
  headsha: "sha",
  head: "sha",
  branch: "branch",
  ref: "branch",
  gitbranch: "branch",
  headbranch: "branch",
  build: "build",
  buildnumber: "build",
  buildno: "build",
  bundleversion: "build",
  cfbundleversion: "build",
  version: "version",
  versionname: "version",
  appversion: "version",
  marketingversion: "version",
  cfbundleshortversionstring: "version",
  digest: "digest",
  checksum: "digest",
  sha256: "digest",
  hash: "digest",
  artifactdigest: "digest",
  imagedigest: "digest",
  bundle: "bundle",
  bundleid: "bundle",
  bundleidentifier: "bundle",
  artifact: "artifact",
  ipa: "artifact",
  archive: "artifact",
  package: "artifact",
  model: "model",
  host: "host",
  hostname: "host",
  machine: "host",
  device: "device",
  devicename: "device",
  phone: "device",
  udid: "udid",
  deviceid: "udid",
  url: "url",
  link: "url",
};

/** Facts that name what was built and shipped: compared across stages. Hosts, devices and URLs change by design. */
const IDENTITY_KEYS: Readonly<Record<string, true>> = { branch: true, sha: true, build: true, version: true, bundle: true, digest: true, model: true };

/** The order facts read in, most telling first; other keys follow in the order given. */
const KEY_ORDER = ["branch", "sha", "build", "version", "bundle", "digest", "artifact", "model", "host", "device", "udid", "url"];

const KEY_LABEL: Readonly<Record<string, string>> = { udid: "UDID", url: "URL" };

/** `abc1234` for a sha, a digest's first 12 hex digits (no `sha256:`), a URL without its scheme; everything else as written. */
export function shortValue(key: string, value: string): string {
  if (key === "sha" && /^[0-9a-f]{8,}$/i.test(value)) return value.slice(0, 7);
  if (key === "digest") {
    const match = /^([a-z0-9]+:)?([0-9a-f]{16,})$/i.exec(value);
    if (match !== null) return match[2].slice(0, 12);
  }
  if (key === "url") return value.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return value;
}

function factText(value: Value | undefined): string | null {
  if (typeof value === "boolean") return value ? "yes" : "no";
  const text = str(value);
  if (text !== null) return text;
  if (value === undefined || value === null || typeof value !== "object") return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** Whether two values of `key` name the same thing: a short sha matches its full sha; case and quotes are ignored for words. */
export function sameValue(key: string, a: string, b: string): boolean {
  if (key === "sha" || key === "digest") {
    const clean = (value: string) => value.toLowerCase().replace(/^[a-z0-9]+:(?=[0-9a-f]{16,}$)/, "");
    const x = clean(a);
    const y = clean(b);
    if (x === y) return true;
    const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
    return /^[0-9a-f]{7,}$/.test(shorter) && /^[0-9a-f]+$/.test(longer) && longer.startsWith(shorter);
  }
  // A branch without `refs/heads/`, `refs/remotes/<remote>/` or `origin/`.
  const plain = (value: string) => value.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "").replace(/^origin\//, "");
  if (key === "branch") return plain(a) === plain(b);
  const loose = (value: string) => value.normalize("NFC").replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  return loose(a) === loose(b);
}

interface RawFact {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** Facts as `{key: value}`, or as `[{key|name|label, value}]` as some tools write them; known spellings to their canonical key, first one wins. */
function rawFacts(value: Value | undefined): RawFact[] {
  const fields = fieldsOf(value);
  const pairs: [string, Value | undefined][] =
    fields !== null
      ? Object.entries(fields)
      : Array.isArray(value)
        ? value.flatMap((item): [string, Value | undefined][] => {
            const entry = fieldsOf(item);
            const given = entry === null ? null : str(entry.key ?? entry.name ?? entry.label);
            return entry === null || given === null ? [] : [[given, entry.value]];
          })
        : [];
  const out: RawFact[] = [];
  const seen = new Set<string>();
  for (const [given, raw] of pairs) {
    if (out.length >= MAX_FACTS) break;
    const text = factText(raw);
    if (text === null) continue;
    const alias = KEY_ALIASES[given.toLowerCase().replace(/[\s_.-]+/g, "")];
    const key = alias ?? given.trim();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: alias === undefined ? key : (KEY_LABEL[key] ?? key), value: text });
  }
  const rank = (key: string) => {
    const index = KEY_ORDER.indexOf(key);
    return index < 0 ? KEY_ORDER.length : index;
  };
  return out.map((fact, index) => ({ fact, index })).sort((a, b) => rank(a.fact.key) - rank(b.fact.key) || a.index - b.index).map(({ fact }) => fact);
}

// ---------------------------------------------------------------------------
// Evidence

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif|heic)(\?.*)?$/i;

/** A string as evidence: an https link, an image, a file (with `:line`), or a note. */
export function evidenceOf(raw: string, label: string | null = null): Evidence {
  const text = raw.trim();
  if (/^https?:\/\/\S+$/i.test(text)) {
    return IMAGE_EXTENSION.test(text) && /^https:/i.test(text) ? { kind: "image", src: text, label } : { kind: "url", url: text, label };
  }
  const pathLike = !/\s/.test(text) && (/^(\/|\.{1,2}\/|~\/|\$[A-Z_]+)/.test(text) || text.includes("/") || /\.[a-z0-9]{1,6}(:\d+)?$/i.test(text));
  if (pathLike) {
    const located = /^(.*?):(\d+)(?::\d+)?$/.exec(text);
    const path = located === null ? text : located[1];
    const line = located === null ? null : Number(located[2]);
    if (IMAGE_EXTENSION.test(path)) return { kind: "image", src: path, label };
    return { kind: "file", path, line, label };
  }
  return { kind: "text", text, label };
}

function evidenceItem(value: Value | undefined): Evidence | null {
  if (typeof value === "string") return value.trim() === "" ? null : evidenceOf(value);
  const fields = fieldsOf(value);
  if (fields === null) return null;
  const label = str(fields.label ?? fields.title ?? fields.name);
  const url = str(fields.url ?? fields.href ?? fields.link);
  if (url !== null && /^https?:\/\//i.test(url)) return { ...evidenceOf(url, label), label } as Evidence;
  const image = str(fields.image ?? fields.src ?? fields.screenshot);
  if (image !== null) {
    const read = evidenceOf(image, label);
    return read.kind === "file" ? { kind: "image", src: read.path, label } : read.kind === "url" ? { kind: "image", src: read.url, label } : read;
  }
  const path = str(fields.path ?? fields.file ?? fields.log);
  if (path !== null) {
    const line = typeof fields.line === "number" && Number.isInteger(fields.line) && fields.line > 0 ? fields.line : null;
    const read = evidenceOf(path, label);
    if (read.kind === "file") return { ...read, line: line ?? read.line };
    return read;
  }
  const text = str(fields.text ?? fields.note ?? fields.output ?? fields.message);
  return text === null ? null : { kind: "text", text, label };
}

function evidenceList(fields: Fields): Evidence[] {
  const out: Evidence[] = [];
  const add = (value: Value | undefined) => {
    if (value === undefined || value === null) return;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (out.length >= MAX_EVIDENCE) return;
      const evidence = evidenceItem(item);
      if (evidence !== null) out.push(evidence);
    }
  };
  add(fields.evidence);
  add(fields.receipt);
  add(fields.log);
  add(fields.screenshot);
  add(fields.artifacts);
  return out;
}

// ---------------------------------------------------------------------------
// Stage names

/** The verb a stage's name implies, in the past tense, first match wins: "Install on iPhone" → installed. */
const VERBS: readonly (readonly [RegExp, string])[] = [
  [/\b(re-?)?install/i, "installed"],
  [/\blaunch|\bopen(ed)? on\b|\brun on\b|\bstart(ed)? on\b/i, "launched"],
  [/\bprobe|\blive\b|\bserv(e|ed|ing)\b|\bsmoke\b|\bhealth/i, "live"],
  [/\bdeploy|\bpromot/i, "deployed"],
  [/\bpublish/i, "published"],
  [/\brelease/i, "released"],
  [/\bupload|\bsubmit/i, "uploaded"],
  [/\btransfer|\bcop(y|ied)\b|\bsync|\bscp\b|\bdownload/i, "transferred"],
  [/\bbuil[dt]|\bcompil|\barchiv|\bbundl/i, "built"],
  [/\bcheck(ed)?[\s-]?out|\bsource\b|\bclone|\bfetch|\bworktree/i, "checked out"],
  [/\bmerge/i, "merged"],
  [/\bpush/i, "pushed"],
  [/\bcommit/i, "committed"],
];

export function stageVerb(name: string): string | null {
  for (const [pattern, verb] of VERBS) if (pattern.test(name)) return verb;
  return null;
}

/** What the verdict calls the thing a stage holds: "Installed build", "Deployed revision". */
const SUBJECT: Readonly<Record<string, string>> = {
  installed: "Installed build",
  launched: "Launched build",
  live: "Deployed revision",
  deployed: "Deployed revision",
  published: "Published revision",
  released: "Released build",
  uploaded: "Uploaded build",
  transferred: "Transferred build",
  built: "Built artifact",
  "checked out": "Checked-out source",
  merged: "Merged revision",
  pushed: "Pushed revision",
  committed: "Commit",
};

function subjectOf(stage: Stage): string {
  return stage.verb === null ? stage.name : SUBJECT[stage.verb];
}

/** "installed main", or "main at Smoke test" where the name says no verb. */
function valueAt(stage: Stage, value: string): string {
  return stage.verb === null ? `${value} at ${stage.name}` : `${stage.verb} ${value}`;
}

// ---------------------------------------------------------------------------
// Reading

interface RawStage {
  readonly name: string;
  readonly status: StageStatus;
  readonly note: string | null;
  readonly facts: RawFact[];
  readonly at: number | null;
  readonly timeText: string | null;
  readonly ms: number | null;
  readonly detail: string | null;
  readonly evidence: Evidence[];
}

function rawStage(value: Value, index: number): RawStage | null {
  if (typeof value === "string") {
    const name = value.trim();
    return name === "" ? null : { name, status: "unknown", note: null, facts: [], at: null, timeText: null, ms: null, detail: null, evidence: [] };
  }
  const fields = fieldsOf(value);
  if (fields === null) return null;
  const name = str(fields.name ?? fields.stage ?? fields.title ?? fields.step) ?? `Stage ${index + 1}`;
  const { status, note } = stageStatus(fields.status ?? fields.state ?? fields.result ?? fields.conclusion ?? undefined);
  const timeValue = fields.time ?? fields.at ?? fields.completedAt ?? fields.finishedAt ?? fields.startedAt ?? fields.timestamp ?? undefined;
  const at = timestamp(timeValue);
  const timeText = at === null ? str(timeValue) : null;
  let ms = parseDuration(fields.duration ?? fields.elapsed ?? undefined);
  if (ms === null) {
    const start = timestamp(fields.startedAt ?? fields.start ?? undefined);
    const end = timestamp(fields.completedAt ?? fields.finishedAt ?? fields.end ?? undefined);
    if (start !== null && end !== null && end >= start) ms = end - start;
  }
  const detail = str(fields.detail ?? fields.note ?? fields.message ?? fields.error ?? undefined);
  return { name, status, note, facts: rawFacts(fields.facts ?? fields.identity ?? undefined), at, timeText, ms, detail, evidence: evidenceList(fields) };
}

/** The chain `stages` describes, checked against `expected`, or why it can't be read. */
export function readProvenance(stages: Value | undefined, expected?: Value): ProvenanceResult {
  if (!Array.isArray(stages)) return { ok: false, error: SHAPE_HINT };
  if (stages.length > MAX_STAGES) return { ok: false, error: `Provenance shows up to ${MAX_STAGES} stages; this chain has ${stages.length}` };
  const raws = stages.map(rawStage).filter((stage): stage is RawStage => stage !== null);
  if (stages.length > 0 && raws.length === 0) return { ok: false, error: SHAPE_HINT };
  const wanted = rawFacts(expected);
  const wantedBy = new Map(wanted.map((fact) => [fact.key, fact.value]));

  // A receipt: the stage reported its outcome (done, failed or running). Evidence on a stage without an outcome is shown, but is no receipt.
  const reported = raws.map((stage) => stage.status === "done" || stage.status === "failed" || stage.status === "running");
  const lastReceipt = reported.lastIndexOf(true);

  // Checks: against what was asked for where it was asked, else against the previous stage reporting the same identity fact.
  // A stage without a receipt is checked (it may be set up wrong) but confirms nothing: its facts are intentions.
  const mismatches: Mismatch[] = [];
  const checks = raws.map(() => new Map<string, { check: FactCheck | null; confirmed: boolean }>());
  const previous = new Map<string, { stage: number; value: string }>();
  raws.forEach((stage, index) => {
    for (const fact of stage.facts) {
      const want = wantedBy.get(fact.key);
      if (want !== undefined) {
        const same = sameValue(fact.key, want, fact.value);
        const check: FactCheck | null = same ? null : { kind: "expected", expected: want };
        checks[index].set(fact.key, { check, confirmed: same && reported[index] });
        if (check !== null) mismatches.push({ stage: index, key: fact.key, label: fact.label, actual: fact.value, check });
        continue;
      }
      if (IDENTITY_KEYS[fact.key] !== true) continue;
      const before = previous.get(fact.key);
      previous.set(fact.key, { stage: index, value: fact.value });
      if (before === undefined) continue;
      const same = sameValue(fact.key, before.value, fact.value);
      const check: FactCheck | null = same ? null : { kind: "changed", stage: before.stage, previous: before.value };
      const confirmed = same && reported[index] && reported[before.stage];
      checks[index].set(fact.key, { check, confirmed });
      // The first stage of an agreeing pair is confirmed too.
      if (confirmed && !checks[before.stage].has(fact.key)) checks[before.stage].set(fact.key, { check: null, confirmed: true });
      if (check !== null) mismatches.push({ stage: index, key: fact.key, label: fact.label, actual: fact.value, check });
    }
  });

  const failedAt = raws.findIndex((stage) => stage.status === "failed");
  const runningAt = raws.findIndex((stage) => stage.status === "running");
  const receiptOf = (stage: RawStage, index: number): Receipt => {
    if (stage.status === "skipped") return "skipped";
    if (reported[index]) return "receipt";
    if (index > lastReceipt && failedAt >= 0 && failedAt <= lastReceipt) return "not-reached";
    if (index > lastReceipt && runningAt >= 0) return "waiting";
    return "none";
  };
  const receipts = raws.map(receiptOf);
  const gapAfter = receipts.some((receipt, index) => index > lastReceipt && receipt === "none");

  const built: Stage[] = raws.map((stage, index) => ({
    name: stage.name,
    status: stage.status,
    note: stage.note,
    facts: stage.facts.map((fact) => {
      const checked = checks[index].get(fact.key);
      return {
        key: fact.key,
        label: fact.label,
        value: fact.value,
        short: shortValue(fact.key, fact.value),
        identity: IDENTITY_KEYS[fact.key] === true,
        check: checked?.check ?? null,
        confirmed: checked?.confirmed ?? false,
      };
    }),
    at: stage.at,
    timeText: stage.timeText,
    ms: stage.ms,
    detail: stage.detail,
    evidence: stage.evidence,
    receipt: receipts[index],
    last: index === lastReceipt && gapAfter,
    verb: stageVerb(stage.name),
  }));

  const timed = built.filter((stage) => stage.ms !== null);
  const expectedFacts: Fact[] = wanted.map((fact) => ({
    key: fact.key,
    label: fact.label,
    value: fact.value,
    short: shortValue(fact.key, fact.value),
    identity: IDENTITY_KEYS[fact.key] === true,
    check: null,
    confirmed: built.some((stage) => stage.receipt === "receipt" && stage.facts.some((candidate) => candidate.key === fact.key && candidate.confirmed)),
  }));
  return {
    ok: true,
    provenance: {
      stages: built,
      expected: expectedFacts,
      mismatches,
      lastReceipt,
      totalMs: timed.length === 0 ? null : timed.reduce((sum, stage) => sum + (stage.ms ?? 0), 0),
      timed: timed.length,
      verdict: verdictOf(built, expectedFacts, mismatches, lastReceipt),
    },
  };
}

// ---------------------------------------------------------------------------
// Verdict

/** "expected branch feat/399 · installed main", the first wrong stage named when it is earlier. */
export function mismatchText(stages: readonly Stage[], mismatch: Mismatch, firstWrong: number = mismatch.stage): string {
  const stage = stages[mismatch.stage];
  const actual = shortValue(mismatch.key, mismatch.actual);
  if (mismatch.check.kind === "expected") {
    const since = firstWrong < mismatch.stage ? ` (wrong from ${stages[firstWrong].name} on)` : "";
    return `expected ${mismatch.label} ${shortValue(mismatch.key, mismatch.check.expected)} · ${valueAt(stage, actual)}${since}`;
  }
  const from = stages[mismatch.check.stage];
  return `${mismatch.label} changed: ${valueAt(from, shortValue(mismatch.key, mismatch.check.previous))} · ${valueAt(stage, actual)}`;
}

function joinNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function verdictOf(stages: readonly Stage[], expected: readonly Fact[], mismatches: readonly Mismatch[], lastReceipt: number): Verdict {
  const lines: { text: string; tone: VerdictTone }[] = [];

  // One line per wrong fact: what was asked for against the furthest stage that has it wrong.
  const expectedWrong = mismatches.filter((mismatch) => mismatch.check.kind === "expected");
  for (const key of new Set(expectedWrong.map((mismatch) => mismatch.key))) {
    const ofKey = expectedWrong.filter((mismatch) => mismatch.key === key);
    lines.push({ text: mismatchText(stages, ofKey[ofKey.length - 1], ofKey[0].stage), tone: "bad" });
  }
  const changed = mismatches.filter((mismatch) => mismatch.check.kind === "changed");
  for (const mismatch of changed) lines.push({ text: mismatchText(stages, mismatch), tone: "bad" });

  // What was asked for and no stage with a receipt confirms.
  for (const fact of expected) {
    if (fact.confirmed || expectedWrong.some((mismatch) => mismatch.key === fact.key)) continue;
    const named = stages.filter((stage) => stage.facts.some((candidate) => candidate.key === fact.key));
    lines.push({
      text:
        named.length === 0
          ? `${fact.label} not confirmed: no stage reports it (expected ${fact.short})`
          : `${fact.label} ${fact.short} not confirmed: only ${joinNames(named.map((stage) => stage.name))} names it, without a receipt`,
      tone: "warn",
    });
  }

  // Stages without a receipt, with why where the data says ("timed out").
  const missing = stages.filter((stage) => stage.receipt === "none");
  if (missing.length > 0) {
    lines.push({ text: `No receipt: ${missing.map((stage) => (stage.note === null ? stage.name : `${stage.name} (${stage.note})`)).join(" · ")}`, tone: "warn" });
  }

  const pick = (title: string, tone: VerdictTone): Verdict => ({ tone, title, lines });

  if (stages.length === 0) return pick("No stages", "neutral");
  const failed = stages.find((stage) => stage.status === "failed");
  if (failed !== undefined) return pick(`${failed.name} failed${failed.note === null ? "" : `: ${failed.note}`}`, "bad");

  if (expectedWrong.length > 0) {
    const furthest = expectedWrong[expectedWrong.length - 1];
    const stage = stages[furthest.stage];
    return pick(
      stage.receipt === "receipt" ? `${subjectOf(stage)} is not the requested one` : `${stage.name}: ${furthest.label} isn't the requested one`,
      "bad",
    );
  }
  if (changed.length > 0) {
    const last = changed[changed.length - 1];
    if (last.check.kind === "changed") {
      const from = last.check.stage;
      return pick(`${subjectOf(stages[last.stage])} doesn't match ${from === 0 ? "the source" : stages[from].name}`, "bad");
    }
  }

  const running = stages.find((stage) => stage.status === "running");
  if (running !== undefined) return pick(`${running.name}: in progress`, "info");

  if (lastReceipt < 0) return pick(`No receipts: none of the ${stages.length === 1 ? "stage" : `${stages.length} stages`} reported an outcome`, "warn");
  if (stages.some((stage, index) => index > lastReceipt && stage.receipt !== "skipped")) {
    return pick(`Unknown after ${stages[lastReceipt].name}: no receipt`, "warn");
  }

  // Every stage that ran has a receipt. Say what was compared, and against what.
  const compared = stages
    .map((stage, index) => ({ stage, index }))
    .filter(({ stage }) => stage.receipt === "receipt" && stage.facts.some((fact) => fact.confirmed));
  const subject = compared.length === 0 ? null : compared[compared.length - 1].stage;
  const unconfirmed = expected.filter((fact) => !fact.confirmed);
  if (subject === null) {
    if (expected.length > 0) return pick(`Done, but no stage confirms the requested ${joinNames(expected.map((fact) => fact.label))}`, "warn");
    lines.push({ text: "No identity fact (branch, sha, build, version, digest) appears in two stages, so nothing was compared", tone: "neutral" });
    return pick(stages.length === 1 ? `${stages[0].name} done` : `All ${stages.length} stages done`, "good");
  }
  if (unconfirmed.length > 0) return pick(`${subjectOf(subject)}: ${joinNames(unconfirmed.map((fact) => fact.label))} not confirmed`, "warn");
  // What was compared, so a match is not taken on faith: "sha 44f1d74 at all 4 stages".
  const agreed = [...new Set(compared.flatMap(({ stage }) => stage.facts.filter((fact) => fact.confirmed).map((fact) => fact.key)))].map((key) => {
    const holding = compared.filter(({ stage }) => stage.facts.some((fact) => fact.key === key && fact.confirmed));
    const fact = holding[0].stage.facts.find((candidate) => candidate.key === key);
    const where = holding.length === stages.length && stages.length > 2 ? `all ${stages.length} stages` : joinNames(holding.map(({ stage }) => stage.name));
    return { text: `${fact?.label ?? key} ${fact?.short ?? ""} at ${where}`, tone: "good" as const };
  });
  lines.unshift(...agreed);
  if (expected.length > 0) return pick(`${subjectOf(subject)} is the requested one`, missing.length > 0 ? "warn" : "good");
  return pick(`${subjectOf(subject)} matches ${compared[0].index === 0 ? "source" : compared[0].stage.name}`, missing.length > 0 ? "warn" : "good");
}

// ---------------------------------------------------------------------------
// Summaries

/** "5 stages · 3 with a receipt · 6m 11s (4 of 5 timed)". */
export function chainSummary(provenance: Provenance): string {
  const { stages, totalMs, timed } = provenance;
  const counted = stages.filter((stage) => stage.receipt !== "skipped");
  const receipts = counted.filter((stage) => stage.receipt === "receipt").length;
  const parts = [`${stages.length} ${stages.length === 1 ? "stage" : "stages"}`];
  if (receipts < counted.length) parts.push(`${receipts} with a receipt`);
  if (totalMs !== null) parts.push(`${formatElapsed(totalMs)}${timed < counted.length ? ` (${timed} of ${counted.length} timed)` : ""}`);
  return parts.join(" · ");
}

/** What a stage without a receipt says instead of its status. */
export const RECEIPT_LABEL: Readonly<Record<Exclude<Receipt, "receipt">, string>> = {
  none: "no receipt",
  waiting: "waiting",
  "not-reached": "not reached",
  skipped: "skipped",
};
