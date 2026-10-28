// Self-contained widgets: each keeps its own React state, nothing is bound
// to `$state`. The pure parts (clock math, quiz parsing and scoring, card
// order) live in widget-logic.ts.
import { useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CardDepthContext } from "../runtime";
import { finiteNumber, optionalText, type Props } from "../values";
import { CheckMark, ErrorLine } from "./display";
import { EASE_OUT_EXPO, FADE, useEntrance } from "./motion";
import {
  countdownSeconds,
  elapsedMs,
  formatClock,
  parseCards,
  parseQuestions,
  pauseClock,
  quizScore,
  reconcileOrder,
  remainingMs,
  shuffleOrder,
  startClock,
  STOPPED,
  type Clock,
  type Flashcard,
  type QuizQuestion,
} from "./widget-logic";

/** Outline buttons sit on the page color, as inputs.tsx's quiet buttons do. */
const QUIET = "bg-background";

/** Markdown inline in a control: no paragraph margins. */
const INLINE_MD = "min-w-0 [&_p]:m-0";

/** A cross drawn in currentColor, the companion of CheckMark. */
function XMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className}>
      <path
        d="M4.5 4.5l7 7m0-7l-7 7"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Timer ────────────────────────────────────────────────────────────────

/** Fast enough that the readout turns over within a fifth of a second. */
const TICK_MS = 200;

