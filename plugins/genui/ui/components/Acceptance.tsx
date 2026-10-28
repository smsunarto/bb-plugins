// Acceptance: is it really done? The verdict first ("Not done: 3 of 8
// criteria proven · 2 failing · 1 blocked"), what needs the user, then the
// criteria: a matrix of conditions (platforms, devices, viewports, runs) with
// one compact status cell each, or one status per criterion. A cell opens its
// evidence: the note, how and by whom it was checked, the run and time, and
// the evidence itself (a file at a line, a link, an image, what a tool
// printed). What an owner only claimed is hatched, never green; what nobody
// ran is "not tested". Reading and wording live in core/acceptance.ts.
// Wide and narrow layouts switch on the frame's own width (container
// queries), so a row opens at its final height without measuring first.
import { useContext, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  acceptanceVerdict,
  cellsLine,
  checkLabel,
  checkSummary,
  COUNT_WORD,
  isGap,
  needsPlaces,
  ownerContradiction,
  readAcceptance,
  STATUS_LABEL,
  STATUS_ORDER,
  type AcceptanceReport,
  type AcceptanceStatus,
  type Check,
  type Criterion,
  type Evidence,
  type NeedsYou,
  type Verdict,
} from "../../core/acceptance";
import { CardDepthContext, useUiRuntime } from "../runtime";
import { propsKey, usePersistedState } from "../usePersistedState";
import { formatNumber, TONE_TEXT, type Props } from "../values";
import { CodeExcerpt, Disclosure, ReportPathsContext, Segmented, TEXT_BUTTON, useFileOpener, useFileText, useShownPath, useWorkspaceRoot, type MarkTone } from "./codeHealthKit";
import { ErrorLine } from "./display";
import { CAPTION, FOCUS_RING } from "./inputs";
import { useImageUrl } from "./media";
import { CHART_DRAW_MS, FADE, RISE, SMOOTH_HEIGHT_CLASS, useEntrance, useSmoothHeight, type Entrance } from "./motion";
import { ICON_BUTTON } from "./projectKit";
import { useGroupPicture, ViewerGroup } from "./viewer";

/** Criteria shown before "Show N more", and how many each press adds. */
const PAGE = 30;
/** Places a "needs you" item names before "and N more". */
const NEEDS_PLACES = 2;

const GROW_X: Entrance = { keyframes: [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], duration: CHART_DRAW_MS };

const ACCENT = "var(--color-timeline-accent,var(--primary))";

/** Notes: small prose at every width (BB's markdown sizes its own paragraphs up on phones). */
const SMALL_PROSE =
  "min-w-0 text-xs leading-[18px] text-foreground [overflow-wrap:anywhere] [&_li]:text-xs [&_p]:my-0 [&_p]:text-xs [&_p]:leading-[18px] [&>:first-child]:mt-0 [&>:last-child]:mb-0";

/** Diagonal hatching for what was only claimed: the accent, never the success green. */
const HATCH = `repeating-linear-gradient(135deg, color-mix(in oklch, ${ACCENT} 30%, transparent) 0 1.5px, transparent 1.5px 5px)`;

/** The fill of a status in the cells, the bar and the legend. */
const CELL_STYLE: Record<AcceptanceStatus, string> = {
  passed: "bg-success/14",
  failed: "bg-destructive/12",
  blocked: "bg-warning/18",
  untested: "border border-dashed border-muted-foreground/40",
  claimed: "border border-[color-mix(in_oklch,var(--color-timeline-accent,var(--primary))_45%,transparent)]",
  skipped: "bg-surface-recessed",
};

const BAR_FILL: Record<AcceptanceStatus, string> = {
  passed: "bg-success",
  failed: "bg-destructive",
  blocked: "bg-warning",
  untested: "bg-muted-foreground/25",
  claimed: "",
  skipped: "bg-muted-foreground/45",
};

const STATUS_INK: Record<AcceptanceStatus, string> = {
  passed: "text-success",
  failed: "text-destructive",
  blocked: "text-warning-text",
  untested: "text-muted-foreground",
  claimed: "text-[var(--color-timeline-accent,var(--primary))]",
  skipped: "text-muted-foreground",
};

const MARK_TONE: Record<AcceptanceStatus, MarkTone> = {
  passed: "info",
  failed: "bad",
  blocked: "warn",
  untested: "info",
  claimed: "info",
  skipped: "info",
};

/** The legend's words: the cell states as a reader names them. */
const LEGEND_LABEL: Record<AcceptanceStatus, string> = {
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  untested: "Not tested",
  claimed: "Only claimed",
  skipped: "Skipped",
};

const AT_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });

/** An ISO date or date-time as the reader's local time; anything else as written. */
function formatAt(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const day = new Date(`${raw}T00:00:00Z`);
    return Number.isNaN(day.getTime()) ? raw : DAY_FORMAT.format(day);
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw;
  const time = new Date(raw);
  return Number.isNaN(time.getTime()) ? raw : AT_FORMAT.format(time);
}

