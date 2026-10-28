// Which build or revision really reached the phone or the server: the chain
// from source to live (a row of stages on a wide reply, a timeline on a
// narrow one), each stage with its outcome and the facts it reported as
// chips. A fact that differs from what was requested, or from the stage
// before, is marked wrong with both values; the verdict on top says it in
// one line. Stages after the last receipt read "no receipt", never a pass.
// A stage opens to its detail, every fact (copyable) and its evidence: a
// log read through runtime.readText, a screenshot, a link.
import { useContext, useId, useMemo, useState, type CSSProperties } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  chainSummary,
  RECEIPT_LABEL,
  readProvenance,
  shortValue,
  STAGE_STATUS_LABEL,
  type Evidence,
  type Fact,
  type Provenance as Chain,
  type Stage,
  type VerdictTone,
} from "../../core/provenance";
import { formatElapsed } from "../../core/pipeline";
import { CardDepthContext, useUiRuntime } from "../runtime";
import { formatNumber, TONE_DOT, TONE_TEXT, type Props } from "../values";
import { CodeExcerpt, OpenFileButton, ReportFrame, TEXT_BUTTON, useFileOpener, useFileText } from "./codeHealthKit";
import { ErrorLine } from "./display";
import { FOCUS_RING } from "./inputs";
import { useImageUrl } from "./media";
import { FADE, SMOOTH_HEIGHT_CLASS, useEntrance, useSmoothHeight } from "./motion";
import { EXACT_TIME, ICON_BUTTON } from "./projectKit";
import { useGroupPicture, ViewerGroup } from "./viewer";

/** Past this many stages the chain is a timeline at every width: a row would squeeze them. */
const MAX_ROW_STAGES = 6;
/** Chips a stage shows in the chain; the rest are in its detail. */
const CHAIN_FACTS = 5;
/** Lines of a log shown whole; a longer one shows its tail. */
const LOG_LINES = 40;
const LOG_TAIL = 24;

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY_CLOCK = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Values that read as identifiers, set in mono. */
const MONO_KEYS: Readonly<Record<string, true>> = { branch: true, sha: true, build: true, version: true, bundle: true, digest: true, artifact: true, udid: true, model: true };

// ---------------------------------------------------------------------------
// Marks

/** Done (a check), failed (a cross), done but carrying a wrong fact (an alert), running (an arc), the rest rings. */
function StageMark({ stage, wrong }: { stage: Stage; wrong: boolean }) {
  const base = "relative size-[18px] shrink-0 rounded-full bg-background";
  if (stage.status === "failed") return <Icon name="CircleX" aria-hidden className={cn(base, "text-destructive")} />;
  if (wrong) return <Icon name="AlertCircle" aria-hidden className={cn(base, "text-destructive")} />;
  if (stage.status === "done") return <Icon name="CircleCheck" aria-hidden className={cn(base, "text-success")} />;
  if (stage.receipt === "none") return <Icon name="CircleQuestion" aria-hidden className={cn(base, "text-warning-text")} />;
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn(base, stage.status === "running" ? "text-warning" : "text-muted-foreground")}>
      {stage.status === "running" ? (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.75" />
          <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="origin-center animate-spin motion-reduce:animate-none" />
        </>
      ) : stage.status === "skipped" ? (
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.6 2.1" />
      ) : (
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      )}
    </svg>
  );
}

const VERDICT_ICON: Record<VerdictTone, { name: string; className: string }> = {
  good: { name: "CircleCheck", className: "text-success" },
  bad: { name: "AlertCircle", className: "text-destructive" },
  warn: { name: "CircleQuestion", className: "text-warning-text" },
  info: { name: "Clock", className: "text-muted-foreground" },
  neutral: { name: "Info", className: "text-muted-foreground" },
};

/** "done", "done, branch not as requested", "no receipt (timed out)". */
function stageState(stage: Stage): string {
  const wrong = stage.facts.filter((fact) => fact.check !== null).map((fact) => `${fact.label} ${fact.check?.kind === "expected" ? "not as requested" : "changed"}`);
  const state = stage.receipt === "receipt" ? STAGE_STATUS_LABEL[stage.status].toLowerCase() : RECEIPT_LABEL[stage.receipt];
  return [`${state}${stage.note === null ? "" : ` (${stage.note})`}`, ...wrong].join(", ");
}

