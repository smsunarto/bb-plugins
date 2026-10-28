// What `Logs` shows: a command's output or a log file (text with ANSI colours,
// a list of lines, or JSON log records from pino, bunyan, winston, structlog,
// zap…) as numbered lines with a level each, quiet timestamps and fields,
// and the `file:line` locations they name. Also the pieces the viewer works
// with: repeats folded, search matches, and a line cut into styled runs.
// Pure: no React, no DOM.
import { isPlainObject } from "./evaluate";
import { ansiLines, CODE_EXTENSIONS, type AnsiColor, type AnsiSegment } from "./test-results";
import type { Value } from "./types";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

/** Most severe first. */
export const LOG_LEVELS: readonly LogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace"];

export interface LogLink {
  /** Offsets in the line's text. */
  readonly start: number;
  readonly end: number;
  /** As written, `file://` dropped. */
  readonly path: string;
  readonly line: number;
  readonly column: number | null;
}

export interface LogLine {
  /** 1-based, in the order shown. */
  readonly number: number;
  /** Plain text: ANSI codes and control characters dropped. */
  readonly text: string;
  /** Colour runs whose texts join to `text`; null when the output had no colour codes. */
  readonly segments: readonly AnsiSegment[] | null;
  /** Detected on the line, or the level of the entry it continues. */
  readonly level: LogLevel | null;
  /** Part of the entry above: a stack line under a log line or a JSON record, a wrapped message. */
  readonly continued: boolean;
  /** Ranges of `text` shown quietly: the timestamp, a record's fields. */
  readonly quiet: readonly (readonly [number, number])[];
  /** Length of the leading timestamp (0 for none); repeats compare what follows. */
  readonly stamp: number;
  readonly links: readonly LogLink[];
}

export interface LogOutput {
  readonly lines: readonly LogLine[];
  readonly format: "text" | "records";
  /** Entries per level (continuation lines not counted). */
  readonly counts: Readonly<Record<LogLevel, number>>;
  /** Fields every record has with the same value (`hostname`, `pid`, `service`): said once, not per line. */
  readonly context: readonly (readonly [string, string])[];
  /** Lines left out at the start of very long output. */
  readonly dropped: number;
  /** Record times are shown in UTC (records only). */
  readonly utc: boolean;
}

export type LogResult = { readonly ok: true; readonly output: LogOutput } | { readonly ok: false; readonly error: string };

/** Lines kept from very long output: the last ones, where a failure usually is. */
export const MAX_LOG_LINES = 20_000;

const SHAPE_HINT = "Logs needs text, a list of lines, or a list of JSON log records";

// ---------------------------------------------------------------------------
// Levels

const LEVEL_WORDS: Readonly<Record<string, LogLevel>> = {
  fatal: "fatal",
  panic: "fatal",
  crit: "fatal",
  critical: "fatal",
  emerg: "fatal",
  emergency: "fatal",
  alert: "fatal",
  f: "fatal",
  a: "fatal",
  error: "error",
  err: "error",
  e: "error",
  severe: "error",
  warn: "warn",
  warning: "warn",
  w: "warn",
  info: "info",
  information: "info",
  informational: "info",
  notice: "info",
  i: "info",
  debug: "debug",
  dbg: "debug",
  d: "debug",
  verbose: "debug",
  v: "debug",
  fine: "debug",
  config: "debug",
  trace: "trace",
  trc: "trace",
  finer: "trace",
  finest: "trace",
  silly: "trace",
};

/** A level as a record or logfmt pair writes it: a name, or a number (pino/bunyan 10–60; Python's `levelno` 10–50; syslog 0–7). */
export function levelOf(value: Value | undefined, scale: "pino" | "python" = "pino"): LogLevel | null {
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    if (/^\d+$/.test(word)) return levelOf(Number(word), scale);
    return Object.hasOwn(LEVEL_WORDS, word) ? LEVEL_WORDS[word] : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (scale === "python") return value >= 50 ? "fatal" : value >= 40 ? "error" : value >= 30 ? "warn" : value >= 20 ? "info" : value >= 10 ? "debug" : "trace";
  if (value >= 0 && value <= 7 && Number.isInteger(value)) return value <= 2 ? "fatal" : value === 3 ? "error" : value === 4 ? "warn" : value <= 6 ? "info" : "debug";
  return value >= 60 ? "fatal" : value >= 50 ? "error" : value >= 40 ? "warn" : value >= 30 ? "info" : value >= 20 ? "debug" : "trace";
}

