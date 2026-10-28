// A transcript against its reference, the way a speech engineer checks one:
// per-track WER and error counts first, then one lane per track on a shared
// time ruler with every word at its time, errors coloured (misheard, missing
// as a gap holding the missing words, extra), speakers as a quiet band, and
// the recording playing under a playhead: a word seeks and plays from it,
// errors step one by one, a time typed as mm:ss jumps there. Only the words on
// screen render, so an hour-long recording costs what a minute does. Untimed
// input reads as aligned text instead.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  analyse,
  autoScale,
  columns as alignedColumns,
  countsText,
  describeRegion,
  formatClock,
  formatWer,
  laneIndex,
  parseClock,
  placeTracks,
  readTracks,
  tickStep,
  visibleSlice,
  type Analysis,
  type Comparison,
  type LaneIndex,
  type Placed,
  type Region,
  type Track,
} from "../../core/transcript";
import { useUiRuntime } from "../runtime";
import { propsKey, usePersistedState } from "../usePersistedState";
import { ACCENT, optionalText, type Props } from "../values";
import { ErrorLine } from "./display";
import { FIELD, FOCUS_RING } from "./inputs";
import { reducedMotion } from "./motion";
import { Frame, Heading, Quiet, Segmented } from "./perfKit";
import { ICON_BUTTON } from "./projectKit";

type View = "timeline" | "text";

const VIEWS: readonly { value: View; label: string }[] = [
  { value: "timeline", label: "Timeline" },
  { value: "text", label: "Text" },
];

/** A word box's horizontal padding (px-[3px] each side) plus a pixel of rounding, and the gap kept before the next word. */
const WORD_PADDING_PX = 7;
const WORD_GAP_PX = 2;
/** Width of the fade at the lanes' right edge while more words lie beyond it. */
const EDGE_FADE_PX = 32;

let measureContext: CanvasRenderingContext2D | null | undefined;
const measured = new Map<string, number>();

/** A word's width as the lanes draw it (12px in the page's font), measured once per text. */
function measureWord(text: string): number {
  const known = measured.get(text);
  if (known !== undefined) return known;
  if (measureContext === undefined) {
    measureContext = document.createElement("canvas").getContext("2d");
    if (measureContext !== null) measureContext.font = `400 12px ${getComputedStyle(document.body).fontFamily || "system-ui, sans-serif"}`;
  }
  // Without a canvas, a wide average advance errs towards room to spare.
  const width = measureContext === null ? text.length * 7 : measureContext.measureText(text).width;
  // Before the page's web font arrives the canvas measures a fallback; don't keep that.
  if (document.fonts.status === "loaded") measured.set(text, width);
  return width;
}

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8] as const;
/** Pixels rendered beyond each side of the visible span, so scrolling never shows a blank edge. */
const OVERSCAN_PX = 600;
/** Aligned-text columns shown before "Show more". */
const COLUMN_PAGE = 400;
/** After the user scrolls the lanes, playback stops following for this long. */
const USER_SCROLL_HOLD_MS = 3000;
/** Leading space before the first second, so the first word isn't flush with the edge. */
const LANE_PAD_PX = 12;

type ErrorKind = "sub" | "del" | "ins" | "speaker";

const ERROR_LABEL: Record<ErrorKind, string> = {
  sub: "Misheard",
  del: "Missing",
  ins: "Extra",
  speaker: "Wrong speaker",
};

/** Word fills per error: a faint wash with a strong underline, so text stays readable in both themes. */
const ERROR_STYLE: Record<"sub" | "ins", CSSProperties> = {
  sub: { background: "color-mix(in oklab, var(--warning) 16%, transparent)", boxShadow: "inset 0 -2px 0 var(--warning)" },
  ins: { background: `color-mix(in oklab, ${ACCENT} 14%, transparent)`, boxShadow: `inset 0 -2px 0 ${ACCENT}` },
};
const MISSING_STYLE: CSSProperties = {
  background: "color-mix(in oklab, var(--destructive) 7%, transparent)",
  border: "1px dashed color-mix(in oklab, var(--destructive) 70%, transparent)",
};
const SPEAKER_OUTLINE = "1.5px dotted var(--foreground)";

/** Speaker bands: kept clear of the error colours (amber, red, the accent blue). */
const SPEAKER_COLORS = [
  "var(--success)",
  "color-mix(in oklch, var(--color-timeline-accent, var(--primary)) 50%, var(--destructive))",
  "color-mix(in oklch, var(--muted-foreground) 70%, var(--background))",
  "color-mix(in oklch, var(--success) 45%, var(--color-timeline-accent, var(--primary)))",
  "color-mix(in oklch, var(--warning) 50%, var(--muted-foreground))",
] as const;

export function Transcript({ props }: { props: Props }) {
  const read = useMemo(() => readTracks(props.tracks), [props.tracks]);
  const audio = optionalText(props.audio)?.trim() || null;
  const id = propsKey(props.tracks ?? null);
  if (!read.ok) return <ErrorLine message={read.error} />;
  return (
    <Frame label="Transcript">
      {read.tracks.length === 0 || read.tracks.every((track) => track.words.length === 0) ? (
        <Quiet>No words to show.</Quiet>
      ) : (
        <TranscriptView tracks={read.tracks} audio={audio} id={id} />
      )}
    </Frame>
  );
}

// ——— Playback ———

type Source = { status: "none" } | { status: "loading" } | { status: "ready"; url: string } | { status: "failed"; error: string };

interface Player {
  readonly audio: ReactNode;
  readonly source: Source;
  readonly duration: number | null;
  readonly playing: boolean;
  /** The position, in tenths of a second (re-renders at most ten times a second). */
  readonly time: number;
  /** The exact position, for the playhead, read every frame while playing. */
  readonly subscribe: (listener: (time: number) => void) => () => void;
  readonly now: () => number;
  readonly seek: (time: number, play: boolean) => void;
  readonly toggle: () => void;
}

