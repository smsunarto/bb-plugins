import { createContext, useContext, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { Action, PropsOf, Value } from "../../core/types";
import { Button as BaseButton } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input as InputField } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider as SliderControl } from "@/components/ui/slider";
import { Select as SelectRoot, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { resolveIconName } from "../icons";
import { CardDepthContext, NodeKeyContext, questionClosed, sentFor, useAnswers, useUiRuntime } from "../runtime";
import {
  finiteNumber,
  formatNumber,
  isAction,
  isScalar,
  list,
  text,
  type Props,
} from "../values";
import { ACTION_GLYPHS, actionIntent, sendEffect } from "./action-logic";
// fields.tsx imports this module's field styles; Radio is only used at render time, so the cycle is safe.
import { Radio } from "./fields";
import { reducedMotion, useEntrance, type Entrance } from "./motion";
import { keepTyping } from "../keepTyping";

export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Text field and dropdown share one compact field shape. */
export const FIELD = cn(
  "h-8 w-full min-w-0 rounded-md border border-border bg-background text-[13px] text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-shadow duration-150",
  FOCUS_RING,
);

/** The small caption above a control. */
export const CAPTION = "text-xs leading-5 text-muted-foreground";

export function Slider({ props }: { props: PropsOf<"Slider"> }) {
  const { setValue } = useUiRuntime();
  const id = useId();
  const { value: binding, min } = props;
  const max = Math.max(min, props.max);
  // Integer bounds step by 1; fractional ranges get 100 stops.
  const step = props.step ?? (Number.isInteger(min) && Number.isInteger(max) ? 1 : (max - min) / 100);
  const current = finiteNumber(binding.value) ?? min;
  const label = props.label ?? null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex h-5 items-center justify-between gap-3 text-xs">
        <Label id={`${id}-label`} className="truncate text-xs font-normal leading-5 text-muted-foreground">
          {label}
        </Label>
        <span className="text-sm font-semibold leading-5 tabular-nums text-foreground">
          {formatNumber(current)}
        </span>
      </div>
      <SliderControl
        id={id}
        min={min}
        max={max}
        step={step}
        value={[current]}
        thumbLabel={label === null ? binding.name : undefined}
        thumbLabelledBy={label === null ? undefined : `${id}-label`}
        onValueChange={([next]) => {
          if (next !== undefined) setValue(binding.name, next);
        }}
        className="my-1.5"
      />
    </div>
  );
}

export function Toggle({ props }: { props: PropsOf<"Toggle"> }) {
  const { setValue } = useUiRuntime();
  const id = useId();
  const binding = props.value;
  const on = Boolean(binding.value);
  return (
    <div className="flex w-fit max-w-full items-center gap-2 self-start">
      <Switch id={id} checked={on} size="default" onCheckedChange={(next) => setValue(binding.name, next)} {...keepTyping} />
      <Label htmlFor={id} {...keepTyping} className="min-w-0 cursor-pointer truncate text-sm font-normal leading-5 text-foreground">
        {props.label}
      </Label>
    </div>
  );
}

/** Segments fit a few short labels; long or many options read better as Radio's vertical list. */
const SEGMENT_MAX_OPTIONS = 5;
const SEGMENT_MAX_LABEL = 24;
const SEGMENT_MAX_TOTAL = 60;

