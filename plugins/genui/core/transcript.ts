// Transcripts as Transcript compares them: tracks read from hand-written word
// lists or common ASR output (openai-whisper / WhisperKit / WhisperX JSON,
// whisper.cpp JSON, Deepgram, AssemblyAI, a generic {words}, SRT/WebVTT, plain
// text), normalised into comparable tokens, each hypothesis aligned word by
// word to the first track (the reference) with a Levenshtein alignment, and
// scored: substitutions, deletions, insertions, WER, speaker mismatches, and
// the error regions a reader steps through. Pure; shared by the renderer and
// the markdown fallback.
import { objectFields, type Fields } from "./perf-units";
import type { Value } from "./types";

/**
 * How a word's time is known: `word` it has its own start and end; `segment`
 * only the segment (subtitle cue, whisper segment) it sits in is timed, and
 * its start and end are an even split of that window; `none` untimed.
 */
export type Timing = "word" | "segment" | "none";

export interface Word {
  readonly text: string;
  /** Seconds from the start of the recording; null when untimed. */
  readonly start: number | null;
  readonly end: number | null;
  readonly timing: Timing;
  /** The timed window a `segment` word sits in. */
  readonly window: { readonly start: number; readonly end: number } | null;
  readonly speaker: string | null;
  /** 0–1, as the tool reported it (probability, confidence, score). */
  readonly confidence: number | null;
}

/** Where a track came from, for the quiet line under its name. */
export type TrackSource = "words" | "text" | "subtitles" | "whisper" | "whisper.cpp" | "deepgram" | "assemblyai" | "rows";

export interface Track {
  readonly name: string;
  readonly words: readonly Word[];
  readonly source: TrackSource;
  /** Model, language and other facts the file states, joined; null when none. */
  readonly detail: string | null;
  /** The best timing any of its words has. */
  readonly timing: Timing;
  /** Words with an end before their start, or times given in a way we could not read, left untimed. */
  readonly untimed: number;
}

export type ReadTracks = { readonly ok: true; readonly tracks: readonly Track[] } | { readonly ok: false; readonly error: string };

/** Words a track may hold; a longer one is refused rather than aligned for minutes. */
export const MAX_WORDS = 60_000;

const TEXT_KEYS = ["punctuated_word", "word", "text", "content", "token"] as const;
const SPEAKER_KEYS = ["speaker", "speaker_label", "spk", "speakerId", "speaker_id"] as const;
const CONFIDENCE_KEYS = ["confidence", "probability", "score", "p"] as const;

