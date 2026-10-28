// Choosing: option cards (pictures or details), colour swatches, suggested
// follow-up questions, and a swipeable row of cards. The rules live in
// choose-logic.ts.
import {
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { Scalar } from "../../core/types";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { resolveIconName } from "../icons";
import { RenderNode } from "../render";
import { CardDepthContext, NodeKeyContext, sentFor, useAnswers, useUiRuntime } from "../runtime";
import { isBinding, list, nodes, optionalText, type Props } from "../values";
import { actionIntent, sendEffect, type SendEffect } from "./action-logic";
import { cardOptions, followUpPrompts, sameColor, swatchColors, togglePick, type CardOption } from "./choose-logic";
import { CheckMark, ErrorLine } from "./display";
import { ActionHint, CAPTION, InMessageLine, SentLine, useClosedChoices } from "./inputs";
import { useImageUrl, type ImageState } from "./media";
import { reducedMotion, RISE, useEntrance } from "./motion";
import { ExpandButton, useGroupPicture, ViewerGroup } from "./viewer";

/** Selectable tiles get an offset ring, so focus never reads as selection. */
const TILE_FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Arrow keys of a roving radio group: next or previous option, wrapping. */
const ROVING_KEYS: Readonly<Record<string, number>> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

/**
 * Keyboard for a radio group drawn as tiles: arrows move focus and pick, like
 * native radios. Returns the handler for the group element.
 */
function useRovingRadios(pick: (index: number) => void) {
  const group = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    const delta = ROVING_KEYS[event.key];
    const radios = Array.from(group.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
    const from = radios.indexOf(event.target as HTMLElement);
    if (delta === undefined || from < 0) return;
    event.preventDefault();
    const to = (from + delta + radios.length) % radios.length;
    radios[to]?.focus();
    pick(to);
  };
  return { group, onKeyDown };
}

// ── OptionCards ──────────────────────────────────────────────────────────────

/** An option's picture, read like every image through the runtime (files and the https proxy). */
function OptionPicture({ src, picture }: { src: string; picture: ImageState }) {
  const [decoded, setDecoded] = useState<{ readonly url: string; readonly ok: boolean } | null>(null);
  const url = picture.status === "ready" ? picture.url : null;
  const result = url !== null && decoded?.url === url ? decoded : null;
  const failed = picture.status === "failed" ? picture.error : result?.ok === false ? `Couldn't load ${src}` : null;
  return (
    <span className="relative block aspect-[4/3] w-full overflow-hidden bg-surface-recessed">
      {failed !== null ? (
        <span title={failed} className="absolute inset-0 flex items-center justify-center px-3 text-center text-xs text-muted-foreground">
          {picture.status === "failed" && picture.off ? "Web images are off" : "Image unavailable"}
        </span>
      ) : result === null ? (
        <span className="absolute inset-0 animate-pulse bg-muted/60 motion-reduce:animate-none" />
      ) : null}
      {url === null || failed !== null ? null : (
        <img
          src={url}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={() => setDecoded({ url, ok: true })}
          onError={() => setDecoded({ url, ok: false })}
          className={cn(
            "absolute inset-0 size-full object-cover transition-opacity duration-300 motion-reduce:transition-none",
            result?.ok ? "opacity-100" : "opacity-0",
          )}
        />
      )}
    </span>
  );
}

/** The radio dot or checkbox tick of a tile; `onImage` floats it over a picture. */
function SelectionMark({ checked, multiple, onImage }: { checked: boolean; multiple: boolean; onImage: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-[18px] shrink-0 items-center justify-center border transition-colors duration-150 motion-reduce:transition-none",
        multiple ? "rounded-[5px]" : "rounded-full",
        checked ? "border-transparent bg-primary text-primary-foreground" : "border-border bg-background",
        onImage && "absolute right-2 top-2 shadow-[0_1px_3px_rgb(0_0_0/0.25)]",
        onImage && !checked && "border-white/80 bg-black/20 backdrop-blur-sm",
      )}
    >
      {!checked ? null : multiple ? (
        <CheckMark className="size-3" />
      ) : (
        <span className="size-1.5 rounded-full bg-primary-foreground" />
      )}
    </span>
  );
}

