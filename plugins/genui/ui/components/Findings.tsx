// Review, lint and type findings as a code-scanning panel reads them: the
// count per severity as a strip, then the findings by file (or by area, or
// by severity), most severe first. A review leads with its verdict and what
// is still open, counts its findings per status (open, fixed and awaiting
// confirmation, confirmed, rejected, deferred) and filters to the unresolved
// ones. A finding opens to its detail, the reviewer's evidence, where it
// stands, the code at its line with the column underlined, the fix (a diff
// where the tool gave edits) and its rule's docs; "Fix this" and "Fix all"
// put the work still to fix in the user's message. Long reports page in.
import { useContext, useMemo, type ReactNode } from "react";
import { Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import { Button as BaseButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  countSeverities,
  editsPatch,
  fixAllMessage,
  fixThisMessage,
  groupByArea,
  groupByFile,
  groupBySeverity,
  hasLifecycle,
  isResolved,
  needsFix,
  readFindings,
  SEVERITIES,
  severityCount,
  severityLabel,
  statusCounts,
  statusSentence,
  verdictHeadline,
  type Finding,
  type FindingGroup,
  type FindingStatus,
  type Review,
  type Severity,
  type SeverityCounts,
  type SeverityScale,
  type VerdictTone,
} from "../../core/findings";
import { commonDirectory, displayPath } from "../../core/test-results";
import { CardDepthContext, NodeKeyContext, sentFor, useAnswers, useUiRuntime, type TextFile } from "../runtime";
import { propsKey, usePersistedState } from "../usePersistedState";
import { formatNumber, optionalText, TONE_DOT, TONE_PILL, TONE_TEXT, type Props, type Tone } from "../values";
import { actionIntent, sendEffect } from "./action-logic";
import {
  acceptStrings,
  Chevron,
  CodeExcerpt,
  Disclosure,
  OpenFileButton,
  ReportFrame,
  ReportPathsContext,
  Segmented,
  TEXT_BUTTON,
  useFileOpener,
  useFileText,
  useShownPath,
  useWorkspaceRoot,
  type MarkTone,
} from "./codeHealthKit";
import { Code, Diff } from "./code";
import { ErrorLine } from "./display";
import { ActionGlyph, ActionHint, FOCUS_RING } from "./inputs";
import { CHART_DRAW_MS, FADE, RISE, useEntrance, type Entrance } from "./motion";
import { ICON_BUTTON } from "./projectKit";

/** Findings shown before "Show N more", and how many each click adds. */
const FINDING_PAGE = 25;

const GROW_X: Entrance = { keyframes: [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], duration: CHART_DRAW_MS };

const SEVERITY_STYLE: Record<Severity, { icon: string; ink: string; fill: string; tone: MarkTone }> = {
  critical: { icon: "AlertCircle", ink: "text-destructive", fill: "bg-destructive", tone: "bad" },
  high: { icon: "CircleX", ink: "text-destructive", fill: "bg-destructive/70", tone: "bad" },
  medium: { icon: "AlertTriangle", ink: "text-warning-text", fill: "bg-warning", tone: "warn" },
  low: { icon: "Info", ink: "text-[var(--color-timeline-accent,var(--primary))]", fill: "bg-[var(--color-timeline-accent,var(--primary))]", tone: "info" },
  info: { icon: "Info", ink: "text-muted-foreground", fill: "bg-muted-foreground/40", tone: "info" },
};

/** A severity's fill; on the risk scale `high` is a lighter red than `critical`, on the lint scale an error is the full red. */
function severityFill(severity: Severity, scale: SeverityScale): string {
  return severity === "high" && scale === "lint" ? "bg-destructive" : SEVERITY_STYLE[severity].fill;
}

const PROSE = "min-w-0 text-[13px] leading-5 text-foreground [&>:first-child]:mt-0 [&>:last-child]:mb-0";

type Mode = "file" | "area" | "severity";

type Show = "all" | "unresolved";

/** A status as a row's pill says it: short; the body says it in full (statusSentence). Owner-reported fixes are never green. */
const STATUS_STYLE: Record<FindingStatus, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "neutral" },
  deferred: { label: "Deferred", tone: "info" },
  fixed: { label: "Fixed, unconfirmed", tone: "warn" },
  confirmed: { label: "Confirmed", tone: "good" },
  rejected: { label: "Rejected", tone: "neutral" },
  wontfix: { label: "Won't fix", tone: "neutral" },
};