/** The recording behind an <audio> the component drives itself, or a bare cursor when there is none. */
function usePlayer(path: string | null): Player {
  const { loadAudio } = useUiRuntime();
  const element = useRef<HTMLAudioElement>(null);
  const [loaded, setLoaded] = useState<Source>(() => (path === null ? { status: "none" } : { status: "loading" }));
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const exact = useRef(0);
  const listeners = useRef(new Set<(time: number) => void>());

  useEffect(() => {
    if (path === null) {
      setLoaded({ status: "none" });
      return;
    }
    if (loadAudio === null) {
      setLoaded({ status: "failed", error: "recordings can't be played here" });
      return;
    }
    let live = true;
    setLoaded({ status: "loading" });
    void loadAudio(path).then((result) => {
      if (live) setLoaded(result.ok ? { status: "ready", url: result.url } : { status: "failed", error: result.error });
    });
    return () => {
      live = false;
    };
  }, [path, loadAudio]);

  const publish = useCallback((at: number) => {
    exact.current = at;
    for (const listener of listeners.current) listener(at);
    setTime(Math.floor(at * 10) / 10);
  }, []);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const audio = element.current;
      if (audio !== null) publish(audio.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, publish]);

  const ready = loaded.status === "ready" && mediaError === null;
  const seek = useCallback(
    (at: number, play: boolean) => {
      const audio = element.current;
      const end = audio !== null && Number.isFinite(audio.duration) ? audio.duration : Infinity;
      const target = Math.max(0, Math.min(at, end));
      if (ready && audio !== null) {
        audio.currentTime = target;
        if (play) void audio.play().catch(() => undefined);
      }
      publish(target);
    },
    [publish, ready],
  );
  const toggle = useCallback(() => {
    const audio = element.current;
    if (audio === null || !ready) return;
    if (audio.paused) void audio.play().catch(() => undefined);
    else audio.pause();
  }, [ready]);

  const source: Source = mediaError !== null ? { status: "failed", error: mediaError } : loaded;
  const audio =
    loaded.status === "ready" ? (
      <audio
        ref={element}
        src={loaded.url}
        preload="auto"
        className="hidden"
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          setDuration(Number.isFinite(value) ? value : null);
          setMediaError(null);
        }}
        onDurationChange={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value)) setDuration(value);
        }}
        onPlay={() => setPlaying(true)}
        onPause={(event) => {
          setPlaying(false);
          publish(event.currentTarget.currentTime);
        }}
        onSeeked={(event) => publish(event.currentTarget.currentTime)}
        onError={() => setMediaError(`this browser can't play ${path ?? "the recording"}`)}
      />
    ) : null;

  return {
    audio,
    source,
    duration,
    playing,
    time,
    subscribe: useCallback((listener: (time: number) => void) => {
      listeners.current.add(listener);
      return () => void listeners.current.delete(listener);
    }, []),
    now: useCallback(() => exact.current, []),
    seek,
    toggle,
  };
}

// ——— Lanes ———

interface Ghost {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly region: number;
}

interface Turn {
  readonly start: number;
  readonly end: number;
  readonly speaker: string;
  readonly color: string;
  readonly wrong: boolean;
}

interface Lane {
  readonly index: number;
  readonly track: Track;
  readonly comparison: Comparison | null;
  readonly places: readonly (Placed | null)[];
  readonly order: LaneIndex;
  /** Words missing from this hypothesis, at the reference's times. */
  readonly ghosts: readonly Ghost[];
  readonly turns: readonly Turn[];
  /** Per word, the error region it belongs to (index into analysis.regions), else -1. */
  readonly regionOf: Int32Array;
  readonly note: string | null;
}

function speakerColors(analysis: Analysis): Map<string, string> {
  const colors = new Map<string, string>();
  for (const word of analysis.reference.words) {
    if (word.speaker !== null && !colors.has(word.speaker)) colors.set(word.speaker, SPEAKER_COLORS[colors.size % SPEAKER_COLORS.length]);
  }
  return colors;
}

/**
 * Per track, per word: the error region it belongs to (index into
 * analysis.regions), else -1. Reference words take the first region naming
 * them; a hypothesis word prefers its word error over a speaker mismatch.
 */
function regionIndexes(analysis: Analysis): Int32Array[] {
  const indexes = analysis.tracks.map((track) => new Int32Array(track.words.length).fill(-1));
  analysis.regions.forEach((region, position) => {
    if (region.ref !== null) for (let word = region.ref[0]; word <= region.ref[1]; word++) if (indexes[0][word] < 0) indexes[0][word] = position;
    const own = indexes[region.track];
    if (region.hyp !== null) for (let word = region.hyp[0]; word <= region.hyp[1]; word++) if (own[word] < 0 || region.kind !== "speaker") own[word] = position;
  });
  return indexes;
}

function buildLanes(analysis: Analysis, places: readonly (readonly (Placed | null)[] | null)[]): Lane[] {
  const colors = speakerColors(analysis);
  const refPlaces = places[0];
  const regionOf = regionIndexes(analysis);
  return analysis.tracks.flatMap((track, index): Lane[] => {
    const own = places[index];
    if (own === null) return [];
    const comparison = index === 0 ? null : analysis.comparisons[index - 1];
    const ghosts: Ghost[] = [];
    analysis.regions.forEach((region, position) => {
      if (index === 0 || region.track !== index || region.kind !== "del" || region.ref === null || refPlaces === null) return;
      const first = refPlaces[region.ref[0]];
      const last = refPlaces[region.ref[1]];
      if (first !== null && last !== null) ghosts.push({ start: first.start, end: last.end, text: region.refText, region: position });
    });
    const turns: Turn[] = [];
    track.words.forEach((word, position) => {
      const place = own[position];
      if (word.speaker === null || place === null) return;
      const mapped = comparison === null ? word.speaker : (comparison.speakerMap.get(word.speaker) ?? null);
      const color = (mapped !== null ? colors.get(mapped) : undefined) ?? "color-mix(in oklch, var(--muted-foreground) 45%, var(--background))";
      const wrong = comparison !== null && comparison.speakerWrong[position];
      const last = turns[turns.length - 1];
      if (last !== undefined && last.speaker === word.speaker && last.wrong === wrong && place.start - last.end < 1.5) turns[turns.length - 1] = { ...last, end: Math.max(last.end, place.end) };
      else turns.push({ start: place.start, end: place.end, speaker: word.speaker, color, wrong });
    });
    const note =
      track.timing === "segment"
        ? "only segments are timed: words are spread evenly across each"
        : track.timing === "none"
          ? index === 0
            ? "untimed: placed by the transcript below it"
            : "untimed: each word sits under the reference word it matches"
          : null;
    return [{ index, track, comparison, places: own, order: laneIndex(own), ghosts, turns, regionOf: regionOf[index], note }];
  });
}

// ——— The view ———