function OptionCard({
  option,
  order,
  checked,
  multiple,
  tabIndex,
  onSelect,
}: {
  option: CardOption;
  order: number;
  checked: boolean;
  multiple: boolean;
  tabIndex: number;
  onSelect: () => void;
}) {
  const rise = useEntrance<HTMLDivElement>(RISE);
  const icon = option.icon === null ? null : resolveIconName(option.icon);
  const picture = useImageUrl(option.image);
  const view = useGroupPicture(
    order,
    picture.status === "ready" ? { url: picture.url, alt: option.title, caption: option.detail === null ? option.title : `${option.title} · ${option.detail}` } : null,
  );
  return (
    // The tile is the option's radio, so the picture's own full-size button sits beside it, over its corner.
    <div ref={rise} className="relative flex min-w-0 flex-col">
      <button
        type="button"
        role={multiple ? "checkbox" : "radio"}
        aria-checked={checked}
        tabIndex={tabIndex}
        onClick={onSelect}
        className={cn(
          "relative flex min-w-0 flex-1 cursor-pointer touch-manipulation flex-col overflow-hidden rounded-lg border bg-background text-left transition-[border-color,box-shadow,background-color] duration-150 motion-reduce:transition-none",
          TILE_FOCUS,
          checked
            ? "border-primary shadow-[0_0_0_1px_var(--primary)]"
            : "border-border hover:border-foreground/25 [@media(hover:hover)]:hover:bg-surface-recessed/50",
        )}
      >
        {option.image === null ? null : <OptionPicture src={option.image} picture={picture} />}
        <span className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5">
          {icon === null ? null : (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-recessed text-foreground">
              <Icon name={icon} aria-hidden className="size-4" />
            </span>
          )}
          <span className={cn("flex min-w-0 flex-1 flex-col gap-0.5", icon !== null && "self-center")}>
            <span className="text-sm font-medium leading-5 text-foreground [overflow-wrap:anywhere]">{option.title}</span>
            {option.detail === null ? null : (
              <span className="text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">{option.detail}</span>
            )}
          </span>
          {option.image === null ? <SelectionMark checked={checked} multiple={multiple} onImage={false} /> : null}
        </span>
        {option.image === null ? null : <SelectionMark checked={checked} multiple={multiple} onImage />}
      </button>
      {option.image === null || picture.status !== "ready" ? null : (
        <ExpandButton label={`View ${option.title} full size`} onOpen={view} className="left-2 top-2" />
      )}
    </div>
  );
}

/**
 * A grid of option tiles bound to a state: a scalar state picks one (radio
 * semantics), a list state picks several (checkboxes). Picture options are
 * small tiles, two to a phone row; text options are wider, one to a phone row.
 */
export function OptionCards({ props }: { props: Props }) {
  const { setValue } = useUiRuntime();
  const labelId = useId();
  const binding = props.value;
  const options = cardOptions(props.options) ?? [];
  const values: Scalar[] = options.map((option) => option.value);
  const multiple = isBinding(binding) && Array.isArray(binding.value);
  const picked = isBinding(binding) ? (multiple ? list(binding.value) : [binding.value]) : [];
  const { group, onKeyDown } = useRovingRadios((index) => {
    if (isBinding(binding) && !multiple) setValue(binding.name, values[index] ?? null);
  });
  if (!isBinding(binding)) return <ErrorLine message="OptionCards needs a $state binding" />;
  if (!Array.isArray(props.options)) return <ErrorLine message="OptionCards options must be a list" />;
  if (options.length === 0) return null;
  const label = optionalText(props.label);
  const selected = multiple ? -1 : values.findIndex((value) => value === binding.value);
  const pictured = options.some((option) => option.image !== null);
  const grid: CSSProperties = {
    gridTemplateColumns: pictured
      ? "repeat(auto-fill,minmax(min(9rem,100%),1fr))"
      : "repeat(auto-fit,minmax(min(12.5rem,100%),1fr))",
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label === null ? null : (
        <span id={labelId} className={CAPTION}>
          {label}
        </span>
      )}
      <ViewerGroup>
        <div
          ref={group}
          role={multiple ? "group" : "radiogroup"}
          aria-labelledby={label === null ? undefined : labelId}
          aria-label={label === null ? binding.name : undefined}
          onKeyDown={multiple ? undefined : onKeyDown}
          className="grid min-w-0 gap-2"
          style={grid}
        >
          {options.map((option, index) => (
            <OptionCard
              // Options are positional; the same value may repeat.
              key={index}
              option={option}
              order={index}
              checked={multiple ? picked.includes(option.value) : index === selected}
              multiple={multiple}
              // Roving focus for radios: Tab lands on the selected option, else the first.
              tabIndex={multiple || index === Math.max(0, selected) ? 0 : -1}
              onSelect={() => setValue(binding.name, multiple ? togglePick(picked, option.value, values) : option.value)}
            />
          ))}
        </div>
      </ViewerGroup>
    </div>
  );
}