function str(value: Value | undefined): string | null {
  return typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function num(value: Value | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

function first(fields: Fields, keys: readonly string[], read: (value: Value | undefined) => string | number | null): string | number | null {
  for (const key of keys) {
    const value = read(fields[key]);
    if (value !== null) return value;
  }
  return null;
}

function speakerName(value: string | number | null): string | null {
  if (value === null) return null;
  const text = String(value).trim();
  if (text === "") return null;
  // Deepgram and AssemblyAI number or letter their speakers.
  return /^\d+$/.test(text) || /^[A-Z]$/.test(text) ? `Speaker ${text}` : text;
}

/** A word's own or inherited fields read into a Word; null when it has no text. */
interface RawWord {
  readonly text: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly speaker: string | null;
  readonly confidence: number | null;
}

function rawWord(item: Value, inherited: string | null): RawWord | null {
  if (typeof item === "string") {
    const text = item.trim();
    return text === "" ? null : { text, start: null, end: null, speaker: inherited, confidence: null };
  }
  const fields = objectFields(item);
  if (fields === null) return null;
  const text = (first(fields, TEXT_KEYS, str) as string | null)?.trim() ?? "";
  if (text === "") return null;
  const start = num(fields.start) ?? num(fields.start_time) ?? num(fields.from);
  const end = num(fields.end) ?? num(fields.end_time) ?? num(fields.to);
  const confidence = first(fields, CONFIDENCE_KEYS, num) as number | null;
  return {
    text,
    start,
    end,
    speaker: speakerName(first(fields, SPEAKER_KEYS, str)) ?? inherited,
    confidence: confidence !== null && confidence >= 0 && confidence <= 1 ? confidence : null,
  };
}

/**
 * Times in milliseconds rather than seconds: an explicit unit, else every
 * time an integer and the last at least 1,000 (AssemblyAI, whisper's .tsv,
 * whisper.cpp offsets). Recognisers that report seconds report fractions.
 */
function inMilliseconds(times: readonly number[], unit: string | null): boolean {
  if (unit !== null) return /^(ms|milliseconds?)$/i.test(unit.trim());
  return times.length > 0 && times.every(Number.isInteger) && Math.max(...times) >= 1000;
}

/** Timed words from raw words, in seconds; words without a usable span come out untimed. */
function timedWords(raws: readonly RawWord[], unit: string | null): { words: Word[]; untimed: number } {
  const times = raws.flatMap((raw) => [raw.start, raw.end]).filter((time): time is number => time !== null);
  const scale = inMilliseconds(times, unit) ? 1 / 1000 : 1;
  let untimed = 0;
  const words = raws.map((raw): Word => {
    const start = raw.start === null ? null : raw.start * scale;
    const end = raw.end === null ? start : raw.end * scale;
    const usable = start !== null && end !== null && start >= 0 && end >= start;
    if (!usable && (raw.start !== null || raw.end !== null)) untimed++;
    return {
      text: raw.text,
      start: usable ? start : null,
      end: usable ? end : null,
      timing: usable ? "word" : "none",
      window: null,
      speaker: raw.speaker,
      confidence: raw.confidence,
    };
  });
  return { words, untimed };
}

/** Splits a segment's text into words placed evenly (by characters) across its window. */
function segmentWords(text: string, start: number | null, end: number | null, speaker: string | null): Word[] {
  const pieces = text.split(/\s+/).filter((piece) => piece !== "");
  if (start === null || end === null || !(end >= start) || start < 0) {
    return pieces.map((piece) => ({ text: piece, start: null, end: null, timing: "none", window: null, speaker, confidence: null }));
  }
  if (pieces.length === 1) return [{ text: pieces[0], start, end, timing: "word", window: null, speaker, confidence: null }];
  const total = pieces.reduce((sum, piece) => sum + piece.length + 1, 0);
  let at = 0;
  return pieces.map((piece) => {
    const from = start + ((end - start) * at) / total;
    at += piece.length + 1;
    const to = start + ((end - start) * at) / total;
    return { text: piece, start: from, end: to, timing: "segment", window: { start, end }, speaker, confidence: null };
  });
}

function bestTiming(words: readonly Word[]): Timing {
  if (words.some((word) => word.timing === "word")) return "word";
  if (words.some((word) => word.timing === "segment")) return "segment";
  return "none";
}

/** SRT or WebVTT cues ("00:01.000 --> 00:04.000"), WebVTT `<v Name>` voices as speakers. */
const CUE_TIME = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

function cueSeconds(text: string): number {
  const parts = text.replace(",", ".").split(":").map(Number);
  return parts.reduce((sum, part) => sum * 60 + part, 0);
}

function subtitleWords(text: string): Word[] {
  const words: Word[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = CUE_TIME.exec(lines[index]);
    if (match === null) continue;
    const start = cueSeconds(match[1]);
    const end = cueSeconds(match[2]);
    const body: string[] = [];
    while (index + 1 < lines.length && lines[index + 1].trim() !== "" && !CUE_TIME.test(lines[index + 1])) body.push(lines[++index]);
    let cue = body.join(" ");
    const voice = /<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(cue);
    cue = cue.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
    words.push(...segmentWords(cue, start, end, voice === null ? null : voice[1].trim()));
  }
  return words;
}

interface Content {
  readonly words: Word[];
  readonly source: TrackSource;
  readonly detail: string | null;
  readonly name: string | null;
  readonly untimed: number;
}

function details(...parts: (string | null | undefined)[]): string | null {
  const kept = parts.filter((part): part is string => typeof part === "string" && part.trim() !== "");
  return kept.length === 0 ? null : kept.join(" · ");
}

/** whisper.cpp `-oj`/`-ojf`: transcription[] with ms offsets; tokens (with -ojf) give word times. */
function whisperCpp(fields: Fields, list: readonly Value[]): Content {
  const words: Word[] = [];
  for (const entry of list) {
    const segment = objectFields(entry);
    if (segment === null) continue;
    const offsets = objectFields(segment.offsets);
    const from = offsets === null ? null : num(offsets.from);
    const to = offsets === null ? null : num(offsets.to);
    const tokens = Array.isArray(segment.tokens) ? segment.tokens : [];
    const built: { text: string; start: number | null; end: number | null; p: number[] }[] = [];
    for (const token of tokens) {
      const item = objectFields(token);
      const text = item === null ? null : str(item.text);
      if (item === null || text === null || /^\[_[A-Z]+_?.*\]$/.test(text.trim()) || text.trim() === "") continue;
      const tokenOffsets = objectFields(item.offsets);
      const start = tokenOffsets === null ? null : num(tokenOffsets.from);
      const end = tokenOffsets === null ? null : num(tokenOffsets.to);
      const p = num(item.p);
      const current = built[built.length - 1];
      if (current === undefined || /^\s/.test(text)) built.push({ text: text.trim(), start, end, p: p === null ? [] : [p] });
      else {
        current.text += text;
        current.end = end ?? current.end;
        if (p !== null) current.p.push(p);
      }
    }
    if (built.length > 0) {
      for (const word of built) {
        const usable = word.start !== null && word.end !== null && word.end >= word.start;
        words.push({
          text: word.text,
          start: usable ? word.start! / 1000 : null,
          end: usable ? word.end! / 1000 : null,
          timing: usable ? "word" : "none",
          window: null,
          speaker: null,
          confidence: word.p.length === 0 ? null : word.p.reduce((sum, p) => sum + p, 0) / word.p.length,
        });
      }
      continue;
    }
    // `-ml 1` prints one word per entry; longer entries are segments.
    const text = str(segment.text) ?? "";
    const speaker = speakerName(str(segment.speaker));
    words.push(...segmentWords(text, from === null ? null : from / 1000, to === null ? null : to / 1000, speaker));
  }
  const params = objectFields(fields.params);
  const model = params === null ? null : str(params.model);
  const result = objectFields(fields.result);
  const name = model === null ? "whisper.cpp" : `whisper.cpp ${model.replace(/^.*[\\/]/, "").replace(/^ggml-/, "").replace(/\.bin$/, "")}`;
  return { words, source: "whisper.cpp", detail: details(result === null ? null : str(result.language)), name, untimed: 0 };
}

/** openai-whisper, WhisperKit, WhisperX, mlx-whisper, faster-whisper dumps: segments[] with words[] when word timestamps were on. */
function whisperSegments(fields: Fields, list: readonly Value[], unit: string | null): Content {
  const raws: RawWord[] = [];
  const segmentOnly: Word[] = [];
  let timedByWords = false;
  for (const entry of list) {
    const segment = objectFields(entry);
    if (segment === null) continue;
    const speaker = speakerName(first(segment, SPEAKER_KEYS, str));
    if (Array.isArray(segment.words) && segment.words.length > 0) {
      timedByWords = true;
      for (const word of segment.words) {
        const raw = rawWord(word, speaker);
        if (raw !== null) raws.push(raw);
      }
    } else {
      const start = num(segment.start);
      const end = num(segment.end);
      for (const word of segmentWords(str(segment.text) ?? "", start, end, speaker)) {
        segmentOnly.push(word);
        raws.push({ text: word.text, start: null, end: null, speaker, confidence: null });
      }
    }
  }
  if (!timedByWords) {
    const scale = inMilliseconds(segmentOnly.flatMap((word) => (word.window === null ? [] : [word.window.start, word.window.end])), unit) ? 1 / 1000 : 1;
    const words = scale === 1 ? segmentOnly : segmentOnly.map((word) => scaleWord(word, scale));
    return { words, source: "whisper", detail: details(str(fields.language), str(fields.model)), name: str(fields.model), untimed: 0 };
  }
  const { words, untimed } = timedWords(raws, unit);
  return { words, source: "whisper", detail: details(str(fields.language), str(fields.model)), name: str(fields.model), untimed };
}

function scaleWord(word: Word, scale: number): Word {
  return {
    ...word,
    start: word.start === null ? null : word.start * scale,
    end: word.end === null ? null : word.end * scale,
    window: word.window === null ? null : { start: word.window.start * scale, end: word.window.end * scale },
  };
}

/** A list of word objects, or rows of segments (whisper's .tsv: start, end, text in ms). */
function wordList(list: readonly Value[], unit: string | null): Content {
  const rows = list.map((item) => objectFields(item));
  const multiWord = rows.some((row) => row !== null && typeof row.text === "string" && /\S\s+\S/.test(row.text.trim()) && row.word === undefined);
  if (multiWord) {
    const times = rows.flatMap((row) => (row === null ? [] : [num(row.start), num(row.end)])).filter((time): time is number => time !== null);
    const scale = inMilliseconds(times, unit) ? 1 / 1000 : 1;
    const words = rows.flatMap((row) => {
      if (row === null) return [];
      const start = num(row.start);
      const end = num(row.end);
      return segmentWords(str(row.text) ?? "", start === null ? null : start * scale, end === null ? null : end * scale, speakerName(first(row, SPEAKER_KEYS, str)));
    });
    return { words, source: "rows", detail: null, name: null, untimed: 0 };
  }
  const raws = list.map((item) => rawWord(item, null)).filter((raw): raw is RawWord => raw !== null);
  const { words, untimed } = timedWords(raws, unit);
  return { words, source: "words", detail: null, name: null, untimed };
}

/** Plain text or subtitles. */
function textContent(text: string): Content {
  if (text.split(/\r?\n/, 40).some((line) => CUE_TIME.test(line))) return { words: subtitleWords(text), source: "subtitles", detail: null, name: null, untimed: 0 };
  const words = text
    .replace(/^WEBVTT.*$/m, "")
    .split(/\s+/)
    .filter((piece) => piece !== "")
    .map((piece): Word => ({ text: piece, start: null, end: null, timing: "none", window: null, speaker: null, confidence: null }));
  return { words, source: "text", detail: null, name: null, untimed: 0 };
}

/** Any one transcript: a string, a list of words or segment rows, or a tool's JSON object. */
function content(value: Value | undefined, unit: string | null): Content | null {
  if (typeof value === "string") return textContent(value);
  if (Array.isArray(value)) return wordList(value, unit);
  const fields = objectFields(value);
  if (fields === null) return null;
  const ownUnit = str(fields.unit) ?? unit;
  if (Array.isArray(fields.transcription)) return whisperCpp(fields, fields.transcription);
  // Deepgram: results.channels[0].alternatives[0].words (seconds).
  const results = objectFields(fields.results);
  if (results !== null && Array.isArray(results.channels)) {
    const channel = objectFields(results.channels[0]);
    const alternative = channel !== null && Array.isArray(channel.alternatives) ? objectFields(channel.alternatives[0]) : null;
    if (alternative !== null && Array.isArray(alternative.words)) {
      const metadata = objectFields(fields.metadata);
      const models = metadata === null ? null : objectFields(metadata.model_info);
      const model = models === null ? null : objectFields(Object.values(models)[0]);
      const read = wordList(alternative.words, ownUnit ?? "s");
      return { ...read, source: "deepgram", name: model === null ? "Deepgram" : `Deepgram ${str(model.name) ?? ""}`.trim(), detail: details(str(channel?.detected_language)) };
    }
  }
  if (Array.isArray(fields.segments) && fields.segments.some((segment) => objectFields(segment) !== null)) {
    // WhisperX writes word_segments too; segments keep the speakers.
    return whisperSegments(fields, fields.segments, ownUnit);
  }
  if (Array.isArray(fields.words)) {
    // AssemblyAI: words[] in ms beside audio_duration in seconds.
    const assembly = typeof fields.audio_duration === "number" || typeof fields.acoustic_model === "string" || typeof fields.speech_model === "string";
    const read = wordList(fields.words, ownUnit ?? (assembly ? "ms" : null));
    return { ...read, source: assembly ? "assemblyai" : read.source, name: assembly ? "AssemblyAI" : null, detail: details(str(fields.language), str(fields.language_code), str(fields.model)) };
  }
  if (Array.isArray(fields.word_segments)) return { ...wordList(fields.word_segments, ownUnit), source: "whisper" };
  if (typeof fields.text === "string") return textContent(fields.text);
  return null;
}

function trackOf(value: Value, position: number): Track | string {
  const fields = typeof value === "string" || Array.isArray(value) ? null : objectFields(value);
  const unit = fields === null ? null : str(fields.unit);
  // A track is {name, words | text | segments | transcription …} or a tool's JSON as it stands; `words` may itself be a tool's JSON.
  const inner = fields !== null && fields.words !== undefined && !Array.isArray(fields.words) ? fields.words : value;
  const read = content(inner, unit);
  if (read === null) return `track ${position + 1} has no words, text or segments`;
  if (read.words.length > MAX_WORDS) return `track ${position + 1} has ${read.words.length.toLocaleString("en-US")} words; at most ${MAX_WORDS.toLocaleString("en-US")} can be compared`;
  const given = fields === null ? null : (str(fields.name) ?? str(fields.label) ?? str(fields.title));
  const name = given?.trim() || read.name || (position === 0 ? "Reference" : `Transcript ${position + 1}`);
  const detail = details(fields === null ? null : (str(fields.model) === name ? null : str(fields.model)), fields === null ? null : str(fields.detail), read.detail);
  return { name, words: read.words, source: read.source, detail, timing: bestTiming(read.words), untimed: read.untimed };
}

/** A list item that is one word rather than one track. */
function looksLikeWord(item: Value): boolean {
  const fields = objectFields(item);
  if (fields === null) return false;
  if (fields.words !== undefined || fields.segments !== undefined || fields.transcription !== undefined || fields.name !== undefined) return false;
  return (num(fields.start) !== null || num(fields.end) !== null) && (typeof fields.word === "string" || typeof fields.text === "string");
}

/**
 * Reads Transcript's `tracks`: a list of tracks (the first is the reference),
 * `{tracks: [...]}`, or one transcript on its own (a tool's JSON, a word
 * list, text). Never throws.
 */
export function readTracks(value: Value | undefined): ReadTracks {
  if (value === undefined || value === null) return { ok: false, error: "Transcript needs tracks: [{name, words: [{text, start, end}]} | {name, text}]" };
  if (Array.isArray(value) && value.length === 0) return { ok: true, tracks: [] };
  const fields = objectFields(value);
  let items: readonly Value[];
  if (fields !== null && Array.isArray(fields.tracks)) items = fields.tracks;
  // A list of tracks, unless it is one track's words (word objects, or single-word strings).
  else if (Array.isArray(value) && !looksLikeWord(value[0]) && !value.every((item) => typeof item === "string" && !/\s/.test(item.trim()))) items = value;
  else items = [value];
  const tracks: Track[] = [];
  for (const [position, item] of items.entries()) {
    const track = trackOf(item, position);
    if (typeof track === "string") return { ok: false, error: track };
    tracks.push(track);
  }
  return { ok: true, tracks };
}

// ——— Normalisation ———

/** A comparable unit: one normalised word, or a spoken number joined from several words. */
export interface Token {
  readonly key: string;
  /** The track's words it came from (inclusive). */
  readonly from: number;
  readonly to: number;
}

const UNITS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS: Readonly<Record<string, number>> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Readonly<Record<string, number>> = { thousand: 1e3, million: 1e6, billion: 1e9 };
const ORDINALS: Readonly<Record<string, string>> = {
  first: "one",
  second: "two",
  third: "three",
  fifth: "five",
  eighth: "eight",
  ninth: "nine",
  twelfth: "twelve",
};

/** An ordinal number word as its cardinal ("twentieth" → "twenty"), or null. */
function cardinalOf(word: string): string | null {
  if (Object.hasOwn(ORDINALS, word)) return ORDINALS[word];
  if (word.endsWith("ieth")) {
    const base = `${word.slice(0, -4)}y`;
    return Object.hasOwn(TENS, base) ? base : null;
  }
  if (word.endsWith("th")) {
    const base = word.slice(0, -2);
    return Object.hasOwn(UNITS, base) || Object.hasOwn(TEENS, base) || Object.hasOwn(SCALES, base) || base === "hundred" ? base : null;
  }
  return null;
}

type NumberKind = "unit" | "teen" | "ten" | "hundred" | "scale" | "zero";

function numberKind(word: string): NumberKind | null {
  if (word === "zero") return "zero";
  if (Object.hasOwn(UNITS, word)) return "unit";
  if (Object.hasOwn(TEENS, word)) return "teen";
  if (Object.hasOwn(TENS, word)) return "ten";
  if (word === "hundred") return "hundred";
  if (Object.hasOwn(SCALES, word)) return "scale";
  return null;
}

interface Piece {
  readonly text: string;
  readonly word: number;
}

/** One word's text as normalised pieces: lower case, no punctuation, hyphens split, "19:49" as 1949, 50% as "50 percent". */
function pieces(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/(\d):(?=\d{2}\b)/g, "$1")
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/&/g, " and ")
    .replace(/'/g, "")
    .replace(/(\d)\.(?=\d)/g, "$1\u0000")
    .replace(/[^\p{L}\p{N}\p{M}\u0000]+/gu, " ")
    .replace(/\u0000/g, ".")
    .split(" ")
    .filter((piece) => piece !== "");
}

/**
 * A spoken number starting at `at`, as digits: "twenty five" → 25,
 * "one hundred and five" → 105, "two thousand twenty four" → 2024, and the
 * way years and clock times are said: "nineteen forty nine" → 1949 (which
 * also matches "19:49"), "nine oh five" → 905. Ordinals keep a marker so
 * "twenty first" matches "21st". Null when no number starts there.
 */
function spokenNumber(list: readonly Piece[], at: number): { key: string; next: number } | null {
  const group = numberGroup(list, at);
  if (group === null) return null;
  // Year and clock style: a group under 100 followed by a 10–99 group, or "oh" and a digit.
  if (!group.ordinal && !group.scaled && group.value > 0 && group.value < 100 && group.next < list.length) {
    const word = list[group.next].text;
    if (word === "oh" && group.next + 1 < list.length && Object.hasOwn(UNITS, list[group.next + 1].text)) {
      const unit = UNITS[list[group.next + 1].text];
      return { key: `${group.value}0${unit}`, next: group.next + 2 };
    }
    const kind = numberKind(word) ?? numberKind(cardinalOf(word) ?? "");
    if (kind === "teen" || kind === "ten") {
      const second = numberGroup(list, group.next);
      if (second !== null && !second.scaled && second.value >= 10 && second.value < 100) {
        return { key: `${group.value}${second.value}${second.ordinal ? "th" : ""}`, next: second.next };
      }
    }
  }
  return { key: `${group.value}${group.ordinal ? "th" : ""}`, next: group.next };
}

function numberGroup(list: readonly Piece[], at: number): { value: number; next: number; ordinal: boolean; scaled: boolean } | null {
  let total = 0;
  let current = 0;
  let last: NumberKind | null = null;
  let lastScale = Infinity;
  let index = at;
  let ordinal = false;
  let scaled = false;
  while (index < list.length) {
    let word = list[index].text;
    if (word === "and" && (last === "hundred" || last === "scale") && index + 1 < list.length) {
      const after = numberKind(list[index + 1].text) ?? numberKind(cardinalOf(list[index + 1].text) ?? "");
      if (after === "unit" || after === "teen" || after === "ten") {
        index++;
        continue;
      }
      break;
    }
    const cardinal = numberKind(word) === null ? cardinalOf(word) : null;
    if (cardinal !== null) word = cardinal;
    const kind = numberKind(word);
    if (kind === null) break;
    let accepted = true;
    switch (kind) {
      case "zero":
        if (last !== null) accepted = false;
        else {
          index++;
          return { value: 0, next: index, ordinal: false, scaled: false };
        }
        break;
      case "unit":
        if (last === null || last === "ten" || last === "hundred" || last === "scale") current += UNITS[word];
        else accepted = false;
        break;
      case "teen":
      case "ten":
        if (last === null || last === "hundred" || last === "scale") current += kind === "teen" ? TEENS[word] : TENS[word];
        else accepted = false;
        break;
      case "hundred":
        if ((last === "unit" || last === "teen") && current < 100) {
          current *= 100;
          scaled = true;
        } else accepted = false;
        break;
      case "scale": {
        const scale = SCALES[word];
        if (last !== null && last !== "scale" && last !== "zero" && scale < lastScale) {
          total += current * scale;
          current = 0;
          lastScale = scale;
          scaled = true;
        } else accepted = false;
        break;
      }
    }
    if (!accepted) break;
    last = kind;
    index++;
    if (cardinal !== null) {
      ordinal = true;
      break;
    }
  }
  if (last === null) return null;
  return { value: total + current, next: index, ordinal, scaled };
}

/** Ordinals written with digits ("21st") keep the same marker as spoken ones. */
function digitKey(text: string): string {
  const ordinal = /^(\d+)(st|nd|rd|th)$/.exec(text);
  return ordinal === null ? text : `${Number(ordinal[1])}th`;
}

/**
 * The comparable tokens of a track's words. WER counts these: hyphenated
 * words count per part, a spoken number as one ("twenty five" = "25").
 */
export function tokenize(words: readonly { readonly text: string }[]): Token[] {
  const list: Piece[] = [];
  words.forEach((word, index) => {
    for (const text of pieces(word.text)) list.push({ text, word: index });
  });
  const tokens: Token[] = [];
  let index = 0;
  while (index < list.length) {
    const piece = list[index];
    const spoken = spokenNumber(list, index);
    if (spoken !== null) {
      tokens.push({ key: spoken.key, from: piece.word, to: list[spoken.next - 1].word });
      index = spoken.next;
      continue;
    }
    tokens.push({ key: /^\d/.test(piece.text) ? digitKey(piece.text) : piece.text, from: piece.word, to: piece.word });
    index++;
  }
  return tokens;
}

// ——— Alignment ———

export type OpKind = "match" | "sub" | "del" | "ins";

/** One step of an alignment: token indexes into the reference and the hypothesis. */
export interface Op {
  readonly kind: OpKind;
  readonly ref: number | null;
  readonly hyp: number | null;
}

/**
 * Optional tie-breaks among alignments with the fewest errors: a 0–1 penalty
 * for pairing reference token `ref` with hypothesis token `hyp` (time
 * distance where both are timed), so "hello hello" pairs in order and a
 * substitution lands on the word said at that moment.
 */
export type PairPenalty = (ref: number, hyp: number) => number;

/** Cells one dynamic-programming table may hold before the alignment splits on anchors or narrows to a band. */
const MAX_CELLS = 4_000_000;

const DIAGONAL = 0;
const UP = 1; // reference token deleted
const LEFT = 2; // hypothesis token inserted

/**
 * A minimum-edit-distance alignment of two token sequences (substitution,
 * deletion and insertion cost 1). Long inputs are split on anchors (tokens
 * that occur exactly once in both, in order), then aligned piecewise, and a
 * piece still too large is aligned inside a diagonal band.
 */
export function align(ref: readonly Token[], hyp: readonly Token[], penalty: PairPenalty | null = null): Op[] {
  const ops: Op[] = [];
  alignRange(ref, hyp, 0, ref.length, 0, hyp.length, penalty, ops, 0);
  return ops;
}

function alignRange(
  ref: readonly Token[],
  hyp: readonly Token[],
  r0: number,
  r1: number,
  h0: number,
  h1: number,
  penalty: PairPenalty | null,
  out: Op[],
  depth: number,
): void {
  // Common head and tail match outright.
  while (r0 < r1 && h0 < h1 && ref[r0].key === hyp[h0].key && (penalty === null || penalty(r0, h0) < 0.5)) {
    out.push({ kind: "match", ref: r0++, hyp: h0++ });
  }
  const tail: Op[] = [];
  while (r1 > r0 && h1 > h0 && ref[r1 - 1].key === hyp[h1 - 1].key && (penalty === null || penalty(r1 - 1, h1 - 1) < 0.5)) {
    tail.push({ kind: "match", ref: --r1, hyp: --h1 });
  }
  const n = r1 - r0;
  const m = h1 - h0;
  if (n === 0 || m === 0) {
    for (let index = r0; index < r1; index++) out.push({ kind: "del", ref: index, hyp: null });
    for (let index = h0; index < h1; index++) out.push({ kind: "ins", ref: null, hyp: index });
  } else if ((n + 1) * (m + 1) <= MAX_CELLS) {
    table(ref, hyp, r0, r1, h0, h1, penalty, out, Infinity);
  } else {
    const anchors = depth < 8 ? uniqueAnchors(ref, hyp, r0, r1, h0, h1) : [];
    if (anchors.length === 0) {
      table(ref, hyp, r0, r1, h0, h1, penalty, out, Math.max(Math.abs(n - m) + 64, Math.floor(MAX_CELLS / (n + 1) / 2)));
    } else {
      let r = r0;
      let h = h0;
      for (const [ra, ha] of anchors) {
        alignRange(ref, hyp, r, ra, h, ha, penalty, out, depth + 1);
        out.push({ kind: "match", ref: ra, hyp: ha });
        r = ra + 1;
        h = ha + 1;
      }
      alignRange(ref, hyp, r, r1, h, h1, penalty, out, depth + 1);
    }
  }
  for (let index = tail.length - 1; index >= 0; index--) out.push(tail[index]);
}

/** Tokens unique on both sides within the ranges, longest increasing run of them (patience diff). */
function uniqueAnchors(ref: readonly Token[], hyp: readonly Token[], r0: number, r1: number, h0: number, h1: number): [number, number][] {
  const count = (tokens: readonly Token[], from: number, to: number) => {
    const seen = new Map<string, number>();
    for (let index = from; index < to; index++) seen.set(tokens[index].key, seen.has(tokens[index].key) ? -1 : index);
    return seen;
  };
  const inRef = count(ref, r0, r1);
  const inHyp = count(hyp, h0, h1);
  const pairs: [number, number][] = [];
  for (let index = r0; index < r1; index++) {
    const key = ref[index].key;
    const there = inHyp.get(key);
    if (inRef.get(key) === index && there !== undefined && there >= 0) pairs.push([index, there]);
  }
  // Longest increasing subsequence on the hypothesis positions.
  const tails: number[] = [];
  const previous = new Array<number>(pairs.length).fill(-1);
  for (let index = 0; index < pairs.length; index++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (pairs[tails[middle]][1] < pairs[index][1]) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  }
  const chain: [number, number][] = [];
  for (let index = tails.length === 0 ? -1 : tails[tails.length - 1]; index >= 0; index = previous[index]) chain.push(pairs[index]);
  return chain.reverse();
}

/** The edit-distance table over the ranges, within `band` of the diagonal, and its backtrace. */
function table(
  ref: readonly Token[],
  hyp: readonly Token[],
  r0: number,
  r1: number,
  h0: number,
  h1: number,
  penalty: PairPenalty | null,
  out: Op[],
  band: number,
): void {
  const n = r1 - r0;
  const m = h1 - h0;
  // Tie-breaks stay below one error in total, so they never change the error count.
  const epsilon = 0.5 / (n + m + 1);
  const width = m + 1;
  const moves = new Uint8Array((n + 1) * width);
  let previous = new Float64Array(width);
  let current = new Float64Array(width);
  for (let j = 0; j <= m; j++) {
    previous[j] = j;
    moves[j] = LEFT;
  }
  for (let i = 1; i <= n; i++) {
    const centre = Math.round((i * m) / n);
    const low = Math.max(1, centre - band);
    const high = Math.min(m, centre + band);
    current.fill(Infinity);
    current[0] = i;
    moves[i * width] = UP;
    const key = ref[r0 + i - 1].key;
    for (let j = low; j <= high; j++) {
      const same = key === hyp[h0 + j - 1].key;
      const tie = penalty === null ? (same ? 0 : 0.5) : penalty(r0 + i - 1, h0 + j - 1);
      const diagonal = previous[j - 1] + (same ? 0 : 1) + epsilon * tie;
      const up = previous[j] + 1 + epsilon * 0.75;
      const left = current[j - 1] + 1 + epsilon * 0.75;
      let best = diagonal;
      let move = DIAGONAL;
      if (up < best) {
        best = up;
        move = UP;
      }
      if (left < best) {
        best = left;
        move = LEFT;
      }
      current[j] = best;
      moves[i * width + j] = move;
    }
    [previous, current] = [current, previous];
  }
  const steps: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const move = i === 0 ? LEFT : j === 0 ? UP : moves[i * width + j];
    if (move === DIAGONAL) {
      const kind = ref[r0 + i - 1].key === hyp[h0 + j - 1].key ? "match" : "sub";
      steps.push({ kind, ref: r0 + i - 1, hyp: h0 + j - 1 });
      i--;
      j--;
    } else if (move === UP) {
      steps.push({ kind: "del", ref: r0 + i - 1, hyp: null });
      i--;
    } else {
      steps.push({ kind: "ins", ref: null, hyp: h0 + j - 1 });
      j--;
    }
  }
  for (let index = steps.length - 1; index >= 0; index--) out.push(steps[index]);
}