function TranscriptView({ tracks, audio, id }: { tracks: readonly Track[]; audio: string | null; id: string }) {
  const analysis = useMemo(() => analyse(tracks)!, [tracks]);
  const places = useMemo(() => placeTracks(analysis), [analysis]);
  const lanes = useMemo(() => buildLanes(analysis, places), [analysis, places]);
  const timed = lanes.length > 0;
  const [storedView, setView] = usePersistedState<View>(`${id}:transcript-view`, "timeline", (stored) => (stored === "timeline" || stored === "text" ? stored : null));
  const [zoom, setZoom] = usePersistedState<number>(`${id}:transcript-zoom`, 1, (stored) =>
    typeof stored === "number" && (ZOOM_STEPS as readonly number[]).includes(stored) ? stored : null,
  );
  const view: View = timed ? storedView : "text";
  const player = usePlayer(audio);
  const [selected, setSelected] = useState<number | null>(null);
  const [reveal, setReveal] = useState<{ time: number; nonce: number } | null>(null);
  const regions = analysis.regions;

  const lastWordEnd = useMemo(
    () => lanes.reduce((max, lane) => lane.places.reduce((inner, place) => (place === null ? inner : Math.max(inner, place.end)), max), 0),
    [lanes],
  );
  const span = Math.max(lastWordEnd, player.duration ?? 0, 1);
  const scale = useMemo(
    () => autoScale(lanes.map((lane) => ({ places: lane.places, words: lane.track.words })), measureWord, WORD_PADDING_PX + WORD_GAP_PX),
    [lanes],
  );
  const pps = scale * zoom;

  const goTo = useCallback(
    (time: number, play: boolean) => {
      player.seek(time, play);
      setReveal((previous) => ({ time, nonce: (previous?.nonce ?? 0) + 1 }));
    },
    [player],
  );
  const step = (direction: 1 | -1) => {
    if (regions.length === 0) return;
    let next: number;
    if (selected !== null) next = Math.min(regions.length - 1, Math.max(0, selected + direction));
    else {
      const now = player.now();
      const after = regions.findIndex((region) => region.start !== null && region.start > now + 0.05);
      if (direction === 1) next = after < 0 ? regions.length - 1 : after;
      else {
        let before = regions.length - 1;
        while (before > 0 && !(regions[before].start !== null && regions[before].start! < now - 0.05)) before--;
        next = before;
      }
    }
    setSelected(next);
    const start = regions[next].start;
    if (start !== null) goTo(start, false);
    else setReveal((previous) => ({ time: -1, nonce: (previous?.nonce ?? 0) + 1 }));
  };

  const onWord = useCallback(
    (lane: number, word: number, region: number) => {
      const place = places[lane]?.[word] ?? null;
      if (region >= 0) setSelected(region);
      if (place !== null) player.seek(place.start, true);
    },
    [places, player],
  );

  const comparisons = analysis.comparisons;
  const durationMismatch =
    player.duration !== null && lastWordEnd > player.duration + 0.5 && analysis.tracks.some((track) => track.timing === "word")
      ? `The recording (${formatClock(player.duration, false)}) is shorter than the transcript (${formatClock(lastWordEnd, false)}): it may not be the recording these words came from.`
      : null;
  const untimed = analysis.tracks.filter((track) => track.untimed > 0).map((track) => `${track.name}: ${track.untimed} words with unusable times shown untimed`);

  return (
    <>
      <Summary analysis={analysis} span={lastWordEnd} />
      <Legend analysis={analysis} />
      {player.audio}
      <Controls
        player={player}
        span={span}
        regions={regions}
        selected={selected}
        onStep={step}
        onJump={(time) => goTo(time, false)}
        view={view}
        timed={timed}
        onView={setView}
        zoom={zoom}
        onZoom={setZoom}
      />
      <Caption analysis={analysis} selected={selected} playable={player.source.status === "ready"} />
      {view === "timeline" ? (
        <Timeline analysis={analysis} lanes={lanes} pps={pps} span={span} player={player} selected={selected} reveal={reveal} onWord={onWord} />
      ) : (
        <AlignedText analysis={analysis} places={places} player={player} selected={selected} reveal={reveal} onWord={onWord} />
      )}
      {durationMismatch !== null || untimed.length > 0 ? (
        <p className="m-0 text-xs leading-5 text-warning-text">{[durationMismatch, ...untimed].filter((part) => part !== null).join(" ")}</p>
      ) : null}
      {comparisons.length > 0 ? (
        <p className="m-0 text-[11px] leading-4 text-muted-foreground">
          WER = (misheard + missing + extra) ÷ reference words, compared ignoring case and punctuation, with numbers matched however they're written.
        </p>
      ) : null}
    </>
  );
}