// ── Swatches ─────────────────────────────────────────────────────────────────

/** CSS-wide keywords pass CSS.supports but name no colour. */
const CSS_WIDE_KEYWORD = /^(inherit|initial|unset|revert|revert-layer)$/i;

function isCssColor(value: string): boolean {
  return CSS.supports("color", value) && !CSS_WIDE_KEYWORD.test(value);
}

/**
 * Colour chips with name and value. Without a state it is a palette: a tap
 * copies the value. With a state it is a single-choice colour picker.
 */
export function Swatches({ props }: { props: Props }) {
  const { setValue, run } = useUiRuntime();
  const labelId = useId();
  const binding = props.value;
  const picker = isBinding(binding);
  const parsed = swatchColors(props.colors, isCssColor);
  const colors = parsed?.colors ?? [];
  const { group, onKeyDown } = useRovingRadios((index) => {
    if (picker && colors[index] !== undefined) setValue(binding.name, colors[index].value);
  });
  if (parsed === null) return <ErrorLine message="Swatches colors must be a list" />;
  if (props.value !== undefined && !picker) return <ErrorLine message="Swatches value must be a $state binding" />;
  const label = optionalText(props.label);
  const selected = picker ? colors.findIndex((color) => sameColor(binding.value, color.value)) : -1;
  const invalid =
    parsed.invalid.length === 0 ? null : (
      <ErrorLine message={`Not CSS colors: ${parsed.invalid.join(", ")}`} />
    );
  if (colors.length === 0) return invalid;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label === null ? null : (
        <span id={labelId} className={CAPTION}>
          {label}
        </span>
      )}
      <div
        ref={group}
        role={picker ? "radiogroup" : "group"}
        aria-labelledby={label === null ? undefined : labelId}
        aria-label={label === null ? (picker ? binding.name : "Colors") : undefined}
        onKeyDown={picker ? onKeyDown : undefined}
        className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(10.5rem,100%),1fr))] gap-2"
      >
        {colors.map((color, index) => {
          const checked = index === selected;
          const shown = color.name === null ? color.value : `${color.name}, ${color.value}`;
          return (
            <SwatchChip
              // Colours are positional; the same value may repeat.
              key={index}
              value={color.value}
              name={color.name}
              checked={checked}
              role={picker ? "radio" : undefined}
              tabIndex={picker ? (index === Math.max(0, selected) ? 0 : -1) : 0}
              ariaLabel={picker ? shown : `Copy ${shown}`}
              onClick={() =>
                picker
                  ? setValue(binding.name, color.value)
                  : run([{ kind: "action", type: "copy", text: color.value }])
              }
            />
          );
        })}
      </div>
      {invalid}
    </div>
  );
}