// ——— Scoring ———

export type HypStatus = "ok" | "sub" | "ins";
export type RefStatus = "ok" | "sub" | "del";

export interface Counts {
  /** Reference tokens: WER's denominator. */
  readonly words: number;
  readonly hits: number;
  readonly substitutions: number;
  readonly deletions: number;
  readonly insertions: number;
  /** Aligned words whose speaker differs (after mapping labels); null when the two tracks don't both name speakers. */
  readonly speaker: number | null;
}

export type RegionKind = "sub" | "del" | "ins" | "mixed" | "speaker";

/** A run of errors in one hypothesis, as a reader steps through them. */
export interface Region {
  readonly track: number;
  readonly kind: RegionKind;
  /** Reference words involved (inclusive), and the hypothesis words. */
  readonly ref: readonly [number, number] | null;
  readonly hyp: readonly [number, number] | null;
  /** Seconds, from the reference's times where it is timed, else the hypothesis's; null when neither is. */
  readonly start: number | null;
  readonly end: number | null;
  readonly refText: string;
  readonly hypText: string;
  /** For speaker regions: the reference speaker and the one the hypothesis gave. */
  readonly speakers: readonly [string, string] | null;
}

export interface Comparison {
  /** Index of the hypothesis among the tracks (≥ 1). */
  readonly track: number;
  readonly ops: readonly Op[];
  readonly counts: Counts;
  /** (S + D + I) / reference words; null when the reference has no words. */
  readonly wer: number | null;
  readonly hypStatus: readonly HypStatus[];
  /** Per reference word, as this hypothesis has it. */
  readonly refStatus: readonly RefStatus[];
  /** Per hypothesis word, the reference word it is aligned to (match or substitution), else null. */
  readonly pairedRef: readonly (number | null)[];
  /** Per hypothesis word: its speaker disagrees with the reference's. */
  readonly speakerWrong: readonly boolean[];
  /** Hypothesis speaker label → the reference speaker it stands for (null: none). */
  readonly speakerMap: ReadonlyMap<string, string | null>;
  readonly regions: readonly Region[];
}