export function Choice({ props }: { props: PropsOf<"Choice"> }) {
  const { setValue } = useUiRuntime();
  const labelId = useId();
  const binding = props.value;
  const options = props.options;
  const labels = options.map((option) => (isScalar(option) ? String(option) : null));
  const fits =
    options.length <= SEGMENT_MAX_OPTIONS &&
    labels.every((text) => text !== null && text.length <= SEGMENT_MAX_LABEL) &&
    labels.join("").length <= SEGMENT_MAX_TOTAL;
  if (!fits) return <Radio props={props} />;
  const label = props.label ?? null;
  const scalars = options.filter(isScalar);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {label === null ? null : (
        <span id={labelId} className="text-xs leading-5 text-muted-foreground">
          {label}
        </span>
      )}
      <ToggleGroup
        type="single"
        aria-labelledby={label === null ? undefined : labelId}
        // Options are positional: the same value may repeat, and any scalar round-trips.
        value={String(scalars.findIndex((option) => option === binding.value))}
        onValueChange={(next) => {
          // A press on the chosen option would clear it; a choice keeps one.
          if (next !== "") setValue(binding.name, scalars[Number(next)] ?? null);
        }}
        className="w-fit max-w-full flex-wrap justify-start gap-0.5 rounded-lg bg-surface-recessed p-0.5"
      >
        {scalars.map((option, index) => (
          <ToggleGroupItem key={index} value={String(index)} {...keepTyping} className="h-7 min-w-0 px-3 text-[13px] font-normal data-[state=on]:font-medium">
            {option === null ? "None" : String(option)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

export function Input({ props }: { props: PropsOf<"Input"> }) {
  const { setValue } = useUiRuntime();
  const id = useId();
  const binding = props.value;
  const label = props.label ?? null;
  const placeholder = props.placeholder ?? null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label === null ? null : (
        <Label htmlFor={id} className={cn(CAPTION, "font-normal")}>
          {label}
        </Label>
      )}
      <InputField
        id={id}
        type="text"
        value={text(binding.value)}
        placeholder={placeholder ?? undefined}
        aria-label={label === null ? (placeholder ?? binding.name) : undefined}
        onChange={(event) => setValue(binding.name, event.currentTarget.value)}
        className="h-8 px-2.5 text-[13px] placeholder:text-subtle-foreground"
      />
    </div>
  );
}

/** BB's dropdown as a field; option values are positions, so any scalar round-trips. */
export function Select({ props }: { props: PropsOf<"Select"> }) {
  const { setValue } = useUiRuntime();
  const id = useId();
  const binding = props.value;
  const label = props.label ?? null;
  const options = props.options.filter(isScalar);
  const selected = options.findIndex((option) => option === binding.value);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label === null ? null : (
        <Label htmlFor={id} className={cn(CAPTION, "font-normal")}>
          {label}
        </Label>
      )}
      <SelectRoot value={selected < 0 ? "" : String(selected)} onValueChange={(next) => setValue(binding.name, options[Number(next)] ?? null)}>
        <SelectTrigger id={id} aria-label={label === null ? binding.name : undefined} className="h-8 min-w-0 pl-2.5 pr-2.5 text-[13px]">
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option, index) => (
              // Options are positional; the same value may repeat.
              <SelectItem key={index} value={String(index)}>
                {option === null ? "None" : String(option)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </SelectRoot>
    </div>
  );
}

/** Checkboxes over a list state: ticking adds the option (in option order), unticking removes it. */
export function Checklist({ props }: { props: PropsOf<"Checklist"> }) {
  const { setValue } = useUiRuntime();
  const labelId = useId();
  const binding = props.value;
  const label = props.label ?? null;
  const options = props.options.filter(isScalar);
  const picked = list(binding.value);
  const toggle = (option: Value) =>
    setValue(
      binding.name,
      picked.includes(option)
        ? picked.filter((value) => value !== option)
        : [
            ...options.filter((candidate) => candidate === option || picked.includes(candidate)),
            // Values the spec preset that are not options stay, after the options.
            ...picked.filter((value) => !options.some((candidate) => candidate === value)),
          ],
    );
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label === null ? null : (
        <span id={labelId} className={CAPTION}>
          {label}
        </span>
      )}
      <div
        role="group"
        aria-labelledby={label === null ? undefined : labelId}
        className="-mx-1.5 flex min-w-0 flex-col"
      >
        {options.map((option, index) => {
          const checked = picked.includes(option);
          const id = `${labelId}-${index}`;
          return (
            <div
              // Options are positional; the same value may repeat.
              key={index}
              className="flex w-fit max-w-full items-start gap-2 rounded-md px-1.5 py-1 transition-colors duration-150 hover:bg-surface-recessed"
            >
              <Checkbox id={id} checked={checked} onCheckedChange={() => toggle(option)} {...keepTyping} className="mt-0.5" />
              <Label htmlFor={id} {...keepTyping} className="min-w-0 cursor-pointer text-sm font-normal leading-5 text-foreground [overflow-wrap:anywhere]">
                {option === null ? "None" : String(option)}
              </Label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A button's part in its ButtonGroup: undefined outside every group; null
 * for a button that is not an open choice (links, copies, Set, or a closed
 * question); else whether it is the picked choice and how to toggle it.
 */
const ChoiceContext = createContext<{ readonly pressed: boolean; toggle(text: string): void } | null | undefined>(undefined);

/**
 * A Button wherever it appears: inside a ButtonGroup it is a plain button;
 * anywhere else (a Row cell, a Table cell, a Grid tile) it is a group of one,
 * so a choice button still toggles and folds away once answered.
 */
export function Button({ props }: { props: Props }) {
  const grouped = useContext(ChoiceContext) !== undefined;
  const key = useContext(NodeKeyContext);
  if (grouped) return <ButtonView props={props} />;
  return <ButtonGroup buttons={[{ key, props, element: <ButtonView props={props} /> }]} />;
}

function ButtonView({ props }: { props: Props }) {
  const { run } = useUiRuntime();
  const choice = useContext(ChoiceContext);
  // Inside a nested tile, buttons sit on a tinted surface beside siblings that
  // carry the same action: a filled button per tile is too loud.
  const nested = useContext(CardDepthContext) > 1;
  const [running, setRunning] = useState(false);
  const label = text(props.label);
  const actions: readonly Action[] = props.action === undefined ? [] : list(props.action).filter(isAction);
  const answers = answerTexts(props);
  // A choice stages its answer; its other actions (a Set beside the Send) run when it is picked.
  const picks = choice != null && answers.length > 0;
  const pressed = picks && choice.pressed;
  const filled = props.variant === "primary" && !nested;
  const destructive = props.variant === "destructive";
  const { target } = useAnswers();
  // The hint doesn't quote the label back, unless the button's width cuts it
  // off: measured as the pointer arrives or focus lands, before the hint opens.
  const labelRef = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  const measure = () => {
    const span = labelRef.current;
    if (span !== null) setClipped(span.scrollWidth > span.clientWidth);
  };
  // A button without an action answers with its own label.
  const intended: readonly Action[] = props.action === undefined ? [{ kind: "action", type: "send", text: label }] : actions;
  const { glyph, hint } = actionIntent(intended, {
    send: sendEffect(target, picks, pressed),
    shown: clipped ? undefined : label,
  });
  // The spec's icon says what the button is about, the glyph at its end what
  // pressing it does; a picked choice shows a check instead. An unknown name
  // draws nothing, and an action's glyph is never the spec's icon: it would
  // show twice, or promise another action.
  const named = props.icon === undefined ? null : resolveIconName(text(props.icon));
  const icon = pressed ? "Check" : named === null || ACTION_GLYPHS.has(named) ? null : named;
  const others = actions.filter((action) => action.type !== "send");
  return (
    <ActionHint hint={hint}>
      <BaseButton
        type="button"
        size="sm"
        variant={filled ? "default" : "outline"}
        disabled={running || (!picks && others.length === 0)}
        aria-busy={running || undefined}
        aria-pressed={picks ? pressed : undefined}
        onPointerEnter={measure}
        onFocus={measure}
        {...(picks ? keepTyping : undefined)}
        onClick={async () => {
          setRunning(true);
          try {
            if (!picks) await run(others);
            else {
              if (!pressed && others.length > 0) await run(others);
              choice.toggle(answers.join("\n"));
            }
          } finally {
            setRunning(false);
          }
        }}
        className={cn(
          "w-fit max-w-full gap-1.5 text-[13px]",
          !filled && "bg-background text-foreground",
          pressed && "ring-2 ring-[var(--color-timeline-accent,var(--primary))] ring-offset-1 ring-offset-background",
          pressed && !filled && "border-transparent bg-surface-recessed",
          destructive &&
            "border-destructive/40 text-destructive hover:bg-destructive/8 hover:text-destructive focus-visible:ring-destructive/60",
        )}
      >
        {icon === null ? null : <Icon name={icon} aria-hidden className="size-3.5 shrink-0" />}
        <span ref={labelRef} className="truncate">
          {label}
        </span>
        {glyph === null ? null : <ActionGlyph name={glyph} />}
      </BaseButton>
    </ActionHint>
  );
}

/** The glyph at the end of a control saying what pressing it does (action-logic.ts), quieter than its label. */
export function ActionGlyph({ name }: { name: string }) {
  return <Icon name={name} aria-hidden className="size-3.5 shrink-0 opacity-60" />;
}

/** How long the pointer rests on a control before its hint shows; a neighbour's then shows at once. */
const HINT_DELAY_MS = 300;

/** True under a HintProvider. */
const HintScope = createContext(false);

/** One tooltip provider for a block's hints (LiveUi), so moving to a neighbouring control doesn't wait again. */
export function HintProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={HINT_DELAY_MS}>
      <HintScope value={true}>{children}</HintScope>
    </TooltipProvider>
  );
}

/**
 * BB's tooltip with what pressing `children` does (actionIntent's hint), on
 * hover or keyboard focus. Without a hint it never opens but keeps the same
 * tree, so an action that changes with state doesn't remount a focused
 * control. Outside a HintProvider it brings its own.
 */
export function ActionHint({
  hint,
  align,
  children,
}: {
  hint: string | null;
  /** "end" over a full-width row, beside its glyph. */
  align?: "center" | "end";
  children: ReactElement;
}) {
  const scoped = useContext(HintScope);
  const [open, setOpen] = useState(false);
  const tooltip = (
    // The hint holds no controls: it closes as the pointer leaves, and clicks pass through to what it covers.
    <Tooltip open={open && hint !== null} onOpenChange={setOpen} disableHoverableContent>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {hint === null ? null : (
        <TooltipContent
          align={align}
          // The registry's fade and zoom, in and out, hold still when the system asks for reduced motion.
          className="pointer-events-none whitespace-pre-line motion-reduce:animate-none motion-reduce:data-[state=closed]:animate-none"
        >
          {hint}
        </TooltipContent>
      )}
    </Tooltip>
  );
  return scoped ? tooltip : <TooltipProvider delayDuration={HINT_DELAY_MS}>{tooltip}</TooltipProvider>;
}

/** A quiet confirmation of what this UI sent; `text` null reads just "Sent". */
export function SentLine({ text }: { text: string | null }) {
  const ref = useEntrance<HTMLParagraphElement>(SENT_ENTRANCE);
  return (
    <p
      ref={ref}
      role="status"
      title={text ?? undefined}
      className="m-0 flex min-w-0 items-center gap-1.5 text-[13px] leading-5 text-muted-foreground"
    >
      <Icon name="Check" aria-hidden className="size-3.5 shrink-0" />
      {text === null ? (
        "Sent"
      ) : (
        <>
          <span className="sr-only">You sent: </span>
          <span className="min-w-0 truncate">{text}</span>
        </>
      )}
    </p>
  );
}

/**
 * The one cue under a question whose answer is staged: it is in the user's
 * message, and goes when they send it. In the gallery, where it would go.
 */
export function InMessageLine() {
  const { target } = useAnswers();
  return (
    <p role="status" className="m-0 flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
      <Icon name="CornerDownRight" aria-hidden className="size-3.5 shrink-0" />
      {target === "gallery" ? "Would go in your message" : "In your message"}
    </p>
  );
}

const SENT_ENTRANCE: Entrance = { keyframes: [{ opacity: 0 }, { opacity: 1 }], duration: 240 };

/** How long answered choices fade before they leave the layout. */
const CHOICE_FADE_MS = 200;

/**
 * Whether `question` is closed (its answer was sent, or the thread moved on)
 * and, once its fade has run, gone. Choices closed before they mounted are
 * gone at once; ones closed on screen fade first.
 */
export function useClosedChoices(question: string): { closed: boolean; gone: boolean } {
  const { superseded } = useUiRuntime();
  const { sent } = useAnswers();
  const closed = questionClosed(sent, question, superseded);
  const [gone, setGone] = useState(closed);
  useEffect(() => {
    if (!closed) {
      setGone(false);
      return;
    }
    const timer = setTimeout(() => setGone(true), reducedMotion() ? 0 : CHOICE_FADE_MS);
    return () => clearTimeout(timer);
  }, [closed]);
  return { closed, gone };
}

export interface GroupedButton {
  readonly key: string;
  readonly props: Props;
  /** The rendered Button, as its parent wraps it. */
  readonly element: ReactNode;
}

/** A button's answer when picked: its Send actions' texts, or its own label when it has no action. */
function answerTexts(props: Props): string[] {
  if (props.action === undefined) return [text(props.label)];
  return list(props.action).flatMap((action) => (isAction(action) && action.type === "send" ? [action.text] : []));
}

/**
 * A run of consecutive Buttons: one wrapping row, and one question. Its
 * choice buttons (Send, or no action) are a single-select toggle: a pick
 * stages its answer in the user's message (useAnswers), picking it again
 * withdraws it, a sibling switches. Once the answer is sent they fold into
 * one line showing it, and once the thread moved on without one they leave.
 * Other buttons (links, copies, local state) run at once and stay.
 * `question` names it where the buttons' keys are not node keys.
 */
export function ButtonGroup({ buttons, question: given }: { buttons: readonly GroupedButton[]; question?: string }) {
  const { staged, sent, stage } = useAnswers();
  const question = given ?? `buttons:${buttons[0]?.key ?? ""}`;
  const texts = buttons.map(({ props }) => answerTexts(props));
  const choice = texts.map((answers) => answers.length > 0);
  const { closed, gone } = useClosedChoices(question);
  const answered = sentFor(sent, question, (answer) => texts.some((answers) => answers.includes(answer)));
  const entry = staged.get(question);
  const picked = entry === undefined ? -1 : buttons.findIndex((button) => button.key === entry.selection);
  const pickedText = picked === -1 ? null : texts[picked].join("\n");
  // A picked button whose Send reads state that changed since: its answer follows.
  useEffect(() => {
    if (closed || entry === undefined || pickedText === null || pickedText === entry.text) return;
    stage(question, { text: pickedText, selection: entry.selection });
  }, [closed, entry, pickedText, question, stage]);
  // The sent line shows beside the question it answered; other runs just fold away.
  const sentHere = answered !== null && gone;
  const shown = choice.some((isChoice) => !(isChoice && gone));
  if (!sentHere && !shown) return null;
  return (
    <div data-button-group="" data-genui-question={choice.some(Boolean) ? question : undefined} className="flex min-w-0 flex-col gap-2">
      {sentHere ? <SentLine text={answered.text} /> : null}
      {shown ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {buttons.map((button, index) => {
            const leaving = choice[index] && closed;
            if (leaving && gone) return null;
            const open = choice[index] && !closed;
            return (
              <div
                key={button.key}
                inert={leaving}
                className={cn(
                  "flex min-w-0 max-w-full transition-opacity duration-200 ease-out motion-reduce:transition-none",
                  leaving && "opacity-0",
                )}
              >
                <ChoiceContext
                  value={
                    open
                      ? {
                          pressed: index === picked,
                          toggle: (answer) => stage(question, index === picked ? null : { text: answer, selection: button.key }),
                        }
                      : null
                  }
                >
                  {button.element}
                </ChoiceContext>
              </div>
            );
          })}
        </div>
      ) : null}
      {entry !== undefined && !closed ? <InMessageLine /> : null}
    </div>
  );
}