function SwatchChip({
  value,
  name,
  checked,
  role,
  tabIndex,
  ariaLabel,
  onClick,
}: {
  value: string;
  name: string | null;
  checked: boolean;
  role: "radio" | undefined;
  tabIndex: number;
  ariaLabel: string;
  onClick: () => void;
}) {
  const rise = useEntrance<HTMLButtonElement>(RISE);
  return (
    <button
      ref={rise}
      type="button"
      role={role}
      aria-checked={role === undefined ? undefined : checked}
      aria-label={ariaLabel}
      title={role === undefined ? `Copy ${value}` : value}
      tabIndex={tabIndex}
      onClick={onClick}
      className={cn(
        "group/swatch flex min-w-0 cursor-pointer touch-manipulation items-center gap-2.5 rounded-lg border bg-background p-1.5 pr-2.5 text-left transition-[border-color,box-shadow,background-color] duration-150 motion-reduce:transition-none",
        TILE_FOCUS,
        checked
          ? "border-primary shadow-[0_0_0_1px_var(--primary)]"
          : "border-border hover:border-foreground/25 [@media(hover:hover)]:hover:bg-surface-recessed/50",
      )}
    >
      <span
        aria-hidden
        className="relative flex size-9 shrink-0 items-center justify-center rounded-md ring-1 ring-inset ring-foreground/10"
        style={{ backgroundColor: value }}
      >
        {checked ? (
          <span className="flex size-5 items-center justify-center rounded-full bg-background text-foreground shadow-[0_1px_3px_rgb(0_0_0/0.25)]">
            <CheckMark className="size-3" />
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        {name === null ? null : (
          <span className="line-clamp-2 text-[13px] font-medium leading-5 text-foreground break-words hyphens-auto">{name}</span>
        )}
        <span
          className={cn(
            "truncate font-mono leading-4",
            name === null ? "text-xs text-foreground" : "text-[11px] text-muted-foreground",
          )}
        >
          {value}
        </span>
      </span>
      {role === undefined ? (
        <Icon
          name="Copy"
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/swatch:opacity-100 group-focus-visible/swatch:opacity-100 motion-reduce:transition-none"
        />
      ) : null}
    </button>
  );
}

// ── FollowUps ────────────────────────────────────────────────────────────────

/**
 * Suggested next questions as quiet rows, and one question: a tap puts the
 * prompt in the user's message (single-select: tap again to take it out,
 * another to switch). Like a ButtonGroup's choices, they fold away once sent
 * (leaving a "sent" line) or once the thread moved on.
 */
export function FollowUps({ props }: { props: Props }) {
  const { staged, sent, target, stage } = useAnswers();
  const question = useContext(NodeKeyContext);
  const { closed, gone } = useClosedChoices(question);
  const prompts = followUpPrompts(props.prompts);
  const answered = sentFor(sent, question, (text) => prompts.includes(text));
  if (gone) return answered === null ? null : <SentLine text={answered.text} />;
  if (prompts.length === 0) return null;
  const picked = staged.get(question)?.selection ?? null;
  return (
    <div data-genui-question={question} className="flex min-w-0 flex-col gap-2">
      <ul
        aria-label="Suggested follow-ups"
        inert={closed}
        className={cn(
          "m-0 flex min-w-0 list-none flex-col p-0 transition-opacity duration-200 ease-out motion-reduce:transition-none",
          closed && "opacity-0",
        )}
      >
        {prompts.map((prompt) => (
          <FollowUpRow
            key={prompt}
            prompt={prompt}
            pressed={picked === prompt}
            effect={sendEffect(target, !closed, picked === prompt)}
            onPick={() => void stage(question, picked === prompt ? null : { text: prompt, selection: prompt })}
          />
        ))}
      </ul>
      {picked !== null && !closed ? <InMessageLine /> : null}
    </div>
  );
}

function FollowUpRow({ prompt, pressed, effect, onPick }: { prompt: string; pressed: boolean; effect: SendEffect; onPick: () => void }) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  return (
    <li ref={rise} className="min-w-0 border-t border-border/70">
      <ActionHint hint={actionIntent([{ kind: "action", type: "send", text: prompt }], { send: effect, shown: prompt }).hint} align="end">
        <button
          type="button"
          aria-pressed={pressed}
          onClick={onPick}
          className={cn(
            "group/follow flex min-h-10 w-full min-w-0 cursor-pointer touch-manipulation items-center gap-3 rounded-sm py-2 text-left text-sm leading-5 transition-colors duration-150 hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default motion-reduce:transition-none",
            pressed ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{prompt}</span>
          {pressed ? (
            <CheckMark className="size-3.5 shrink-0 text-[var(--color-timeline-accent,var(--primary))]" />
          ) : (
            <Icon
              name="Sent"
              aria-hidden
              className="size-3.5 shrink-0 transition-transform duration-150 group-hover/follow:translate-x-0.5 motion-reduce:transition-none"
            />
          )}
        </button>
      </ActionHint>
    </li>
  );
}

// ── Carousel ─────────────────────────────────────────────────────────────────

/** The track's `gap-3`, which a scroll step adds to a slide's width. */
const SLIDE_GAP_PX = 12;

/** How far the hidden side of the row fades out. */
const EDGE_FADE = "1.75rem";

/**
 * A horizontal scroll-snap row of cards (each Card a tile), the next card
 * peeking. Swipe or trackpad on touch; arrow buttons where a pointer can
 * hover; ←/→, Home and End when the row has focus. Scrolling never renders:
 * only reaching or leaving an end does.
 */
export function Carousel({ props }: { props: Props }) {
  const depth = useContext(CardDepthContext);
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const children = nodes(props.children);
  const empty = children.length === 0;

  useLayoutEffect(() => {
    const element = scroller.current;
    const row = track.current;
    if (element === null || row === null) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const max = element.scrollWidth - element.clientWidth;
      const start = element.scrollLeft <= 1;
      const end = element.scrollLeft >= max - 1;
      setEdges((previous) => (previous.start === start && previous.end === end ? previous : { start, end }));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    element.addEventListener("scroll", schedule, { passive: true });
    // The row grows as cards stream in; the pane can resize.
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    observer.observe(row);
    return () => {
      element.removeEventListener("scroll", schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
    // Mounts with the first card: an empty carousel renders nothing to observe.
  }, [empty]);

  if (empty) return null;

  /** Scrolls by as many whole slides as fit (at least one); ±Infinity jumps to an end. */
  const page = (direction: number) => {
    const element = scroller.current;
    const slide = track.current?.firstElementChild;
    if (element === null || !(slide instanceof HTMLElement)) return;
    const behavior: ScrollBehavior = reducedMotion() ? "auto" : "smooth";
    if (!Number.isFinite(direction)) {
      element.scrollTo({ left: direction > 0 ? element.scrollWidth : 0, behavior });
      return;
    }
    const step = slide.offsetWidth + SLIDE_GAP_PX;
    const slides = Math.max(1, Math.floor((element.clientWidth + SLIDE_GAP_PX) / step));
    element.scrollBy({ left: direction * slides * step, behavior });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys inside a card (a field, a button) stay theirs.
    if (event.target !== event.currentTarget) return;
    const direction =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "End" ? Infinity : event.key === "Home" ? -Infinity : 0;
    if (direction === 0) return;
    event.preventDefault();
    page(direction);
  };

  const fade =
    edges.start && edges.end
      ? undefined
      : `linear-gradient(to right, transparent, #000 ${edges.start ? "0px" : EDGE_FADE}, #000 calc(100% - ${edges.end ? "0px" : EDGE_FADE}), transparent)`;
  // Directly in the UI's frame the row bleeds to the frame's edges, so cards
  // scroll out under its border instead of stopping at its padding.
  const bleed = depth === 1;

  return (
    <div className="group/carousel relative min-w-0">
      <div
        ref={scroller}
        role="region"
        aria-roledescription="carousel"
        aria-label="Cards"
        tabIndex={0}
        onKeyDown={onKeyDown}
        style={{ maskImage: fade, WebkitMaskImage: fade }}
        className={cn(
          "@container min-w-0 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-lg py-1 [scrollbar-width:none] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-scrollbar]:hidden",
          bleed && "-mx-4 scroll-px-4 px-4 sm:-mx-5 sm:scroll-px-5 sm:px-5",
        )}
      >
        <div ref={track} className="flex w-max items-stretch gap-3">
          <CardDepthContext value={Math.max(depth, 1)}>
            {children.map((child, index) => (
              <Slide key={child.key} index={index} count={children.length}>
                <RenderNode node={child} />
              </Slide>
            ))}
          </CardDepthContext>
        </div>
      </div>
      <CarouselArrow side="previous" hidden={edges.start} onClick={() => page(-1)} />
      <CarouselArrow side="next" hidden={edges.end} onClick={() => page(1)} />
    </div>
  );
}

function Slide({ index, count, children }: { index: number; count: number; children: ReactNode }) {
  const rise = useEntrance<HTMLDivElement>(RISE);
  return (
    <div
      ref={rise}
      role="group"
      aria-roledescription="slide"
      aria-label={`${index + 1} of ${count}`}
      className="flex w-[min(17rem,82cqw)] shrink-0 snap-start flex-col [&>section]:flex-1"
    >
      {children}
    </div>
  );
}

/** A round arrow over one end of the row; only where a pointer can hover, and only when that way has more. */
function CarouselArrow({ side, hidden, onClick }: { side: "previous" | "next"; hidden: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      // The focused row already scrolls with ← and →.
      tabIndex={-1}
      aria-label={side === "previous" ? "Previous cards" : "Next cards"}
      aria-hidden={hidden}
      onClick={onClick}
      className={cn(
        "absolute top-1/2 hidden size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-background text-foreground shadow-[0_2px_8px_rgb(0_0_0/0.12)] transition-opacity duration-150 hover:bg-surface-recessed motion-reduce:transition-none [@media(hover:hover)]:flex",
        side === "previous" ? "left-1" : "right-1",
        hidden
          ? "pointer-events-none opacity-0"
          : "opacity-0 group-focus-within/carousel:opacity-100 group-hover/carousel:opacity-100",
      )}
    >
      <Icon name={side === "previous" ? "ChevronLeft" : "ChevronRight"} aria-hidden className="size-4" />
    </button>
  );
}