/** The reference and the hypotheses aligned to it. */
export interface Analysis {
  readonly tracks: readonly Track[];
  readonly reference: Track;
  readonly refTokens: readonly Token[];
  readonly comparisons: readonly Comparison[];
  /** All regions of all hypotheses, by time (untimed ones last, in order). */
  readonly regions: readonly Region[];
}

function midpoint(words: readonly Word[], token: Token): number | null {
  const start = words[token.from].start;
  const end = words[token.to].end;
  return start === null || end === null ? null : (start + end) / 2;
}

/** Hypothesis speaker labels mapped one to one onto the reference speakers they share most aligned words with. */
function mapSpeakers(pairs: readonly [string, string][]): Map<string, string | null> {
  const tally = new Map<string, number>();
  for (const [hyp, ref] of pairs) tally.set(`${hyp}\u0000${ref}`, (tally.get(`${hyp}\u0000${ref}`) ?? 0) + 1);
  const ranked = [...tally.entries()]
    .map(([key, count]) => {
      const [hyp, ref] = key.split("\u0000");
      return { hyp, ref, count, same: hyp === ref };
    })
    .sort((a, b) => b.count - a.count || Number(b.same) - Number(a.same) || a.hyp.localeCompare(b.hyp));
  const map = new Map<string, string | null>();
  const taken = new Set<string>();
  for (const { hyp, ref } of ranked) {
    if (map.has(hyp) || taken.has(ref)) continue;
    map.set(hyp, ref);
    taken.add(ref);
  }
  for (const [hyp] of pairs) if (!map.has(hyp)) map.set(hyp, null);
  return map;
}