export function Timer({ props }: { props: Props }) {
  const [clock, setClock] = useState<Clock>(STOPPED);
  const [now, setNow] = useState(() => Date.now());
  const label = optionalText(props.label);
  const seconds = finiteNumber(props.seconds);
  const countdown = props.seconds !== undefined && props.seconds !== null;
  const totalMs = seconds === null ? 0 : seconds * 1000;
  const running = clock.startedAt !== null;

  useEffect(() => {
    if (clock.startedAt === null) return;
    // Every tick re-reads the wall clock, so throttled background intervals
    // only delay the repaint, never the time.
    const tick = () => {
      const time = Date.now();
      setNow(time);
      if (countdown && elapsedMs(clock, time) >= totalMs) {
        setClock({ banked: totalMs, startedAt: null });
      }
    };
    const interval = setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [clock, countdown, totalMs]);

  if (countdown && (seconds === null || seconds <= 0)) {
    return <ErrorLine message="Timer needs a positive number of seconds" />;
  }

  const elapsed = elapsedMs(clock, now);
  const remaining = remainingMs(clock, totalMs, now);
  const done = countdown && remaining === 0;
  const readout = countdown
    ? formatClock(countdownSeconds(remaining), totalMs >= 3_600_000)
    : formatClock(elapsed / 1000);
  const ratio = countdown ? Math.min(1, elapsed / totalMs) : 0;
  const name = label ?? (countdown ? "Countdown" : "Stopwatch");

  const toggle = () => {
    const time = Date.now();
    setNow(time);
    setClock(running ? pauseClock(clock, time) : startClock(clock, time));
  };

  return (
    <div role="group" aria-label={name} className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        {label === null ? null : (
          <span className="truncate text-xs leading-5 text-muted-foreground">{label}</span>
        )}
        <div
          role="timer"
          className={cn(
            "flex items-center gap-2 text-4xl font-semibold leading-10 tracking-[-0.02em] tabular-nums",
            done ? "text-success" : "text-foreground",
          )}
        >
          {done ? (
            <>
              <CheckMark className="size-8 shrink-0" />
              Done
            </>
          ) : (
            readout
          )}
        </div>
        <span aria-live="polite" className="sr-only">
          {done ? `${name} done` : ""}
        </span>
      </div>
      {countdown ? (
        <div aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full w-full origin-left rounded-full transition-transform ease-linear motion-reduce:transition-none",
              done ? "bg-success" : "bg-[var(--color-timeline-accent,var(--primary))]",
            )}
            style={{ transform: `scaleX(${ratio})`, transitionDuration: `${TICK_MS}ms` }}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {done ? null : (
          <Button type="button" size="sm" onClick={toggle} className="min-w-20">
            {running ? "Pause" : elapsed > 0 ? "Resume" : "Start"}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!running && elapsed === 0}
          onClick={() => {
            setNow(Date.now());
            setClock(STOPPED);
          }}
          className={QUIET}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}

// ── Quiz ─────────────────────────────────────────────────────────────────

function SkippedNote({ skipped }: { skipped: number }) {
  if (skipped === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {skipped === 1 ? "Skipped 1 invalid question" : `Skipped ${skipped} invalid questions`}
    </p>
  );
}

function QuizOption({
  option,
  index,
  question,
  pick,
  onPick,
}: {
  option: string;
  index: number;
  question: QuizQuestion;
  pick: number | null;
  onPick: (index: number) => void;
}) {
  const locked = pick !== null;
  const correct = locked && index === question.answer;
  const wrong = locked && index === pick && !correct;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={index === pick}
      aria-disabled={locked}
      onClick={(event) => {
        if (locked || (event.target as Element).closest("a") !== null) return;
        onPick(index);
      }}
      className={cn(
        "flex w-full min-w-0 items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-sm leading-5 transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        !locked && "cursor-pointer border-border bg-background text-foreground hover:bg-state-hover",
        correct && "border-success/40 bg-success/10 text-foreground",
        wrong && "border-destructive/35 bg-destructive/8 text-foreground",
        locked && !correct && !wrong && "cursor-default border-border bg-background text-muted-foreground",
      )}
    >
      <Markdown content={option} className={cn(INLINE_MD, "flex-1 text-sm")} />
      {correct ? <CheckMark className="mt-0.5 size-4 shrink-0 text-success" /> : null}
      {wrong ? <XMark className="mt-0.5 size-4 shrink-0 text-destructive" /> : null}
    </button>
  );
}

export function Quiz({ props }: { props: Props }) {
  const { questions, skipped } = parseQuestions(props.questions);
  const [position, setPosition] = useState(0);
  const [picks, setPicks] = useState<readonly (number | null)[]>([]);
  // Moving between questions replaces the focused button, so focus follows to the new view.
  const root = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const count = questions.length;
  const at = Math.min(position, count);

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    root.current?.focus({ preventScroll: true });
  }, [at]);

  if (count === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {skipped === 0 ? "No questions" : "No valid questions to show"}
      </p>
    );
  }

  const go = (next: number) => {
    moved.current = true;
    setPosition(Math.max(0, Math.min(count, next)));
  };

  if (at === count) {
    const score = quizScore(questions, picks);
    return (
      <div ref={root} tabIndex={-1} className="flex min-w-0 flex-col gap-3 outline-none">
        <div className="flex flex-col gap-1">
          <span className="text-xs leading-5 text-muted-foreground">Score</span>
          <p
            aria-live="polite"
            className="m-0 text-xl font-semibold leading-7 tracking-[-0.02em] tabular-nums text-foreground"
          >
            {score} of {count} correct
          </p>
        </div>
        <ol aria-label="Results" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {questions.map((question, index) => {
            const right = picks[index] === question.answer;
            return (
              <li
                key={index}
                aria-label={`Question ${index + 1}: ${right ? "correct" : "incorrect"}`}
                className={cn("size-2 rounded-full", right ? "bg-success" : "bg-destructive/70")}
              />
            );
          })}
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" className={QUIET} onClick={() => go(count - 1)}>
            Back
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setPicks([]);
              go(0);
            }}
          >
            Retry
          </Button>
        </div>
        <SkippedNote skipped={skipped} />
      </div>
    );
  }

  const question = questions[at]!;
  const pick = picks[at] ?? null;
  const last = at === count - 1;
  return (
    <div
      // A fresh region per question: revisiting an answered one does not re-announce it.
      key={at}
      ref={root}
      tabIndex={-1}
      role="group"
      aria-label={`Question ${at + 1} of ${count}`}
      className="flex min-w-0 flex-col gap-3 outline-none"
    >
      <span className="text-xs leading-5 tabular-nums text-muted-foreground">
        {at + 1} of {count}
      </span>
      <Markdown content={question.q} className={cn(INLINE_MD, "text-sm font-medium text-foreground")} />
      <div role="radiogroup" aria-label="Options" className="flex min-w-0 flex-col gap-1.5">
        {question.options.map((option, index) => (
          <QuizOption
            // Options are positional; the same text may repeat.
            key={index}
            option={option}
            index={index}
            question={question}
            pick={pick}
            onPick={(chosen) =>
              setPicks((previous) => {
                const next = [...previous];
                next[at] = chosen;
                return next;
              })
            }
          />
        ))}
      </div>
      {/* Out of flow, so the empty region adds no gap; present before the pick, so it is announced. */}
      <span aria-live="polite" className="sr-only">
        {pick === null ? "" : pick === question.answer ? "Correct" : "Incorrect"}
      </span>
      {pick === null ? null : (
        <div className="flex min-w-0 flex-col gap-1">
          {pick === question.answer ? (
            <span className="flex items-center gap-1.5 text-sm font-medium text-success">
              <CheckMark className="size-4 shrink-0" />
              Correct
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-sm font-medium text-destructive">
              <XMark className="size-4 shrink-0" />
              Incorrect
            </span>
          )}
          {question.why === null ? null : (
            <Markdown content={question.why} className={cn(INLINE_MD, "text-sm text-muted-foreground")} />
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={QUIET}
          disabled={at === 0}
          onClick={() => go(at - 1)}
        >
          Back
        </Button>
        <Button type="button" size="sm" disabled={pick === null} onClick={() => go(at + 1)}>
          {last ? "See score" : "Next"}
        </Button>
      </div>
      <SkippedNote skipped={skipped} />
    </div>
  );
}

// ── Flashcards ───────────────────────────────────────────────────────────

/** Standalone the card is framed; inside a Card it is a flat tile; inside a tile it lifts to the page color. */
function faceSurface(depth: number): string {
  if (depth === 0) return "border border-border bg-background";
  return depth === 1 ? "bg-surface-recessed" : "bg-background";
}

function FlipCard({
  card,
  flipped,
  from,
  onFlip,
}: {
  card: Flashcard;
  flipped: boolean;
  from: number;
  onFlip: () => void;
}) {
  // A card dealt by Previous/Next slides in a little from that side; a shuffled one fades in.
  const enter = useEntrance<HTMLDivElement>(
    from === 0
      ? FADE
      : {
          keyframes: [{ opacity: 0, transform: `translateX(${from}px)` }, { opacity: 1, transform: "none" }],
          duration: 320,
        },
  );
  const surface = faceSurface(useContext(CardDepthContext));
  const face = (side: "front" | "back") => {
    const hidden = (side === "back") !== flipped;
    return (
      <div
        inert={hidden}
        aria-hidden={hidden}
        className={cn(
          // Both faces share one grid cell, so the card is as tall as the taller face.
          "flex min-h-36 min-w-0 flex-col items-center justify-center rounded-xl px-5 py-6 text-center [grid-area:1/1]",
          "[-webkit-backface-visibility:hidden] [backface-visibility:hidden]",
          // Reduced motion: no turn, the faces crossfade instead.
          "motion-reduce:transition-opacity motion-reduce:duration-300",
          surface,
          side === "back" && "[transform:rotateY(180deg)] motion-reduce:[transform:none]",
          hidden && "motion-reduce:opacity-0",
        )}
      >
        <Markdown
          content={side === "front" ? card.front : card.back}
          className={cn(
            INLINE_MD,
            "max-w-full text-pretty text-foreground [overflow-wrap:anywhere]",
            side === "front" ? "text-[15px] font-medium leading-6" : "text-sm leading-5",
          )}
        />
      </div>
    );
  };
  return (
    <div ref={enter} className="[perspective:1400px]">
      <div
        role="button"
        tabIndex={0}
        aria-roledescription="flashcard"
        aria-pressed={flipped}
        onClick={(event) => {
          if ((event.target as Element).closest("a") === null) onFlip();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== " " && event.key !== "Enter")) return;
          event.preventDefault();
          onFlip();
        }}
        className={cn(
          "grid min-w-0 cursor-pointer rounded-xl [transform-style:preserve-3d] transition-transform duration-500",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "motion-reduce:transition-none motion-reduce:[transform:none]",
          flipped && "[transform:rotateY(180deg)]",
        )}
        style={{ transitionTimingFunction: EASE_OUT_EXPO }}
      >
        {face("front")}
        {face("back")}
      </div>
    </div>
  );
}

export function Flashcards({ props }: { props: Props }) {
  const cards = parseCards(props.cards);
  const [order, setOrder] = useState<readonly number[]>([]);
  const [position, setPosition] = useState(0);
  const [flipped, setFlipped] = useState(false);
  // Bumped per shuffle, so a reshuffled first card is dealt afresh, face up.
  const [deal, setDeal] = useState(0);
  const [from, setFrom] = useState(0);

  if (cards.length === 0) return <p className="text-xs text-muted-foreground">No cards</p>;

  // Cards may still be streaming in: the order follows the list as it grows.
  const sequence = reconcileOrder(order, cards.length);
  const at = Math.min(position, cards.length - 1);
  const cardIndex = sequence[at]!;

  const go = (next: number) => {
    if (next < 0 || next >= cards.length || next === at) return;
    setFrom(next > at ? 12 : -12);
    setPosition(next);
    setFlipped(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") go(at - 1);
    else if (event.key === "ArrowRight") go(at + 1);
    else return;
    event.preventDefault();
  };

  return (
    <div role="group" aria-label="Flashcards" onKeyDown={onKeyDown} className="flex min-w-0 flex-col gap-3">
      <FlipCard
        // A new card mounts face up instead of turning back and showing its answer.
        key={`${deal}:${cardIndex}`}
        card={cards[cardIndex]!}
        flipped={flipped}
        from={from}
        onFlip={() => setFlipped((value) => !value)}
      />
      <div className="flex min-w-0 items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={QUIET}
          disabled={cards.length < 2}
          onClick={() => {
            setOrder(shuffleOrder(sequence));
            setDeal((value) => value + 1);
            setFrom(0);
            setPosition(0);
            setFlipped(false);
          }}
        >
          Shuffle
        </Button>
        <span aria-live="polite" className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
          <span className="sr-only">Card </span>
          {at + 1} / {cards.length}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={QUIET}
          aria-keyshortcuts="ArrowLeft"
          disabled={at === 0}
          onClick={() => go(at - 1)}
        >
          Previous
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={QUIET}
          aria-keyshortcuts="ArrowRight"
          disabled={at === cards.length - 1}
          onClick={() => go(at + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
