// The Decisions components: a Plan the user approves in one tap, a weighted
// Decision matrix and a three-point Estimate. The maths and the messages live
// in core/decisions.ts (shared with the markdown fallback); this file draws
// them and keeps what the user changes (checks, weights, edited numbers)
// with usePersistedState, so it survives BB remounting the row.
import { useContext, useEffect, useId, useState, type ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button as BaseButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  acceptEdits,
  applyEdits,
  decisionMessage,
  estimateTask,
  estimateTotals,
  estimateUnit,
  formatAmount,
  formatQuantity,
  formatWithUnit,
  leaderMargin,
  nudgeWeight,
  planMessage,
  planTotal,
  rankOptions,
  readDecision,
  readEstimate,
  readNumber,
  readPlan,
  round,
  weightMax,
  weightStep,
  type DecisionModel,
  type EstimateEdits,
  type PlanFile,
  type PlanStep,
  type Ranked,
  type Risk,
  type TaskEstimate,
} from "../../core/decisions";
import type { Value } from "../../core/types";
import { NodeKeyContext, questionClosed, sentFor, useAnswers, useUiRuntime } from "../runtime";
import { propsKey, usePersistedState } from "../usePersistedState";
import { formatNumber, TONE_PILL, type Props, type Tone } from "../values";
import { actionIntent, sendEffect } from "./action-logic";
import { niceScale } from "./chartMath";
import { CheckMark, ErrorLine } from "./display";
import { ActionGlyph, ActionHint, Button, ButtonGroup, CAPTION, FIELD, FOCUS_RING, InMessageLine, SentLine } from "./inputs";
import { RISE, useEntrance } from "./motion";
import { ICON_BUTTON, Panel, QuietLine, ShowAll } from "./projectKit";

/** Rows shown before "Show all N". */
const PLAN_ROWS = 20;
const ESTIMATE_ROWS = 25;
/** Title, bar and figures; the figures column has a fixed width so every bar shares one axis. */
const ESTIMATE_GRID = "grid min-w-0 grid-cols-[minmax(0,1fr)_8rem] gap-x-3 px-3 @lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_8rem]";

const RISK_TONE: Record<Risk, Tone> = { low: "good", medium: "warn", high: "bad" };
const RISK_LABEL: Record<Risk, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-1.5 py-px text-[11px] font-medium leading-4", TONE_PILL[tone])}>
      {children}
    </span>
  );
}