function wordsText(words: readonly Word[], range: readonly [number, number] | null): string {
  return range === null ? "" : words.slice(range[0], range[1] + 1).map((word) => word.text).join(" ");
}

function span(words: readonly Word[], range: readonly [number, number] | null): [number, number] | null {
  if (range === null) return null;
  let start: number | null = null;
  let end: number | null = null;
  for (let index = range[0]; index <= range[1]; index++) {
    const word = words[index];
    if (word.start !== null) start = start === null ? word.start : Math.min(start, word.start);
    if (word.end !== null) end = end === null ? word.end : Math.max(end, word.end);
  }
  return start === null || end === null ? null : [start, end];
}

function extend(range: [number, number] | null, from: number, to: number): [number, number] {
  return range === null ? [from, to] : [Math.min(range[0], from), Math.max(range[1], to)];
}

function compare(reference: Track, refTokens: readonly Token[], track: Track, index: number): Comparison {
  const hypTokens = tokenize(track.words);
  const timed = reference.timing !== "none" && track.timing !== "none";
  const refMid = timed ? refTokens.map((token) => midpoint(reference.words, token)) : [];
  const hypMid = timed ? hypTokens.map((token) => midpoint(track.words, token)) : [];
  const penalty: PairPenalty | null = timed
    ? (r, h) => {
        const a = refMid[r];
        const b = hypMid[h];
        if (a === null || b === null) return refTokens[r].key === hypTokens[h].key ? 0 : 0.5;
        return Math.min(1, Math.abs(a - b) / 2);
      }
    : null;
  const ops = align(refTokens, hypTokens, penalty);

  const hypStatus: HypStatus[] = track.words.map(() => "ok");
  const refStatus: RefStatus[] = reference.words.map(() => "ok");
  const pairedRef: (number | null)[] = track.words.map(() => null);
  let hits = 0;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  const worse = <T extends string>(current: T, next: T, order: readonly T[]) => (order.indexOf(next) > order.indexOf(current) ? next : current);
  for (const op of ops) {
    const refToken = op.ref === null ? null : refTokens[op.ref];
    const hypToken = op.hyp === null ? null : hypTokens[op.hyp];
    if (op.kind === "match") hits++;
    else if (op.kind === "sub") substitutions++;
    else if (op.kind === "del") deletions++;
    else insertions++;
    if (refToken !== null) {
      const status: RefStatus = op.kind === "match" ? "ok" : op.kind === "sub" ? "sub" : "del";
      for (let word = refToken.from; word <= refToken.to; word++) refStatus[word] = worse(refStatus[word], status, ["ok", "sub", "del"]);
    }
    if (hypToken !== null) {
      const status: HypStatus = op.kind === "match" ? "ok" : op.kind === "sub" ? "sub" : "ins";
      for (let word = hypToken.from; word <= hypToken.to; word++) {
        hypStatus[word] = worse(hypStatus[word], status, ["ok", "ins", "sub"]);
        if (refToken !== null && pairedRef[word] === null) pairedRef[word] = refToken.from;
      }
    }
  }

  // Speakers: compared on aligned words where both name one, labels mapped first.
  const bothSpeak = reference.words.some((word) => word.speaker !== null) && track.words.some((word) => word.speaker !== null);
  const pairs: [string, string][] = [];
  if (bothSpeak) {
    track.words.forEach((word, position) => {
      const paired = pairedRef[position];
      const other = paired === null ? null : reference.words[paired].speaker;
      if (word.speaker !== null && other !== null && other !== undefined) pairs.push([word.speaker, other]);
    });
  }
  const speakerMap = mapSpeakers(pairs);
  const speakerWrong = track.words.map((word, position) => {
    const paired = pairedRef[position];
    if (!bothSpeak || paired === null || word.speaker === null) return false;
    const other = reference.words[paired].speaker;
    return other !== null && speakerMap.get(word.speaker) !== other;
  });
  const speakerErrors = bothSpeak ? speakerWrong.filter(Boolean).length : null;

  const counts: Counts = { words: refTokens.length, hits, substitutions, deletions, insertions, speaker: speakerErrors };
  const wer = refTokens.length === 0 ? null : (substitutions + deletions + insertions) / refTokens.length;
  return {
    track: index,
    ops,
    counts,
    wer,
    hypStatus,
    refStatus,
    pairedRef,
    speakerWrong,
    speakerMap,
    regions: regionsOf(index, ops, refTokens, hypTokens, reference, track, speakerWrong, speakerMap),
  };
}