const LEVEL_TOKEN = "fatal|panic|crit(?:ical)?|emerg(?:ency)?|alert|err(?:or)?|severe|warn(?:ing)?|info(?:rmation)?|notice|debug|dbg|verbose|trace|trc";
const JSON_LEVEL = /"(?:level|severity|lvl|levelname|log\.level)"\s*:\s*"?([\w]+)"?/i;
const LOGFMT_LEVEL = /(?:^|\s)(?:level|lvl|severity|loglevel)=("?)(\w+)\1(?=\s|$)/i;
const BRACKET_LEVEL = new RegExp(`[[<(]\\s*(${LEVEL_TOKEN}|[EWIDVF])\\s*[\\]>)]`, "i");
const UPPER_LEVEL = /(?:^|[\s|:[(])(FATAL|PANIC|CRITICAL|CRIT|EMERG|ALERT|SEVERE|ERROR|ERR|WARNING|WARN|NOTICE|INFO|DEBUG|DBG|TRACE|VERBOSE|FINEST|FINER|FINE)(?=$|[\s|:\]),-])/;
const COMPILER_LEVEL = /(?:^|[\s:)])(fatal error|error|warning)(?:\[[\w-]+\]| TS\d+| [A-Z]{2,}\d+)?:\s/;
const LOGCAT_LEVEL = /^(?:\d+\s+\d+\s+)?([VDIWEFA])[/ ][^\s:]*(?:\s*\(\s*\d+\))?:/;
const KLOG_LEVEL = /^([IWEF])\d{4} \d{2}:\d{2}:\d{2}\.\d+/;
const ERROR_START = /^(?:Uncaught\s+)?(?:[\w$.]*(?:Error|Exception)(?:\s\[[\w-]+\])?(?::\s|$)|Traceback \(most recent call last\):|panic: |FAIL\b|FAILED\b|npm (?:ERR!|error)\s|\s*[×✗✕✘❌]\s)/;
const WARN_START = /^(?:npm (?:WARN|warn)\s|\s*⚠\s|(?:\(node:\d+\) )?\[?[\w]*Warning\]?:\s)/;

/** The level a line of text names, read after its timestamp; null when it names none. */
export function textLevel(text: string): LogLevel | null {
  const json = text.trimStart().startsWith("{") ? JSON_LEVEL.exec(text) : null;
  if (json !== null) return levelOf(json[1]);
  const logfmt = LOGFMT_LEVEL.exec(text);
  if (logfmt !== null) return levelOf(logfmt[2]);
  const syslog = /^<(\d{1,3})>/.exec(text);
  if (syslog !== null) return levelOf(Number(syslog[1]) % 8);
  const klog = KLOG_LEVEL.exec(text);
  if (klog !== null) return LEVEL_WORDS[klog[1].toLowerCase()];
  const logcat = LOGCAT_LEVEL.exec(text);
  if (logcat !== null) return LEVEL_WORDS[logcat[1].toLowerCase()];
  if (ERROR_START.test(text)) return "error";
  if (WARN_START.test(text)) return "warn";
  const head = text.slice(0, 64);
  const bracket = BRACKET_LEVEL.exec(head);
  // A single-letter bracket (`[E]`) only in capitals.
  if (bracket !== null && (bracket[1].length > 1 || /[A-Z]/.test(bracket[1]))) return levelOf(bracket[1]);
  const upper = UPPER_LEVEL.exec(head);
  if (upper !== null) return levelOf(upper[1]);
  const compiler = COMPILER_LEVEL.exec(text);
  if (compiler !== null) return compiler[1] === "warning" ? "warn" : "error";
  const leading = /^(Error|Fatal|Panic|Warning|Warn|Info|Debug|Trace)\b:?\s/.exec(text);
  if (leading !== null) return levelOf(leading[1]);
  return null;
}