const VERDICT_ICON: Record<VerdictTone, string> = { good: "CircleCheck", warn: "AlertTriangle", bad: "CircleX" };

/** A tool's message with its `code spans` (Ruff, Biome, reviews) in monospace. */
function ToolText({ text }: { text: string }) {
  return text.split(/(`[^`\n]+`)/).map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="rounded-sm bg-surface-recessed px-1 font-mono text-[0.92em]">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

function SeverityMark({ severity, className }: { severity: Severity; className?: string }) {
  const style = SEVERITY_STYLE[severity];
  return <Icon name={style.icon} aria-hidden className={cn("size-3.5 shrink-0", style.ink, className)} />;
}

/** `2 errors · 1 warning` as coloured counts. */
function Counts({ counts, scale, className }: { counts: SeverityCounts; scale: SeverityScale; className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground", className)}>
      {SEVERITIES.filter((severity) => counts[severity] > 0).map((severity) => (
        <span key={severity} className="flex items-center gap-1" title={severityCount(severity, scale, counts[severity])}>
          <span aria-hidden className={cn("size-1.5 rounded-full", severityFill(severity, scale))} />
          {formatNumber(counts[severity])}
          <span className="sr-only"> {severityLabel(severity, scale)}</span>
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Header

function Summary({
  findings,
  scale,
  heading,
  caption,
  verdict,
}: {
  findings: readonly Finding[];
  scale: SeverityScale;
  heading: string;
  caption: string;
  verdict: { text: string; tone: VerdictTone } | null;
}) {
  const fade = useEntrance<HTMLDivElement>(FADE);
  const grow = useEntrance<HTMLDivElement>(GROW_X);
  const counts = countSeverities(findings);
  const present = SEVERITIES.filter((severity) => counts[severity] > 0);
  const statuses = statusCounts(findings);
  return (
    <div ref={fade} className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-col">
        <h3 className="m-0 text-balance text-[15px] font-semibold leading-6 tracking-[-0.01em] text-foreground">{heading}</h3>
        {caption === "" ? null : <span className="text-xs leading-5 text-muted-foreground">{caption}</span>}
      </div>
      {verdict === null ? null : (
        <div className={cn("flex min-w-0 items-start gap-1.5 text-[13px] font-medium leading-5", TONE_TEXT[verdict.tone])}>
          <Icon name={VERDICT_ICON[verdict.tone]} aria-hidden className="mt-[3px] size-3.5 shrink-0" />
          <span className="min-w-0">{verdict.text}</span>
        </div>
      )}
      <div
        ref={grow}
        role="img"
        aria-label={present.map((severity) => severityCount(severity, scale, counts[severity])).join(", ")}
        className="flex h-1.5 w-full origin-left gap-[2px] overflow-hidden rounded-full bg-muted"
      >
        {present.map((severity) => (
          <div key={severity} className={cn("h-full min-w-[3px]", severityFill(severity, scale))} style={{ flex: `${counts[severity]} 1 0` }} />
        ))}
      </div>
      <p className="m-0 flex flex-wrap gap-x-4 gap-y-0.5 text-xs leading-5 text-muted-foreground">
        {present.map((severity) => (
          <span key={severity} className="flex items-center gap-1.5 tabular-nums">
            <span aria-hidden className={cn("size-2 rounded-full", severityFill(severity, scale))} />
            <span className={cn("font-medium", SEVERITY_STYLE[severity].ink)}>{formatNumber(counts[severity])}</span>
            {severityCount(severity, scale, counts[severity]).replace(/^\d+ /, "")}
          </span>
        ))}
      </p>
      {statuses.length === 0 ? null : (
        <p className="m-0 flex flex-wrap gap-x-3 gap-y-0.5 text-xs leading-5 text-muted-foreground" aria-label={`By status: ${statuses.map((entry) => entry.text).join(", ")}`}>
          {statuses.map((entry) => (
            <span key={entry.status} className="flex items-center gap-1.5 tabular-nums">
              <span aria-hidden className={cn("size-1.5 rounded-full", TONE_DOT[STATUS_STYLE[entry.status].tone])} />
              {entry.text}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Asking for a fix

/**
 * A toggle that puts `message` in the user's message (its own question:
 * press again to take it out); it reads "Sent" once sent. Like a link, it
 * stays usable in an older reply.
 */
function SendButton({ message, label, icon, primary = false }: { message: string; label: string; icon: string; primary?: boolean }) {
  const { staged, sent, target, stage } = useAnswers();
  const question = `${useContext(NodeKeyContext)}/${propsKey(message)}`;
  const answered = sentFor(sent, question, (text) => text === message) !== null;
  const pressed = staged.has(question);
  const { hint } = actionIntent([{ kind: "action", type: "send", text: message }], { send: sendEffect(target, true, pressed) });
  return (
    <ActionHint hint={hint}>
      <BaseButton
        type="button"
        size="sm"
        variant={primary && !pressed ? "default" : "outline"}
        data-genui-question={question}
        aria-pressed={target === "direct" ? undefined : pressed}
        onClick={() => void stage(question, pressed ? null : { text: message, selection: true })}
        className={cn(
          "h-7 w-fit max-w-full gap-1.5 px-2.5 text-xs",
          (!primary || pressed) && "bg-background text-foreground",
          pressed && "border-transparent bg-surface-recessed ring-2 ring-[var(--color-timeline-accent,var(--primary))] ring-offset-1 ring-offset-background",
        )}
      >
        <Icon name={answered || pressed ? "Check" : icon} aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{pressed ? `${label}: in your message` : answered ? "Sent" : label}</span>
        {answered && !pressed ? null : <ActionGlyph name="Sent" />}
      </BaseButton>
    </ActionHint>
  );
}

// ---------------------------------------------------------------------------
// One finding

function FixView({ finding, path, file }: { finding: Finding; path: string; file: TextFile | null }) {
  const fix = finding.fix;
  if (fix === null) return null;
  if (fix.kind === "proposal") {
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs font-medium leading-5 text-foreground">Proposed fix</span>
        <Markdown content={fix.text} className={PROSE} />
      </div>
    );
  }
  let body: ReactNode;
  if (fix.kind === "patch") body = <Diff props={{ patch: fix.patch }} />;
  else if (fix.kind === "code") body = <Code props={{ code: fix.code, language: /\.([a-z0-9]+)$/i.exec(finding.file ?? "")?.[1] ?? null }} />;
  else if (file === null) body = null;
  else {
    const patch = file.ok ? editsPatch(file.text, path, fix.edits) : null;
    body = patch === null ? null : <Diff props={{ patch }} />;
  }
  if (body === null && finding.fixNote === null) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="flex min-w-0 items-center gap-1.5 text-xs leading-5 text-muted-foreground">
        <Icon name="EditFile" aria-hidden className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground">Fix</span>
        {finding.fixNote === null ? null : (
          <span className="min-w-0 [overflow-wrap:anywhere]">
            · <ToolText text={finding.fixNote} />
          </span>
        )}
      </span>
      {body}
    </div>
  );
}

function FindingBody({ finding, scale }: { finding: Finding; scale: SeverityScale }) {
  const { run } = useUiRuntime();
  const shownPath = useShownPath();
  const file = useFileText(finding.file !== null && finding.line !== null ? finding.file : null);
  const shown = finding.file === null ? null : shownPath(finding.file);
  const location = shown === null ? null : `${shown}${finding.line === null ? "" : `:${finding.line}${finding.column === null ? "" : `:${finding.column}`}`}`;
  const copy = () => {
    const rule = finding.rule === null ? "" : ` (${finding.rule})`;
    void run([{ kind: "action", type: "copy", text: `${location === null ? "" : `${location} `}${severityLabel(finding.severity, scale)}: ${finding.title}${rule}` }]);
  };
  return (
    <div className="flex min-w-0 flex-col gap-2.5 pb-2 pl-[22px] pt-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-5 text-muted-foreground">
          <span className={cn("font-medium", SEVERITY_STYLE[finding.severity].ink)}>{severityLabel(finding.severity, scale)}</span>
          {finding.id === null ? null : <span className="font-mono text-[11px]">{finding.id}</span>}
          {finding.rule === null ? null : finding.url === null ? (
            <span className="font-mono text-[11px]">{finding.rule}</span>
          ) : (
            <UrlLink
              href={finding.url}
              title={`${finding.rule} documentation`}
              className="group/link inline-flex min-w-0 items-center gap-1 rounded-sm font-mono text-[11px] text-primary underline-offset-2 hover:underline"
            >
              <span className="truncate">{finding.rule}</span>
              <Icon name="ExternalLink" aria-hidden className="size-3 shrink-0" />
            </UrlLink>
          )}
          {location === null ? null : (
            <span className="min-w-0 truncate font-mono text-[11px]" title={finding.file ?? undefined}>
              {location}
            </span>
          )}
        </span>
        {finding.file === null ? null : <OpenFileButton path={finding.file} line={finding.line} />}
        <button type="button" title="Copy finding" aria-label={`Copy the finding: ${finding.title}`} onClick={copy} className={ICON_BUTTON}>
          <Icon name="Copy" className="size-3.5" />
        </button>
      </div>
      {finding.detail === null ? null : finding.detailIsText ? (
        <pre className="m-0 whitespace-pre-wrap font-mono text-[11.5px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">{finding.detail}</pre>
      ) : (
        <Markdown content={finding.detail} className={PROSE} />
      )}
      {finding.status === null ? null : <LifecycleView finding={finding} />}
      {finding.evidence === null ? null : (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-medium leading-5 text-foreground">Evidence</span>
          <Markdown content={finding.evidence} className={PROSE} />
        </div>
      )}
      {finding.file !== null && finding.line !== null ? (
        <CodeExcerpt
          path={finding.file}
          file={file}
          tone={SEVERITY_STYLE[finding.severity].tone}
          snippet={finding.snippet}
          mark={{
            start: finding.line,
            end: finding.endLine !== null && finding.endLine >= finding.line && finding.endLine - finding.line < 12 ? finding.endLine : finding.line,
            column: finding.column === null ? null : { start: finding.column, end: finding.endLine === null || finding.endLine === finding.line ? finding.endColumn : null },
          }}
        />
      ) : null}
      <FixView finding={finding} path={shown ?? "file"} file={file} />
      {needsFix(finding) ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SendButton message={fixThisMessage(finding, shown)} label="Fix this" icon="EditFile" />
        </div>
      ) : null}
    </div>
  );
}

/** Where a finding stands: who fixed, confirmed, rejected or took it, and the note that goes with it (a rejection's counter-evidence). */
function LifecycleView({ finding }: { finding: Finding }) {
  const status = finding.status ?? "open";
  const style = STATUS_STYLE[status];
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md bg-surface-recessed px-2.5 py-1.5">
      <span className="flex min-w-0 items-start gap-1.5 text-xs font-medium leading-5 text-foreground">
        <span aria-hidden className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", TONE_DOT[style.tone])} />
        <span className="min-w-0 [overflow-wrap:anywhere]">{statusSentence(finding)}</span>
      </span>
      {finding.note === null ? null : (
        <p className="m-0 pl-3 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
          <span className="font-medium text-foreground">{status === "rejected" ? "Counter-evidence: " : "Note: "}</span>
          <ToolText text={finding.note} />
        </p>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: FindingStatus }) {
  const style = STATUS_STYLE[status];
  return (
    <span className={cn("mt-0.5 inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-1.5 text-[10.5px] font-medium leading-4", TONE_PILL[style.tone])}>{style.label}</span>
  );
}

function FindingRow({
  finding,
  scale,
  mode,
  lifecycle,
  open,
  onToggle,
}: {
  finding: Finding;
  scale: SeverityScale;
  mode: Mode;
  /** Whether the report carries statuses: then every row shows its own. */
  lifecycle: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const shownPath = useShownPath();
  const where =
    mode === "file"
      ? finding.line === null
        ? null
        : `${finding.line}${finding.column === null ? "" : `:${finding.column}`}`
      : finding.file === null
        ? null
        : `${shownPath(finding.file)}${finding.line === null ? "" : `:${finding.line}`}`;
  return (
    <li ref={rise} className="min-w-0">
      <Disclosure
        open={open}
        onToggle={onToggle}
        label={`${severityLabel(finding.severity, scale)}${finding.line === null ? "" : `, line ${finding.line}`}${lifecycle ? `, ${STATUS_STYLE[finding.status ?? "open"].label}` : ""}: ${finding.title}`}
        header={
          <span className="flex w-full min-w-0 items-start gap-2 py-1">
            <span className="mt-[3px] flex items-center gap-2">
              <Chevron open={open} />
              <SeverityMark severity={finding.severity} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn("text-[13px] leading-5 [overflow-wrap:anywhere]", isResolved(finding) ? "text-muted-foreground" : "text-foreground", !open && "line-clamp-2")}>
                <ToolText text={finding.title} />
              </span>
              {mode !== "file" && where !== null ? (
                <span className="truncate font-mono text-[11px] leading-4 text-muted-foreground">{where}</span>
              ) : null}
            </span>
            {finding.rule === null || mode === "area" ? null : (
              <span
                className="mt-0.5 hidden max-w-[11rem] shrink-0 truncate rounded-sm bg-surface-recessed px-1.5 font-mono text-[10.5px] leading-4 text-muted-foreground sm:inline"
                title={finding.rule}
              >
                {/* A plugin's rules read by name here (`no-unused-vars`); the body names the plugin. */}
                {finding.rule.replace(/^@?[\w-]+\/(?=[\w-]+$)/, "")}
              </span>
            )}
            {mode === "file" && where !== null ? (
              <span className="mt-px shrink-0 font-mono text-[11px] leading-5 tabular-nums text-muted-foreground">{where}</span>
            ) : null}
            {lifecycle ? <StatusPill status={finding.status ?? "open"} /> : null}
          </span>
        }
      >
        {() => <FindingBody finding={finding} scale={scale} />}
      </Disclosure>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Groups

function GroupHeader({ group, scale, mode }: { group: FindingGroup; scale: SeverityScale; mode: Mode }) {
  const shownPath = useShownPath();
  if (group.severity !== null) {
    const count = group.findings.length;
    return (
      <h4 className="m-0 flex min-w-0 items-center gap-2 py-1 text-xs font-medium leading-5 text-foreground">
        <SeverityMark severity={group.severity} />
        <span className="capitalize">{severityCount(group.severity, scale, count).replace(/^\d+ /, "")}</span>
        <span className="font-normal tabular-nums text-muted-foreground">{formatNumber(count)}</span>
      </h4>
    );
  }
  if (mode === "area") {
    return (
      <h4 className="m-0 flex min-w-0 items-center gap-2 py-1 text-xs font-normal leading-5">
        <Icon name="Bug" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground first-letter:uppercase" title={group.area ?? undefined}>
          {group.area ?? "No area"}
        </span>
        <Counts counts={group.counts} scale={scale} />
      </h4>
    );
  }
  return (
    <h4 className="m-0 flex min-w-0 items-center justify-between gap-2 py-1 text-xs font-normal leading-5">
      {group.file === null ? (
        <span className="flex min-w-0 items-center gap-2">
          <Icon name="FileQuestion" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-[12px] text-foreground">No file</span>
        </span>
      ) : (
        <FileLink path={group.file} shown={shownPath(group.file)} className="text-[12px]" />
      )}
      <Counts counts={group.counts} scale={scale} />
    </h4>
  );
}

/** A file's icon and path as one control that opens it in BB; plain where BB can't open it. */
function FileLink({ path, shown, className }: { path: string; shown: string; className?: string }) {
  const file = useFileOpener(path);
  const content = (
    <>
      <Icon
        name="FileText"
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground transition-colors duration-150 group-hover/file:text-foreground"
      />
      <span className="truncate underline-offset-2 group-hover/file:underline">{shown}</span>
    </>
  );
  const shape = cn("flex min-w-0 items-center gap-2 font-mono text-foreground", className);
  if (file === null) {
    return (
      <span title={path} className={shape}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={`Open ${file.target}`}
      onClick={() => void file.open(null)}
      className={cn("group/file cursor-pointer rounded-sm text-left", FOCUS_RING, shape)}
    >
      {content}
    </button>
  );
}

/** The review's own evidence and artifacts, folded under one line: what the reviewer ran and kept. */
function ReviewEvidence({ review, open, onToggle }: { review: Review; open: boolean; onToggle: () => void }) {
  const parts = [
    review.evidence.length === 0 ? null : `${formatNumber(review.evidence.length)} ${review.evidence.length === 1 ? "note" : "notes"}`,
    review.artifacts.length === 0 ? null : `${formatNumber(review.artifacts.length)} ${review.artifacts.length === 1 ? "artifact" : "artifacts"}`,
  ].filter((part) => part !== null);
  return (
    <section aria-label="Review evidence" className="min-w-0 border-t border-border/60 pt-1.5">
      <Disclosure
        open={open}
        onToggle={onToggle}
        header={
          <span className="flex w-full min-w-0 items-center gap-2 py-1 text-xs leading-5">
            <Chevron open={open} />
            <span className="font-medium text-foreground">Review evidence</span>
            <span className="truncate text-muted-foreground">{parts.join(" · ")}</span>
          </span>
        }
      >
        {() => (
          <div className="flex min-w-0 flex-col gap-2 pb-1 pl-[22px] pt-1">
            {review.evidence.length === 0 ? null : (
              <ul className="m-0 flex min-w-0 list-disc flex-col gap-0.5 pl-4 text-xs leading-5 text-muted-foreground marker:text-muted-foreground/60">
                {review.evidence.map((entry, index) => (
                  <li key={index} className="[overflow-wrap:anywhere]">
                    <ToolText text={entry} />
                  </li>
                ))}
              </ul>
            )}
            {review.artifacts.length === 0 ? null : (
              <ul className="m-0 flex min-w-0 list-none flex-col p-0">
                {review.artifacts.map((path) => (
                  <li key={path} className="flex min-w-0 text-xs leading-6">
                    {/^https?:\/\//.test(path) ? (
                      <UrlLink
                        href={path}
                        title={path}
                        className={cn(
                          "flex min-w-0 items-center gap-2 rounded-sm font-mono text-[11.5px] text-primary underline-offset-2 hover:underline",
                          FOCUS_RING,
                        )}
                      >
                        <Icon name="Globe" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{path}</span>
                        <Icon name="ExternalLink" aria-hidden className="size-3 shrink-0" />
                      </UrlLink>
                    ) : (
                      <FileLink path={path} shown={path} className="text-[11.5px]" />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Disclosure>
    </section>
  );
}

// ---------------------------------------------------------------------------

export function Findings({ props }: { props: Props }) {
  const depth = useContext(CardDepthContext);
  const result = useMemo(() => readFindings(props.items), [props.items]);
  const title = optionalText(props.title);
  const findings = useMemo(() => (result.ok ? result.report.findings : []), [result]);
  const id = useMemo(() => propsKey(props.items), [props.items]);
  const [show, setShow] = usePersistedState<Show>(`${id}:findings-show`, "all", (stored) => (stored === "all" || stored === "unresolved" ? stored : null));
  const [opened, setOpened] = usePersistedState<string[]>(`${id}:findings-open`, [], acceptStrings);
  const [shown, setShown] = usePersistedState<number>(`${id}:findings-shown`, FINDING_PAGE, (stored) =>
    typeof stored === "number" && Number.isSafeInteger(stored) && stored > 0 ? stored : null,
  );
  const { indexOf, files, areas, common, absolute, lifecycle } = useMemo(() => {
    const paths = new Set<string>();
    for (const item of findings) if (item.file !== null) paths.add(item.file);
    return {
      indexOf: new Map(findings.map((item, index) => [item, String(index)])),
      files: paths.size,
      areas: findings.some((item) => item.rule !== null),
      common: commonDirectory(paths),
      absolute: [...paths].some((path) => path.startsWith("/")),
      lifecycle: hasLifecycle(findings),
    };
  }, [findings]);
  // A review names no files: its findings read best by severity (unresolved first in each), by area on demand.
  const [mode, setMode] = usePersistedState<Mode>(`${id}:findings-mode`, files === 0 && areas ? "severity" : "file", (stored) =>
    stored === "file" || stored === "area" || stored === "severity" ? stored : null,
  );
  const root = useWorkspaceRoot(absolute);
  const paths = useMemo(() => ({ root, common }), [root, common]);
  const placeMode: Mode = files === 0 && areas ? "area" : "file";
  const groupMode: Mode = mode === "severity" ? "severity" : placeMode;
  const filter: Show = lifecycle ? show : "all";
  const listed = useMemo(() => (filter === "unresolved" ? findings.filter((item) => !isResolved(item)) : findings), [findings, filter]);
  const groups = useMemo(
    () => (groupMode === "file" ? groupByFile(listed) : groupMode === "area" ? groupByArea(listed) : groupBySeverity(listed)),
    [listed, groupMode],
  );
  const [evidenceOpen, setEvidenceOpen] = usePersistedState<boolean>(`${id}:findings-evidence`, false, (stored) => (typeof stored === "boolean" ? stored : null));

  if (!result.ok) return <ErrorLine message={result.error} />;
  const report = result.report;
  const { scale, tool, review } = report;
  const verdict = verdictHeadline(report);
  const total = `${formatNumber(findings.length)} ${findings.length === 1 ? "finding" : "findings"}`;
  const subjectHeading = review?.subject == null ? null : `${review.subject} review`;

  if (findings.length === 0) {
    return (
      <ReportFrame depth={depth} label={title ?? subjectHeading ?? "Findings"}>
        <CardDepthContext value={depth + 1}>
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="m-0 text-[15px] font-semibold leading-6 text-foreground">{title ?? subjectHeading ?? "No findings"}</h3>
            <p className="m-0 flex items-center gap-1.5 text-xs leading-5 text-muted-foreground">
              <Icon name="CircleCheck" aria-hidden className="size-3.5 text-success" />
              {verdict !== null ? `${verdict.text.replace(/: nothing open$/, "")}: no findings.` : tool === null ? "Nothing to fix." : `${tool} reported nothing.`}
            </p>
          </div>
        </CardDepthContext>
      </ReportFrame>
    );
  }

  const heading = title ?? subjectHeading ?? total;
  const caption = [heading === total ? null : total, tool === title ? null : tool, files > 0 ? `${formatNumber(files)} ${files === 1 ? "file" : "files"}` : null]
    .filter((part) => part !== null)
    .join(" · ");
  // Page across groups: the first `shown` findings in the current order, regrouped.
  const visible: FindingGroup[] = [];
  let left = shown;
  for (const group of groups) {
    if (left <= 0) break;
    visible.push(group.findings.length <= left ? group : { ...group, findings: group.findings.slice(0, left) });
    left -= group.findings.length;
  }
  const rest = listed.length - Math.min(shown, listed.length);
  const toggle = (key: string) => setOpened((list) => (list.includes(key) ? list.filter((item) => item !== key) : [...list, key]));
  const display = (item: Finding) => (item.file === null ? null : displayPath(item.file, paths.root, paths.common));
  // "Fix" acts on what still needs a fix: not on fixes awaiting confirmation, nor on settled findings.
  const fixable = lifecycle ? findings.filter(needsFix) : findings;
  const unresolved = findings.filter((item) => !isResolved(item)).length;

  return (
    <ReportFrame depth={depth} label={heading}>
      <CardDepthContext value={depth + 1}>
        <ReportPathsContext value={paths}>
          <div className="flex min-w-0 flex-col gap-3">
            <Summary findings={findings} scale={scale} heading={heading} caption={caption} verdict={verdict} />
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {findings.length > 1 ? (
                  <Segmented
                    label="Group findings"
                    value={groupMode}
                    onChange={setMode}
                    options={[
                      placeMode === "area" ? { value: "area", label: "By area" } : { value: "file", label: "By file" },
                      { value: "severity", label: "By severity" },
                    ]}
                  />
                ) : null}
                {lifecycle ? (
                  <Segmented
                    label="Show findings"
                    value={filter}
                    onChange={setShow}
                    options={[
                      { value: "all", label: `All ${formatNumber(findings.length)}` },
                      { value: "unresolved", label: `Unresolved ${formatNumber(unresolved)}` },
                    ]}
                  />
                ) : null}
              </div>
              {fixable.length === 0 ? (
                <span className="text-xs leading-7 text-muted-foreground">Nothing left to fix</span>
              ) : (
                <SendButton
                  message={fixable.length === 1 ? fixThisMessage(fixable[0]!, display(fixable[0]!)) : fixAllMessage(fixable, scale, display, review?.subject ?? null)}
                  label={fixable.length === 1 ? "Fix it" : `Fix all ${formatNumber(fixable.length)}`}
                  icon="EditFile"
                  primary
                />
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              {listed.length === 0 ? (
                <p className="m-0 flex items-center gap-1.5 border-t border-border/60 pt-2 text-xs leading-5 text-muted-foreground">
                  <Icon name="CircleCheck" aria-hidden className="size-3.5 text-success" />
                  Every finding is confirmed, rejected or won't be fixed.
                </p>
              ) : null}
              {visible.map((group) => (
                <section
                  key={group.key}
                  aria-label={group.file ?? group.area ?? group.severity ?? (groupMode === "area" ? "No area" : "No file")}
                  className="flex min-w-0 flex-col border-t border-border/60 pt-1.5"
                >
                  <GroupHeader group={groups.find((full) => full.key === group.key) ?? group} scale={scale} mode={groupMode} />
                  <ul className="m-0 flex min-w-0 list-none flex-col p-0">
                    {group.findings.map((item) => {
                      const key = indexOf.get(item)!;
                      return (
                        <FindingRow key={key} finding={item} scale={scale} mode={groupMode} lifecycle={lifecycle} open={opened.includes(key)} onToggle={() => toggle(key)} />
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
            {rest > 0 ? (
              <button type="button" onClick={() => setShown((count) => count + FINDING_PAGE)} className={TEXT_BUTTON}>
                Show {formatNumber(Math.min(rest, FINDING_PAGE))} more of {formatNumber(rest)}
              </button>
            ) : null}
            {review === undefined || review.evidence.length + review.artifacts.length === 0 ? null : (
              <ReviewEvidence review={review} open={evidenceOpen} onToggle={() => setEvidenceOpen((value) => !value)} />
            )}
          </div>
        </ReportPathsContext>
      </CardDepthContext>
    </ReportFrame>
  );
}