function regionsOf(
  index: number,
  ops: readonly Op[],
  refTokens: readonly Token[],
  hypTokens: readonly Token[],
  reference: Track,
  track: Track,
  speakerWrong: readonly boolean[],
  speakerMap: ReadonlyMap<string, string | null>,
): Region[] {
  const regions: Region[] = [];
  let run: { kinds: Set<OpKind>; ref: [number, number] | null; hyp: [number, number] | null } | null = null;
  const close = () => {
    if (run === null) return;
    const kinds = [...run.kinds];
    const kind: RegionKind = kinds.length === 1 ? (kinds[0] as RegionKind) : kinds.every((kind) => kind === "sub" || kind === "del") || kinds.every((kind) => kind === "sub" || kind === "ins") ? "sub" : "mixed";
    // A substitution run with extra or missing words reads as one replacement ("can you hear me" → "Jeremy").
    const timing = span(reference.words, run.ref) ?? span(track.words, run.hyp) ?? nearTime(run, ops, refTokens, reference);
    regions.push({
      track: index,
      kind,
      ref: run.ref,
      hyp: run.hyp,
      start: timing === null ? null : timing[0],
      end: timing === null ? null : timing[1],
      refText: wordsText(reference.words, run.ref),
      hypText: wordsText(track.words, run.hyp),
      speakers: null,
    });
    run = null;
  };
  for (const op of ops) {
    if (op.kind === "match") {
      close();
      continue;
    }
    run ??= { kinds: new Set(), ref: null, hyp: null };
    run.kinds.add(op.kind);
    if (op.ref !== null) run.ref = extend(run.ref, refTokens[op.ref].from, refTokens[op.ref].to);
    if (op.hyp !== null) run.hyp = extend(run.hyp, hypTokens[op.hyp].from, hypTokens[op.hyp].to);
  }
  close();

  // Speaker regions: consecutive hypothesis words attributed to the wrong speaker.
  let from = -1;
  for (let position = 0; position <= track.words.length; position++) {
    const wrong = position < track.words.length && speakerWrong[position];
    if (wrong && from < 0) from = position;
    const breaks = from >= 0 && (!wrong || track.words[position].speaker !== track.words[from].speaker);
    if (breaks) {
      const hyp: [number, number] = [from, position - 1];
      const words = track.words.slice(from, position);
      const pairedRefs = ops.filter((op) => op.hyp !== null && op.ref !== null && hypTokens[op.hyp].from >= from && hypTokens[op.hyp].to <= position - 1).map((op) => refTokens[op.ref!]);
      const ref: [number, number] | null = pairedRefs.length === 0 ? null : [pairedRefs[0].from, pairedRefs[pairedRefs.length - 1].to];
      const timing = span(reference.words, ref) ?? span(track.words, hyp);
      const given = words[0].speaker ?? "";
      const expected = ref === null ? null : reference.words[ref[0]].speaker;
      regions.push({
        track: index,
        kind: "speaker",
        ref,
        hyp,
        start: timing === null ? null : timing[0],
        end: timing === null ? null : timing[1],
        refText: wordsText(reference.words, ref),
        hypText: wordsText(track.words, hyp),
        speakers: [expected ?? "another speaker", speakerMap.get(given) ?? given],
      });
      from = wrong ? position : -1;
    }
  }
  return regions;
}