function Summary({ analysis, span }: { analysis: Analysis; span: number }) {
  const { comparisons, reference, refTokens } = analysis;
  const words = refTokens.length;
  const speakers = new Set(reference.words.flatMap((word) => (word.speaker === null ? [] : [word.speaker])));
  const facts = [
    `${words.toLocaleString("en-US")} reference word${words === 1 ? "" : "s"}`,
    span > 0 ? formatClock(span, false) : null,
    speakers.size > 0 ? `${speakers.size} speaker${speakers.size === 1 ? "" : "s"}` : null,
  ].filter((part) => part !== null);
  if (comparisons.length === 0) {
    return <Heading title={reference.name} meta={[...facts, reference.detail].filter((part) => part !== null).join(" · ")} />;
  }
  if (comparisons.length === 1) {
    const [comparison] = comparisons;
    const track = analysis.tracks[comparison.track];
    const errors = comparison.counts.substitutions + comparison.counts.deletions + comparison.counts.insertions;
    const title =
      comparison.wer === null ? (
        `${track.name}: no reference words to score against`
      ) : (
        <>
          {errors === 0 ? "No word errors" : `${errors.toLocaleString("en-US")} word error${errors === 1 ? "" : "s"}`} in {words.toLocaleString("en-US")} words
          <span className="ml-2 tabular-nums text-muted-foreground">WER {formatWer(comparison.wer)}</span>
        </>
      );
    return (
      <Heading
        title={title}
        meta={
          <>
            {track.name} against {reference.name}
            {comparison.counts.speaker !== null || errors > 0 ? ` · ${countsText(comparison.counts)}` : ""}
            {facts.length > 1 ? ` · ${facts.slice(1).join(" · ")}` : ""}
          </>
        }
      />
    );
  }
  const scored = comparisons.filter((comparison) => comparison.wer !== null);
  const lowest = Math.min(...scored.map((comparison) => comparison.wer!));
  const leaders = scored.filter((comparison) => comparison.wer === lowest).map((comparison) => analysis.tracks[comparison.track].name);
  const title =
    scored.length === 0
      ? `${comparisons.length} transcripts against ${reference.name}`
      : lowest === 0 && leaders.length === comparisons.length
        ? "Every transcript matches the reference word for word"
        : `Lowest WER ${formatWer(lowest)}: ${leaders.join(", ")}`;
  return (
    <>
      <Heading
        title={title}
        meta={`${comparisons.length} transcripts against ${reference.name} · ${facts.join(" · ")}`}
      />
      <ul className="m-0 flex list-none flex-col p-0" aria-label="Error rate per transcript">
        {comparisons.map((comparison) => {
          const track = analysis.tracks[comparison.track];
          return (
            <li key={comparison.track} className="flex min-w-0 items-baseline gap-2 border-b border-border/40 py-1 text-xs leading-5 last:border-b-0">
              <span className="min-w-0 flex-[0_1_auto] truncate font-medium text-foreground">{track.name}</span>
              <span className="shrink-0 tabular-nums text-foreground">{comparison.wer === null ? "—" : formatWer(comparison.wer)}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{countsText(comparison.counts)}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Swatch({ kind }: { kind: ErrorKind }) {
  const style: CSSProperties =
    kind === "del" ? MISSING_STYLE : kind === "speaker" ? { outline: SPEAKER_OUTLINE, outlineOffset: -1 } : ERROR_STYLE[kind];
  return <span aria-hidden className="inline-block h-3 w-4 shrink-0 rounded-[3px]" style={style} />;
}

function Legend({ analysis }: { analysis: Analysis }) {
  const present = (["sub", "del", "ins", "speaker"] as const).filter((kind) =>
    analysis.comparisons.some((comparison) =>
      kind === "sub"
        ? comparison.counts.substitutions > 0
        : kind === "del"
          ? comparison.counts.deletions > 0
          : kind === "ins"
            ? comparison.counts.insertions > 0
            : (comparison.counts.speaker ?? 0) > 0,
    ),
  );
  const colors = speakerColors(analysis);
  if (present.length === 0 && colors.size === 0) return null;
  return (
    <div aria-hidden className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-4 text-muted-foreground">
      {present.map((kind) => (
        <span key={kind} className="inline-flex items-center gap-1.5">
          <Swatch kind={kind} />
          {ERROR_LABEL[kind]}
        </span>
      ))}
      {[...colors.entries()].map(([speaker, color]) => (
        <span key={speaker} className="inline-flex min-w-0 items-center gap-1.5">
          <span className="h-[3px] w-4 shrink-0 rounded-full" style={{ background: color }} />
          <span className="max-w-[10rem] truncate">{speaker}</span>
        </span>
      ))}
    </div>
  );
}

function Controls({
  player,
  span,
  regions,
  selected,
  onStep,
  onJump,
  view,
  timed,
  onView,
  zoom,
  onZoom,
}: {
  player: Player;
  span: number;
  regions: readonly Region[];
  selected: number | null;
  onStep: (direction: 1 | -1) => void;
  onJump: (time: number) => void;
  view: View;
  timed: boolean;
  onView: (view: View) => void;
  zoom: number;
  onZoom: (zoom: number) => void;
}) {
  const [jump, setJump] = useState("");
  const [invalid, setInvalid] = useState(false);
  const { source } = player;
  const zoomAt = ZOOM_STEPS.indexOf(zoom as (typeof ZOOM_STEPS)[number]);
  const submit = () => {
    const time = parseClock(jump);
    if (time === null || time > span + 0.001) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onJump(time);
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      {source.status === "none" ? null : (
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={player.toggle}
            disabled={source.status !== "ready"}
            aria-label={player.playing ? "Pause recording" : "Play recording"}
            className={cn(
              "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-foreground text-background transition-opacity duration-150 hover:opacity-85 disabled:cursor-default disabled:opacity-35",
              FOCUS_RING,
            )}
          >
            <Icon name={player.playing ? "Pause" : "Play"} aria-hidden className="size-3.5" />
          </button>
          {source.status === "failed" ? (
            <span className="min-w-0 truncate text-xs leading-5 text-destructive" title={source.error}>
              Recording unavailable: {source.error}
            </span>
          ) : (
            <span className="whitespace-nowrap text-xs leading-5 tabular-nums text-muted-foreground" aria-live="off">
              {source.status === "loading" ? (
                "Loading recording…"
              ) : (
                <>
                  <span className="text-foreground">{formatClock(player.time)}</span> / {formatClock(player.duration ?? span)}
                </>
              )}
            </span>
          )}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Errors">
        <button type="button" onClick={() => onStep(-1)} disabled={regions.length === 0} aria-label="Previous error" className={ICON_BUTTON}>
          <Icon name="ChevronLeft" aria-hidden className="size-3.5" />
        </button>
        <span className="min-w-[5.5rem] text-center text-xs leading-5 tabular-nums text-muted-foreground" aria-live="polite">
          {regions.length === 0 ? "No errors" : selected === null ? `${regions.length} error${regions.length === 1 ? "" : "s"}` : `Error ${selected + 1} of ${regions.length}`}
        </span>
        <button type="button" onClick={() => onStep(1)} disabled={regions.length === 0} aria-label="Next error" className={ICON_BUTTON}>
          <Icon name="ChevronRight" aria-hidden className="size-3.5" />
        </button>
      </div>
      {timed ? (
        <form
          className="flex shrink-0 items-center"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            value={jump}
            onChange={(event) => {
              setJump(event.target.value);
              setInvalid(false);
            }}
            inputMode="decimal"
            placeholder="Go to m:ss"
            aria-label="Go to a time (m:ss)"
            aria-invalid={invalid}
            title={invalid ? `Type a time between 0:00 and ${formatClock(span, false)}` : "Type a time such as 0:12 and press Enter"}
            className={cn(FIELD, "h-7 w-[6.5rem] px-2 text-xs tabular-nums", invalid && "border-destructive")}
          />
        </form>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {view === "timeline" ? (
          <div className="flex items-center" role="group" aria-label="Zoom">
            <button type="button" aria-label="Zoom out" disabled={zoomAt <= 0} onClick={() => onZoom(ZOOM_STEPS[Math.max(0, zoomAt - 1)])} className={ICON_BUTTON}>
              <Icon name="ZoomOut" aria-hidden className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              disabled={zoomAt >= ZOOM_STEPS.length - 1}
              onClick={() => onZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, zoomAt + 1)])}
              className={ICON_BUTTON}
            >
              <Icon name="ZoomIn" aria-hidden className="size-3.5" />
            </button>
          </div>
        ) : null}
        {timed ? <Segmented label="View" value={view} options={VIEWS} onChange={onView} /> : null}
      </div>
    </div>
  );
}

/** One line saying which error is selected, or what to do; always one line tall. */
function Caption({ analysis, selected, playable }: { analysis: Analysis; selected: number | null; playable: boolean }) {
  const region = selected === null ? null : analysis.regions[selected];
  const many = analysis.comparisons.length > 1;
  let text: string;
  if (region !== null) {
    const at = region.start === null ? "" : `${formatClock(region.start)} · `;
    text = `${at}${many ? `${analysis.tracks[region.track].name}: ` : ""}${describeRegion(region)}`;
  } else if (analysis.comparisons.length === 0) text = playable ? "One transcript, nothing to compare. Press a word to play from it." : "One transcript: nothing to compare it with.";
  else if (analysis.regions.length === 0) text = "Every transcript matches the reference word for word.";
  else text = playable ? "Press a word to play from it; ‹ › step through the errors." : "Step through the errors with ‹ ›.";
  return (
    <p className={cn("m-0 truncate text-xs leading-5", region === null ? "text-muted-foreground" : "text-foreground")} title={text}>
      {text}
    </p>
  );
}

// ——— Timeline ———

function useScrollWindow(scroller: React.RefObject<HTMLDivElement | null>): { left: number; width: number; userScrolledAt: React.RefObject<number> } {
  const [view, setView] = useState({ left: 0, width: 0 });
  const userScrolledAt = useRef(Number.NEGATIVE_INFINITY);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setView((previous) => (previous.left === element.scrollLeft && previous.width === element.clientWidth ? previous : { left: element.scrollLeft, width: element.clientWidth }));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    const userScroll = () => (userScrolledAt.current = performance.now());
    update();
    element.addEventListener("scroll", schedule, { passive: true });
    for (const type of ["wheel", "touchstart", "pointerdown"] as const) element.addEventListener(type, userScroll, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", schedule);
      for (const type of ["wheel", "touchstart", "pointerdown"] as const) element.removeEventListener(type, userScroll);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scroller]);
  return { ...view, userScrolledAt };
}

function Timeline({
  analysis,
  lanes,
  pps,
  span,
  player,
  selected,
  reveal,
  onWord,
}: {
  analysis: Analysis;
  lanes: readonly Lane[];
  pps: number;
  span: number;
  player: Player;
  selected: number | null;
  reveal: { time: number; nonce: number } | null;
  onWord: (lane: number, word: number, region: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const { left, width, userScrolledAt } = useScrollWindow(scroller);
  const [focus, setFocus] = useState<{ lane: number; word: number } | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const contentWidth = Math.ceil(span * pps) + LANE_PAD_PX * 2;
  const from = Math.max(0, (left - OVERSCAN_PX - LANE_PAD_PX) / pps);
  const to = (left + Math.max(width, 320) + OVERSCAN_PX) / pps;
  const region = selected === null ? null : analysis.regions[selected];

  // Keep the time under the same spot of the view when the zoom changes.
  const previousPps = useRef(pps);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null || previousPps.current === pps) return;
    const centre = (element.scrollLeft + element.clientWidth / 2 - LANE_PAD_PX) / previousPps.current;
    previousPps.current = pps;
    element.scrollLeft = Math.max(0, centre * pps + LANE_PAD_PX - element.clientWidth / 2);
  }, [pps]);

  const scrollToTime = useCallback(
    (time: number, smooth: boolean) => {
      const element = scroller.current;
      if (element === null) return;
      const target = Math.max(0, time * pps + LANE_PAD_PX - element.clientWidth * 0.25);
      // A glide across more than two screens only blurs past words; jump there instead.
      const near = Math.abs(target - element.scrollLeft) < element.clientWidth * 2;
      element.scrollTo({ left: target, behavior: smooth && near && !reducedMotion() ? "smooth" : "auto" });
    },
    [pps],
  );

  useEffect(() => {
    if (reveal === null || reveal.time < 0) return;
    const element = scroller.current;
    if (element === null) return;
    const x = reveal.time * pps + LANE_PAD_PX;
    if (x < element.scrollLeft + 24 || x > element.scrollLeft + element.clientWidth * 0.8) scrollToTime(reveal.time, true);
    // Only a new request scrolls; a zoom keeps the view where the user is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  // The playhead moves every frame without re-rendering the lanes; playback pages the view along.
  const playing = player.playing;
  useLayoutEffect(() => {
    const place = (time: number) => {
      const line = playhead.current;
      if (line !== null) line.style.transform = `translateX(${time * pps + LANE_PAD_PX - 4.5}px)`;
      const element = scroller.current;
      if (element === null || !playing || performance.now() - userScrolledAt.current < USER_SCROLL_HOLD_MS) return;
      const x = time * pps + LANE_PAD_PX;
      if (x < element.scrollLeft || x > element.scrollLeft + element.clientWidth * 0.85) element.scrollLeft = Math.max(0, x - element.clientWidth * 0.15);
    };
    place(player.now());
    return player.subscribe(place);
  }, [player, pps, playing, userScrolledAt]);

  useEffect(() => {
    const key = pendingFocus.current;
    if (key === null) return;
    const target = scroller.current?.querySelector<HTMLElement>(`[data-word="${key}"]`);
    if (target) {
      pendingFocus.current = null;
      target.focus({ preventScroll: true });
    }
  });

  const moveFocus = (lane: number, word: number) => {
    const place = lanes[lane].places[word];
    if (place === null) return;
    setFocus({ lane, word });
    pendingFocus.current = `${lane}:${word}`;
    const element = scroller.current;
    if (element !== null) {
      const x0 = place.start * pps + LANE_PAD_PX;
      const x1 = place.end * pps + LANE_PAD_PX;
      if (x0 < element.scrollLeft + 8 || x1 > element.scrollLeft + element.clientWidth - 8) element.scrollLeft = Math.max(0, x0 - element.clientWidth * 0.3);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = (event.target as HTMLElement).dataset.word;
    if (key === undefined) return;
    const [laneAt, word] = key.split(":").map(Number);
    const lane = lanes[laneAt];
    const position = lane.order.order.indexOf(word);
    let next: { lane: number; word: number } | null = null;
    if (event.key === "ArrowRight" && position + 1 < lane.order.order.length) next = { lane: laneAt, word: lane.order.order[position + 1] };
    else if (event.key === "ArrowLeft" && position > 0) next = { lane: laneAt, word: lane.order.order[position - 1] };
    else if (event.key === "Home") next = { lane: laneAt, word: lane.order.order[0] };
    else if (event.key === "End") next = { lane: laneAt, word: lane.order.order[lane.order.order.length - 1] };
    else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && lane.places[word] !== null) {
      const other = laneAt + (event.key === "ArrowDown" ? 1 : -1);
      if (other >= 0 && other < lanes.length) {
        const nearest = nearestWord(lanes[other], lane.places[word]!.start);
        if (nearest !== null) next = { lane: other, word: nearest };
      }
    }
    if (next === null) return;
    event.preventDefault();
    moveFocus(next.lane, next.word);
  };

  const current = player.playing || player.time > 0 ? player.time : null;
  const step = tickStep(pps);
  const ticks: number[] = [];
  for (let tick = Math.floor(from / step) * step; tick <= Math.min(to, span) + 1e-9; tick += step) ticks.push(Number(tick.toFixed(3)));
  // Words cut by the right edge fade out, so they read as "more this way" rather than as clipped text.
  const more = width > 0 && left + width < contentWidth - 1;
  const fade = `linear-gradient(to right, #000 calc(100% - ${EDGE_FADE_PX}px), transparent)`;
  const edgeFade: CSSProperties | undefined = more ? { maskImage: fade, WebkitMaskImage: fade } : undefined;

  return (
    <div
      ref={scroller}
      className="relative min-w-0 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:thin]"
      style={edgeFade}
      onKeyDown={onKeyDown}
    >
      <div className="relative" style={{ width: contentWidth }}>
        <Ruler ticks={ticks} step={step} pps={pps} span={span} player={player} />
        <div className="flex flex-col gap-1.5 pt-1">
          {lanes.map((lane, position) => (
            <LaneRow
              key={lane.index}
              lane={lane}
              position={position}
              analysis={analysis}
              pps={pps}
              from={from}
              to={to}
              viewWidth={width}
              left={left}
              current={current}
              region={region}
              selected={selected}
              focus={focus?.lane === position ? focus.word : null}
              onWord={onWord}
            />
          ))}
        </div>
        <div
          ref={playhead}
          aria-hidden
          className="pointer-events-none absolute bottom-0 left-0 top-0 z-[3] w-[9px]"
          style={{ transform: `translateX(${LANE_PAD_PX - 4.5}px)` }}
        >
          <span className="absolute inset-y-0 left-[4px] w-px bg-foreground/80" />
          <span className="absolute left-0 top-0 size-0 border-x-[4.5px] border-t-[5px] border-x-transparent border-t-foreground/80" />
        </div>
      </div>
    </div>
  );
}

function nearestWord(lane: Lane, time: number): number | null {
  const [first, last] = visibleSlice(lane.order, time - 5, time + 5);
  let best: number | null = null;
  let distance = Infinity;
  for (let position = Math.max(0, first - 1); position < Math.min(lane.order.order.length, last + 1); position++) {
    const word = lane.order.order[position];
    const gap = Math.abs(lane.places[word]!.start - time);
    if (gap < distance) {
      distance = gap;
      best = word;
    }
  }
  return best ?? lane.order.order[0] ?? null;
}

/** The time axis; also a slider: press or drag on it to move the playhead, arrows step a second. */
function Ruler({ ticks, step, pps, span, player }: { ticks: readonly number[]; step: number; pps: number; span: number; player: Player }) {
  const dragging = useRef(false);
  const timeAt = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(span, (event.clientX - rect.left - LANE_PAD_PX) / pps));
  };
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Position in the recording"
      aria-valuemin={0}
      aria-valuemax={Math.round(span * 10) / 10}
      aria-valuenow={player.time}
      aria-valuetext={formatClock(player.time)}
      className={cn("relative h-5 cursor-pointer touch-none select-none border-b border-border", FOCUS_RING)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        player.seek(timeAt(event), false);
      }}
      onPointerMove={(event) => {
        if (dragging.current) player.seek(timeAt(event), false);
      }}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      onKeyDown={(event) => {
        const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (delta !== 0) {
          event.preventDefault();
          player.seek(player.now() + delta * (event.shiftKey ? 5 : 1), false);
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          player.seek(event.key === "Home" ? 0 : span, false);
        }
      }}
    >
      {ticks.map((tick) => (
        <span
          key={tick}
          aria-hidden
          className="absolute bottom-0 h-full border-l border-border/70 pl-1 text-[10.5px] leading-4 tabular-nums text-muted-foreground"
          style={{ left: tick * pps + LANE_PAD_PX }}
        >
          {formatClock(tick, step < 1)}
        </span>
      ))}
    </div>
  );
}

const LaneRow = memo(function LaneRow({
  lane,
  position,
  analysis,
  pps,
  from,
  to,
  viewWidth,
  left,
  current,
  region,
  selected,
  focus,
  onWord,
}: {
  lane: Lane;
  position: number;
  analysis: Analysis;
  pps: number;
  from: number;
  to: number;
  viewWidth: number;
  left: number;
  current: number | null;
  region: Region | null;
  selected: number | null;
  focus: number | null;
  onWord: (lane: number, word: number, region: number) => void;
}) {
  const { track, comparison } = lane;
  const [first, last] = visibleSlice(lane.order, from, to);
  const shown = lane.order.order.slice(first, last);
  const tabStop = focus !== null && lane.places[focus] !== null ? focus : (shown.find((word) => lane.places[word]!.end >= left / pps) ?? shown[0] ?? null);
  const hasSpeakers = lane.turns.length > 0;
  const labelId = `lane-${position}-${analysis.tracks.length}`;
  const inRegion = (word: number) => {
    if (region === null) return false;
    if (lane.index === 0) return region.ref !== null && word >= region.ref[0] && word <= region.ref[1];
    return region.track === lane.index && region.hyp !== null && word >= region.hyp[0] && word <= region.hyp[1];
  };
  return (
    <div role="group" aria-labelledby={labelId} className="relative">
      <div className="h-[18px]">
        <span
          id={labelId}
          className="sticky left-0 z-[4] inline-flex max-w-full items-baseline gap-1.5 whitespace-nowrap bg-background pr-2 text-[11px] leading-[18px]"
          style={{ left: 0, maxWidth: Math.max(160, viewWidth - 8) }}
        >
          <span className="truncate font-medium text-foreground">{track.name}</span>
          {comparison === null ? (
            <span className="shrink-0 text-muted-foreground">{lane.index === 0 ? "reference" : ""}</span>
          ) : comparison.wer === null ? null : (
            <span className="shrink-0 tabular-nums text-muted-foreground">WER {formatWer(comparison.wer)}</span>
          )}
          {track.detail === null ? null : <span className="hidden truncate text-muted-foreground @md:inline">· {track.detail}</span>}
          {lane.note === null ? null : <span className="truncate text-muted-foreground">· {lane.note}</span>}
        </span>
      </div>
      <div className="relative h-[26px]">
        {lane.ghosts.map((ghost) =>
          ghost.end < from || ghost.start > to ? null : (
            <span
              key={`ghost-${ghost.region}`}
              aria-hidden
              title={`Missing: ${ghost.text}`}
              className={cn(
                "absolute top-[1px] z-0 h-6 overflow-hidden whitespace-nowrap rounded-[4px] px-[3px] text-[12px] leading-[22px] text-destructive/80 line-through decoration-destructive/60",
                selected === ghost.region && "outline outline-2 outline-offset-1 outline-destructive",
              )}
              style={{ ...MISSING_STYLE, left: ghost.start * pps + LANE_PAD_PX, width: Math.max(6, (ghost.end - ghost.start) * pps - 2) }}
            >
              {ghost.text}
            </span>
          ),
        )}
        {shown.map((word, offset) => {
          const place = lane.places[word]!;
          const status = comparison === null ? "ok" : comparison.hypStatus[word];
          const wrongSpeaker = comparison !== null && comparison.speakerWrong[word];
          const regionIndex = lane.regionOf[word];
          const active = current !== null && current >= place.start && current < place.end;
          // A box spans the word's own time, widened into the silence after it when its text needs the room,
          // and always stops before the next word starts: recognisers' overlapping times never draw one word over another.
          const next = lane.order.order[first + offset + 1];
          const room = (next === undefined ? place.end : lane.places[next]!.start) - place.start;
          const needed = measureWord(lane.track.words[word].text) + WORD_PADDING_PX;
          const width = Math.max(4, Math.min(room * pps - WORD_GAP_PX, Math.max((place.end - place.start) * pps - WORD_GAP_PX, needed)));
          return (
            <WordBox
              key={word}
              laneAt={position}
              lane={lane}
              word={word}
              place={place}
              width={width}
              truncated={needed > width}
              status={status}
              wrongSpeaker={wrongSpeaker}
              regionIndex={regionIndex}
              analysis={analysis}
              pps={pps}
              active={active}
              chosen={inRegion(word)}
              tabStop={tabStop === word}
              onWord={onWord}
            />
          );
        })}
      </div>
      {hasSpeakers ? (
        <div aria-hidden className="relative h-[15px]">
          {lane.turns.map((turn, index) =>
            turn.end < from || turn.start > to ? null : (
              <span
                key={index}
                className="absolute top-[2px] flex h-[13px] flex-col overflow-hidden"
                style={{ left: turn.start * pps + LANE_PAD_PX, width: Math.max(3, (turn.end - turn.start) * pps - 2) }}
              >
                <span
                  className="h-[3px] w-full shrink-0 rounded-full"
                  style={{
                    background: turn.wrong ? `repeating-linear-gradient(135deg, ${turn.color} 0 3px, transparent 3px 5px)` : turn.color,
                    opacity: turn.wrong ? 1 : 0.7,
                  }}
                />
                <span className={cn("truncate text-[10px] leading-[10px]", turn.wrong ? "font-medium text-foreground" : "text-muted-foreground")}>{turn.speaker}</span>
              </span>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
});

function wordLabel(lane: Lane, word: number, analysis: Analysis, place: Placed): string {
  const { track, comparison } = lane;
  const item = track.words[word];
  const parts = [item.text, place.basis === "aligned" ? `under ${formatClock(place.start)}, untimed` : formatClock(place.start)];
  if (place.basis === "segment") parts.push("time estimated within its segment");
  if (comparison !== null) {
    const status = comparison.hypStatus[word];
    const paired = comparison.pairedRef[word];
    if (status === "sub") {
      const region = lane.regionOf[word] >= 0 ? analysis.regions[lane.regionOf[word]] : null;
      parts.push(`misheard: reference says “${region !== null && region.kind !== "speaker" ? region.refText : paired === null ? "" : analysis.reference.words[paired].text}”`);
    } else if (status === "ins") parts.push("extra: not in the reference");
    if (comparison.speakerWrong[word] && item.speaker !== null) {
      const expected = paired === null ? null : analysis.reference.words[paired].speaker;
      parts.push(`given to ${item.speaker}${expected === null ? "" : `, said by ${expected}`}`);
    } else if (item.speaker !== null) parts.push(item.speaker);
  } else if (item.speaker !== null) parts.push(item.speaker);
  if (item.confidence !== null) parts.push(`confidence ${Math.round(item.confidence * 100)}%`);
  return parts.join(", ");
}

function WordBox({
  laneAt,
  lane,
  word,
  place,
  width,
  truncated,
  status,
  wrongSpeaker,
  regionIndex,
  analysis,
  pps,
  active,
  chosen,
  tabStop,
  onWord,
}: {
  laneAt: number;
  lane: Lane;
  word: number;
  place: Placed;
  width: number;
  /** Its text is wider than its room: shown with an ellipsis, in full on hover and focus. */
  truncated: boolean;
  status: "ok" | "sub" | "ins";
  wrongSpeaker: boolean;
  regionIndex: number;
  analysis: Analysis;
  pps: number;
  active: boolean;
  chosen: boolean;
  tabStop: boolean;
  onWord: (lane: number, word: number, region: number) => void;
}) {
  const label = wordLabel(lane, word, analysis, place);
  const text = lane.track.words[word].text;
  const style: CSSProperties = {
    ...(status === "ok" ? null : ERROR_STYLE[status]),
    ...(wrongSpeaker ? { outline: SPEAKER_OUTLINE, outlineOffset: -1 } : null),
  };
  return (
    <span className="group/word absolute top-[1px] z-[1] h-6 focus-within:z-[5] hover:z-[5]" style={{ left: place.start * pps + LANE_PAD_PX, width }}>
      <button
        type="button"
        data-word={`${laneAt}:${word}`}
        tabIndex={tabStop ? 0 : -1}
        aria-label={label}
        title={label}
        onClick={() => onWord(lane.index, word, regionIndex)}
        className={cn(
          "block size-full cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap rounded-[4px] px-[3px] text-left text-[12px] leading-6 text-foreground transition-colors duration-100",
          status === "ok" && "hover:bg-state-hover",
          place.basis === "aligned" && "italic text-muted-foreground",
          place.basis === "segment" && "underline decoration-muted-foreground/50 decoration-dashed underline-offset-[3px]",
          active && "bg-foreground/10 ring-1 ring-foreground/50",
          chosen && "ring-2 ring-foreground/80",
          FOCUS_RING,
        )}
        style={style}
      >
        {text}
      </button>
      {truncated ? (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-full left-0 mb-0.5 hidden whitespace-nowrap rounded-md border border-border bg-background px-1.5 text-[11.5px] leading-[18px] text-foreground shadow-[0_4px_12px_rgb(0_0_0/0.08)] group-focus-within/word:block group-hover/word:block"
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}

// ——— Aligned text ———

function AlignedText({
  analysis,
  places,
  player,
  selected,
  reveal,
  onWord,
}: {
  analysis: Analysis;
  places: readonly (readonly (Placed | null)[] | null)[];
  player: Player;
  selected: number | null;
  reveal: { time: number; nonce: number } | null;
  onWord: (lane: number, word: number, region: number) => void;
}) {
  const cols = useMemo(() => alignedColumns(analysis), [analysis]);
  const [page, setPage] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const region = selected === null ? null : analysis.regions[selected];
  const comparisons = analysis.comparisons;
  const regionOf = useMemo(() => regionIndexes(analysis), [analysis]);
  const regionColumns = useMemo(() => {
    if (region === null) return new Set<number>();
    const set = new Set<number>();
    const slot = region.track - 1;
    cols.forEach((column, index) => {
      if (region.ref !== null && column.ref !== null && column.ref >= region.ref[0] && column.ref <= region.ref[1]) set.add(index);
      if (region.hyp !== null && column.hyp[slot]?.some((word) => word >= region.hyp![0] && word <= region.hyp![1])) set.add(index);
    });
    return set;
  }, [cols, region]);

  // Stepping to an error turns to its page, then scrolls its first column into view; once per request.
  const firstChosen = regionColumns.size === 0 ? null : Math.min(...regionColumns);
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (reveal === null || firstChosen === null || handled.current === reveal.nonce) return;
    const target = Math.floor(firstChosen / COLUMN_PAGE);
    if (target !== page) {
      setPage(target);
      return;
    }
    handled.current = reveal.nonce;
    container.current?.querySelector(`[data-column="${firstChosen}"]`)?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, page]);

  const current = player.playing || player.time > 0 ? player.time : null;
  const isCurrent = (lane: number, word: number) => {
    const place = places[lane]?.[word] ?? null;
    return current !== null && place !== null && current >= place.start && current < place.end;
  };
  const pages = Math.ceil(cols.length / COLUMN_PAGE);
  const from = page * COLUMN_PAGE;
  const to = Math.min(cols.length, from + COLUMN_PAGE);
  const turn = (next: number) => {
    setPage(next);
    container.current?.scrollIntoView({ block: "nearest" });
  };
  const names = analysis.tracks.map((track) => track.name);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {comparisons.length > 0 ? (
        <p className="m-0 text-[11px] leading-4 text-muted-foreground">
          Each column: {names.map((name, index) => `${index === 0 ? "" : index === names.length - 1 ? " then " : ", "}${name}`).join("")}, top to bottom.
        </p>
      ) : null}
      <div ref={container} className="flex min-w-0 flex-wrap gap-x-1 gap-y-2.5" aria-label="Aligned transcripts">
        {cols.slice(from, to).map((column, offset) => (
          <div
            key={from + offset}
            data-column={from + offset}
            className={cn("flex flex-col rounded-[4px] px-0.5", regionColumns.has(from + offset) && "bg-surface-recessed ring-1 ring-foreground/40")}
          >
            <TextWord
              text={column.ref === null ? null : analysis.reference.words[column.ref].text}
              style={null}
              active={column.ref !== null && isCurrent(0, column.ref)}
              onPress={column.ref === null ? null : () => onWord(0, column.ref!, -1)}
            />
            {comparisons.map((comparison, slot) => {
              const words = column.hyp[slot] ?? [];
              const track = analysis.tracks[comparison.track];
              if (words.length === 0) {
                const missing = column.ref !== null && comparison.refStatus[column.ref] === "del";
                return (
                  <span
                    key={slot}
                    className={cn("whitespace-nowrap rounded-[3px] px-[3px] text-[12.5px] leading-5", missing ? "text-destructive/80 line-through decoration-destructive/60" : "text-transparent")}
                    style={missing ? MISSING_STYLE : undefined}
                    aria-label={missing ? `${track.name} is missing ${analysis.reference.words[column.ref!].text}` : undefined}
                  >
                    {column.ref === null ? "·" : analysis.reference.words[column.ref].text}
                  </span>
                );
              }
              return (
                <span key={slot} className="flex gap-1">
                  {words.map((word) => {
                    const status = comparison.hypStatus[word];
                    const wrong = comparison.speakerWrong[word];
                    const regionIndex = regionOf[comparison.track][word];
                    return (
                      <TextWord
                        key={word}
                        text={track.words[word].text}
                        style={{ ...(status === "ok" ? null : ERROR_STYLE[status]), ...(wrong ? { outline: SPEAKER_OUTLINE, outlineOffset: -1 } : null) }}
                        active={isCurrent(comparison.track, word)}
                        onPress={() => onWord(comparison.track, word, regionIndex)}
                      />
                    );
                  })}
                </span>
              );
            })}
          </div>
        ))}
      </div>
      {pages > 1 ? (
        <div className="flex items-center gap-2 text-xs leading-5 tabular-nums text-muted-foreground">
          <button type="button" aria-label="Earlier words" disabled={page === 0} onClick={() => turn(page - 1)} className={ICON_BUTTON}>
            <Icon name="ChevronLeft" aria-hidden className="size-3.5" />
          </button>
          <span>
            Columns {(from + 1).toLocaleString("en-US")}–{to.toLocaleString("en-US")} of {cols.length.toLocaleString("en-US")}
          </span>
          <button type="button" aria-label="Later words" disabled={page >= pages - 1} onClick={() => turn(page + 1)} className={ICON_BUTTON}>
            <Icon name="ChevronRight" aria-hidden className="size-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function TextWord({ text, style, active, onPress }: { text: string | null; style: CSSProperties | null; active: boolean; onPress: (() => void) | null }) {
  const className = cn("whitespace-nowrap rounded-[3px] px-[3px] text-left text-[12.5px] leading-5 text-foreground", active && "bg-foreground/10 ring-1 ring-foreground/50");
  if (text === null) return <span className={cn(className, "text-muted-foreground/60")} aria-hidden>·</span>;
  if (onPress === null) return <span className={className} style={style ?? undefined}>{text}</span>;
  return (
    <button type="button" onClick={onPress} className={cn(className, "cursor-pointer hover:bg-state-hover", FOCUS_RING)} style={style ?? undefined}>
      {text}
    </button>
  );
}