// ---------------------------------------------------------------------------
// Marks

/** Chords of a circle along 135° hatching, for the claimed mark. */
const HATCH_LINES = [-3.4, 0, 3.4].map((offset) => {
  const radius = 4.6;
  const half = Math.sqrt(radius * radius - offset * offset);
  const [cx, cy] = [7 + offset / Math.SQRT2, 7 - offset / Math.SQRT2];
  const [dx, dy] = [half / Math.SQRT2, half / Math.SQRT2];
  return { x1: cx - dx, y1: cy - dy, x2: cx + dx, y2: cy + dy };
});

/** The status as a 14 px glyph: filled for what was checked, outlined for what wasn't, hatched for a claim. */
function StatusMark({ check, className }: { check: Pick<Check, "status" | "notApplicable">; className?: string }) {
  const common = cn("size-3.5 shrink-0", className);
  if (check.notApplicable) {
    return (
      <svg viewBox="0 0 14 14" aria-hidden className={cn(common, "text-muted-foreground/70")}>
        <path d="M4 7h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  switch (check.status) {
    case "passed":
      return (
        <svg viewBox="0 0 14 14" aria-hidden className={cn(common, "text-success")}>
          <circle cx="7" cy="7" r="6.5" fill="currentColor" />
          <path d="M4.2 7.2l1.9 1.9 3.8-4" fill="none" stroke="var(--background)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "failed":
      return (
        <svg viewBox="0 0 14 14" aria-hidden className={cn(common, "text-destructive")}>
          <circle cx="7" cy="7" r="6.5" fill="currentColor" />
          <path d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4" stroke="var(--background)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "blocked":
      return (
        <svg viewBox="0 0 14 14" aria-hidden className={cn(common, "text-warning")}>
          <circle cx="7" cy="7" r="6.5" fill="currentColor" />
          <path d="M4.2 7h5.6" stroke="var(--background)" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "claimed":
      return (
        <svg viewBox="0 0 14 14" aria-hidden className={cn(common, "text-[var(--color-timeline-accent,var(--primary))]")}>
          <circle cx="7" cy="7" r="5.9" fill="none" stroke="currentColor" strokeWidth="1.3" />
          {HATCH_LINES.map((line, index) => (
            <line key={index} {...line} stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
          ))}
        </svg>
      );
    case "skipped":
      return (
        <svg viewBox="0 0 14 14" aria-hidden className={cn(common, "text-muted-foreground")}>
          <circle cx="7" cy="7" r="5.9" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5.6 4.6l2.6 2.4-2.6 2.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 14 14" aria-hidden className={cn(common, "text-muted-foreground/80")}>
          <circle cx="7" cy="7" r="5.9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.2 1.9" />
        </svg>
      );
  }
}

/** A short status word in its tone, for list rows and cards. */
function StatusText({ check, className }: { check: Check; className?: string }) {
  const word = check.notApplicable ? "Not applicable" : !check.recorded ? "No result" : check.status === "claimed" ? "Only claimed" : STATUS_LABEL[check.status];
  return <span className={cn("shrink-0 whitespace-nowrap text-[11.5px] font-medium leading-5", check.notApplicable ? "text-muted-foreground" : STATUS_INK[check.status], className)}>{word}</span>;
}

// ---------------------------------------------------------------------------
// Header

function Heading({ report, verdict }: { report: AcceptanceReport; verdict: Verdict }) {
  const fade = useEntrance<HTMLDivElement>(FADE);
  const meta = [
    report.title ?? "Acceptance",
    report.columns.length > 0 ? `${formatNumber(report.columns.length)} ${report.columns.length === 1 ? "condition" : "conditions"}` : null,
    verdict.optional.total > 0 ? `${formatNumber(verdict.optional.total)} optional, ${verdict.optional.proven === 0 ? "none" : formatNumber(verdict.optional.proven)} proven` : null,
    verdict.notApplicable > 0 ? `${formatNumber(verdict.notApplicable)} not applicable` : null,
    report.hiddenColumns > 0 ? `${formatNumber(report.hiddenColumns)} ${report.hiddenColumns === 1 ? "column" : "columns"} not shown` : null,
    report.unnamed > 0 ? `${formatNumber(report.unnamed)} without a name left out` : null,
  ].filter((part) => part !== null);
  const contradiction = ownerContradiction(report, verdict);
  return (
    <div ref={fade} className="flex min-w-0 flex-col gap-1">
      <p className={cn(CAPTION, "m-0")}>{meta.join(" · ")}</p>
      <h3 className="m-0 text-balance text-[15px] font-semibold leading-6 tracking-[-0.01em] text-foreground">
        <span className={TONE_TEXT[verdict.tone]}>{verdict.headline}</span>
        {verdict.headline === "No criteria" ? null : <span>: {verdict.proven}</span>}
      </h3>
      {verdict.parts.length > 0 ? (
        <p className="m-0 flex flex-wrap gap-x-3.5 gap-y-0.5 text-xs leading-5 text-muted-foreground">
          {STATUS_ORDER.filter((status) => status !== "passed" && verdict.counts[status] > 0).map((status) => (
            <span key={status} className="flex items-center gap-1.5 tabular-nums">
              <StatusMark check={{ status, notApplicable: false }} className="size-3" />
              <span>
                <span className={cn("font-medium", STATUS_INK[status])}>{formatNumber(verdict.counts[status])}</span> {COUNT_WORD[status]}
              </span>
            </span>
          ))}
        </p>
      ) : null}
      {contradiction === null ? null : (
        <p className="m-0 flex items-start gap-1.5 text-xs leading-5 text-warning-text">
          <Icon name="AlertTriangle" aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {contradiction}
        </p>
      )}
      {report.statedVerdict === null ? null : <p className="m-0 text-xs leading-5 text-muted-foreground">Stated verdict: “{report.statedVerdict}”</p>}
    </div>
  );
}

/** The share of cells (or criteria) per status, as one thin bar. */
function StatusBar({ counts, label }: { counts: Readonly<Record<AcceptanceStatus, number>>; label: string }) {
  const grow = useEntrance<HTMLDivElement>(GROW_X);
  const present = [...STATUS_ORDER].reverse().filter((status) => counts[status] > 0);
  if (present.length === 0) return null;
  return (
    <div ref={grow} role="img" aria-label={label} className="flex h-1.5 w-full origin-left gap-[2px] overflow-hidden rounded-full bg-muted">
      {present.map((status) => (
        <div
          key={status}
          className={cn("h-full min-w-[3px]", BAR_FILL[status])}
          style={{ flex: `${counts[status]} 1 0`, backgroundImage: status === "claimed" ? HATCH : undefined, backgroundColor: status === "claimed" ? `color-mix(in oklch, ${ACCENT} 18%, transparent)` : undefined }}
        />
      ))}
    </div>
  );
}

function NeedsYouBox({ items }: { items: readonly NeedsYou[] }) {
  if (items.length === 0) return null;
  return (
    <div role="note" aria-label="Needs you" className="flex min-w-0 flex-col gap-1 rounded-lg bg-warning/10 px-3 py-2">
      <p className="m-0 flex items-center gap-1.5 text-xs font-medium leading-5 text-warning-text">
        <Icon name="UserRound" aria-hidden className="size-3.5 shrink-0" />
        Needs you
      </p>
      <ul className="m-0 flex min-w-0 list-none flex-col gap-1 p-0">
        {items.map((item, index) => (
          <li key={index} className="flex min-w-0 flex-col">
            <span className="text-[13px] leading-5 text-foreground [overflow-wrap:anywhere]">{item.what === "" ? "Your input" : item.what}</span>
            <span className="text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]" title={needsPlaces(item)}>
              {needsPlaces(item, NEEDS_PLACES)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Limitations({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className={CAPTION}>Limitations the owner stated</span>
      <ul className="m-0 flex min-w-0 list-disc flex-col gap-0.5 pl-4 text-xs leading-[18px] text-foreground marker:text-muted-foreground">
        {items.map((item, index) => (
          <li key={index} className="[overflow-wrap:anywhere]">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Legend({ report }: { report: AcceptanceReport }) {
  const present = new Set<AcceptanceStatus>();
  let notApplicable = false;
  for (const criterion of report.criteria) {
    for (const cell of criterion.cells ?? [criterion.own]) {
      if (cell.notApplicable) notApplicable = true;
      else present.add(cell.status);
    }
  }
  return (
    <ul aria-label="Legend" className="m-0 flex min-w-0 list-none flex-wrap items-center gap-x-3 gap-y-0.5 p-0 text-[11px] leading-5 text-muted-foreground">
      {[...STATUS_ORDER].reverse().filter((status) => present.has(status)).map((status) => (
        <li key={status} className="flex items-center gap-1">
          <StatusMark check={{ status, notApplicable: false }} className="size-3" />
          {LEGEND_LABEL[status]}
        </li>
      ))}
      {notApplicable ? (
        <li className="flex items-center gap-1">
          <StatusMark check={{ status: "untested", notApplicable: true }} className="size-3" />
          Not applicable
        </li>
      ) : null}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Evidence

function EvidenceFile({ item, tone }: { item: Extract<Evidence, { kind: "file" }>; tone: MarkTone }) {
  const shownPath = useShownPath();
  const opener = useFileOpener(item.path);
  const file = useFileText(item.line === null ? null : item.path);
  if (item.line !== null) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        {item.label === null ? null : <span className={CAPTION}>{item.label}</span>}
        <CodeExcerpt path={item.path} file={file} tone={tone} mark={{ start: item.line, end: item.endLine ?? item.line }} />
      </div>
    );
  }
  // Like a link's box beside it: the whole box opens the file, its path in the link colour.
  const content = (
    <>
      <Icon name="FileText" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        {item.label === null ? null : <span className="truncate text-xs leading-4 text-foreground">{item.label}</span>}
        <span
          className={cn(
            "truncate font-mono text-[11px] leading-5",
            opener === null ? "text-muted-foreground" : "text-primary group-hover/file:underline",
          )}
        >
          {shownPath(item.path)}
        </span>
      </span>
    </>
  );
  const box = "flex w-full min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1 text-left";
  if (opener === null) {
    return (
      <div title={item.path} className={box}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      title={`Open ${opener.target}`}
      onClick={() => void opener.open(null)}
      className={cn("group/file cursor-pointer hover:bg-state-hover", box, FOCUS_RING)}
    >
      {content}
    </button>
  );
}

function EvidenceLink({ item }: { item: Extract<Evidence, { kind: "url" }> }) {
  let host = item.url;
  try {
    const url = new URL(item.url);
    host = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    // Shown as written.
  }
  return (
    <UrlLink
      href={item.url}
      title={item.url}
      className={cn("group/link flex min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1 no-underline hover:bg-state-hover", FOCUS_RING)}
    >
      <Icon name="Globe" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        {item.label === null ? null : <span className="truncate text-xs leading-4 text-foreground">{item.label}</span>}
        <span className="truncate text-[11.5px] leading-5 text-primary group-hover/link:underline">{host}</span>
      </span>
      <Icon name="ExternalLink" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </UrlLink>
  );
}

function EvidenceImage({ item, order }: { item: Extract<Evidence, { kind: "image" }>; order: number }) {
  const image = useImageUrl(item.src);
  const name = item.label ?? item.src.split(/[\\/]/).pop() ?? item.src;
  const open = useGroupPicture(order, image.status === "ready" ? { url: image.url, alt: item.label ?? `Evidence: ${name}`, caption: item.label ?? item.src } : null);
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1">
      {image.status === "failed" ? (
        <p className="m-0 flex min-w-0 items-start gap-1.5 text-xs leading-5 text-muted-foreground">
          <Icon name="FileQuestion" aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            Couldn't show {item.src}: {image.error}
          </span>
        </p>
      ) : (
        <button
          type="button"
          aria-label={`View ${name} full size`}
          disabled={image.status !== "ready"}
          onClick={(event) => open(event.currentTarget)}
          className={cn(
            "flex h-52 min-w-0 cursor-zoom-in items-center justify-center overflow-hidden rounded-md border border-border bg-surface-recessed disabled:cursor-default",
            FOCUS_RING,
          )}
        >
          {image.status === "ready" ? (
            <img src={image.url} alt={item.label ?? `Evidence: ${name}`} className="block max-h-full max-w-full object-contain" />
          ) : (
            <span role="status" aria-label={`Loading ${name}`} className="block size-full animate-pulse bg-muted motion-reduce:animate-none" />
          )}
        </button>
      )}
      <figcaption className="flex min-w-0 items-baseline gap-2 text-[11px] leading-4 text-muted-foreground" title={item.src}>
        {item.label === null ? null : <span className="shrink-0 text-xs text-foreground">{item.label}</span>}
        <span className="min-w-0 truncate font-mono">{item.src.split(/[\\/]/).pop() ?? item.src}</span>
      </figcaption>
    </figure>
  );
}

function EvidenceText({ item }: { item: Extract<Evidence, { kind: "text" }> }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {item.label === null ? null : <span className={CAPTION}>{item.label}</span>}
      <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11.5px] leading-5 text-foreground [overflow-wrap:anywhere]">
        {item.text}
      </pre>
    </div>
  );
}

function EvidenceItem({ item, tone, order }: { item: Evidence; tone: MarkTone; order: number }) {
  switch (item.kind) {
    case "file":
      return <EvidenceFile item={item} tone={tone} />;
    case "url":
      return <EvidenceLink item={item} />;
    case "image":
      return <EvidenceImage item={item} order={order} />;
    default:
      return <EvidenceText item={item} />;
  }
}

/**
 * Facts about a check: how, by whom, which run, when. Who checked is said
 * where the status line doesn't already name them, and "not recorded" where
 * a result names nobody. A matrix row's own facts (`rowLevel`) name `by` only.
 */
function Facts({ check, rowLevel }: { check: Check; rowLevel: boolean }) {
  const rows: [string, ReactNode][] = [];
  const unnamed = <span className="text-muted-foreground">not recorded</span>;
  if (check.method !== null) rows.push(["Method", check.method]);
  if (rowLevel || check.notApplicable || !check.recorded) {
    if (check.by !== null) rows.push(["By", check.by]);
  } else if (check.status === "claimed" || check.status === "passed") {
    if (check.by === null) rows.push([check.status === "claimed" ? "Claimed by" : "Checked by", unnamed]);
  } else if (check.status === "failed") rows.push(["Checked by", check.by ?? unnamed]);
  else if (check.by !== null) rows.push(["By", check.by]);
  if (check.run !== null) rows.push(["Run", <span className="font-mono text-[11px]">{check.run}</span>]);
  if (check.at !== null) rows.push(["When", <time dateTime={check.at}>{formatAt(check.at)}</time>]);
  if (rows.length === 0) return null;
  return (
    <dl className="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs leading-5">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="m-0 min-w-0 text-foreground [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One check opened: what it says, the note, the facts and the evidence. */
function EvidencePanel({ criterion, column, check, onClose, id }: { criterion: Criterion; column: string | null; check: Check; onClose: (() => void) | null; id?: string }) {
  const { run } = useUiRuntime();
  const rowLevel = column === null && criterion.cells !== null;
  const quiet: string[] = [];
  if (!check.recorded && !check.notApplicable && !rowLevel) quiet.push("Nothing was recorded for this: no run, no note, no evidence.");
  else if (!rowLevel && check.evidence.length === 0 && !check.notApplicable && (check.status === "passed" || check.status === "claimed")) quiet.push("No evidence attached.");
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && onClose !== null) {
      event.stopPropagation();
      onClose();
    }
  };
  return (
    <div id={id} role="region" aria-label={`${criterion.name}${column === null ? "" : ` · ${column}`}: evidence`} onKeyDown={onKeyDown} className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-background px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-2">
        <StatusMark check={check} className="mt-[3px]" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className={cn("text-[13px] font-medium leading-5 [overflow-wrap:anywhere]", check.notApplicable ? "text-muted-foreground" : STATUS_INK[check.status])}>
            {rowLevel ? (criterion.own.notApplicable ? "Not applicable" : `${STATUS_LABEL[criterion.own.status]} overall`) : checkLabel(check)}
          </span>
          {criterion.cells === null ? null : (
            <p className="m-0 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
              {criterion.name}
              {column === null ? "" : ` · ${column}`}
            </p>
          )}
        </div>
        <button
          type="button"
          title="Copy"
          aria-label={`Copy: ${criterion.name}${column === null ? "" : ` · ${column}`}`}
          onClick={() =>
            void run([
              {
                kind: "action",
                type: "copy",
                text: rowLevel ? `${criterion.name}: ${STATUS_LABEL[criterion.own.status]} overall${check.note === null ? "" : ` — ${check.note}`}` : checkSummary(criterion.name, column, check),
              },
            ])
          }
          className={ICON_BUTTON}
        >
          <Icon name="Copy" className="size-3.5" />
        </button>
        {onClose === null ? null : (
          <button type="button" title="Close" aria-label="Close the evidence" onClick={onClose} className={ICON_BUTTON}>
            <Icon name="X" className="size-3.5" />
          </button>
        )}
      </div>
      {criterion.detail !== null && column === null && criterion.cells === null ? <p className="m-0 text-xs leading-5 text-muted-foreground">{criterion.detail}</p> : null}
      {check.note === null ? null : <Markdown content={check.note} className={SMALL_PROSE} />}
      <Facts check={check} rowLevel={rowLevel} />
      {check.evidence.length > 0 ? (
        <ViewerGroup>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className={CAPTION}>Evidence</span>
            {check.evidence.map((item, index) => (
              <EvidenceItem key={index} item={item} tone={MARK_TONE[check.status]} order={index} />
            ))}
          </div>
        </ViewerGroup>
      ) : null}
      {quiet.map((text) => (
        <p key={text} className="m-0 text-xs leading-5 text-muted-foreground">
          {text}
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Matrix

/** A row-level check worth opening: the criterion carries its own note, evidence or checker. */
function hasOwnDetail(criterion: Criterion): boolean {
  const own = criterion.own;
  return own.note !== null || own.evidence.length > 0 || own.by !== null || own.method !== null || own.run !== null || own.at !== null;
}

/** One compact status cell: the mark on its status's fill, a dot when it carries evidence. */
function Cell({ criterion, column, check, open, controls, onToggle, wide }: { criterion: Criterion; column: string; check: Check; open: boolean; controls: string; onToggle: () => void; wide: boolean }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      aria-label={`${criterion.name} · ${column}: ${checkLabel(check)}${check.evidence.length > 0 ? ", with evidence" : ""}`}
      title={`${column}: ${checkLabel(check)}`}
      onClick={onToggle}
      className={cn(
        "relative flex min-w-0 cursor-pointer items-center rounded-md text-left transition-[box-shadow,filter] duration-150 hover:brightness-[0.97] dark:hover:brightness-110",
        wide ? "h-7 w-full justify-center" : "min-h-7 w-full justify-start gap-1.5 px-2 py-1",
        check.notApplicable ? "" : CELL_STYLE[check.status],
        open && "ring-2 ring-ring ring-offset-1 ring-offset-background",
        FOCUS_RING,
      )}
      style={check.status === "claimed" && !check.notApplicable ? { backgroundImage: HATCH } : undefined}
    >
      <StatusMark check={check} />
      {wide ? null : <span className="min-w-0 text-xs leading-4 text-foreground [overflow-wrap:anywhere]">{column}</span>}
      {check.evidence.length > 0 ? <span aria-hidden className={cn("absolute right-1 top-1 size-1 rounded-full bg-foreground/45", wide ? "" : "static ml-0.5 shrink-0")} /> : null}
    </button>
  );
}

function RowName({ criterion, open, onToggle, controls }: { criterion: Criterion; open: boolean; onToggle: (() => void) | null; controls: string }) {
  const name = (
    <span className="flex min-w-0 items-start gap-1.5">
      <StatusMark check={criterion.own} className="mt-[3px]" />
      <span className="flex min-w-0 flex-col">
        <span className={cn("text-[13px] leading-5 text-foreground underline-offset-2 [overflow-wrap:anywhere]", onToggle !== null && "decoration-muted-foreground/60 group-hover/name:underline", open && "font-medium")}>
          {criterion.name}
          {criterion.required ? null : <span className="ml-1.5 rounded-sm bg-surface-recessed px-1 text-[10.5px] font-normal text-muted-foreground">optional</span>}
        </span>
        {criterion.detail === null ? null : <span className="text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">{criterion.detail}</span>}
        {criterion.stated === null ? null : (
          <span className="text-xs leading-4 text-warning-text">
            Marked {STATUS_LABEL[criterion.stated].toLowerCase()}; its conditions say {STATUS_LABEL[criterion.own.status].toLowerCase()}
          </span>
        )}
      </span>
    </span>
  );
  if (onToggle === null) return name;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      aria-label={`${criterion.name}: ${STATUS_LABEL[criterion.own.status]} overall, details`}
      onClick={onToggle}
      className={cn("group/name w-full min-w-0 cursor-pointer rounded-sm text-left", FOCUS_RING)}
    >
      {name}
    </button>
  );
}

function MatrixRow({
  report,
  criterion,
  opened,
  toggle,
  drawerId,
}: {
  report: AcceptanceReport;
  criterion: Criterion;
  opened: string | null;
  toggle: (key: string) => void;
  drawerId: string;
}) {
  const rise = useEntrance<HTMLTableRowElement>(RISE);
  const rowKey = String(criterion.index);
  const openColumn = opened?.startsWith(`${rowKey}:`) ? Number(opened.slice(rowKey.length + 1)) : null;
  const rowOpen = opened === rowKey;
  const controls = `${drawerId}-w${criterion.index}`;
  return (
    <>
      <tr ref={rise} className="border-t border-border/60">
        <th scope="row" className="sticky left-0 z-[1] min-w-[11rem] max-w-[18rem] bg-background py-1.5 pr-3 text-left align-middle font-normal">
          <RowName criterion={criterion} open={rowOpen} onToggle={hasOwnDetail(criterion) ? () => toggle(rowKey) : null} controls={controls} />
        </th>
        {report.columns.map((column, position) => (
          <td key={column} className="w-[4.75rem] px-[3px] py-1 align-middle">
            <Cell
              criterion={criterion}
              column={column}
              check={criterion.cells![position]!}
              open={openColumn === position}
              controls={controls}
              onToggle={() => toggle(`${rowKey}:${position}`)}
              wide
            />
          </td>
        ))}
      </tr>
      {rowOpen || openColumn !== null ? (
        <tr>
          <td colSpan={report.columns.length + 1} className="pb-2 pt-0.5">
            <div className="sticky left-0 max-w-[min(100%,40rem)]">
              <EvidencePanel
                id={controls}
                criterion={criterion}
                column={openColumn === null ? null : (report.columns[openColumn] ?? null)}
                check={openColumn === null ? criterion.own : criterion.cells![openColumn]!}
                onClose={() => toggle(opened!)}
              />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function MatrixTable({ report, criteria, opened, toggle, drawerId }: { report: AcceptanceReport; criteria: readonly Criterion[]; opened: string | null; toggle: (key: string) => void; drawerId: string }) {
  return (
    <div className="hidden min-w-0 overflow-x-auto @lg:block">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-[1] bg-background pb-1.5 pr-3 text-left align-bottom text-xs font-normal text-muted-foreground">
              Criterion
            </th>
            {report.columns.map((column) => (
              <th key={column} scope="col" className="w-[4.75rem] px-[3px] pb-1.5 text-center align-bottom text-[11.5px] font-medium leading-4 text-foreground [overflow-wrap:anywhere]">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {criteria.map((criterion) => (
            <MatrixRow key={criterion.index} report={report} criterion={criterion} opened={opened} toggle={toggle} drawerId={drawerId} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Narrow screens: one card per criterion, its conditions as chips that open their evidence inside the card. */
function CriterionCard({ report, criterion, opened, toggle, drawerId }: { report: AcceptanceReport; criterion: Criterion; opened: string | null; toggle: (key: string) => void; drawerId: string }) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const rowKey = String(criterion.index);
  const openColumn = opened?.startsWith(`${rowKey}:`) ? Number(opened.slice(rowKey.length + 1)) : null;
  const rowOpen = opened === rowKey;
  const controls = `${drawerId}-n${criterion.index}`;
  return (
    <li ref={rise} className="flex min-w-0 flex-col gap-2 rounded-lg bg-surface-recessed/70 px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <RowName criterion={criterion} open={rowOpen} onToggle={hasOwnDetail(criterion) ? () => toggle(rowKey) : null} controls={controls} />
        </div>
        <StatusText check={criterion.own} />
      </div>
      <ul aria-label={`${criterion.name}: conditions`} className="m-0 grid min-w-0 list-none grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-1 p-0">
        {report.columns.map((column, position) => (
          <li key={column} className="min-w-0 rounded-md bg-background">
            <Cell
              criterion={criterion}
              column={column}
              check={criterion.cells![position]!}
              open={openColumn === position}
              controls={controls}
              onToggle={() => toggle(`${rowKey}:${position}`)}
              wide={false}
            />
          </li>
        ))}
      </ul>
      {rowOpen || openColumn !== null ? (
        <EvidencePanel
          id={controls}
          criterion={criterion}
          column={openColumn === null ? null : (report.columns[openColumn] ?? null)}
          check={openColumn === null ? criterion.own : criterion.cells![openColumn]!}
          onClose={() => toggle(opened!)}
        />
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// One status per criterion

function CheckRow({ criterion, open, onToggle }: { criterion: Criterion; open: boolean; onToggle: () => void }) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const check = criterion.own;
  const by = check.by === null ? null : check.status === "claimed" ? `claimed by ${check.by}` : `by ${check.by}`;
  return (
    <li ref={rise} className="min-w-0 border-t border-border/60 first:border-t-0">
      <Disclosure
        open={open}
        onToggle={onToggle}
        label={`${criterion.name}: ${checkLabel(check)}`}
        header={
          <span className="flex w-full min-w-0 items-start gap-2 py-1.5">
            <StatusMark check={check} className="mt-[3px]" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn("text-[13px] leading-5 text-foreground [overflow-wrap:anywhere]", !open && "line-clamp-2")}>
                {criterion.name}
                {criterion.required ? null : <span className="ml-1.5 rounded-sm bg-surface-recessed px-1 text-[10.5px] text-muted-foreground">optional</span>}
              </span>
              {check.needs !== null ? (
                <span className="text-xs leading-4 text-warning-text [overflow-wrap:anywhere]">Needs you: {check.needs || (check.note ?? "your input")}</span>
              ) : !open && check.note !== null ? (
                <span className="truncate text-xs leading-4 text-muted-foreground">{check.note}</span>
              ) : null}
            </span>
            <span className="flex shrink-0 flex-col items-end">
              <StatusText check={check} />
              {by === null ? null : <span className="max-w-[9rem] truncate text-[11px] leading-4 text-muted-foreground">{by}</span>}
            </span>
          </span>
        }
      >
        {() => (
          <div className="pb-2 pl-[22px]">
            <EvidencePanel criterion={criterion} column={null} check={check} onClose={null} />
          </div>
        )}
      </Disclosure>
    </li>
  );
}

// ---------------------------------------------------------------------------

type Filter = "all" | "gaps";

/** The outermost component draws the frame; inside a Card it sits flat. */
function Frame({ label, children }: { label: string; children: ReactNode }) {
  const depth = useContext(CardDepthContext);
  const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();
  const body = (
    <div ref={outer} className={cn("min-w-0", SMOOTH_HEIGHT_CLASS)}>
      <div ref={inner} className="@container flex min-w-0 flex-col gap-3">
        {children}
      </div>
    </div>
  );
  if (depth > 0) return <section aria-label={label} className="min-w-0 text-sm text-foreground">{body}</section>;
  return (
    <CardDepthContext value={1}>
      <section aria-label={label} className="min-w-0 rounded-xl border border-border bg-background p-4 text-sm text-foreground sm:px-5">
        {body}
      </section>
    </CardDepthContext>
  );
}

export function Acceptance({ props }: { props: Props }) {
  const read = useMemo(() => readAcceptance(props.criteria, props.columns), [props.criteria, props.columns]);
  const id = useMemo(() => propsKey([props.criteria ?? null, props.columns ?? null]), [props.criteria, props.columns]);
  const drawerId = useId();
  const [filter, setFilter] = usePersistedState<Filter>(`${id}:acceptance-filter`, "all", (stored) => (stored === "all" || stored === "gaps" ? stored : null));
  const [opened, setOpened] = usePersistedState<string | null>(`${id}:acceptance-open`, null, (stored) => (typeof stored === "string" ? stored : null));
  const [shown, setShown] = usePersistedState<number>(`${id}:acceptance-shown`, PAGE, (stored) => (typeof stored === "number" && Number.isSafeInteger(stored) && stored > 0 ? stored : null));
  const report = read.ok ? read.report : null;
  const absolute = useMemo(
    () => report?.criteria.some((criterion) => [criterion.own, ...(criterion.cells ?? [])].some((check) => check.evidence.some((item) => item.kind === "file" && item.path.startsWith("/")))) ?? false,
    [report],
  );
  const root = useWorkspaceRoot(absolute);
  const paths = useMemo(() => ({ root, common: "" }), [root]);

  if (!read.ok) return <ErrorLine message={read.error} />;
  const data = read.report;
  const verdict = acceptanceVerdict(data);
  const label = data.title ?? "Acceptance";
  if (data.criteria.length === 0) {
    return (
      <Frame label={label}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className={cn(CAPTION, "m-0")}>{label}</p>
          <p className="m-0 flex items-center gap-1.5 text-xs leading-5 text-muted-foreground">
            <Icon name="ListTodo" aria-hidden className="size-3.5 shrink-0" />
            {data.unnamed > 0 ? "No criterion has a name yet." : "No criteria yet."}
          </p>
        </div>
      </Frame>
    );
  }

  const matrix = data.columns.length > 0;
  const gaps = data.criteria.filter(isGap);
  const gapsOnly = filter === "gaps" && gaps.length > 0 && gaps.length < data.criteria.length;
  const list = gapsOnly ? gaps : data.criteria;
  const visible = list.slice(0, shown);
  const rest = list.length - visible.length;
  const toggle = (key: string) => setOpened((current) => (current === key ? null : key));
  const cellCounts = verdict.cells?.counts ?? null;
  const cells = cellsLine(verdict);
  const barCounts = cellCounts ?? verdict.counts;

  return (
    <Frame label={label}>
      <ReportPathsContext value={paths}>
        <Heading report={data} verdict={verdict} />
        <div className="flex min-w-0 flex-col gap-1">
          <StatusBar counts={barCounts} label={cells ?? verdict.parts.join(", ")} />
          {cells === null ? null : <p className="m-0 text-xs leading-5 tabular-nums text-muted-foreground">{cells}</p>}
        </div>
        <NeedsYouBox items={verdict.needsYou} />
        <Limitations items={data.limitations} />
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          {gaps.length > 0 && gaps.length < data.criteria.length ? (
            <Segmented
              label="Show criteria"
              value={gapsOnly ? "gaps" : "all"}
              onChange={(next) => {
                setFilter(next);
                setShown(PAGE);
              }}
              options={[
                { value: "all", label: `All ${formatNumber(data.criteria.length)}` },
                { value: "gaps", label: `Gaps only ${formatNumber(gaps.length)}` },
              ]}
            />
          ) : (
            <span />
          )}
          {matrix ? <Legend report={data} /> : null}
        </div>
        {matrix ? (
          <>
            <MatrixTable report={data} criteria={visible} opened={opened} toggle={toggle} drawerId={drawerId} />
            <ul aria-label="Criteria" className="m-0 flex min-w-0 list-none flex-col gap-2 p-0 @lg:hidden">
              {visible.map((criterion) => (
                <CriterionCard key={criterion.index} report={data} criterion={criterion} opened={opened} toggle={toggle} drawerId={drawerId} />
              ))}
            </ul>
          </>
        ) : (
          <ul aria-label="Criteria" className="m-0 flex min-w-0 list-none flex-col p-0">
            {visible.map((criterion) => (
              <CheckRow key={criterion.index} criterion={criterion} open={opened === String(criterion.index)} onToggle={() => toggle(String(criterion.index))} />
            ))}
          </ul>
        )}
        {rest > 0 ? (
          <button type="button" onClick={() => setShown((count) => count + PAGE)} className={TEXT_BUTTON}>
            Show {formatNumber(Math.min(rest, PAGE))} more of {formatNumber(rest)}
          </button>
        ) : null}
      </ReportPathsContext>
    </Frame>
  );
}