/** A path chip that opens the file in BB at its line (plain text where nothing can open files). */
function FileChip({ file }: { file: PlanFile }) {
  const { openFile } = useUiRuntime();
  const label = file.line === null ? file.path : `${file.path}:${file.line}`;
  const content = (
    <>
      <Icon name="FileText" aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </>
  );
  const shape = "inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-md bg-surface-recessed px-1.5 font-mono text-[11.5px] leading-4";
  if (openFile === null) {
    return (
      <span title={label} className={cn(shape, "text-muted-foreground")}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={`Open ${label}`}
      onClick={async () => {
        if (!(await openFile(file.path, file.line ?? undefined))) toast.error(`Couldn't open ${file.path}`);
      }}
      className={cn(shape, "cursor-pointer text-foreground transition-colors duration-150 hover:bg-state-hover", FOCUS_RING)}
    >
      {content}
    </button>
  );
}

/** A square checkbox drawn like Checklist's. */
function CheckBox({ checked, disabled, label, onToggle }: { checked: boolean; disabled: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "-m-1.5 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md disabled:cursor-default",
        FOCUS_RING,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-4 items-center justify-center rounded-[4px] border transition-colors duration-150",
          checked ? "border-transparent bg-primary text-primary-foreground" : "border-border bg-background",
          disabled && "opacity-70",
        )}
      >
        {checked ? <CheckMark className="size-3" /> : null}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Plan

interface PlanState {
  /** Checks the user changed, by step index; the rest follow `optional`. */
  readonly toggled: Readonly<Record<string, boolean>>;
}

const PLAN_INITIAL: PlanState = { toggled: {} };

/** Also reads states kept with the note field a Plan once had. */
function acceptPlanState(stored: unknown): PlanState | null {
  if (typeof stored !== "object" || stored === null || !("toggled" in stored)) return null;
  const { toggled } = stored;
  if (typeof toggled !== "object" || toggled === null || Array.isArray(toggled)) return null;
  return Object.values(toggled).every((value) => typeof value === "boolean") ? { toggled: toggled as Record<string, boolean> } : null;
}

function PlanRow({
  step,
  index,
  checked,
  frozen,
  onToggle,
}: {
  step: PlanStep;
  index: number;
  checked: boolean;
  frozen: boolean;
  onToggle: () => void;
}) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  return (
    <li ref={rise} className="flex min-w-0 gap-3 px-3 py-2.5">
      <div className="flex shrink-0 items-start gap-2.5 pt-px">
        <CheckBox
          checked={checked}
          disabled={frozen}
          label={`Step ${index + 1}: ${step.title}`}
          onToggle={onToggle}
        />
        <span aria-hidden className="w-4 text-right text-xs leading-5 tabular-nums text-muted-foreground">
          {index + 1}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <span
            className={cn(
              "min-w-0 flex-1 basis-48 text-sm font-medium leading-5 [overflow-wrap:anywhere]",
              checked ? "text-foreground" : "text-muted-foreground line-through decoration-muted-foreground/60",
            )}
          >
            {step.title}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {step.optional ? <Pill tone="neutral">Optional</Pill> : null}
            {step.risk === null ? null : <Pill tone={RISK_TONE[step.risk]}>{RISK_LABEL[step.risk]}</Pill>}
            {step.estimate === null ? null : (
              <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs leading-5 tabular-nums text-muted-foreground">
                <Icon name="Clock" aria-hidden className="size-3" />
                <span className="sr-only">Estimate </span>
                {step.amount === null ? step.estimate : formatQuantity(step.amount)}
              </span>
            )}
          </span>
        </div>
        {step.detail === null ? null : (
          <Markdown
            content={step.detail}
            className={cn("min-w-0 text-xs leading-5 text-muted-foreground [&_p]:m-0", !checked && "opacity-70")}
          />
        )}
        {step.files.length === 0 ? null : (
          <div className="flex min-w-0 flex-wrap gap-1 pt-0.5">
            {step.files.map((file, fileIndex) => (
              <FileChip key={fileIndex} file={file} />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The agent's plan, and one question: numbered steps with a checkbox each
 * (optional ones start unchecked), their files, risks and estimates, and an
 * Approve toggle that stages the approval (the steps kept and skipped) in
 * the user's message. Changing the steps after approving updates it; changes
 * in their own words go in the composer. Once sent (or the thread moved on)
 * the steps stay read-only and the footer is what was sent.
 */
export function Plan({ props }: { props: Props }) {
  const { superseded } = useUiRuntime();
  const { staged, sent, target, stage } = useAnswers();
  const question = useContext(NodeKeyContext);
  const read = readPlan(props.steps);
  const [state, setState] = usePersistedState(`${propsKey(props.steps ?? null)}:plan`, PLAN_INITIAL, acceptPlanState);
  const [sending, setSending] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const steps = read.error === null ? read.steps : [];
  const checked = steps.map((step, index) => state.toggled[String(index)] ?? !step.optional);
  const message = planMessage(steps, checked);
  const entry = staged.get(question);
  const closed = questionClosed(sent, question, superseded);
  // Approved, then the steps changed: the approval follows them (none left: nothing to approve).
  useEffect(() => {
    if (closed || entry === undefined || entry.text === message) return;
    void stage(question, message === "" ? null : { text: message, selection: true });
  }, [closed, entry, message, question, stage]);
  if (read.error !== null) return <ErrorLine message={read.error} />;
  if (steps.length === 0) return <QuietLine icon="ListTodo">No steps in this plan yet.</QuietLine>;
  const answered = sentFor(sent, question);
  const approved = entry !== undefined;
  const frozen = sending || closed;
  const selected = planTotal(steps, checked);
  const all = planTotal(steps, steps.map(() => true));
  const kept = checked.filter(Boolean).length;
  const risky = steps.filter((step, index) => checked[index] && step.risk === "high").length;
  const shown = showAll ? steps : steps.slice(0, PLAN_ROWS);
  const toggle = (index: number) =>
    setState((previous) => {
      const toggled = { ...previous.toggled };
      const next = !(previous.toggled[String(index)] ?? !steps[index].optional);
      // Back at its default, the step follows the spec again.
      if (next === !steps[index].optional) delete toggled[String(index)];
      else toggled[String(index)] = next;
      return { toggled };
    });
  const totalText =
    selected.total === null
      ? null
      : all.total !== null && kept < steps.length && formatQuantity(all.total) !== formatQuantity(selected.total)
        ? `${formatQuantity(selected.total)} of ${formatQuantity(all.total)}`
        : formatQuantity(selected.total);
  const approve = async () => {
    setSending(true);
    await stage(question, approved ? null : { text: message, selection: true });
    setSending(false);
  };
  return (
    <Panel
      label="Plan"
      header={
        <>
          <span className="font-medium text-foreground">Plan</span>
          <span className="tabular-nums">
            {kept === steps.length ? `${steps.length} ${steps.length === 1 ? "step" : "steps"}` : `${kept} of ${steps.length} steps`}
          </span>
          {risky > 0 ? <span className="text-destructive">{risky} high risk</span> : null}
          {totalText === null ? null : (
            <span className="ml-auto inline-flex items-center gap-1 pr-1.5 tabular-nums">
              <Icon name="Clock" aria-hidden className="size-3" />
              <span className="sr-only">Estimated total </span>
              <span className="font-medium text-foreground">{totalText}</span>
              {selected.unparsed > 0 ? <span>+ {selected.unparsed} unsized</span> : null}
            </span>
          )}
          {selected.mixed ? <span className="ml-auto pr-1.5">Estimates mix points and time</span> : null}
        </>
      }
    >
      <ol aria-label="Steps" className="m-0 flex min-w-0 list-none flex-col divide-y divide-border/60 p-0">
        {shown.map((step, index) => (
          <PlanRow key={index} step={step} index={index} checked={checked[index]} frozen={frozen} onToggle={() => toggle(index)} />
        ))}
      </ol>
      {shown.length < steps.length ? <ShowAll count={steps.length} noun="steps" onClick={() => setShowAll(true)} /> : null}
      {answered !== null ? (
        // The whole message, wrapped: it is the plan the agent will follow.
        <div className="border-t border-border px-3 py-2.5 [&_.truncate]:whitespace-normal [&_p]:items-start [&_svg]:mt-1">
          <SentLine text={answered.question !== null || answered.text === message ? answered.text : null} />
        </div>
      ) : closed ? null : (
        <div data-genui-question={question} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border px-3 py-3">
          {/* The caption beside it already quotes the approval. */}
          <ActionHint hint={actionIntent([{ kind: "action", type: "send", text: message }], { send: sendEffect(target, true, approved), shown: message }).hint}>
            <BaseButton
              type="button"
              size="sm"
              variant={approved ? "outline" : "default"}
              disabled={sending || message === ""}
              aria-busy={sending || undefined}
              aria-pressed={target === "direct" ? undefined : approved}
              onClick={() => void approve()}
              className={cn("w-fit max-w-full gap-1.5 text-[13px]", approved && "border-transparent bg-surface-recessed text-foreground ring-2 ring-[var(--color-timeline-accent,var(--primary))] ring-offset-1 ring-offset-background")}
            >
              {approved ? <Icon name="Check" aria-hidden className="size-3.5 shrink-0" /> : null}
              <span className="truncate">Approve</span>
              <ActionGlyph name="Sent" />
            </BaseButton>
          </ActionHint>
          {approved ? (
            <InMessageLine />
          ) : (
            <span aria-live="polite" className="min-w-0 flex-1 basis-56 text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">
              {message === "" ? "Check a step to approve." : message}
            </span>
          )}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Decision

/** A score cell's wash: the accent from faint (low) to strong (top of the scale). */
function scoreTint(score: number | null, scale: number): string | undefined {
  if (score === null) return undefined;
  const ratio = Math.min(1, Math.max(0, score / scale));
  return `color-mix(in oklch, var(--color-timeline-accent, var(--primary)) ${Math.round(4 + ratio * 34)}%, transparent)`;
}

function acceptWeights(count: number) {
  return (stored: unknown): number[] | null =>
    Array.isArray(stored) && stored.length === count && stored.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
      ? stored
      : null;
}

function WeightControl({
  name,
  weight,
  step,
  max,
  disabled,
  onChange,
}: {
  name: string;
  weight: number;
  step: number;
  max: number;
  disabled: boolean;
  onChange: (weight: number) => void;
}) {
  return (
    <div role="group" aria-label={`Weight of ${name}`} className="inline-flex h-7 shrink-0 items-center rounded-md border border-border bg-background">
      <button
        type="button"
        aria-label={`Lower weight of ${name}`}
        disabled={disabled || weight <= 0}
        onClick={() => onChange(nudgeWeight(weight, -1, step, max))}
        className={cn(ICON_BUTTON, "rounded-r-none disabled:opacity-40")}
      >
        <Icon name="Minus" aria-hidden className="size-3" />
      </button>
      <output aria-live="polite" className="min-w-7 px-0.5 text-center text-xs font-medium tabular-nums text-foreground">
        {round(weight, 4)}
      </output>
      <button
        type="button"
        aria-label={`Raise weight of ${name}`}
        disabled={disabled || weight >= max}
        onClick={() => onChange(nudgeWeight(weight, 1, step, max))}
        className={cn(ICON_BUTTON, "rounded-l-none disabled:opacity-40")}
      >
        <Icon name="Plus" aria-hidden className="size-3" />
      </button>
    </div>
  );
}

function ProsCons({ pros, cons, note }: { pros: readonly string[]; cons: readonly string[]; note: string | null }) {
  if (pros.length === 0 && cons.length === 0 && note === null) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs leading-4">
      {pros.map((pro, index) => (
        <span key={`p${index}`} className="flex min-w-0 gap-1.5">
          <span aria-hidden className="shrink-0 font-semibold text-success">+</span>
          <span className="sr-only">Pro: </span>
          <span className="min-w-0 text-foreground [overflow-wrap:anywhere]">{pro}</span>
        </span>
      ))}
      {cons.map((con, index) => (
        <span key={`c${index}`} className="flex min-w-0 gap-1.5">
          <span aria-hidden className="shrink-0 font-semibold text-destructive">−</span>
          <span className="sr-only">Con: </span>
          <span className="min-w-0 text-foreground [overflow-wrap:anywhere]">{con}</span>
        </span>
      ))}
      {note === null ? null : <span className="text-muted-foreground [overflow-wrap:anywhere]">{note}</span>}
    </div>
  );
}

function share(weight: number, sum: number): string {
  return sum > 0 ? `${Math.round((weight / sum) * 100)}%` : "0%";
}

/** One line on who leads: "BullMQ leads with 4.25 of 5, 0.25 ahead of SQS." */
function Verdict({ model, ranked }: { model: DecisionModel; ranked: readonly Ranked[] }) {
  const lead = leaderMargin(ranked);
  if (lead === null) return null;
  const leader = model.options[ranked[0].index];
  const score = `${formatNumber(ranked[0].total)} of ${model.scale}`;
  if (lead.tied.length > 0) {
    const names = [leader.name, ...lead.tied.map((index) => model.options[index].name)];
    return (
      <p className="m-0 text-sm leading-5 text-foreground">
        <span className="font-semibold">{names.slice(0, -1).join(", ")} and {names[names.length - 1]}</span> are tied at {score}.
      </p>
    );
  }
  return (
    <p className="m-0 text-sm leading-5 text-foreground">
      <span className="font-semibold">{leader.name}</span> leads with {score}
      {ranked.length > 1 ? (
        <>
          , <span className="tabular-nums">{formatNumber(lead.margin)}</span> ahead of {model.options[ranked[1].index].name}
        </>
      ) : null}
      .
    </p>
  );
}

/**
 * A weighted decision matrix: scores tinted by value, a weight stepper per
 * criterion (persisted), live weighted totals and the ranking, pros and cons
 * on demand, and one "Go with" choice per option: a single-select group
 * whose pick (with the user's weights, which it follows) goes into their
 * message. Below 32rem of width the matrix becomes one card per option,
 * best first.
 */
export function Decision({ props }: { props: Props }) {
  const { superseded } = useUiRuntime();
  const { sent } = useAnswers();
  const question = useContext(NodeKeyContext);
  const read = readDecision(props.options, props.criteria);
  const criteriaCount = read.ok ? read.model.criteria.length : 0;
  const initial = read.ok ? read.model.criteria.map((criterion) => criterion.weight) : [];
  const [weights, setWeights] = usePersistedState(
    `${propsKey([props.options ?? null, props.criteria ?? null])}:weights`,
    initial,
    acceptWeights(criteriaCount),
  );
  const [details, setDetails] = useState(false);
  if (!read.ok) return <ErrorLine message={read.error} />;
  const model = read.model;
  if (model.options.length === 0) return <QuietLine icon="Target">No options to compare yet.</QuietLine>;
  // While criteria stream in, the stored weights may be shorter: new ones take their spec weight.
  const current = model.criteria.map((criterion, index) => weights[index] ?? criterion.weight);
  const sum = current.reduce((total, weight) => total + weight, 0);
  const step = weightStep(initial);
  const max = weightMax(initial);
  const ranked = rankOptions(model, current);
  const rankOf = new Map(ranked.map((entry, position) => [entry.index, position]));
  const leader = ranked[0].index;
  const tiedLead = (leaderMargin(ranked)?.tied.length ?? 0) > 0;
  const frozen = questionClosed(sent, question, superseded);
  const changed = current.some((weight, index) => weight !== initial[index]);
  const hasDetails = model.options.some((option) => option.pros.length > 0 || option.cons.length > 0 || option.note !== null);
  const setWeight = (index: number, weight: number) =>
    setWeights((previous) => model.criteria.map((criterion, position) => (position === index ? weight : (previous[position] ?? criterion.weight))));
  const buttons = ranked.map((entry) => {
    const name = model.options[entry.index].name;
    const buttonProps: Props = {
      label: `Go with ${name}`,
      variant: entry.index === leader && !tiedLead ? "primary" : "secondary",
      action: [{ kind: "action", type: "send", text: decisionMessage(model, entry.index, current) }] satisfies Value[],
    };
    return { key: String(entry.index), props: buttonProps, element: <Button props={buttonProps} /> };
  });
  const weightCell = (index: number) => (
    <div className="flex items-center gap-2">
      <WeightControl
        name={model.criteria[index].name}
        weight={current[index]}
        step={step}
        max={max}
        disabled={frozen}
        onChange={(weight) => setWeight(index, weight)}
      />
      <span className="w-8 text-right text-[11px] tabular-nums text-muted-foreground">{share(current[index], sum)}</span>
    </div>
  );
  const scoreCell = (score: number | null) => (
    <span
      className="inline-flex h-6 min-w-8 items-center justify-center rounded-md px-1.5 text-xs font-medium tabular-nums text-foreground"
      style={{ background: scoreTint(score, model.scale) }}
    >
      {score === null ? <span className="text-muted-foreground">—</span> : formatAmount(score)}
    </span>
  );
  return (
    <Panel
      label="Decision"
      header={
        <>
          <span className="font-medium text-foreground">Decision</span>
          <span className="tabular-nums">
            {model.options.length} options · {model.criteria.length} {model.criteria.length === 1 ? "criterion" : "criteria"} · scores 0–{model.scale}
          </span>
          {changed && !frozen ? (
            <button
              type="button"
              onClick={() => setWeights(initial)}
              className={cn("ml-auto inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground", FOCUS_RING)}
            >
              <Icon name="RotateCcw" aria-hidden className="size-3" />
              Reset weights
            </button>
          ) : null}
        </>
      }
    >
      <div className="@container flex min-w-0 flex-col gap-3 px-3 py-3">
        <Verdict model={model} ranked={ranked} />
        {/* Wide: criteria as rows (weights at hand), options as columns in the given order. */}
        <div className="hidden min-w-0 overflow-x-auto @lg:block">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th scope="col" className="pb-2 pr-3 text-left font-normal">
                  Criterion
                </th>
                <th scope="col" className="pb-2 pr-3 text-left font-normal">
                  Weight
                </th>
                {model.options.map((option, index) => (
                  <th key={index} scope="col" className="max-w-40 px-1.5 pb-2 text-center align-bottom font-medium text-foreground">
                    <span className="flex flex-col items-center gap-1">
                      {index === leader && !tiedLead ? <Pill tone="info">Leads</Pill> : null}
                      <span className="[overflow-wrap:anywhere]">{option.name}</span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.criteria.map((criterion, criterionIndex) => (
                <tr key={criterionIndex} className="border-t border-border/60">
                  <th scope="row" className="max-w-56 py-1.5 pr-3 text-left align-middle font-normal">
                    <span className="block text-sm leading-5 text-foreground">{criterion.name}</span>
                    {criterion.note === null ? null : <span className="block text-xs leading-4 text-muted-foreground">{criterion.note}</span>}
                  </th>
                  <td className="py-1.5 pr-3 align-middle">{weightCell(criterionIndex)}</td>
                  {model.options.map((option, index) => (
                    <td key={index} className="px-1.5 py-1.5 text-center align-middle">
                      {scoreCell(option.scores[criterionIndex])}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-t border-border">
                <th scope="row" colSpan={2} className="py-2 pr-3 text-left align-middle text-xs font-normal text-muted-foreground">
                  Weighted score
                </th>
                {model.options.map((option, index) => {
                  const entry = ranked[rankOf.get(index) ?? 0];
                  return (
                    <td key={index} className="px-1.5 py-2 text-center align-middle">
                      <span className="flex flex-col items-center gap-0.5">
                        <span className={cn("text-[15px] font-semibold tabular-nums leading-5", index === leader ? "text-foreground" : "text-muted-foreground")}>
                          {formatNumber(entry.total)}
                        </span>
                        <span className="text-[11px] tabular-nums text-muted-foreground">#{(rankOf.get(index) ?? 0) + 1}</span>
                      </span>
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
        {details ? (
          <ul aria-label="Pros and cons" className="m-0 hidden min-w-0 list-none grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-2 p-0 @lg:grid">
            {model.options.map((option, index) => (
              <li key={index} className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-surface-recessed px-3 py-2.5">
                <span className="text-xs font-medium leading-4 text-foreground">{option.name}</span>
                <ProsCons pros={option.pros} cons={option.cons} note={option.note} />
              </li>
            ))}
          </ul>
        ) : null}
        {/* Narrow: the weights, then one card per option, best first. */}
        <div className="flex min-w-0 flex-col gap-3 @lg:hidden">
          <div className="flex min-w-0 flex-col gap-1">
            <span className={CAPTION}>Weights</span>
            {model.criteria.map((criterion, index) => (
              <div key={index} className="flex min-w-0 items-center justify-between gap-3">
                <span className="min-w-0 text-sm leading-5 text-foreground [overflow-wrap:anywhere]">
                  {criterion.name}
                  {criterion.note === null ? null : <span className="block text-xs leading-4 text-muted-foreground">{criterion.note}</span>}
                </span>
                {weightCell(index)}
              </div>
            ))}
          </div>
          <ol aria-label="Ranking" className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
            {ranked.map((entry, position) => {
              const option = model.options[entry.index];
              return (
                <li key={entry.index} className="flex min-w-0 flex-col gap-2 rounded-lg bg-surface-recessed px-3 py-2.5">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="text-xs tabular-nums text-muted-foreground">#{position + 1}</span>
                    <span className="min-w-0 flex-1 text-sm font-medium leading-5 text-foreground [overflow-wrap:anywhere]">{option.name}</span>
                    {entry.index === leader && !tiedLead ? <Pill tone="info">Leads</Pill> : null}
                    <span className="text-[15px] font-semibold tabular-nums text-foreground">{formatNumber(entry.total)}</span>
                  </div>
                  <div aria-hidden className="h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-[var(--color-timeline-accent,var(--primary))] transition-[width] duration-300 motion-reduce:transition-none"
                      style={{ width: `${(entry.total / model.scale) * 100}%` }}
                    />
                  </div>
                  <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
                    {model.criteria.map((criterion, index) => (
                      <div key={index} className="contents">
                        <dt className="min-w-0 truncate text-xs leading-6 text-muted-foreground">{criterion.name}</dt>
                        <dd className="m-0">{scoreCell(option.scores[index])}</dd>
                      </div>
                    ))}
                  </dl>
                  {details ? <ProsCons pros={option.pros} cons={option.cons} note={option.note} /> : null}
                </li>
              );
            })}
          </ol>
        </div>
        {hasDetails ? (
          <button
            type="button"
            aria-expanded={details}
            onClick={() => setDetails((open) => !open)}
            className={cn("-ml-1.5 inline-flex w-fit cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground", FOCUS_RING)}
          >
            <Icon name={details ? "ChevronDown" : "ChevronRight"} aria-hidden className="size-3.5" />
            {details ? "Hide pros and cons" : "Show pros and cons"}
          </button>
        ) : null}
        {model.issues.slice(0, 5).map((issue, index) => (
          <QuietLine key={index} icon="AlertTriangle">
            {issue}
          </QuietLine>
        ))}
        <ButtonGroup buttons={buttons} question={question} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Estimate

function NumberField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: number | null;
  placeholder?: string;
  onChange: (value: number | null) => void;
}) {
  const id = useId();
  // Kept as typed ("2." mid-entry) and parsed on every change.
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <label htmlFor={id} className="text-[11px] leading-4 text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={draft}
        placeholder={placeholder}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          setDraft(raw);
          onChange(raw.trim() === "" ? null : readNumber(raw.replace(",", ".")));
        }}
        className={cn(FIELD, "h-7 w-[4.5rem] px-2 tabular-nums placeholder:text-muted-foreground/60")}
      />
    </span>
  );
}

/** A range bar on the shared axis [0, max]: low–high, the likely value as a tick, the PERT mean as a dot. */
function RangeBar({ estimate, max }: { estimate: TaskEstimate; max: number }) {
  const { low, high } = estimate.task;
  if (estimate.error !== null || low === null || high === null || max <= 0) return <div className="h-4" />;
  const at = (value: number) => `${(value / max) * 100}%`;
  return (
    <div aria-hidden className="relative h-4">
      <div className="absolute inset-x-0 top-1/2 h-px bg-border/70" />
      <div
        className="absolute top-1 h-2 rounded-full bg-[color-mix(in_oklch,var(--color-timeline-accent,var(--primary))_28%,transparent)] transition-[left,width] duration-300 motion-reduce:transition-none"
        style={{ left: at(low), width: `max(4px, ${((high - low) / max) * 100}%)` }}
      />
      <div
        className="absolute top-0 h-4 w-0.5 -translate-x-1/2 rounded-full bg-[var(--color-timeline-accent,var(--primary))] transition-[left] duration-300 motion-reduce:transition-none"
        style={{ left: at(estimate.likely) }}
      />
      <div
        className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background bg-foreground transition-[left] duration-300 motion-reduce:transition-none"
        style={{ left: at(estimate.mean) }}
      />
    </div>
  );
}

function EstimateRow({
  estimate,
  index,
  max,
  unit,
  edited,
  editing,
  onEdit,
  onChange,
}: {
  estimate: TaskEstimate;
  index: number;
  max: number;
  unit: string;
  edited: boolean;
  editing: boolean;
  onEdit: () => void;
  onChange: (field: "low" | "likely" | "high", value: number | null) => void;
}) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const { task } = estimate;
  const value = (number: number | null) => (number === null ? "?" : formatAmount(number));
  return (
    <li ref={rise} className={cn(ESTIMATE_GRID, "items-center gap-y-1 py-2")}>
      <div className="flex min-w-0 flex-col">
        <span className="text-sm leading-5 text-foreground [overflow-wrap:anywhere]">
          {task.title}
          {edited ? <span className="ml-1.5 text-[11px] text-muted-foreground">edited</span> : null}
        </span>
        {estimate.error === null ? null : <span className="text-xs leading-4 text-destructive">Not counted: {estimate.error}</span>}
      </div>
      <div className="order-last col-span-2 min-w-0 @lg:order-none @lg:col-span-1">
        <RangeBar estimate={estimate} max={max} />
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <span className="flex flex-col items-end">
          <span className="text-sm font-medium leading-5 tabular-nums text-foreground">
            {estimate.error === null ? formatWithUnit(estimate.mean, unit) : "—"}
          </span>
          <span className="whitespace-nowrap text-[11px] leading-4 tabular-nums text-muted-foreground">
            <span className="sr-only">low, likely, high: </span>
            {value(task.low)} · {task.likely === null ? <span title="midpoint of low and high">({value(estimate.error === null ? estimate.likely : null)})</span> : value(task.likely)} · {value(task.high)}
          </span>
        </span>
        <button
          type="button"
          aria-label={`Edit ${task.title}`}
          aria-expanded={editing}
          onClick={onEdit}
          className={cn(ICON_BUTTON, editing && "bg-state-hover text-foreground")}
        >
          <Icon name="Edit" aria-hidden className="size-3.5" />
        </button>
      </div>
      {editing ? (
        <div className="order-last col-span-full flex flex-wrap items-end gap-2 pb-1 pt-1">
          <NumberField key={`l${index}`} label="Low" value={task.low} onChange={(next) => onChange("low", next)} />
          <NumberField key={`m${index}`} label="Likely" value={task.likely} placeholder="mid" onChange={(next) => onChange("likely", next)} />
          <NumberField key={`h${index}`} label="High" value={task.high} onChange={(next) => onChange("high", next)} />
          <span className="pb-1.5 text-xs text-muted-foreground">{unit}</span>
        </div>
      ) : null}
    </li>
  );
}

/** The total as a range Σlow–Σhigh with the mean and the P50/P80/P90 marks on it. */
function TotalRange({ low, high, marks, unit }: { low: number; high: number; marks: readonly { label: string; value: number }[]; unit: string }) {
  const span = high - low;
  const at = (value: number) => (span > 0 ? ((value - low) / span) * 100 : 50);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div aria-hidden className="relative mx-1 mt-4 h-2.5 rounded-full bg-[color-mix(in_oklch,var(--color-timeline-accent,var(--primary))_18%,transparent)]">
        {marks.map((mark) => (
          <span
            key={mark.label}
            className="absolute -top-0.5 h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-[var(--color-timeline-accent,var(--primary))] transition-[left] duration-300 motion-reduce:transition-none"
            style={{ left: `${at(mark.value)}%` }}
          />
        ))}
        {marks.map((mark, index) => (
          <span
            key={`${mark.label}-label`}
            className={cn(
              "absolute -top-4 whitespace-nowrap text-[10.5px] leading-3 text-muted-foreground transition-[left] duration-300 motion-reduce:transition-none",
              // The first label sits left of its mark and the last right of it, so close marks don't collide.
              index === 0 ? "-translate-x-full pr-1" : index === marks.length - 1 ? "pl-1" : "-translate-x-1/2",
            )}
            style={{ left: `${at(mark.value)}%` }}
          >
            {mark.label}
          </span>
        ))}
      </div>
      <div className="flex justify-between gap-3 text-[11px] tabular-nums text-muted-foreground">
        <span>{formatWithUnit(low, unit)} if all go well</span>
        <span>{formatWithUnit(high, unit)} if nothing does</span>
      </div>
    </div>
  );
}

/**
 * Three-point estimates: per task its low–high range on a shared axis with
 * the likely value marked and the PERT mean; the total's mean, P50, P80 and
 * P90 (normal approximation of summed PERT variances, see estimateTotals) and
 * its range. Low/likely/high are editable inline and the totals follow.
 */
export function Estimate({ props }: { props: Props }) {
  const read = readEstimate(props.tasks);
  const unit = estimateUnit(props.unit);
  const [edits, setEdits] = usePersistedState<EstimateEdits>(`${propsKey(props.tasks ?? null)}:estimate`, {}, acceptEdits);
  const [editing, setEditing] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  if (read.error !== null) return <ErrorLine message={read.error} />;
  if (read.tasks.length === 0) return <QuietLine icon="Clock">No tasks to estimate yet.</QuietLine>;
  const tasks = applyEdits(read.tasks, edits);
  const estimates = tasks.map(estimateTask);
  const totals = estimateTotals(estimates);
  const scale = niceScale(0, Math.max(0, ...estimates.flatMap((e) => (e.error === null ? [e.task.high ?? 0] : []))), 4, true);
  const shown = showAll ? estimates : estimates.slice(0, ESTIMATE_ROWS);
  const edited = Object.keys(edits).length > 0;
  const change = (index: number, field: "low" | "likely" | "high", value: number | null) =>
    setEdits((previous) => {
      const original = read.tasks[index][field];
      const edit = { ...previous[String(index)] };
      if (value === original) delete edit[field];
      else edit[field] = value;
      const next = { ...previous };
      if (Object.keys(edit).length === 0) delete next[String(index)];
      else next[String(index)] = edit;
      return next;
    });
  const metric = (label: string, value: number, strong = false) => (
    <div className="flex min-w-0 flex-col">
      <span className="text-xs leading-4 text-muted-foreground">{label}</span>
      <span className={cn("tabular-nums text-foreground", strong ? "text-xl font-semibold leading-7 tracking-[-0.02em]" : "text-[15px] font-medium leading-7")}>
        {formatWithUnit(value, unit)}
      </span>
    </div>
  );
  return (
    <Panel
      label="Estimate"
      header={
        <>
          <span className="font-medium text-foreground">Estimate</span>
          <span className="tabular-nums">
            {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
            {totals.excluded > 0 ? ` · ${totals.excluded} not counted` : ""}
          </span>
          {edited ? (
            <button
              type="button"
              onClick={() => {
                setEdits({});
                setEditing(null);
              }}
              className={cn("ml-auto inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground", FOCUS_RING)}
            >
              <Icon name="RotateCcw" aria-hidden className="size-3" />
              Reset edits
            </button>
          ) : null}
        </>
      }
    >
      <div className="@container min-w-0">
        {totals.count === 0 ? (
          <QuietLine icon="AlertTriangle" className="px-3 py-3">
            No task has a usable low and high yet.
          </QuietLine>
        ) : (
          <div className="flex min-w-0 flex-col gap-3 border-b border-border/60 px-3 py-3">
            <div aria-live="polite" className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-2 @md:grid-cols-4">
              {metric("Expected (PERT)", totals.mean, true)}
              {metric("P50", totals.p50)}
              {metric("P80", totals.p80)}
              {metric("P90", totals.p90)}
            </div>
            <TotalRange
              low={totals.low}
              high={totals.high}
              unit={unit}
              marks={[
                { label: "P50", value: totals.p50 },
                { label: "P80", value: totals.p80 },
                { label: "P90", value: totals.p90 },
              ]}
            />
          </div>
        )}
        <ol aria-label="Tasks" className="m-0 flex min-w-0 list-none flex-col p-0">
          <li aria-hidden className={cn(ESTIMATE_GRID, "pt-2")}>
            <span className="hidden @lg:block" />
            <div className="relative col-span-2 h-3.5 @lg:col-span-1">
              {scale.ticks.map((tick, index) => (
                <span
                  key={tick}
                  className={cn(
                    "absolute top-0 whitespace-nowrap text-[10.5px] leading-3 tabular-nums text-muted-foreground",
                    index === 0 ? "" : index === scale.ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2",
                  )}
                  style={{ left: `${(tick / scale.max) * 100}%` }}
                >
                  {formatAmount(tick)}
                  {index === scale.ticks.length - 1 ? ` ${unit}` : ""}
                </span>
              ))}
            </div>
            <span className="hidden @lg:block" />
          </li>
          {shown.map((estimate, index) => (
            <EstimateRow
              key={index}
              estimate={estimate}
              index={index}
              max={scale.max}
              unit={unit}
              edited={edits[String(index)] !== undefined}
              editing={editing === index}
              onEdit={() => setEditing((open) => (open === index ? null : index))}
              onChange={(field, value) => change(index, field, value)}
            />
          ))}
        </ol>
        {shown.length < estimates.length ? <ShowAll count={estimates.length} noun="tasks" onClick={() => setShowAll(true)} /> : null}
        <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="inline-block h-3 w-0.5 rounded-full bg-[var(--color-timeline-accent,var(--primary))]" />
            likely
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="inline-block size-1.5 rounded-full bg-foreground" />
            PERT mean (low + 4 × likely + high) / 6
          </span>
          <span>Totals assume independent tasks (normal approximation).</span>
        </p>
      </div>
    </Panel>
  );
}