// ---------------------------------------------------------------------------
// Facts

/** A fact as a chip: its key quiet, its value set as written; a tap copies the full value. Wrong facts carry the other value under them. */
function FactChip({ fact, requested, quiet }: { fact: Fact; requested: boolean; quiet: boolean }) {
  const { run } = useUiRuntime();
  const wrong = fact.check !== null;
  const other =
    fact.check === null ? null : fact.check.kind === "expected" ? `expected ${shortValue(fact.key, fact.check.expected)}` : `was ${shortValue(fact.key, fact.check.previous)}`;
  return (
    <button
      type="button"
      title={`${fact.label}: ${fact.value}${other === null ? "" : ` (${other})`}. Click to copy.`}
      aria-label={`Copy ${fact.label} ${fact.value}${other === null ? "" : `, ${other}`}`}
      onClick={() => void run([{ kind: "action", type: "copy", text: fact.value }])}
      className={cn(
        "flex min-w-0 max-w-full cursor-pointer flex-col items-start rounded-md px-1.5 py-px text-left text-[11px] leading-[18px] transition-colors duration-150",
        FOCUS_RING,
        wrong
          ? "bg-destructive/10 text-destructive hover:bg-destructive/15"
          : quiet
            ? "border border-dashed border-border text-muted-foreground hover:bg-state-hover"
            : "bg-surface-recessed text-foreground hover:bg-state-hover",
      )}
    >
      <span className="flex min-w-0 max-w-full flex-wrap items-baseline gap-x-1">
        <span className={cn("shrink-0", wrong ? "text-destructive/80" : "text-muted-foreground")}>{fact.label}</span>
        <span className={cn("line-clamp-2 min-w-0 max-w-full [overflow-wrap:anywhere]", MONO_KEYS[fact.key] === true && "font-mono", wrong && "font-medium")}>{fact.short}</span>
        {requested && fact.confirmed ? <Icon name="Check" aria-hidden className="size-3 shrink-0 self-center text-success" /> : null}
      </span>
      {other === null ? null : <span className="min-w-0 max-w-full truncate text-[10.5px] leading-4 text-destructive/80">{other}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The chain

function StageItem({
  stage,
  next,
  index,
  row,
  open,
  detailId,
  requested,
  withDay,
  onToggle,
}: {
  stage: Stage;
  next: Stage | null;
  index: number;
  row: boolean;
  open: boolean;
  detailId: string;
  requested: ReadonlySet<string>;
  withDay: boolean;
  onToggle: () => void;
}) {
  const wrong = stage.facts.some((fact) => fact.check !== null);
  const time = stage.at === null ? stage.timeText : (withDay ? DAY_CLOCK : CLOCK).format(stage.at);
  const missing = stage.receipt !== "receipt";
  // Wrong and requested facts always show; the rest fill up to CHAIN_FACTS in their order.
  const kept = new Set(stage.facts.filter((fact) => fact.check !== null || requested.has(fact.key)).map((fact) => fact.key));
  for (const fact of stage.facts) {
    if (kept.size >= CHAIN_FACTS) break;
    kept.add(fact.key);
  }
  const shown = stage.facts.filter((fact) => kept.has(fact.key));
  const hidden = stage.facts.length - shown.length;
  const meta = [
    stage.receipt === "receipt" ? null : RECEIPT_LABEL[stage.receipt],
    stage.note,
    time,
    stage.ms === null ? null : formatElapsed(stage.ms),
  ].filter((part): part is string => part !== null);
  return (
    <div
      role="listitem"
      style={{ "--order": index * 2 } as CSSProperties}
      className={cn("relative flex min-w-0 gap-2.5 [order:var(--order)]", next === null ? "pb-0" : "pb-4", row && "@2xl:flex-1 @2xl:basis-0 @2xl:flex-col @2xl:gap-1.5 @2xl:pb-0 @2xl:pr-4")}
    >
      {next === null ? null : (
        // The link to the next stage: dashed into a stage without a receipt.
        <span
          aria-hidden
          className={cn(
            "absolute bottom-0 left-[8.5px] top-[22px] border-l",
            row && "@2xl:bottom-auto @2xl:left-[26px] @2xl:right-[6px] @2xl:top-[8.5px] @2xl:border-l-0 @2xl:border-t",
            next.receipt !== "receipt" ? "border-dashed border-muted-foreground/40" : "border-border",
          )}
        />
      )}
      <StageMark stage={stage} wrong={wrong} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? detailId : undefined}
          aria-label={`${stage.name}, ${stageState(stage)}`}
          onClick={onToggle}
          className={cn("group flex min-w-0 cursor-pointer flex-col items-start rounded-sm text-left", FOCUS_RING)}
        >
          <span className="flex min-w-0 max-w-full items-center gap-1">
            <span
              className={cn(
                "min-w-0 text-[13px] font-medium leading-5 decoration-muted-foreground/60 underline-offset-2 [overflow-wrap:anywhere] group-hover:underline",
                missing ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {stage.name}
            </span>
            <Icon
              name="ChevronDown"
              aria-hidden
              className={cn("size-3 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")}
            />
          </span>
          {meta.length === 0 ? null : (
            <span className={cn("text-[11px] leading-4 tabular-nums", stage.receipt === "none" ? "text-warning-text" : "text-muted-foreground")}>{meta.join(" · ")}</span>
          )}
        </button>
        {stage.last ? (
          <span className="w-fit rounded-full bg-surface-recessed px-1.5 text-[10.5px] font-medium leading-4 text-muted-foreground">Last receipt</span>
        ) : null}
        {shown.length === 0 ? null : (
          <div className="flex min-w-0 flex-wrap items-start gap-1">
            {shown.map((fact) => (
              <FactChip key={fact.key} fact={fact} requested={requested.has(fact.key)} quiet={missing} />
            ))}
            {hidden > 0 ? (
              <button type="button" onClick={onToggle} className={cn(TEXT_BUTTON, "text-[11px] leading-[18px]")} aria-label={`${stage.name}: ${hidden} more facts`}>
                +{hidden}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage detail

function Excerpt({ text, line }: { text: string; line: number | null }) {
  const lines = text.replace(/\n$/, "").split(/\r?\n/);
  const cut = line === null && lines.length > LOG_LINES ? lines.length - LOG_TAIL : 0;
  return (
    <div className="min-w-0 overflow-hidden">
      {cut > 0 ? <p className="m-0 border-b border-border/60 px-3 py-1 text-[11px] leading-5 text-muted-foreground">{formatNumber(cut)} earlier lines</p> : null}
      <pre className="m-0 max-h-72 overflow-auto px-3 py-2 font-mono text-[11px] leading-[17px] text-foreground [overflow-wrap:anywhere] whitespace-pre-wrap">
        {lines.slice(cut).join("\n")}
      </pre>
    </div>
  );
}

function FileEvidence({ evidence }: { evidence: Extract<Evidence, { kind: "file" }> }) {
  const file = useFileText(evidence.path);
  const opener = useFileOpener(evidence.path);
  if (evidence.line !== null) {
    return <CodeExcerpt path={evidence.path} file={file} mark={{ start: evidence.line, end: evidence.line }} tone="info" />;
  }
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-background">
      {/* CodeExcerpt's header, as for a file with a line: the open button is the file's icon. Where BB can't open it, a plain icon leads. */}
      <div className="flex h-7 items-center justify-between gap-3 border-b border-border bg-surface-recessed pl-3 pr-1 text-[11px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          {opener === null ? <Icon name="FileText" aria-hidden className="size-3 shrink-0" /> : null}
          <span className="truncate font-mono text-foreground" title={evidence.path}>
            {evidence.label ?? evidence.path}
          </span>
        </span>
        <OpenFileButton path={evidence.path} line={null} />
      </div>
      {file === null ? (
        <div role="status" aria-label={`Reading ${evidence.path}`} className="flex flex-col gap-2 px-3 py-2.5">
          {[70, 52, 84, 40].map((width, index) => (
            <div key={index} className="h-3 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" style={{ width: `${width}%` }} />
          ))}
        </div>
      ) : file.ok ? (
        <Excerpt text={file.text} line={null} />
      ) : (
        <p className="m-0 px-3 py-2 text-xs leading-5 text-muted-foreground">
          Couldn't read {evidence.path}: {file.error}
        </p>
      )}
    </div>
  );
}

function ImageEvidence({ evidence, order }: { evidence: Extract<Evidence, { kind: "image" }>; order: number }) {
  const image = useImageUrl(evidence.src);
  const caption = evidence.label ?? evidence.src;
  const open = useGroupPicture(order, image.status === "ready" ? { url: image.url, alt: caption, caption } : null);
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1">
      <div className="flex h-56 min-w-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-recessed">
        {image.status === "ready" ? (
          <button
            type="button"
            aria-label={`View ${caption} full size`}
            onClick={(event) => open(event.currentTarget)}
            className={cn("flex size-full cursor-zoom-in items-center justify-center", FOCUS_RING)}
          >
            <img src={image.url} alt={caption} decoding="async" className="block h-full w-auto max-w-full object-contain" />
          </button>
        ) : image.status === "loading" ? (
          <div role="status" aria-label={`Loading ${caption}`} className="size-full animate-pulse motion-reduce:animate-none" />
        ) : (
          <p className="m-0 px-3 text-center text-xs leading-5 text-muted-foreground">
            {image.off ? "Not shown: web lookups are off in the Generative UI plugin settings." : `Couldn't show ${evidence.src}: ${image.error}`}
          </p>
        )}
      </div>
      <figcaption className="flex min-w-0 items-center gap-1 text-[11px] leading-5 text-muted-foreground">
        <span className="min-w-0 truncate" title={evidence.src}>
          {caption}
        </span>
        {/^https:/i.test(evidence.src) ? null : <OpenFileButton path={evidence.src} line={null} />}
      </figcaption>
    </figure>
  );
}

function EvidenceItem({ evidence, order }: { evidence: Evidence; order: number }) {
  if (evidence.kind === "file") return <FileEvidence evidence={evidence} />;
  if (evidence.kind === "image") return <ImageEvidence evidence={evidence} order={order} />;
  if (evidence.kind === "url") {
    return (
      <UrlLink
        href={evidence.url}
        className={cn("flex w-fit min-w-0 max-w-full items-center gap-1.5 rounded-sm text-xs leading-5 text-foreground no-underline hover:underline", FOCUS_RING)}
      >
        <Icon name="Globe" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{evidence.label ?? evidence.url.replace(/^https?:\/\//, "")}</span>
        <Icon name="ExternalLink" aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      </UrlLink>
    );
  }
  return (
    <div className="min-w-0 rounded-md bg-surface-recessed px-2.5 py-1.5">
      {evidence.label === null ? null : <p className="m-0 text-[11px] leading-4 text-muted-foreground">{evidence.label}</p>}
      <p className="m-0 whitespace-pre-wrap font-mono text-[11px] leading-[17px] text-foreground [overflow-wrap:anywhere]">{evidence.text}</p>
    </div>
  );
}

function FactRow({ fact, requested }: { fact: Fact; requested: boolean }) {
  const { run } = useUiRuntime();
  const check =
    fact.check === null
      ? requested && fact.confirmed
        ? { text: "as requested", tone: "text-success" }
        : null
      : fact.check.kind === "expected"
        ? { text: `expected ${fact.check.expected}`, tone: "text-destructive" }
        : { text: `was ${fact.check.previous}`, tone: "text-destructive" };
  return (
    <div className="contents">
      <dt className="py-0.5 text-[11px] leading-5 text-muted-foreground">{fact.label}</dt>
      <dd className="m-0 flex min-w-0 flex-col py-0.5">
        <span className={cn("text-xs leading-5 [overflow-wrap:anywhere]", MONO_KEYS[fact.key] === true && "font-mono text-[11.5px]", fact.check !== null && "font-medium text-destructive")}>
          {fact.value}
        </span>
        {check === null ? null : <span className={cn("text-[11px] leading-4 [overflow-wrap:anywhere]", check.tone)}>{check.text}</span>}
      </dd>
      <span className="py-0.5">
        <button type="button" aria-label={`Copy ${fact.label}`} title={`Copy ${fact.label}`} onClick={() => void run([{ kind: "action", type: "copy", text: fact.value }])} className={ICON_BUTTON}>
          <Icon name="Copy" aria-hidden className="size-3.5" />
        </button>
      </span>
    </div>
  );
}

function StageDetail({ stage, id, requested, onClose }: { stage: Stage; id: string; requested: ReadonlySet<string>; onClose: () => void }) {
  const fade = useEntrance<HTMLDivElement>(FADE);
  const wrong = stage.facts.some((fact) => fact.check !== null);
  const facts = [
    stage.receipt === "receipt" ? STAGE_STATUS_LABEL[stage.status] : RECEIPT_LABEL[stage.receipt].replace(/^./, (c) => c.toUpperCase()),
    stage.note,
    stage.at === null ? stage.timeText : EXACT_TIME.format(stage.at),
    stage.ms === null ? null : formatElapsed(stage.ms),
  ].filter((part): part is string => part !== null);
  return (
    <div ref={fade} id={id} role="region" aria-label={`${stage.name}: detail and evidence`} className="flex min-w-0 flex-col gap-2.5 rounded-lg bg-surface-recessed/60 px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-2">
        <StageMark stage={stage} wrong={wrong} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] font-semibold leading-5 text-foreground [overflow-wrap:anywhere]">{stage.name}</span>
          <span className="text-[11px] leading-4 text-muted-foreground">{facts.join(" · ")}</span>
        </div>
        <button type="button" aria-label={`Close ${stage.name}`} title="Close" onClick={onClose} className={ICON_BUTTON}>
          <Icon name="X" aria-hidden className="size-3.5" />
        </button>
      </div>
      {stage.detail === null ? null : <p className="m-0 whitespace-pre-wrap text-xs leading-5 text-foreground [overflow-wrap:anywhere]">{stage.detail}</p>}
      {stage.facts.length === 0 ? null : (
        <dl className="m-0 grid min-w-0 grid-cols-[minmax(3.5rem,auto)_minmax(0,1fr)_auto] items-start gap-x-3">
          {stage.facts.map((fact) => (
            <FactRow key={fact.key} fact={fact} requested={requested.has(fact.key)} />
          ))}
        </dl>
      )}
      {stage.evidence.length === 0 ? (
        <p className="m-0 text-xs leading-5 text-muted-foreground">
          {stage.receipt === "receipt" ? "No evidence attached: the outcome is as reported." : "No evidence attached."}
        </p>
      ) : (
        <ViewerGroup>
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-[11px] font-medium uppercase leading-4 tracking-wide text-muted-foreground">Evidence</span>
            {stage.evidence.map((evidence, index) => (
              <EvidenceItem key={index} evidence={evidence} order={index} />
            ))}
          </div>
        </ViewerGroup>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header

function Header({ chain }: { chain: Chain }) {
  const fade = useEntrance<HTMLDivElement>(FADE);
  const { verdict } = chain;
  const icon = VERDICT_ICON[verdict.tone];
  return (
    <div ref={fade} className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-start gap-2">
        <Icon name={icon.name} aria-hidden className={cn("mt-[3px] size-4 shrink-0", icon.className)} />
        <h3 className="m-0 min-w-0 flex-1 text-balance text-[15px] font-semibold leading-6 tracking-[-0.01em] text-foreground [overflow-wrap:anywhere]">{verdict.title}</h3>
      </div>
      {verdict.lines.length === 0 ? null : (
        <ul className="m-0 flex min-w-0 list-none flex-col gap-0.5 p-0 pl-6">
          {verdict.lines.map((line, index) => (
            <li key={index} className={cn("flex min-w-0 items-start gap-2 text-xs leading-5", line.tone === "bad" ? "text-destructive" : "text-muted-foreground")}>
              <span aria-hidden className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", TONE_DOT[line.tone])} />
              <span className="min-w-0 [overflow-wrap:anywhere]">{line.text}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 pl-6 pt-0.5 text-xs leading-5 text-muted-foreground">
        <span className="tabular-nums">{chainSummary(chain)}</span>
        {chain.expected.length === 0 ? null : (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            <span>Requested</span>
            {chain.expected.map((fact) => {
              const wrong = chain.mismatches.some((mismatch) => mismatch.key === fact.key && mismatch.check.kind === "expected");
              const state = wrong ? "not met" : fact.confirmed ? "confirmed" : "not confirmed";
              return (
                <span
                  key={fact.key}
                  title={`${fact.label} ${fact.value}: ${state}`}
                  className={cn(
                    "flex min-w-0 items-center gap-1 rounded-md px-1.5 text-[11px] leading-[18px]",
                    wrong ? "bg-destructive/10 text-destructive" : fact.confirmed ? "bg-success/10 text-foreground" : "border border-dashed border-border",
                  )}
                >
                  <span className={wrong ? "text-destructive/80" : "text-muted-foreground"}>{fact.label}</span>
                  <span className={cn("min-w-0 truncate", MONO_KEYS[fact.key] === true && "font-mono")}>{fact.short}</span>
                  <span className="sr-only">, {state}</span>
                  {wrong ? (
                    <Icon name="X" aria-hidden className="size-3 shrink-0" />
                  ) : fact.confirmed ? (
                    <Icon name="Check" aria-hidden className="size-3 shrink-0 text-success" />
                  ) : (
                    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT.warn)} />
                  )}
                </span>
              );
            })}
          </span>
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Provenance({ props }: { props: Props }) {
  const depth = useContext(CardDepthContext);
  const detailId = useId();
  const result = useMemo(() => readProvenance(props.stages, props.expected), [props.stages, props.expected]);
  const [open, setOpen] = useState<number | null>(null);
  const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();
  if (!result.ok) return <ErrorLine message={result.error} />;
  const chain = result.provenance;
  const { stages } = chain;
  const row = stages.length <= MAX_ROW_STAGES;
  const requested = new Set(chain.expected.map((fact) => fact.key));
  const days = new Set(stages.flatMap((stage) => (stage.at === null ? [] : [new Date(stage.at).toDateString()])));
  const shown = open !== null && open < stages.length ? open : null;
  if (stages.length === 0) {
    return (
      <ReportFrame depth={depth} label="Provenance">
        <p className="m-0 text-xs leading-5 text-muted-foreground">No stages yet.</p>
      </ReportFrame>
    );
  }
  return (
    <ReportFrame depth={depth} label={`Provenance: ${chain.verdict.title}`}>
      <div ref={outer} className={cn("@container min-w-0", SMOOTH_HEIGHT_CLASS)}>
        <div ref={inner} className="flex min-w-0 flex-col gap-4">
          <Header chain={chain} />
          <div role="list" aria-label="Stages, source to live" className={cn("flex min-w-0 flex-col", row && "@2xl:flex-row @2xl:flex-wrap @2xl:gap-y-3")}>
            {stages.map((stage, index) => (
              <StageItem
                key={index}
                stage={stage}
                index={index}
                next={stages[index + 1] ?? null}
                row={row}
                open={shown === index}
                detailId={detailId}
                requested={requested}
                withDay={days.size > 1}
                onToggle={() => setOpen((current) => (current === index ? null : index))}
              />
            ))}
            {shown === null ? null : (
              // Under its stage on a narrow reply; under the whole row on a wide one.
              <div
                style={{ "--order": shown * 2 + 1 } as CSSProperties}
                className={cn(
                  "min-w-0 pl-7 [order:var(--order)]",
                  shown === stages.length - 1 ? "pt-3" : "pb-4",
                  row && "@2xl:basis-full @2xl:pb-0 @2xl:pl-0 @2xl:pt-0 @2xl:[order:9999]",
                )}
              >
                <StageDetail stage={stages[shown]} id={detailId} requested={requested} onClose={() => setOpen(null)} />
              </div>
            )}
          </div>
        </div>
      </div>
    </ReportFrame>
  );
}
