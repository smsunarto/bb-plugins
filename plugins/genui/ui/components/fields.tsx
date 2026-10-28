// Inputs beyond the basic set: a +/- stepper, a radio list with details, an
// editable string list, a growing text area, a date field and star ratings.
// Each writes its `$state` binding; the rules live in fieldLogic.ts.
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { Value } from "../../core/types";
import { Button as BaseButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useUiRuntime } from "../runtime";
import { ACCENT, isBinding, list, optionalText, text, type Props } from "../values";
import { ErrorLine } from "./display";
import {
  addItem,
  isoDate,
  itemProblem,
  itemText,
  radioOptions,
  ratingMax,
  ratingValue,
  replaceItem,
  starFill,
  stepBy,
  stepPrecision,
  stepRange,
  stepperValue,
} from "./fieldLogic";
import { CAPTION, FIELD, FOCUS_RING } from "./inputs";
import { RISE, useEntrance } from "./motion";

/** A 16px stroke glyph in currentColor; host icon names are not guaranteed. */
function Glyph({ d, className }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5", className)}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
}

const MINUS = "M3.5 8h9";
const PLUS = "M3.5 8h9M8 3.5v9";
const CROSS = "M4.5 4.5l7 7M11.5 4.5l-7 7";

// ── Stepper ──────────────────────────────────────────────────────────────────

/** Holding a button steps once, waits, then repeats. */
const HOLD_DELAY_MS = 400;
const HOLD_REPEAT_MS = 70;

/** Steps per key on the focused stepper; Home/End jump to the bounds. */
const STEPPER_KEYS: Readonly<Record<string, number>> = {
  ArrowUp: 1,
  ArrowRight: 1,
  ArrowDown: -1,
  ArrowLeft: -1,
  PageUp: 10,
  PageDown: -10,
  Home: -Infinity,
  End: Infinity,
};

const STEP_BUTTON =
  "flex h-full w-8 shrink-0 cursor-pointer touch-manipulation items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-surface-recessed hover:text-foreground focus-visible:outline-none disabled:pointer-events-none disabled:opacity-35";

export function Stepper({ props }: { props: Props }) {
  const { setValue } = useUiRuntime();
  const labelId = useId();
  const binding = props.value;
  const range = stepRange(props.min, props.max, props.step);
  const current = isBinding(binding) ? stepperValue(binding.value, range) : 0;
  // A held button steps faster than renders land, so it steps from here.
  const latest = useRef(current);
  const hold = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    latest.current = current;
  });
  useEffect(
    () => () => {
      clearTimeout(hold.current);
    },
    [],
  );
  if (!isBinding(binding)) return <ErrorLine message="Stepper needs a $state binding" />;
  const label = optionalText(props.label);
  const move = (count: number): boolean => {
    const next = stepBy(latest.current, count, range);
    if (next === latest.current) return false;
    latest.current = next;
    setValue(binding.name, next);
    return true;
  };
  const release = () => {
    clearTimeout(hold.current);
    hold.current = undefined;
  };
  const press = (count: number) => (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    // No focus theft from the value, no text selection while held.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    release();
    if (!move(count)) return;
    const repeat = () => {
      hold.current = move(count) ? window.setTimeout(repeat, HOLD_REPEAT_MS) : undefined;
    };
    hold.current = window.setTimeout(repeat, HOLD_DELAY_MS);
  };
  const buttonProps = (count: number) => ({
    type: "button" as const,
    tabIndex: -1,
    onPointerDown: press(count),
    onLostPointerCapture: release,
    // Pointer presses step on pointerdown; this is keyboard or assistive activation.
    onClick: (event: { detail: number }) => {
      if (event.detail === 0) move(count);
    },
  });
  const onKeyDown = (event: KeyboardEvent) => {
    const count = STEPPER_KEYS[event.key];
    if (count === undefined) return;
    event.preventDefault();
    move(count);
  };
  return (
    // Caption above the control, like the other fields, so a Row of fields lines up.
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      {label === null ? null : (
        <span id={labelId} className={CAPTION}>
          {label}
        </span>
      )}
      <div
        role="group"
        aria-labelledby={label === null ? undefined : labelId}
        aria-label={label === null ? binding.name : undefined}
        onKeyDown={onKeyDown}
        className="inline-flex h-8 shrink-0 select-none items-stretch overflow-hidden rounded-md border border-border bg-background shadow-[0_1px_2px_rgb(0_0_0/0.04)] [-webkit-touch-callout:none] has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring"
      >
        <button
          {...buttonProps(-1)}
          aria-label="Decrease"
          disabled={range.min !== null && current <= range.min}
          className={STEP_BUTTON}
        >
          <Glyph d={MINUS} />
        </button>
        <span
          role="spinbutton"
          tabIndex={0}
          aria-valuenow={current}
          aria-valuemin={range.min ?? undefined}
          aria-valuemax={range.max ?? undefined}
          aria-labelledby={label === null ? undefined : labelId}
          aria-label={label === null ? binding.name : undefined}
          className="flex min-w-10 items-center justify-center px-1.5 text-sm font-medium tabular-nums text-foreground focus-visible:outline-none"
        >
          {new Intl.NumberFormat("en-US", { maximumFractionDigits: stepPrecision(current, range) }).format(current)}
        </span>
        <button
          {...buttonProps(1)}
          aria-label="Increase"
          disabled={range.max !== null && current >= range.max}
          className={STEP_BUTTON}
        >
          <Glyph d={PLUS} />
        </button>
      </div>
    </div>
  );
}