// ---------------------------------------------------------------------------
// Timestamps and links

const STAMP =
  /^\[?(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2}|\sUTC)?|\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?|[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}(?:\.\d+)?|\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?)\]?(?=\s|$)/;

/** Length of the timestamp `text` starts with (ISO, syslog, logcat, clock times), 0 for none. */
export function stampLength(text: string): number {
  return STAMP.exec(text)?.[0].length ?? 0;
}

const LINKS = new RegExp(
  [
    // Python `File "path", line 12`
    `File "([^"]+\\.(?:${CODE_EXTENSIONS}))", line (\\d+)()`,
    // TypeScript and MSBuild `path(12,5)`
    `(?<![\\w./@-])((?:[A-Za-z]:)?[\\w./@+-]*[\\w@+-]\\.(?:${CODE_EXTENSIONS}))\\((\\d+),(\\d+)\\)`,
    // `path:12`, `path:12:5`, `file:///abs/path:12:5`
    `(?<![\\w.:/@-])(?:file:\\/\\/)?((?:[A-Za-z]:)?[\\w./@+-]*[\\w@+-]\\.(?:${CODE_EXTENSIONS})):(\\d+)(?::(\\d+))?(?![\\w.])`,
  ].join("|"),
  "g",
);

/** The `file:line` locations a line names. */
export function findLinks(text: string): LogLink[] {
  const links: LogLink[] = [];
  for (const match of text.matchAll(LINKS)) {
    const group = match[1] !== undefined ? 1 : match[4] !== undefined ? 4 : 7;
    const line = Number(match[group + 1]);
    if (!Number.isSafeInteger(line) || line < 1) continue;
    const column = match[group + 2] ? Number(match[group + 2]) : null;
    links.push({ start: match.index, end: match.index + match[0].length, path: match[group], line, column });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Reading output

type Fields = Readonly<Record<string, Value>>;

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function emptyCounts(): Record<LogLevel, number> {
  return { fatal: 0, error: 0, warn: 0, info: 0, debug: 0, trace: 0 };
}

/** The log `value` holds: text (one string), a list of lines, or a list of JSON records. */
export function readLogs(value: Value | undefined): LogResult {
  if (typeof value === "string") return { ok: true, output: fromText(value) };
  if (!Array.isArray(value)) {
    if (value !== undefined && value !== null && isPlainObject(value)) {
      // A report that holds its records: `{logs: [...]}`, `{entries: [...]}`, `{records: [...]}`.
      for (const key of ["logs", "entries", "records", "lines", "events"]) {
        const inner = (value as Fields)[key];
        if (Array.isArray(inner)) return readLogs(inner);
      }
    }
    return { ok: false, error: SHAPE_HINT };
  }
  const items = value as readonly Value[];
  if (items.length === 0) return { ok: true, output: fromText("") };
  const records = items.filter((item) => isPlainObject(item) && isLogRecord(item as Fields)).length;
  if (records > 0 && records >= items.length / 2) return { ok: true, output: fromRecords(items) };
  const lines = items.map((item) => (typeof item === "string" ? item : typeof item === "number" || typeof item === "boolean" ? String(item) : JSON.stringify(item)));
  return { ok: true, output: fromText(lines.join("\n")) };
}

const MESSAGE_KEYS = ["msg", "message", "event", "@message", "text", "log", "MESSAGE"];
const LEVEL_KEYS = ["level", "severity", "lvl", "levelname", "level_name", "loglevel", "log.level", "@level", "PRIORITY"];
const TIME_KEYS = ["time", "timestamp", "ts", "@timestamp", "t", "datetime", "asctime", "date", "__REALTIME_TIMESTAMP"];
const ERROR_KEYS = ["err", "error", "exception", "exc_info", "stack", "stack_trace", "stacktrace"];

function isLogRecord(item: Fields): boolean {
  return [...MESSAGE_KEYS, ...LEVEL_KEYS, "levelno"].some((key) => Object.hasOwn(item, key));
}

function first(record: Fields, keys: readonly string[]): [string, Value] | null {
  for (const key of keys) if (Object.hasOwn(record, key) && record[key] !== null && record[key] !== "") return [key, record[key]];
  return null;
}

/** A record's time as epoch ms: numbers in s or ms, ISO and other parseable strings. */
function recordTime(value: Value): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds (zap, structlog) up to the year 5138; journald's microseconds past 1e15.
    return value > 1e15 ? value / 1000 : value < 1e11 ? value * 1000 : value;
  }
  if (typeof value === "string" && /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}/.test(value)) {
    const parsed = Date.parse(/^\d{4}-\d{2}-\d{2} \d/.test(value) ? value.replace(" ", "T").replace(",", ".") : value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function valueText(value: Value): string {
  if (typeof value === "string") return /[\s"=]/.test(value) || value === "" ? JSON.stringify(value) : value;
  const json = JSON.stringify(value) ?? "null";
  return json.length > 160 ? `${json.slice(0, 159)}…` : json;
}

function fromRecords(items: readonly Value[]): LogOutput {
  const records = items.map((item) => (isPlainObject(item) ? (item as Fields) : null));
  const objects = records.filter((record): record is Fields => record !== null);
  // Fields every record has with one value are context, said once.
  const context: [string, string][] = [];
  if (objects.length >= 2) {
    const skip = new Set([...MESSAGE_KEYS, ...LEVEL_KEYS, ...TIME_KEYS, ...ERROR_KEYS, "levelno"]);
    for (const [key, value] of Object.entries(objects[0])) {
      if (skip.has(key) || (typeof value === "object" && value !== null)) continue;
      if (objects.every((record) => Object.hasOwn(record, key) && record[key] === value)) context.push([key, valueText(value)]);
    }
  }
  const shared = new Set(context.map(([key]) => key));
  const times = objects.map((record) => {
    const found = first(record, TIME_KEYS);
    return found === null ? null : recordTime(found[1]);
  });
  const known = times.filter((time): time is number => time !== null);
  const oneDay = known.length > 0 && known.every((time) => new Date(time).toISOString().slice(0, 10) === new Date(known[0]).toISOString().slice(0, 10));
  const lines: LogLine[] = [];
  const counts = emptyCounts();
  let objectIndex = 0;
  for (const record of records) {
    if (record === null) continue;
    const time = times[objectIndex++];
    const levelField = first(record, LEVEL_KEYS);
    const level = levelField !== null ? levelOf(levelField[1]) : Object.hasOwn(record, "levelno") ? levelOf(record.levelno, "python") : null;
    if (level !== null) counts[level]++;
    const message = first(record, MESSAGE_KEYS);
    const used = new Set([levelField?.[0], message?.[0], first(record, TIME_KEYS)?.[0], "levelno"]);
    const continuation: string[] = [];
    const fields: string[] = [];
    for (const [key, value] of Object.entries(record)) {
      if (used.has(key) || shared.has(key)) continue;
      if (ERROR_KEYS.includes(key)) {
        const stack = typeof value === "string" ? value : isPlainObject(value) && typeof (value as Fields).stack === "string" ? ((value as Fields).stack as string) : null;
        if (stack !== null && stack.includes("\n")) {
          continuation.push(...stack.replace(/\s+$/, "").split("\n"));
          continue;
        }
      }
      fields.push(`${key}=${valueText(value)}`);
    }
    const stamp = time === null ? "" : formatStamp(time, oneDay);
    const body = message === null ? "" : typeof message[1] === "string" ? message[1] : JSON.stringify(message[1]);
    const [head, ...wrapped] = body.replace(/\s+$/, "").split("\n");
    const prefix = stamp === "" ? "" : `${stamp} `;
    const tail = fields.length === 0 ? "" : `${head === "" ? "" : "  "}${fields.join(" ")}`;
    const text = `${prefix}${head}${tail}`.replace(CONTROL, "");
    const quiet: [number, number][] = [];
    if (stamp !== "") quiet.push([0, stamp.length]);
    if (tail !== "") quiet.push([text.length - tail.length, text.length]);
    lines.push(makeLine(lines.length + 1, text, null, level, false, quiet, stamp.length));
    for (const extra of [...wrapped, ...continuation]) {
      const plain = extra.replace(CONTROL, "");
      lines.push(makeLine(lines.length + 1, plain, null, level, true, [], 0));
    }
  }
  return { lines, format: "records", counts, context, dropped: 0, utc: known.length > 0 };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** UTC `HH:MM:SS.mmm`, with the date in front when the log spans days. */
function formatStamp(ms: number, oneDay: boolean): string {
  const date = new Date(ms);
  const clock = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
  return oneDay ? clock : `${date.toISOString().slice(0, 10)} ${clock}`;
}

function makeLine(
  number: number,
  text: string,
  segments: readonly AnsiSegment[] | null,
  level: LogLevel | null,
  continued: boolean,
  quiet: readonly (readonly [number, number])[],
  stamp: number,
): LogLine {
  return { number, text, segments, level, continued, quiet, stamp, links: findLinks(text) };
}

/** What a terminal shows of a line a progress bar redrew with `\r`: the last draw. */
function lastDraw(line: string): string {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
  const at = trimmed.lastIndexOf("\r");
  return at === -1 ? trimmed : trimmed.slice(at + 1);
}

/** Text whose lines are mostly JSON objects with a level or message is a JSONL log. */
function jsonLines(lines: readonly string[]): Value[] | null {
  const filled = lines.filter((line) => line.trim() !== "");
  if (filled.length < 2 || !filled.every((line, index) => index >= 20 || line.trimStart().startsWith("{"))) return null;
  const parsed: Value[] = [];
  for (const line of filled) {
    try {
      parsed.push(JSON.parse(line) as Value);
    } catch {
      parsed.push(line);
    }
  }
  const records = parsed.filter((item) => isPlainObject(item) && isLogRecord(item as Fields)).length;
  return records >= filled.length * 0.8 ? parsed : null;
}

function fromText(input: string): LogOutput {
  const all = input.replace(/\r\n/g, "\n").split("\n").map(lastDraw);
  while (all.length > 0 && all[all.length - 1].trim() === "") all.pop();
  const blank = all.findIndex((line) => line.trim() !== "");
  if (blank > 0) all.splice(0, blank);
  const dropped = Math.max(0, all.length - MAX_LOG_LINES);
  const kept = dropped > 0 ? all.slice(dropped) : all;
  if (!input.includes("\x1b")) {
    const records = jsonLines(kept);
    if (records !== null) return { ...fromRecords(records), dropped };
  }
  const styled = input.includes("\x1b") || input.includes("\x9b") ? ansiLines(kept.join("\n")) : null;
  const texts = styled === null ? kept.map((line) => line.replace(CONTROL, "")) : [];
  const segments: (AnsiSegment[] | null)[] = [];
  if (styled !== null) {
    for (const line of styled) {
      const clean = line.map((segment) => ({ ...segment, text: segment.text.replace(CONTROL, "") })).filter((segment) => segment.text !== "");
      segments.push(clean);
      texts.push(clean.map((segment) => segment.text).join(""));
    }
  }
  const stamps = texts.map(stampLength);
  const own = texts.map((text, index) => (text.trim() === "" ? null : textLevel(text.slice(stamps[index]).trimStart())));
  const filled = texts.filter((text) => text.trim() !== "").length;
  // A log is made of entries when most lines start with a timestamp, or most name a level: then a
  // line without one (a stack line, a wrapped message, a blank line) continues the entry above.
  const timestamped = filled > 0 && stamps.filter((stamp) => stamp > 0).length >= filled * 0.5;
  const leveled = !timestamped && filled > 0 && own.filter((level) => level !== null).length >= filled * 0.5;
  const counts = emptyCounts();
  const lines: LogLine[] = [];
  let entryLevel: LogLevel | null = null;
  texts.forEach((text, index) => {
    const stamp = stamps[index];
    const continued = lines.length > 0 && (timestamped ? stamp === 0 : leveled && own[index] === null);
    let level: LogLevel | null;
    if (continued) level = entryLevel;
    else {
      level = own[index];
      if (level !== null) counts[level]++;
      entryLevel = level;
    }
    lines.push(makeLine(index + 1, text, styled === null ? null : segments[index], level, continued, stamp > 0 ? [[0, stamp]] : [], stamp));
  });
  return { lines, format: "text", counts, context: [], dropped, utc: false };
}

// ---------------------------------------------------------------------------
// The viewer's pieces

/** A shown row: a line, standing for `count` identical lines in a row. */
export interface LogRow {
  readonly index: number;
  readonly count: number;
}

/** Lines `indices` (in order) as rows, runs of identical lines (timestamps aside) folded into one. */
export function foldRepeats(lines: readonly LogLine[], indices: readonly number[]): LogRow[] {
  const rows: LogRow[] = [];
  let previous: string | null = null;
  for (const index of indices) {
    const line = lines[index];
    const key = `${line.level}|${line.text.slice(line.stamp)}`;
    const last = rows[rows.length - 1];
    if (last !== undefined && key === previous && line.text.trim() !== "" && index === last.index + last.count) {
      rows[rows.length - 1] = { index: last.index, count: last.count + 1 };
    } else {
      rows.push({ index, count: 1 });
    }
    previous = key;
  }
  return rows;
}

/** Where `query` occurs in `text`, case-insensitively, as [start, end) pairs. */
export function occurrences(text: string, query: string): [number, number][] {
  if (query === "") return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const found: [number, number][] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) found.push([at, at + needle.length]);
  return found;
}

export interface LogRun {
  readonly text: string;
  readonly color: AnsiColor | null;
  readonly bold: boolean;
  readonly inverse: boolean;
  readonly quiet: boolean;
  readonly link: LogLink | null;
  readonly match: boolean;
}

/** A line cut into runs of one style each: its colours, quiet ranges, links and search matches. */
export function lineRuns(line: LogLine, query: string): LogRun[] {
  const text = line.text;
  if (text === "") return [];
  const matches = occurrences(text, query);
  const cuts = new Set<number>([0, text.length]);
  let offset = 0;
  const segments = line.segments ?? [{ text, color: null, bold: false, inverse: false }];
  const segmentStarts: number[] = [];
  for (const segment of segments) {
    segmentStarts.push(offset);
    cuts.add(offset);
    offset += segment.text.length;
  }
  for (const [start, end] of [...line.quiet, ...matches]) cuts.add(start).add(end);
  for (const link of line.links) cuts.add(link.start).add(link.end);
  const points = [...cuts].filter((point) => point >= 0 && point <= text.length).sort((a, b) => a - b);
  const runs: LogRun[] = [];
  let segmentIndex = 0;
  for (let at = 0; at < points.length - 1; at++) {
    const start = points[at];
    const end = points[at + 1];
    if (end <= start) continue;
    while (segmentIndex + 1 < segments.length && segmentStarts[segmentIndex + 1] <= start) segmentIndex++;
    const segment = segments[segmentIndex];
    runs.push({
      text: text.slice(start, end),
      color: segment.color,
      bold: segment.bold,
      inverse: segment.inverse,
      quiet: line.quiet.some(([from, to]) => start >= from && end <= to),
      link: line.links.find((link) => start >= link.start && end <= link.end) ?? null,
      match: matches.some(([from, to]) => start >= from && end <= to),
    });
  }
  return runs;
}

/** The first line at error or fatal level that starts an entry; -1 when there is none. */
export function firstError(lines: readonly LogLine[]): number {
  return lines.findIndex((line) => (line.level === "error" || line.level === "fatal") && !line.continued);
}