/** An insertion's time where only the reference is timed: just after the reference word before it. */
function nearTime(
  run: { ref: [number, number] | null; hyp: [number, number] | null },
  ops: readonly Op[],
  refTokens: readonly Token[],
  reference: Track,
): [number, number] | null {
  if (run.hyp === null) return null;
  let before: number | null = null;
  for (const op of ops) {
    if (op.ref !== null) before = refTokens[op.ref].to;
    if (op.hyp !== null && op.kind === "ins") break;
  }
  const word = before === null ? reference.words.find((item) => item.start !== null) : reference.words[before];
  if (word === undefined || word.end === null || word.start === null) return null;
  const at = before === null ? word.start : word.end;
  return [at, at];
}

function byTime(a: Region, b: Region): number {
  if (a.start === null || b.start === null) return a.start === null ? (b.start === null ? 0 : 1) : -1;
  return a.start - b.start || a.track - b.track;
}

/** Aligns every hypothesis (tracks after the first) to the reference. */
export function analyse(tracks: readonly Track[]): Analysis | null {
  if (tracks.length === 0) return null;
  const reference = tracks[0];
  const refTokens = tokenize(reference.words);
  const comparisons = tracks.slice(1).map((track, position) => compare(reference, refTokens, track, position + 1));
  const regions = comparisons.flatMap((comparison) => comparison.regions).sort(byTime);
  return { tracks, reference, refTokens, comparisons, regions };
}

// ——— Placement and text ———

/** Where a word sits on the time axis, and whether that place is the word's own time. */
export interface Placed {
  readonly start: number;
  readonly end: number;
  /** `aligned`: an untimed word shown under the word it aligns to. */
  readonly basis: "word" | "segment" | "aligned";
}

/**
 * Positions of every track's words on the time axis: their own times, else
 * (untimed tracks) the times of the words they align to; null for a track
 * nothing places. The reference borrows a timed hypothesis's times when it
 * has none of its own.
 */
export function placeTracks(analysis: Analysis): (readonly (Placed | null)[] | null)[] {
  const { reference, comparisons } = analysis;
  const own = (track: Track) => track.words.map((word): Placed | null => (word.start === null || word.end === null ? null : { start: word.start, end: word.end, basis: word.timing === "segment" ? "segment" : "word" }));
  let refPlaces: (Placed | null)[] | null = reference.timing === "none" ? null : own(reference);
  if (refPlaces === null) {
    const timed = comparisons.find((comparison) => analysis.tracks[comparison.track].timing !== "none");
    if (timed !== undefined) {
      const track = analysis.tracks[timed.track];
      const borrowed: (Placed | null)[] = reference.words.map(() => null);
      track.words.forEach((word, position) => {
        const paired = timed.pairedRef[position];
        if (paired === null || word.start === null || word.end === null) return;
        const existing = borrowed[paired];
        borrowed[paired] = existing === null ? { start: word.start, end: word.end, basis: "aligned" } : { ...existing, end: Math.max(existing.end, word.end) };
      });
      refPlaces = fillGaps(borrowed);
    }
  }
  const result: (readonly (Placed | null)[] | null)[] = [refPlaces];
  for (const comparison of comparisons) {
    const track = analysis.tracks[comparison.track];
    if (track.timing !== "none") {
      result.push(own(track));
      continue;
    }
    if (refPlaces === null) {
      result.push(null);
      continue;
    }
    const places: (Placed | null)[] = track.words.map((_, position) => {
      const paired = comparison.pairedRef[position];
      const place = paired === null ? null : refPlaces[paired];
      return place === null ? null : { start: place.start, end: place.end, basis: "aligned" };
    });
    // Words sharing one reference word split its span.
    let position = 0;
    while (position < places.length) {
      const place = places[position];
      let next = position + 1;
      while (place !== null && next < places.length && comparison.pairedRef[next] === comparison.pairedRef[position]) next++;
      if (place !== null && next - position > 1) {
        const step = (place.end - place.start) / (next - position);
        for (let index = position; index < next; index++) places[index] = { start: place.start + step * (index - position), end: place.start + step * (index - position + 1), basis: "aligned" };
      }
      position = next;
    }
    result.push(fillGaps(places));
  }
  return result;
}