// ── Radio ────────────────────────────────────────────────────────────────────

/** Radio-group arrow keys: next or previous option, wrapping. */
const RADIO_KEYS: Readonly<Record<string, number>> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

export function Radio({ props }: { props: Props }) {
  const { setValue } = useUiRuntime();
  const labelId = useId();
  const group = useRef<HTMLDivElement>(null);
  const binding = props.value;
  if (!isBinding(binding)) return <ErrorLine message="Radio needs a $state binding" />;
  const label = optionalText(props.label);
  const options = radioOptions(props.options);
  const selected = options.findIndex((option) => option.value === binding.value);
  // Roving focus: Tab lands on the selected option, else the first.
  const focusable = Math.max(0, selected);
  const onKeyDown = (event: KeyboardEvent) => {
    const delta = RADIO_KEYS[event.key];
    const radios = Array.from(group.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
    const from = radios.indexOf(event.target as HTMLElement);
    if (delta === undefined || from < 0) return;
    event.preventDefault();
    const to = (from + delta + radios.length) % radios.length;
    radios[to]?.focus();
    setValue(binding.name, options[to]?.value ?? null);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label === null ? null : (
        <span id={labelId} className={CAPTION}>
          {label}
        </span>
      )}
      <div
        ref={group}
        role="radiogroup"
        aria-labelledby={label === null ? undefined : labelId}
        aria-label={label === null ? binding.name : undefined}
        onKeyDown={onKeyDown}
        className="-mx-1.5 flex min-w-0 flex-col"
      >
        {options.map((option, index) => {
          const checked = index === selected;
          return (
            <button
              // Options are positional; the same value may repeat.
              key={index}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={index === focusable ? 0 : -1}
              onClick={() => setValue(binding.name, option.value)}
              className={cn(
                "flex w-full min-w-0 cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1.5 text-left text-sm leading-5 text-foreground transition-colors duration-150 hover:bg-surface-recessed",
                FOCUS_RING,
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-150",
                  checked ? "border-transparent bg-primary" : "border-border bg-background",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full bg-primary-foreground transition-transform duration-150 motion-reduce:transition-none",
                    checked ? "scale-100" : "scale-0",
                  )}
                />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="[overflow-wrap:anywhere]">{itemText(option.value)}</span>
                {option.detail === null ? null : (
                  <span className="text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">
                    {option.detail}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── ListEditor ───────────────────────────────────────────────────────────────

export function ListEditor({ props }: { props: Props }) {
  const { setValue } = useUiRuntime();
  const id = useId();
  const hintId = useId();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const binding = props.value;
  if (!isBinding(binding)) return <ErrorLine message="ListEditor needs a $state binding" />;
  const label = optionalText(props.label);
  const placeholder = optionalText(props.placeholder) ?? "Add an item";
  const items = list(binding.value);
  const problem = itemProblem(items, draft);
  const add = () => {
    const next = addItem(items, draft);
    if (next === null) return;
    setValue(binding.name, next);
    setDraft("");
  };
  const remove = (index: number) => {
    setValue(
      binding.name,
      items.filter((_, position) => position !== index),
    );
    setEditing(null);
    input.current?.focus();
  };
  const commit = (index: number, edited: string) => {
    const next = replaceItem(items, index, edited);
    if (next !== null) setValue(binding.name, next);
    setEditing(null);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label === null ? null : (
        <label htmlFor={id} className={CAPTION}>
          {label}
        </label>
      )}
      {items.length === 0 ? null : (
        <ul aria-label={label ?? binding.name} className="-mx-1 flex min-w-0 flex-col">
          {items.map((item, index) => (
            <ListEditorRow
              // Rows are positional; a preset list may repeat an entry.
              key={index}
              item={item}
              editing={editing === index}
              onEdit={() => setEditing(index)}
              onCommit={(edited) => commit(index, edited)}
              onRemove={() => remove(index)}
            />
          ))}
        </ul>
      )}
      <div className="flex min-w-0 items-center gap-2">
        <input
          id={id}
          ref={input}
          type="text"
          value={draft}
          placeholder={placeholder}
          enterKeyHint="done"
          aria-label={label === null ? placeholder : undefined}
          aria-describedby={problem === "duplicate" ? hintId : undefined}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            add();
          }}
          className={cn(FIELD, "px-2.5 placeholder:text-subtle-foreground")}
        />
        <BaseButton
          type="button"
          size="sm"
          variant="outline"
          disabled={problem !== null}
          onClick={add}
          className="shrink-0 bg-background"
        >
          Add
        </BaseButton>
      </div>
      {problem === "duplicate" ? (
        <p id={hintId} className="text-xs leading-4 text-muted-foreground">
          Already in the list
        </p>
      ) : null}
    </div>
  );
}

function ListEditorRow({
  item,
  editing,
  onEdit,
  onCommit,
  onRemove,
}: {
  item: Value;
  editing: boolean;
  onEdit: () => void;
  onCommit: (edited: string) => void;
  onRemove: () => void;
}) {
  const row = useEntrance<HTMLLIElement>(RISE);
  const itemButton = useRef<HTMLButtonElement>(null);
  // Finishing an edit from the keyboard returns focus to the item.
  const refocus = useRef(false);
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    itemButton.current?.focus();
  }, [editing]);
  const shown = itemText(item);
  return (
    <li ref={row} className="flex min-h-8 min-w-0 items-center gap-1">
      {editing ? (
        <input
          type="text"
          autoFocus
          defaultValue={shown}
          enterKeyHint="done"
          aria-label={`Edit ${shown}`}
          // Every exit (Enter, Escape, clicking away) commits on blur, once.
          onBlur={(event) => onCommit(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") event.currentTarget.value = shown;
            else if (event.key !== "Enter") return;
            event.preventDefault();
            refocus.current = true;
            event.currentTarget.blur();
          }}
          className={cn(FIELD, "h-7 flex-1 px-1.5 text-sm")}
        />
      ) : (
        <button
          ref={itemButton}
          type="button"
          onClick={onEdit}
          aria-label={`${shown}, edit`}
          className={cn(
            "min-w-0 flex-1 cursor-text rounded-md px-1.5 py-1 text-left text-sm leading-5 text-foreground transition-colors duration-150 [overflow-wrap:anywhere] hover:bg-surface-recessed",
            FOCUS_RING,
          )}
        >
          {shown}
        </button>
      )}
      <button
        type="button"
        aria-label={`Remove ${shown}`}
        onClick={onRemove}
        className={cn(
          "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-surface-recessed hover:text-foreground",
          FOCUS_RING,
        )}
      >
        <Glyph d={CROSS} className="size-3" />
      </button>
    </li>
  );
}

// ── TextArea ─────────────────────────────────────────────────────────────────

const TEXTAREA_MAX_ROWS = 12;

/** Grows the area to its content, from its 3 `rows` up to the max, then scrolls. */
function fitHeight(area: HTMLTextAreaElement) {
  area.style.height = "auto";
  const style = getComputedStyle(area);
  const borders = area.offsetHeight - area.clientHeight;
  const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const limit = (parseFloat(style.lineHeight) || 20) * TEXTAREA_MAX_ROWS + padding + borders;
  const content = area.scrollHeight + borders;
  area.style.height = `${Math.min(content, limit)}px`;
  area.style.overflowY = content > limit ? "auto" : "hidden";
}

export function TextArea({ props }: { props: Props }) {
  const { setValue } = useUiRuntime();
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const binding = props.value;
  const bound = isBinding(binding);
  const value = bound ? text(binding.value) : "";
  useLayoutEffect(() => {
    if (area.current !== null) fitHeight(area.current);
  }, [value]);
  // A narrower pane wraps more lines.
  useEffect(() => {
    const element = area.current;
    if (element === null) return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fitHeight(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [bound]);
  if (!isBinding(binding)) return <ErrorLine message="TextArea needs a $state binding" />;
  const label = optionalText(props.label);
  const placeholder = optionalText(props.placeholder);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label === null ? null : (
        <label htmlFor={id} className={CAPTION}>
          {label}
        </label>
      )}
      <textarea
        id={id}
        ref={area}
        rows={3}
        value={value}
        placeholder={placeholder ?? undefined}
        aria-label={label === null ? (placeholder ?? binding.name) : undefined}
        onChange={(event) => setValue(binding.name, event.currentTarget.value)}
        className={cn(
          FIELD,
          "block h-auto resize-none overflow-y-hidden px-2.5 py-1.5 leading-5 [scrollbar-width:thin] placeholder:text-subtle-foreground",
        )}
      />
    </div>
  );
}

// ── DateInput ────────────────────────────────────────────────────────────────

export function DateInput({ props }: { props: Props }) {
  const { setValue } = useUiRuntime();
  const id = useId();
  const binding = props.value;
  if (!isBinding(binding)) return <ErrorLine message="DateInput needs a $state binding" />;
  const label = optionalText(props.label);
  const date = isoDate(binding.value);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label === null ? null : (
        <label htmlFor={id} className={CAPTION}>
          {label}
        </label>
      )}
      <input
        id={id}
        type="date"
        value={date ?? ""}
        aria-label={label === null ? binding.name : undefined}
        onChange={(event) => setValue(binding.name, isoDate(event.currentTarget.value))}
        className={cn(
          FIELD,
          "max-w-52 px-2.5 tabular-nums [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-date-and-time-value]:text-left",
          date === null && "text-muted-foreground",
        )}
      />
    </div>
  );
}

// ── Rating ───────────────────────────────────────────────────────────────────

const STAR =
  "M12 3.2l2.6 5.3 5.8.85-4.2 4.1 1 5.8L12 16.5l-5.2 2.75 1-5.8-4.2-4.1 5.8-.85z";

/** Rating arrow keys: one star up or down. */
const RATING_KEYS: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };

/** An outlined star with the accent fill clipped to `fill` (0 to 1) of its width. */
function StarGlyph({ fill }: { fill: number }) {
  return (
    <span aria-hidden className="relative size-5">
      <svg viewBox="0 0 24 24" className="absolute inset-0 size-full text-muted-foreground">
        <path d={STAR} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
      {fill > 0 ? (
        <svg
          viewBox="0 0 24 24"
          className="absolute inset-0 size-full"
          style={fill < 1 ? { clipPath: `inset(0 ${(1 - fill) * 100}% 0 0)` } : undefined}
        >
          <path d={STAR} strokeWidth={1.5} strokeLinejoin="round" style={{ fill: ACCENT, stroke: ACCENT }} />
        </svg>
      ) : null}
    </span>
  );
}

export function Rating({ props }: { props: Props }) {
  const { setValue } = useUiRuntime();
  const labelId = useId();
  const group = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const binding = props.value;
  if (!isBinding(binding)) return <ErrorLine message="Rating needs a $state binding" />;
  const label = optionalText(props.label);
  const max = ratingMax(props.max);
  const value = ratingValue(binding.value, max);
  const shown = preview ?? value;
  // Roving focus: Tab lands on the current rating's star, else the first.
  const focusable = Math.min(max, Math.max(1, Math.round(value)));
  const stars = Array.from({ length: max }, (_, index) => index + 1);
  const onKeyDown = (event: KeyboardEvent) => {
    const delta = RATING_KEYS[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const next = Math.min(max, Math.max(0, Math.round(value) + delta));
    setValue(binding.name, next);
    group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[Math.max(1, next) - 1]?.focus();
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {label === null ? null : (
        <span id={labelId} className={CAPTION}>
          {label}
        </span>
      )}
      <div
        ref={group}
        role="radiogroup"
        aria-labelledby={label === null ? undefined : labelId}
        aria-label={label === null ? binding.name : undefined}
        onKeyDown={onKeyDown}
        onPointerLeave={() => setPreview(null)}
        className="-mx-1.5 flex w-fit max-w-full flex-wrap"
      >
        {stars.map((star) => (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={star === value}
            aria-label={star === 1 ? "1 star" : `${star} stars`}
            tabIndex={star === focusable ? 0 : -1}
            // Hover previews with a mouse only; on touch it would stick after the tap.
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") setPreview(star);
            }}
            onClick={() => {
              // Clicking the current rating clears it; drop the preview so the clear shows.
              setValue(binding.name, star === value ? 0 : star);
              setPreview(null);
            }}
            className={cn(
              "flex size-8 cursor-pointer items-center justify-center rounded-md transition-transform duration-150 active:scale-90 motion-reduce:transition-none motion-reduce:active:scale-100",
              FOCUS_RING,
            )}
          >
            <StarGlyph fill={starFill(shown, star)} />
          </button>
        ))}
      </div>
    </div>
  );
}