/** Unplaced words (insertions in an untimed track) share the gap between their placed neighbours. */
function fillGaps(places: (Placed | null)[]): (Placed | null)[] {
  let position = 0;
  while (position < places.length) {
    if (places[position] !== null) {
      position++;
      continue;
    }
    let next = position;
    while (next < places.length && places[next] === null) next++;
    const before = position > 0 ? places[position - 1] : null;
    const after = next < places.length ? places[next] : null;
    if (before !== null || after !== null) {
      const from = before?.end ?? Math.max(0, (after?.start ?? 0) - 0.3 * (next - position));
      const to = after?.start ?? from + 0.3 * (next - position);
      const gap = Math.max(to - from, 0.12 * (next - position));
      const step = gap / (next - position);
      const origin = to - from < gap ? from - (gap - (to - from)) / 2 : from;
      for (let index = position; index < next; index++) places[index] = { start: Math.max(0, origin + step * (index - position)), end: Math.max(0, origin + step * (index - position + 1)), basis: "aligned" };
    }
    position = next;
  }
  return places;
}

/** One column of the aligned text view: a reference word (or an insertion slot) and what each hypothesis has there. */
export interface Column {
  /** The reference word, or null for words only hypotheses have. */
  readonly ref: number | null;
  /** Per hypothesis (in comparison order): its words in this column. */
  readonly hyp: readonly (readonly number[])[];
}

/** The alignment as columns under the reference words, insertions in columns of their own. */
export function columns(analysis: Analysis): Column[] {
  const { reference, refTokens, comparisons } = analysis;
  const count = comparisons.length;
  const under: number[][][] = reference.words.map(() => comparisons.map(() => []));
  // Insertions before reference word k (k = words.length: after the last).
  const before: number[][][] = [...reference.words.map(() => comparisons.map(() => [])), comparisons.map(() => [])];
  comparisons.forEach((comparison, slot) => {
    const hypTokens = tokenize(analysis.tracks[comparison.track].words);
    let nextRef = 0;
    const seen = new Set<number>();
    for (const op of comparison.ops) {
      if (op.ref !== null) nextRef = refTokens[op.ref].to + 1;
      if (op.hyp === null) continue;
      const token = hypTokens[op.hyp];
      for (let word = token.from; word <= token.to; word++) {
        if (seen.has(word)) continue;
        seen.add(word);
        if (op.ref !== null) under[refTokens[op.ref].from][slot].push(word);
        else before[nextRef][slot].push(word);
      }
    }
  });
  const result: Column[] = [];
  for (let index = 0; index <= reference.words.length; index++) {
    if (before[index].some((words) => words.length > 0)) result.push({ ref: null, hyp: before[index] });
    if (index < reference.words.length) result.push({ ref: index, hyp: count === 0 ? [] : under[index] });
  }
  return result;
}

// ——— Formatting ———

/** A time as m:ss.s (h:mm:ss.s past an hour); `precise` keeps tenths. */
export function formatClock(seconds: number, precise = true): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  const secs = precise ? (Math.floor(rest * 10) / 10).toFixed(1).padStart(4, "0") : String(Math.floor(rest)).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

/** "19:49", "1:02:03", "93", "19:49.5" as seconds; null when it isn't a time. */
export function parseClock(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(trimmed)) return null;
  const parts = trimmed.split(":");
  if (parts.slice(1).some((part) => Number(part.split(".")[0]) >= 60)) return null;
  return parts.reduce((sum, part) => sum * 60 + Number(part), 0);
}

export function formatWer(wer: number): string {
  const percent = wer * 100;
  return `${percent >= 10 || percent === 0 ? percent.toFixed(percent % 1 === 0 ? 0 : 1) : percent.toFixed(1)}%`;
}

/** A region in words: ‘can you hear me’ → ‘Jeremy’, missing ‘you’, extra ‘so’, Maya's words given to Sam. */
export function describeRegion(region: Region): string {
  switch (region.kind) {
    case "del":
      return `missing “${region.refText}”`;
    case "ins":
      return `extra “${region.hypText}”`;
    case "speaker":
      return region.speakers === null ? `“${region.hypText}” has the wrong speaker` : `“${region.hypText}” given to ${region.speakers[1]}, said by ${region.speakers[0]}`;
    default:
      return `“${region.refText}” heard as “${region.hypText}”`;
  }
}

/** "3 misheard · 2 missing · 1 extra" (S, D, I) and speaker mismatches, zero parts left out. */
export function countsText(counts: Counts): string {
  const parts = [
    counts.substitutions > 0 ? `${counts.substitutions} misheard` : null,
    counts.deletions > 0 ? `${counts.deletions} missing` : null,
    counts.insertions > 0 ? `${counts.insertions} extra` : null,
    counts.speaker !== null && counts.speaker > 0 ? `${counts.speaker} with the wrong speaker` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "no errors" : parts.join(" · ");
}

// ——— Layout ———

/** The fewest and most pixels per second the default zoom picks: at most about 3.5 s across a 700 px lane. */
export const MIN_SCALE = 40;
export const MAX_SCALE = 200;

/**
 * Pixels per second at zoom 1: enough that every word's text (`measure`d in
 * pixels) fits the room it has, from its start to the next word's start in its
 * lane (or its own end for the last), set by the densest stretch of any lane,
 * within MIN_SCALE–MAX_SCALE. `pad` is the box's padding and the gap kept to
 * the next word, in pixels.
 */
export function autoScale(
  lanes: readonly { readonly places: readonly (Placed | null)[]; readonly words: readonly Word[] }[],
  measure: (text: string) => number,
  pad: number,
): number {
  let scale = 0;
  for (const { places, words } of lanes) {
    const { order } = laneIndex(places);
    order.forEach((index, position) => {
      const place = places[index]!;
      const next = position + 1 < order.length ? places[order[position + 1]]!.start : place.end;
      const room = Math.max(next - place.start, 0.01);
      scale = Math.max(scale, (measure(words[index].text) + pad) / room);
    });
  }
  return scale === 0 ? 120 : Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Seconds between ruler labels so they sit at least `minPx` apart. */
export function tickStep(pixelsPerSecond: number, minPx = 64): number {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find((step) => step * pixelsPerSecond >= minPx) ?? 7200;
}

/** A lane's words by start time, for finding the ones on screen without scanning them all. */
export interface LaneIndex {
  /** Word indexes ordered by start. */
  readonly order: readonly number[];
  readonly starts: readonly number[];
  /** The longest word, so a word starting before the window but reaching into it is found. */
  readonly longest: number;
}

export function laneIndex(places: readonly (Placed | null)[]): LaneIndex {
  const order = places.flatMap((place, index) => (place === null ? [] : [index])).sort((a, b) => places[a]!.start - places[b]!.start || a - b);
  return {
    order,
    starts: order.map((index) => places[index]!.start),
    longest: order.reduce((longest, index) => Math.max(longest, places[index]!.end - places[index]!.start), 0),
  };
}

/** Positions in `index.order` of the words overlapping [from, to] seconds: [first, last) . */
export function visibleSlice(index: LaneIndex, from: number, to: number): [number, number] {
  const search = (time: number) => {
    let low = 0;
    let high = index.starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (index.starts[middle] < time) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return [search(from - index.longest), search(to)];
}
